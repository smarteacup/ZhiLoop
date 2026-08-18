import { describe, expect, it } from "vitest";

import type { JobExecutionContext } from "@zhiloop/job-runtime";

import { createKnowledgeCompileHandler } from "./compile.js";

function context(checkpoint?: unknown): { readonly value: JobExecutionContext; readonly writes: unknown[] } {
  const writes: unknown[] = [];
  let current = checkpoint === undefined ? undefined : { schemaVersion: 1 as const, revision: 1, progress: 0.1,
    updatedAt: "2026-08-19T00:00:00.000Z", payloadHash: "a".repeat(64), data: checkpoint as never };
  const value = {
    jobId: "job-1", jobType: "KNOWLEDGE_COMPILE", attemptId: "attempt-1", attempt: 1, fencingToken: 1,
    idempotencyKey: "compile-key", input: { schemaVersion: 1, jobType: "KNOWLEDGE_COMPILE", sessionId: "session-1",
      sourceRange: { from: 1, to: 5 }, pipelineHash: "a".repeat(64) }, signal: new AbortController().signal,
    getCheckpoint: () => current,
    saveCheckpoint: (data: unknown, progress: number) => {
      writes.push(data); current = { schemaVersion: 1, revision: (current?.revision ?? 0) + 1, progress,
        updatedAt: "2026-08-19T00:00:00.000Z", payloadHash: "a".repeat(64), data: data as never }; return current;
    },
    heartbeat: () => ({ leaseExpiresAt: "2026-08-19T00:01:00.000Z", cancellationRequested: false }),
    isCancellationRequested: () => false, throwIfCancellationRequested: () => undefined,
    effectKey: () => "b".repeat(64),
  } satisfies JobExecutionContext;
  return { value, writes };
}

describe("KNOWLEDGE_COMPILE durable outer handler", () => {
  it("reuses one stable dispatch effect and persists the inner snapshot/preview references", async () => {
    const effects: string[] = [];
    const handler = createKnowledgeCompileHandler({ startOrResume: async (_input, controls) => {
      effects.push(controls.effectKey); return { snapshotId: "snapshot-1", previewJobId: "preview-1" };
    } });
    const first = context();
    await handler(first.value);
    expect(effects).toEqual(["b".repeat(64)]);
    expect(first.writes).toEqual([{ schemaVersion: 1, phase: "COMPILE_DISPATCHING" },
      { schemaVersion: 1, phase: "COMPILE_DISPATCHED", snapshotId: "snapshot-1", previewJobId: "preview-1" }]);
    const replay = context(first.writes.at(-1));
    await handler(replay.value);
    expect(effects).toHaveLength(1);
    expect(replay.writes).toEqual([]);
  });

  it("retries a lost dispatch response without creating duplicate inner work", async () => {
    const innerEffects = new Set<string>();
    let first = true;
    const handler = createKnowledgeCompileHandler({ startOrResume: async (_input, controls) => {
      innerEffects.add(controls.effectKey);
      if (first) { first = false; throw new Error("RESPONSE_LOST"); }
      return { snapshotId: "snapshot-1", previewJobId: "preview-1" };
    } });
    const initial = context();
    await expect(handler(initial.value)).rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_DISPATCH_FAILED" });
    const retry = context(initial.writes.at(-1));
    await handler(retry.value);
    expect(innerEffects.size).toBe(1);
    expect(retry.writes.at(-1)).toEqual({ schemaVersion: 1, phase: "COMPILE_DISPATCHED",
      snapshotId: "snapshot-1", previewJobId: "preview-1" });
  });

  it("rejects checkpoint shape drift and preserves terminal result failures", async () => {
    const handler = createKnowledgeCompileHandler({ startOrResume: async () => ({ snapshotId: "", previewJobId: "preview-1" }) });
    await expect(handler(context({ schemaVersion: 1, phase: "UNKNOWN" }).value))
      .rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_CHECKPOINT_CORRUPT" });
    await expect(handler(context().value)).rejects.toMatchObject({ code: "KNOWLEDGE_COMPILE_RESULT_INVALID" });
  });
});
