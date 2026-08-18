import { parseEvolutionJobInput } from "@zhiloop/evolution-job-runtime";
import {
  JobCancellationRequestedError,
  JobLeaseLostError,
  NonRetryableJobError,
  RetryableJobError,
  type JobExecutionContext,
  type JobHandler,
} from "@zhiloop/job-runtime";
import type { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import type { KnowledgeRepairDraftStore, RepairChangedAssertion } from "@zhiloop/knowledge-repair-drafts";
import type { KnowledgeVerificationStore, VerificationResultSummary } from "@zhiloop/knowledge-verification";

interface RepairCheckpoint {
  readonly schemaVersion: 1;
  readonly phase: "DRAFT_PERSISTED";
  readonly draftId: string;
  readonly conflictRunId: string;
}

export interface KnowledgeRepairDraftHandlerOptions {
  readonly freshness: Pick<SqliteKnowledgeFreshnessStore, "get" | "getState">;
  readonly verification: Pick<KnowledgeVerificationStore, "getRun">;
  readonly drafts: KnowledgeRepairDraftStore;
}

function parseCheckpoint(context: JobExecutionContext, conflictRunId: string): RepairCheckpoint | undefined {
  const data = context.getCheckpoint()?.data;
  if (data === undefined) return undefined;
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new NonRetryableJobError("REPAIR_CHECKPOINT_CORRUPT");
  const value = data as unknown as RepairCheckpoint;
  if (Object.keys(data).sort().join(",") !== "conflictRunId,draftId,phase,schemaVersion"
    || value.schemaVersion !== 1 || value.phase !== "DRAFT_PERSISTED" || value.conflictRunId !== conflictRunId
    || !/^repair_[a-f0-9]{64}$/u.test(value.draftId)) throw new NonRetryableJobError("REPAIR_CHECKPOINT_CORRUPT");
  return value;
}

function changedAssertion(result: VerificationResultSummary): RepairChangedAssertion {
  return Object.freeze({ assertionId: result.assertionId, assertionKind: result.assertionKind,
    verificationStatus: "UNSUPPORTED", reasonCodes: Object.freeze([...result.reasonCodes]),
    ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }) });
}

function invariant(condition: boolean, code: string): asserts condition {
  if (!condition) throw new NonRetryableJobError(code);
}

function classify(error: unknown): never {
  if (error instanceof NonRetryableJobError || error instanceof RetryableJobError
    || error instanceof JobCancellationRequestedError || error instanceof JobLeaseLostError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/(?:INVALID|CORRUPT|CONFLICT|MISMATCH|NOT_FOUND|MISSING|INCOMPLETE|LIMIT_EXCEEDED)/u.test(message)) {
    throw new NonRetryableJobError("REPAIR_INVARIANT_FAILED");
  }
  throw new RetryableJobError("REPAIR_STORE_UNAVAILABLE");
}

export function createKnowledgeRepairDraftHandler(options: KnowledgeRepairDraftHandlerOptions): JobHandler {
  return async (context): Promise<void> => {
    try {
      const input = parseEvolutionJobInput(context.input);
      if (input.jobType !== "KNOWLEDGE_REPAIR_DRAFT") throw new NonRetryableJobError("REPAIR_JOB_INPUT_INVALID");
      const checkpoint = parseCheckpoint(context, input.conflictRunId);
      if (checkpoint !== undefined) {
        const replay = options.drafts.get(checkpoint.draftId);
        invariant(replay !== undefined && replay.projectId === input.projectId
          && replay.sourceKnowledge.assetId === input.assetId && replay.sourceKnowledge.assetVersion === input.assetVersion
          && replay.conflict.runId === input.conflictRunId, "REPAIR_CHECKPOINT_DRAFT_MISMATCH");
        return;
      }
      context.throwIfCancellationRequested();
      const record = options.freshness.get(input.assetId, input.assetVersion);
      const state = options.freshness.getState(input.assetId, input.assetVersion);
      const run = options.verification.getRun(input.conflictRunId);
      invariant(record !== undefined && state !== undefined, "REPAIR_SOURCE_MISSING");
      invariant(record.projectId === input.projectId && state.projectId === input.projectId
        && record.assetId === input.assetId && record.assetVersion === input.assetVersion
        && state.assetId === input.assetId && state.assetVersion === input.assetVersion, "REPAIR_SOURCE_IDENTITY_MISMATCH");
      invariant(state.status === "CONFLICT", "REPAIR_SOURCE_NOT_CONFLICT");
      invariant(run !== undefined && run.status === "COMPLETED" && run.purpose === "FRESHNESS", "REPAIR_RUN_MISSING");
      invariant(run.projectId === input.projectId && run.candidateId === record.candidate.candidateId
        && run.knowledgeVersion?.assetId === input.assetId && run.knowledgeVersion.assetVersion === input.assetVersion,
      "REPAIR_RUN_IDENTITY_MISMATCH");
      invariant(run.codeRevision === state.codeRevision && run.graphRevision === state.graphRevision,
        "REPAIR_RUN_REVISION_MISMATCH");
      const affected = new Set(state.affectedAssertionIds);
      const byId = new Map(run.results.map((result) => [result.assertionId, result]));
      invariant(byId.size === run.results.length && state.affectedAssertionIds.length > 0, "REPAIR_ASSERTION_CARDINALITY_INVALID");
      const changed = [...affected].map((assertionId) => byId.get(assertionId))
        .filter((result): result is VerificationResultSummary => result?.status === "REFUTED")
        .map(changedAssertion).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
      invariant(changed.length > 0, "REPAIR_REFUTED_ASSERTION_MISSING");
      const sourceAssertions = new Set(record.candidate.assertions.map((assertion) => assertion.assertionId));
      invariant(changed.every((assertion) => sourceAssertions.has(assertion.assertionId)), "REPAIR_ASSERTION_IDENTITY_MISMATCH");
      const reasonCodes = [...new Set(["FRESHNESS_CONFLICT", ...state.reasonCodes,
        ...changed.flatMap((assertion) => assertion.reasonCodes)])].sort();
      context.effectKey(`repair-draft:${input.assetId}:${input.assetVersion}:${input.conflictRunId}`);
      const written = options.drafts.create({ projectId: input.projectId,
        sourceKnowledge: { assetId: record.assetId, assetVersion: record.assetVersion, contentHash: record.assetContentHash,
          lifecycleStatus: record.lifecycleStatus, candidate: record.candidate },
        conflict: { runId: run.runId, codeRevision: run.codeRevision,
          ...(run.graphRevision === undefined ? {} : { graphRevision: run.graphRevision }), completedAt: run.completedAt },
        changedAssertions: changed, reasonCodes, createdAt: run.completedAt });
      context.saveCheckpoint({ schemaVersion: 1, phase: "DRAFT_PERSISTED", draftId: written.draft.draftId,
        conflictRunId: input.conflictRunId }, 1);
    } catch (error) { classify(error); }
  };
}
