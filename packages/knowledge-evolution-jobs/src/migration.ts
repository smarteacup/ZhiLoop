import { parseEvolutionJobInput } from "@zhiloop/evolution-job-runtime";
import { JobCancellationRequestedError, JobLeaseLostError, NonRetryableJobError, RetryableJobError,
  type JobExecutionContext, type JobHandler } from "@zhiloop/job-runtime";
import type { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import { LEGACY_RECIPE_VERSION } from "@zhiloop/knowledge-legacy-migration";
import type { LegacyKnowledgeMigrationService, SqliteLegacyKnowledgeMigrationStore } from
  "@zhiloop/knowledge-legacy-migration";
import type { KnowledgeVerificationBatch, KnowledgeVerificationRequest, SqliteKnowledgeVerificationStore,
  VerificationExecutionControls } from "@zhiloop/knowledge-verification";

type Phase = "PREVIEW_VALIDATED" | "PAGE_COMMITTED" | "COMPLETED";
interface MigrationCheckpoint {
  readonly schemaVersion: 1;
  readonly phase: Phase;
  readonly migrationId: string;
  readonly summaryHash: string;
  readonly processedCount: number;
  readonly cursor?: number;
}

export interface LegacyMigrationVerificationPort {
  verifyBatch(request: KnowledgeVerificationRequest, controls?: VerificationExecutionControls): Promise<KnowledgeVerificationBatch>;
}

export interface LegacyKnowledgeMigrationHandlerOptions {
  readonly store: Pick<SqliteLegacyKnowledgeMigrationStore, "get" | "items" | "recordItem" | "transition">;
  readonly service: LegacyKnowledgeMigrationService;
  readonly registryRevision: () => number;
  readonly recipes: Pick<SqliteKnowledgeVerificationStore, "saveRecipeForMigration">;
  readonly freshness: Pick<SqliteKnowledgeFreshnessStore, "projectForMigration">;
  readonly verifier: LegacyMigrationVerificationPort;
  readonly project: (projectId: string) => KnowledgeVerificationRequest["project"] | undefined;
  readonly pageSize?: number;
}

function checkpoint(context: JobExecutionContext, value: MigrationCheckpoint, progress: number): MigrationCheckpoint {
  context.saveCheckpoint(value as unknown as Record<string, unknown>, progress); return value;
}

function parseCheckpoint(context: JobExecutionContext, migrationId: string, summaryHash: string): MigrationCheckpoint | undefined {
  const raw = context.getCheckpoint()?.data; if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new NonRetryableJobError("MIGRATION_CHECKPOINT_CORRUPT");
  const value = raw as unknown as MigrationCheckpoint; const keys = Object.keys(raw);
  if (value.schemaVersion !== 1 || !new Set<Phase>(["PREVIEW_VALIDATED", "PAGE_COMMITTED", "COMPLETED"]).has(value.phase)
    || value.migrationId !== migrationId || value.summaryHash !== summaryHash
    || keys.some((key) => !["schemaVersion", "phase", "migrationId", "summaryHash", "processedCount", "cursor"].includes(key))
    || !Number.isSafeInteger(value.processedCount) || value.processedCount < 0
    || (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0))) {
    throw new NonRetryableJobError("MIGRATION_CHECKPOINT_CORRUPT");
  }
  return value;
}

function resultState(batch: KnowledgeVerificationBatch): { readonly status: "FRESH" | "CONFLICT" | "UNKNOWN";
  readonly reasons: readonly string[] } {
  const status = batch.results.some((item) => item.status === "REFUTED") ? "CONFLICT"
    : batch.results.some((item) => item.status === "UNKNOWN" || item.status === "ERROR") ? "UNKNOWN" : "FRESH";
  return Object.freeze({ status, reasons: Object.freeze([...new Set([
    status === "FRESH" ? "MIGRATION_VERIFIED" : status === "CONFLICT" ? "MIGRATION_CONFLICT" : "MIGRATION_VERIFICATION_UNKNOWN",
    ...batch.results.flatMap((item) => item.reasonCodes),
  ])].filter((reason) => /^[A-Z][A-Z0-9_]{0,119}$/u.test(reason)).sort().slice(0, 32)) });
}

function classify(error: unknown): never {
  if (error instanceof NonRetryableJobError || error instanceof RetryableJobError
    || error instanceof JobCancellationRequestedError || error instanceof JobLeaseLostError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/^(?:LEGACY_MIGRATION|FRESHNESS_MIGRATION|VERIFICATION_RECIPE)_[A-Z0-9_]+$/u.test(message)) {
    throw new NonRetryableJobError(message);
  }
  if (/(?:CORRUPT|INVALID|MISMATCH|CONFLICT|DRIFT|NOT_FOUND|INCOMPLETE|LIMIT_EXCEEDED)/u.test(message)) {
    throw new NonRetryableJobError("LEGACY_MIGRATION_INVARIANT_FAILED");
  }
  throw new RetryableJobError("LEGACY_MIGRATION_TRANSIENT_FAILURE");
}

