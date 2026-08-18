import { parseEvolutionJobInput, type KnowledgeCompileJobInput } from "@zhiloop/evolution-job-runtime";
import {
  JobCancellationRequestedError,
  JobLeaseLostError,
  NonRetryableJobError,
  RetryableJobError,
  type JobHandler,
} from "@zhiloop/job-runtime";

export interface DurableKnowledgeCompilationPort {
  startOrResume(input: KnowledgeCompileJobInput, controls: {
    readonly effectKey: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly snapshotId: string; readonly previewJobId: string }>;
}

export function createKnowledgeCompileHandler(port: DurableKnowledgeCompilationPort): JobHandler {
  return async (context): Promise<void> => {
    const input = parseEvolutionJobInput(context.input);
    if (input.jobType !== "KNOWLEDGE_COMPILE") throw new NonRetryableJobError("KNOWLEDGE_COMPILE_INPUT_INVALID");
    const raw = context.getCheckpoint()?.data;
    const stored = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw as { readonly schemaVersion?: unknown; readonly phase?: unknown; readonly snapshotId?: unknown; readonly previewJobId?: unknown }
      : undefined;
    if (raw !== undefined && stored === undefined) throw new NonRetryableJobError("KNOWLEDGE_COMPILE_CHECKPOINT_CORRUPT");
    if (stored?.schemaVersion === 1 && stored.phase === "COMPILE_DISPATCHED" && typeof stored.snapshotId === "string"
      && stored.snapshotId.length > 0 && typeof stored.previewJobId === "string" && stored.previewJobId.length > 0
      && Object.keys(stored).length === 4) return;
    if (stored !== undefined && !(stored.schemaVersion === 1 && stored.phase === "COMPILE_DISPATCHING"
      && Object.keys(stored).length === 2)) throw new NonRetryableJobError("KNOWLEDGE_COMPILE_CHECKPOINT_CORRUPT");
    context.throwIfCancellationRequested();
    context.saveCheckpoint({ schemaVersion: 1, phase: "COMPILE_DISPATCHING" }, 0.1);
    try {
      const result = await port.startOrResume(input, { effectKey: context.effectKey("compile-dispatch"), signal: context.signal });
      if (result.snapshotId.length < 1 || result.previewJobId.length < 1) throw new NonRetryableJobError("KNOWLEDGE_COMPILE_RESULT_INVALID");
      context.saveCheckpoint({ schemaVersion: 1, phase: "COMPILE_DISPATCHED",
        snapshotId: result.snapshotId, previewJobId: result.previewJobId }, 1);
    } catch (error) {
      if (error instanceof NonRetryableJobError || error instanceof RetryableJobError
        || error instanceof JobCancellationRequestedError || error instanceof JobLeaseLostError) throw error;
      if (context.signal.aborted && context.signal.reason instanceof Error) throw context.signal.reason;
      throw new RetryableJobError("KNOWLEDGE_COMPILE_DISPATCH_FAILED");
    }
  };
}
