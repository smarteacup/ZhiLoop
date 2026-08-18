import { knowledgeCompilationPipelineHash } from "@zhiloop/knowledge-compilation-scheduler";
import type { DurableKnowledgeCompilationPort } from "@zhiloop/knowledge-evolution-jobs";
import { NonRetryableJobError, RetryableJobError } from "@zhiloop/job-runtime";

import type { P2CandidatePreviewPort } from "./p2-preview-coordinator.js";
import type { P2SidecarRuntime } from "./p2-runtime.js";

export class P2DurableKnowledgeCompilationPort implements DurableKnowledgeCompilationPort {
  constructor(
    private readonly coordinator: P2CandidatePreviewPort,
    private readonly runtime: {
      service(): Pick<ReturnType<P2SidecarRuntime["service"]>, "listSnapshots" | "getSnapshot">;
      candidatePreviewJobForSnapshot(snapshotId: string): { readonly jobId: string } | undefined;
    },
  ) {}

  async startOrResume(
    input: Parameters<DurableKnowledgeCompilationPort["startOrResume"]>[0],
    controls: Parameters<DurableKnowledgeCompilationPort["startOrResume"]>[1],
  ) {
    if (controls.signal.aborted) {
      throw controls.signal.reason instanceof Error ? controls.signal.reason : new Error("KNOWLEDGE_COMPILE_ABORTED");
    }
    if (knowledgeCompilationPipelineHash(this.coordinator.pipelineIdentity()) !== input.pipelineHash) {
      throw new NonRetryableJobError("KNOWLEDGE_COMPILE_PIPELINE_MISMATCH");
    }
    const result = await this.coordinator.coordinate({
      sessionId: input.sessionId,
      expectedLedgerSequence: input.sourceRange.to,
      requestId: `evolution-${controls.effectKey}`,
    });
    if (result.status === "STALE") throw new RetryableJobError(`KNOWLEDGE_COMPILE_${result.reasonCode}`);
    if (result.status === "INELIGIBLE") throw new NonRetryableJobError(`KNOWLEDGE_COMPILE_${result.reasonCode}`);
    const snapshotId = result.status === "CURRENT"
      ? this.runtime.service().listSnapshots({ sessionId: input.sessionId, limit: 1 }).items[0]?.snapshotId
      : result.snapshotId;
    if (snapshotId === undefined) throw new RetryableJobError("KNOWLEDGE_COMPILE_SNAPSHOT_NOT_VISIBLE");
    const snapshot = this.runtime.service().getSnapshot(snapshotId);
    if (snapshot === undefined || snapshot.sessionId !== input.sessionId || snapshot.sourceSequence.from !== input.sourceRange.from
      || snapshot.sourceSequence.to !== input.sourceRange.to) {
      throw new NonRetryableJobError("KNOWLEDGE_COMPILE_SOURCE_RANGE_MISMATCH");
    }
    const previewJobId = result.status === "CURRENT"
      ? this.runtime.candidatePreviewJobForSnapshot(snapshotId)?.jobId
      : result.jobId;
    if (previewJobId === undefined) throw new RetryableJobError("KNOWLEDGE_COMPILE_PREVIEW_JOB_NOT_VISIBLE");
    return Object.freeze({ snapshotId, previewJobId });
  }
}
