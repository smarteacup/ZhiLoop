import { parseEvolutionJobInput, type KnowledgeRepairDraftJobInput } from "@zhiloop/evolution-job-runtime";
import {
  JobCancellationRequestedError,
  JobLeaseLostError,
  NonRetryableJobError,
  RetryableJobError,
  type JobExecutionContext,
  type JobHandler,
} from "@zhiloop/job-runtime";
import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";
import {
  KnowledgeFreshnessWorker,
  selectAffectedAssertionIds,
  type AffectedKnowledgeVersion,
  type FreshnessRevalidationPort,
  type FreshnessWorkerStorePort,
  type FrozenAffectedKnowledgeSnapshot,
  type KnowledgeFreshnessRecord,
  type SqliteKnowledgeFreshnessStore,
} from "@zhiloop/knowledge-freshness";

type RevalidationPhase = "OBSERVATION_LOADED" | "AFFECTED_FROZEN" | "PAGE_COMMITTED" | "VERIFICATION_COMPLETE" | "BASELINE_ACKNOWLEDGED";

interface RevalidationCheckpoint {
  readonly schemaVersion: 1;
  readonly phase: RevalidationPhase;
  readonly observationHash: string;
  readonly snapshotId?: string;
  readonly targetHash?: string;
  readonly targetCount?: number;
  readonly processedCount: number;
  readonly cursor?: AffectedKnowledgeVersion;
  readonly acknowledgementEffectKey?: string;
}

export interface KnowledgeRecipeResolver {
  resolve(record: KnowledgeFreshnessRecord): KnowledgeFreshnessRecord["candidate"] | undefined;
}

export interface DurableKnowledgeChangeObservation {
  readonly observationId: string;
  readonly sourceRef: string;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly observationHash: string;
}

export interface DurableKnowledgeChangePort {
  getObservation(sourceRef: string, projectId: string, observationHash: string): DurableKnowledgeChangeObservation | undefined;
  changeSet(sourceRef: string, projectId: string, observationHash: string): KnowledgeChangeSet;
  acknowledgeSource(projectId: string, sourceRef: string, effectKey: string, observationHash: string): unknown;
}

export interface KnowledgeRevalidateHandlerOptions {
  readonly source: DurableKnowledgeChangePort;
  readonly store: Pick<SqliteKnowledgeFreshnessStore,
    "freezeAffectedSnapshot" | "getAffectedSnapshot" | "readAffectedSnapshotPage" | "get" | "getState" | "transitionWithEffect">;
  readonly verifier: FreshnessRevalidationPort;
  readonly recipes?: KnowledgeRecipeResolver;
  readonly repairJobs?: { enqueue(input: KnowledgeRepairDraftJobInput): unknown };
  readonly onConflict?: (input: {
    readonly projectId: string;
    readonly assetId: string;
    readonly assetVersion: number;
    readonly verificationRunId: string;
    readonly observedAt: string;
    readonly reasonCodes: readonly string[];
  }) => void;
  readonly pageSize?: number;
  readonly maxTargets?: number;
}

const PHASES = new Set<RevalidationPhase>([
  "OBSERVATION_LOADED", "AFFECTED_FROZEN", "PAGE_COMMITTED", "VERIFICATION_COMPLETE", "BASELINE_ACKNOWLEDGED",
]);

function parseCheckpoint(context: JobExecutionContext, observationHash: string): RevalidationCheckpoint | undefined {
  const stored = context.getCheckpoint()?.data;
  if (stored === undefined) return undefined;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) throw new NonRetryableJobError("REVALIDATE_CHECKPOINT_CORRUPT");
  const value = stored as unknown as RevalidationCheckpoint;
  const keys = Object.keys(stored).sort();
  const allowed = ["acknowledgementEffectKey", "cursor", "observationHash", "phase", "processedCount", "schemaVersion",
    "snapshotId", "targetCount", "targetHash"];
  if (value.schemaVersion !== 1 || !PHASES.has(value.phase) || value.observationHash !== observationHash
    || keys.some((key) => !allowed.includes(key))
    || !Number.isSafeInteger(value.processedCount) || value.processedCount < 0
    || (value.snapshotId !== undefined && !/^affected_[a-f0-9]{64}$/u.test(value.snapshotId))
    || (value.targetHash !== undefined && !/^[a-f0-9]{64}$/u.test(value.targetHash))
    || (value.targetCount !== undefined && (!Number.isSafeInteger(value.targetCount) || value.targetCount < 0 || value.targetCount > 100_000))
    || (value.cursor !== undefined && (typeof value.cursor.assetId !== "string" || value.cursor.assetId.length < 1
      || value.cursor.assetId.length > 1_000 || !Number.isSafeInteger(value.cursor.assetVersion) || value.cursor.assetVersion < 1))
    || (value.acknowledgementEffectKey !== undefined && !/^[a-f0-9]{64}$/u.test(value.acknowledgementEffectKey))) {
    throw new NonRetryableJobError("REVALIDATE_CHECKPOINT_CORRUPT");
  }
  const initial = value.phase === "OBSERVATION_LOADED";
  if ((initial && (value.snapshotId !== undefined || value.targetHash !== undefined || value.targetCount !== undefined
    || value.processedCount !== 0 || value.cursor !== undefined || value.acknowledgementEffectKey !== undefined))
    || (!initial && (value.snapshotId === undefined || value.targetHash === undefined || value.targetCount === undefined
      || value.processedCount > value.targetCount))
    || (value.phase === "AFFECTED_FROZEN" && (value.processedCount !== 0 || value.cursor !== undefined))
    || (value.phase === "PAGE_COMMITTED" && (value.processedCount < 1 || value.cursor === undefined))
    || (["VERIFICATION_COMPLETE", "BASELINE_ACKNOWLEDGED"].includes(value.phase)
      && value.processedCount !== value.targetCount)
    || (value.phase === "BASELINE_ACKNOWLEDGED") !== (value.acknowledgementEffectKey !== undefined)) {
    throw new NonRetryableJobError("REVALIDATE_CHECKPOINT_CORRUPT");
  }
  return value;
}