export function createLegacyKnowledgeMigrationHandler(options: LegacyKnowledgeMigrationHandlerOptions): JobHandler {
  const pageSize = options.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) throw new Error("LEGACY_MIGRATION_HANDLER_OPTIONS_INVALID");
  return async (context): Promise<void> => {
    try {
      const input = parseEvolutionJobInput(context.input);
      if (input.jobType !== "LEGACY_KNOWLEDGE_MIGRATION") throw new NonRetryableJobError("LEGACY_MIGRATION_JOB_INPUT_INVALID");
      const preview = options.store.get(input.migrationId);
      if (preview === undefined || preview.projectId !== input.projectId || preview.migrationVersion !== input.migrationVersion
        || (preview.status !== "COMMITTING" && preview.status !== "COMPLETED")) {
        throw new NonRetryableJobError("LEGACY_MIGRATION_PREVIEW_MISMATCH");
      }
      let state = parseCheckpoint(context, preview.migrationId, preview.summaryHash);
      if (preview.status === "COMPLETED") {
        if (preview.revision !== input.previewRevision + 1 || state === undefined
          || state.processedCount !== preview.scannedCount) {
          throw new NonRetryableJobError("LEGACY_MIGRATION_PREVIEW_MISMATCH");
        }
        checkpoint(context, { ...state, phase: "COMPLETED" }, 1);
        return;
      }
      if (preview.revision !== input.previewRevision) throw new NonRetryableJobError("LEGACY_MIGRATION_PREVIEW_MISMATCH");
      const project = options.project(input.projectId);
      if (project === undefined || project.projectId !== input.projectId) throw new NonRetryableJobError("LEGACY_MIGRATION_PROJECT_UNAVAILABLE");
      if (state === undefined) {
        if (options.registryRevision() !== preview.sourceRegistryRevision) {
          throw new NonRetryableJobError("LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT");
        }
        state = checkpoint(context, { schemaVersion: 1, phase: "PREVIEW_VALIDATED", migrationId: preview.migrationId,
          summaryHash: preview.summaryHash, processedCount: 0 }, preview.scannedCount === 0 ? 0.9 : 0.05);
      }
      while (state.processedCount < preview.scannedCount) {
        context.throwIfCancellationRequested();
        const page = options.store.items({ migrationId: preview.migrationId, limit: pageSize,
          ...(state.cursor === undefined ? {} : { afterOrdinal: state.cursor }) });
        if (page.items.length === 0) throw new NonRetryableJobError("LEGACY_MIGRATION_PAGE_INCOMPLETE");
        for (const item of page.items) {
          context.throwIfCancellationRequested(); context.heartbeat();
          if (item.classification === "MIGRATABLE" && item.status === "PENDING") {
            const resolution = options.service.resolve(preview.migrationId, item.ordinal);
            if (resolution === undefined || resolution.candidate.assertions.length < 1) {
              throw new NonRetryableJobError("LEGACY_MIGRATION_SOURCE_MISSING");
            }
            const batch = await options.verifier.verifyBatch({ candidate: resolution.candidate, project,
              requestedAt: preview.createdAt, purpose: "FRESHNESS",
              knowledgeVersion: { assetId: item.assetId, assetVersion: item.assetVersion } }, { signal: context.signal });
            const expected = new Set(resolution.candidate.assertions.map((assertion) => assertion.assertionId));
            if (batch.projectId !== input.projectId || batch.results.length !== expected.size
              || batch.results.some((result) => !expected.has(result.assertionId))) {
              throw new NonRetryableJobError("LEGACY_MIGRATION_VERIFICATION_MISMATCH");
            }
            const classified = resultState(batch);
            context.heartbeat();
            const recipe = options.recipes.saveRecipeForMigration(preview.migrationId, { assetId: item.assetId,
              assetVersion: item.assetVersion, recipeVersion: LEGACY_RECIPE_VERSION,
              assertions: resolution.candidate.assertions, createdAt: preview.createdAt });
            context.heartbeat();
            const projected = options.service.ports.registry.getAsset(item.assetId);
            if (projected === undefined || projected.asset.version !== item.assetVersion
              || projected.asset.contentHash !== item.assetContentHash) throw new NonRetryableJobError("LEGACY_MIGRATION_TARGET_DRIFT");
            const freshness = options.freshness.projectForMigration({ asset: projected.asset, candidate: resolution.candidate,
              verificationResults: batch.results, projectId: input.projectId, observedAt: batch.observedAt,
              migrationId: preview.migrationId, status: classified.status, codeRevision: batch.codeRevision,
              ...(batch.graphRevision === undefined ? {} : { graphRevision: batch.graphRevision }), verificationRunId: batch.runId,
              reasonCodes: classified.reasons });
            options.store.recordItem({ migrationId: preview.migrationId, ordinal: item.ordinal,
              effectKey: context.effectKey(`migration-item:${item.ordinal}:${preview.summaryHash}`), status: "MIGRATED",
              updatedAt: batch.observedAt, verificationRunId: batch.runId, freshnessStatus: classified.status,
              createdRecipe: recipe.status === "CREATED", createdFreshness: freshness.status === "PROJECTED",
              reasonCodes: classified.reasons });
          }
          state = checkpoint(context, { ...state, phase: "PAGE_COMMITTED", cursor: item.ordinal,
            processedCount: item.ordinal + 1 }, Math.min(0.95, (item.ordinal + 1) / Math.max(1, preview.scannedCount)));
        }
      }
      const current = options.store.get(preview.migrationId);
      if (current === undefined) throw new NonRetryableJobError("LEGACY_MIGRATION_PREVIEW_MISSING");
      options.store.transition({ migrationId: current.migrationId, expectedRevision: current.revision,
        effectKey: context.effectKey(`migration-complete:${preview.summaryHash}`), status: "COMPLETED",
        // The immutable COMMITTING timestamp is stable across a crash after this
        // effect but before the following checkpoint write.
        updatedAt: preview.updatedAt });
      checkpoint(context, { ...state, phase: "COMPLETED" }, 1);
    } catch (error) { classify(error); }
  };
}
