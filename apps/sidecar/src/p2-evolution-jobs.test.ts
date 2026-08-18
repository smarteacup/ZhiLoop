import { describe, expect, it, vi } from "vitest";

import { knowledgeCompilationPipelineHash, type KnowledgeCompilationPipelineIdentity } from "@zhiloop/knowledge-compilation-scheduler";
import type { SessionExtractionService } from "@zhiloop/session-extraction";

import { P2DurableKnowledgeCompilationPort } from "./p2-evolution-jobs.js";
import type { P2CandidatePreviewPort } from "./p2-preview-coordinator.js";

const pipeline: KnowledgeCompilationPipelineIdentity = {
  compilerVersion: "compiler-v1", promptVersion: "prompt-v1", policyHash: "policy", configurationHash: "configuration",
};
const snapshot = { snapshotId: "snapshot-1", sessionId: "session-1", sourceSequence: { from: 1, to: 5 } };
const input = { schemaVersion: 1 as const, jobType: "KNOWLEDGE_COMPILE" as const, sessionId: "session-1",
  sourceRange: { from: 1, to: 5 }, pipelineHash: knowledgeCompilationPipelineHash(pipeline) };

function runtime() {
  return {
    service: () => ({ getSnapshot: () => snapshot,
      listSnapshots: () => ({ items: [snapshot] }) }) as unknown as SessionExtractionService,
    candidatePreviewJobForSnapshot: () => ({ jobId: "job-1" }),
  };
}

function portWith(result: Awaited<ReturnType<P2CandidatePreviewPort["coordinate"]>>,
  overrides: { readonly snapshot?: typeof snapshot | null; readonly previewJobId?: string } = {}) {
  const selectedSnapshot = "snapshot" in overrides ? overrides.snapshot ?? undefined : snapshot;
  return new P2DurableKnowledgeCompilationPort({ pipelineIdentity: () => pipeline,
    plan: async () => ({ status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" }),
    coordinate: async () => result }, {
    service: () => ({
      getSnapshot: () => selectedSnapshot,
      listSnapshots: () => ({ items: selectedSnapshot === undefined ? [] : [selectedSnapshot] }),
    }) as unknown as SessionExtractionService,
    candidatePreviewJobForSnapshot: () => overrides.previewJobId === undefined ? undefined : { jobId: overrides.previewJobId },
  });
}

describe("P2DurableKnowledgeCompilationPort", () => {
  it("reuses the shared Snapshot/Candidate Preview coordinator with a stable effect identity", async () => {
    const coordinate = vi.fn(async () => ({ status: "ENQUEUED" as const, snapshotId: "snapshot-1", jobId: "job-1",
      compiledThroughSequence: 5 }));
    const port = new P2DurableKnowledgeCompilationPort({ pipelineIdentity: () => pipeline,
      plan: async () => ({ status: "READY", sourceRange: { from: 1, to: 5 }, compiledThroughSequence: 5 }), coordinate }, runtime());
    await expect(port.startOrResume(input, { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .resolves.toEqual({ snapshotId: "snapshot-1", previewJobId: "job-1" });
    expect(coordinate).toHaveBeenCalledWith({ sessionId: "session-1", expectedLedgerSequence: 5,
      requestId: `evolution-${"a".repeat(64)}` });
  });

  it("resolves CURRENT to the existing durable preview job and rejects range drift", async () => {
    const current = new P2DurableKnowledgeCompilationPort({ pipelineIdentity: () => pipeline,
      plan: async () => ({ status: "CURRENT", compiledThroughSequence: 5 }),
      coordinate: async () => ({ status: "CURRENT", compiledThroughSequence: 5 }) }, runtime());
    await expect(current.startOrResume(input, { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .resolves.toEqual({ snapshotId: "snapshot-1", previewJobId: "job-1" });
    await expect(current.startOrResume({ ...input, sourceRange: { from: 2, to: 5 } }, {
      effectKey: "a".repeat(64), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_SOURCE_RANGE_MISMATCH" });
  });

  it("classifies cancellation, pipeline drift, stale and ineligible outcomes", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(portWith({ status: "CURRENT", compiledThroughSequence: 5 }, { snapshot: null }).startOrResume(input,
      { effectKey: "a".repeat(64), signal: aborted.signal })).rejects.toThrow("cancelled");

    const mismatch = new P2DurableKnowledgeCompilationPort({ pipelineIdentity: () => ({ ...pipeline, compilerVersion: "v2" }),
      plan: async () => ({ status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" }),
      coordinate: async () => ({ status: "CURRENT", compiledThroughSequence: 5 }) }, runtime());
    await expect(mismatch.startOrResume(input, { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_PIPELINE_MISMATCH" });
    await expect(portWith({ status: "STALE", reasonCode: "LEDGER_CHANGED" }).startOrResume(input,
      { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_LEDGER_CHANGED" });
    await expect(portWith({ status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" }).startOrResume(input,
      { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_NO_EXTRACTABLE_EVENTS" });
  });

  it("retries when durable projections have not become visible", async () => {
    await expect(portWith({ status: "CURRENT", compiledThroughSequence: 5 }, { snapshot: null }).startOrResume(input,
      { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_SNAPSHOT_NOT_VISIBLE" });
    await expect(portWith({ status: "CURRENT", compiledThroughSequence: 5 }, { snapshot }).startOrResume(input,
      { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_PREVIEW_JOB_NOT_VISIBLE" });
    await expect(portWith({ status: "ENQUEUED", snapshotId: "snapshot-1", jobId: "job-created",
      compiledThroughSequence: 5 }, { snapshot }).startOrResume(input,
      { effectKey: "a".repeat(64), signal: new AbortController().signal }))
      .resolves.toEqual({ snapshotId: "snapshot-1", previewJobId: "job-created" });
  });
});