function checkpoint(context: JobExecutionContext, value: RevalidationCheckpoint, progress: number): RevalidationCheckpoint {
  context.saveCheckpoint(value, progress);
  return value;
}

function assertObservation(input: Extract<ReturnType<typeof parseEvolutionJobInput>, { jobType: "KNOWLEDGE_REVALIDATE" }>,
  value: DurableKnowledgeChangeObservation | undefined): DurableKnowledgeChangeObservation {
  if (value === undefined) throw new NonRetryableJobError("REVALIDATE_OBSERVATION_MISSING");
  if (value.projectId !== input.projectId || value.repositoryRoot !== input.repositoryRoot || value.sourceRef !== input.sourceRef
    || value.observationHash !== input.changeSetHash) throw new NonRetryableJobError("REVALIDATE_OBSERVATION_MISMATCH");
  return value;
}

function assertSnapshot(input: Extract<ReturnType<typeof parseEvolutionJobInput>, { jobType: "KNOWLEDGE_REVALIDATE" }>,
  value: FrozenAffectedKnowledgeSnapshot | undefined, checkpointValue: RevalidationCheckpoint): FrozenAffectedKnowledgeSnapshot {
  if (value === undefined || value.snapshotId !== checkpointValue.snapshotId || value.projectId !== input.projectId
    || value.sourceRef !== input.sourceRef || value.changeSetHash !== input.changeSetHash
    || value.recipeSelectionHash !== input.recipeSelectionHash || value.targetHash !== checkpointValue.targetHash
    || value.targetCount !== checkpointValue.targetCount) throw new NonRetryableJobError("REVALIDATE_AFFECTED_SNAPSHOT_MISMATCH");
  return value;
}

function classify(error: unknown): never {
  if (error instanceof NonRetryableJobError || error instanceof RetryableJobError
    || error instanceof JobCancellationRequestedError || error instanceof JobLeaseLostError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message === "GIT_CHANGESET_BASELINE_CAS_CONFLICT") throw new NonRetryableJobError("REVALIDATE_BASELINE_CONFLICT");
  if (/(?:CORRUPT|INVALID|MISMATCH|INCOMPLETE|DUPLICATE|UNREQUESTED|LIMIT_EXCEEDED|NOT_FOUND)/u.test(message)) {
    throw new NonRetryableJobError("REVALIDATE_INVARIANT_FAILED");
  }
  throw new RetryableJobError("REVALIDATE_TRANSIENT_FAILURE");
}

export function createKnowledgeRevalidateHandler(options: KnowledgeRevalidateHandlerOptions): JobHandler {
  const pageSize = options.pageSize ?? 100;
  const maxTargets = options.maxTargets ?? 100_000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000
    || !Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 100_000) {
    throw new Error("REVALIDATE_HANDLER_OPTIONS_INVALID");
  }
  const recipes = options.recipes ?? { resolve: (record: KnowledgeFreshnessRecord) => record.candidate };
  return async (context): Promise<void> => {
    try {
      const parsed = parseEvolutionJobInput(context.input);
      if (parsed.jobType !== "KNOWLEDGE_REVALIDATE") throw new NonRetryableJobError("REVALIDATE_JOB_INPUT_INVALID");
      const observation = assertObservation(parsed,
        options.source.getObservation(parsed.sourceRef, parsed.projectId, parsed.changeSetHash));
      const changes = options.source.changeSet(parsed.sourceRef, parsed.projectId, parsed.changeSetHash);
      let state = parseCheckpoint(context, observation.observationHash);
      if (state === undefined) {
        state = checkpoint(context, { schemaVersion: 1, phase: "OBSERVATION_LOADED",
          observationHash: observation.observationHash, processedCount: 0 }, 0.05);
      }
      context.throwIfCancellationRequested();
      let frozen: FrozenAffectedKnowledgeSnapshot;
      if (state.snapshotId === undefined) {
        frozen = options.store.freezeAffectedSnapshot({ changes, changeSetHash: parsed.changeSetHash,
          recipeSelectionHash: parsed.recipeSelectionHash, maxTargets });
        state = checkpoint(context, { ...state, phase: "AFFECTED_FROZEN", snapshotId: frozen.snapshotId,
          targetHash: frozen.targetHash, targetCount: frozen.targetCount }, 0.15);
      } else {
        frozen = assertSnapshot(parsed, options.store.getAffectedSnapshot(state.snapshotId), state);
      }
      while (state.processedCount < frozen.targetCount) {
        context.throwIfCancellationRequested();
        context.heartbeat();
        const page = options.store.readAffectedSnapshotPage({ snapshotId: frozen.snapshotId, limit: pageSize,
          ...(state.cursor === undefined ? {} : { after: state.cursor }) });
        if (page.items.length === 0) throw new NonRetryableJobError("REVALIDATE_AFFECTED_PAGE_INCOMPLETE");
        const available: Array<{ readonly target: AffectedKnowledgeVersion; readonly record: KnowledgeFreshnessRecord }> = [];
        for (const target of page.items) {
          const record = options.store.get(target.assetId, target.assetVersion);
          const current = options.store.getState(target.assetId, target.assetVersion);
          if (current === undefined) throw new NonRetryableJobError("REVALIDATE_FRESHNESS_STATE_MISSING");
          const recipe = record === undefined ? undefined : recipes.resolve(record);
          if (record === undefined || recipe === undefined) {
            options.store.transitionWithEffect(context.effectKey(`recipe-missing:${target.assetId}:${target.assetVersion}:${frozen.targetHash}`), {
              assetId: target.assetId, assetVersion: target.assetVersion, expectedRevision: current.revision,
              projectId: parsed.projectId, status: "UNKNOWN", codeRevision: parsed.sourceRef,
              reasonCodes: ["RECIPE_MISSING"],
              affectedAssertionIds: record === undefined ? [] : selectAffectedAssertionIds(record, changes),
              updatedAt: changes.observedAt,
            });
          } else {
            available.push({ target, record: recipe === record.candidate ? record : Object.freeze({ ...record, candidate: recipe }) });
          }
        }
        if (available.length > 0) {
          const byId = new Map(available.map((item) => [item.target.assetId, item.record]));
          const targetById = new Map(available.map((item) => [item.target.assetId, item.target]));
          const adapter: FreshnessWorkerStorePort = {
            affected: () => ({ items: Object.freeze(available.map((item) => item.target)), bounded: false }),
            get: (assetId) => byId.get(assetId),
            getState: (assetId, version) => options.store.getState(assetId, version),
            transition: (input) => {
              const target = targetById.get(input.assetId);
              if (target === undefined || target.assetVersion !== input.assetVersion) throw new Error("REVALIDATE_TARGET_UNREQUESTED");
              return options.store.transitionWithEffect(context.effectKey(
                `freshness:${target.assetId}:${target.assetVersion}:${frozen.targetHash}`), input);
            },
          };
          const result = await new KnowledgeFreshnessWorker(adapter, options.verifier)
            .run(changes, available.length, context.signal);
          if (result.affectedCount !== available.length) throw new NonRetryableJobError("REVALIDATE_RESULT_CARDINALITY_INVALID");
          for (const item of result.items.filter((entry) => entry.state.status === "CONFLICT")) {
            context.throwIfCancellationRequested();
            try {
              options.onConflict?.({ projectId: parsed.projectId, assetId: item.assetId, assetVersion: item.assetVersion,
                verificationRunId: item.verificationRunId, observedAt: item.state.updatedAt,
                reasonCodes: item.state.reasonCodes });
            } catch { /* Alert observation is best-effort and cannot change the durable Freshness result. */ }
            options.repairJobs?.enqueue({ schemaVersion: 1, jobType: "KNOWLEDGE_REPAIR_DRAFT", projectId: parsed.projectId,
              assetId: item.assetId, assetVersion: item.assetVersion, conflictRunId: item.verificationRunId });
          }
        }
        const cursor = page.items.at(-1)!;
        const processedCount = state.processedCount + page.items.length;
        if (processedCount > frozen.targetCount) throw new NonRetryableJobError("REVALIDATE_RESULT_CARDINALITY_INVALID");
        state = checkpoint(context, { ...state, phase: "PAGE_COMMITTED", processedCount, cursor },
          0.15 + (frozen.targetCount === 0 ? 0.7 : 0.7 * processedCount / frozen.targetCount));
      }
      state = checkpoint(context, { ...state, phase: "VERIFICATION_COMPLETE" }, 0.9);
      context.throwIfCancellationRequested();
      const acknowledgementEffectKey = context.effectKey(`baseline:${observation.observationHash}`);
      options.source.acknowledgeSource(parsed.projectId, parsed.sourceRef, acknowledgementEffectKey, parsed.changeSetHash);
      checkpoint(context, { ...state, phase: "BASELINE_ACKNOWLEDGED", acknowledgementEffectKey }, 1);
    } catch (error) { classify(error); }
  };
}
