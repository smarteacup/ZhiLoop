import { describe, expect, it } from "vitest";

import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

import { KnowledgeFreshnessScheduler, type FreshnessSchedulerTimerPort } from "./scheduler.js";

const change = (paths: readonly string[], sourceRef = "revision-1"): KnowledgeChangeSet => ({
  projectId: "project-a", changedPaths: paths, changedSymbols: [], changedConfigs: [], changedDependencies: [],
  sourceRef, observedAt: "2026-08-19T00:00:00.000Z",
});

const configuration = { enabled: true, changeDebounceMs: 100, fallbackScanIntervalMs: 10_000, maxAffectedPerJob: 500 } as const;

describe("KnowledgeFreshnessScheduler", () => {
  it("rejects unsafe configuration and ChangeSet inputs before queue mutation", async () => {
    const worker = { run: async (changes: KnowledgeChangeSet) => ({ projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: false, affectedCount: 0, items: [] }) };
    expect(() => new KnowledgeFreshnessScheduler(worker, { ...configuration, changeDebounceMs: 99 })).toThrow("changeDebounceMs");
    expect(() => new KnowledgeFreshnessScheduler(worker, { ...configuration, maxAffectedPerJob: 0 })).toThrow("maxAffectedPerJob");
    const scheduler = new KnowledgeFreshnessScheduler(worker, configuration);
    expect(() => scheduler.submit({ ...change(["../unsafe"]), projectId: "" })).toThrow("IDENTITY_INVALID");
    expect(() => scheduler.submit({ ...change(["a.ts"]), sourceRef: "bad\nref" })).toThrow("IDENTITY_INVALID");
    expect(() => scheduler.submit({ ...change(["a.ts"]), observedAt: "not-a-time" })).toThrow("IDENTITY_INVALID");
    expect(() => scheduler.submit(change(["../unsafe"]))).toThrow("CONTENT_INVALID");
    expect(() => scheduler.submit(change(["/absolute.ts"]))).toThrow("CONTENT_INVALID");
    expect(() => scheduler.submit(change(["bad\\path.ts"]))).toThrow("CONTENT_INVALID");
    expect(() => scheduler.submit(change(["bad//path.ts"]))).toThrow("CONTENT_INVALID");
    expect(() => scheduler.submit({ ...change(["a.ts"]), changedSymbols: ["bad\nsymbol"] })).toThrow("CONTENT_INVALID");
    expect(() => scheduler.submit({ ...change(["a.ts"]), changedSymbols: ["symbol", "symbol"] })).toThrow("BOUNDS_INVALID");
    await scheduler.close();
    expect(() => scheduler.submit(change(["a.ts"]))).toThrow("closed");
  });

  it("merges debounced work and never overlaps Worker runs", async () => {
    const calls: KnowledgeChangeSet[] = [];
    const worker = { run: async (changes: KnowledgeChangeSet) => {
      calls.push(changes);
      return { projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: false, affectedCount: 0, items: [] };
    } };
    const scheduler = new KnowledgeFreshnessScheduler(worker, configuration);
    expect(scheduler.submit(change(["a.ts"]))).toBe("QUEUED");
    expect(scheduler.submit(change(["b.ts"], "revision-2"))).toBe("MERGED");
    await scheduler.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sourceRef: "revision-2", changedPaths: ["a.ts", "b.ts"] });
    expect(scheduler.state()).toMatchObject({ completedRuns: 1, pendingProjects: 0, running: false });
    await scheduler.close();
  });

  it("requeues failed work and restores prior configuration on rollback", async () => {
    let fail = true;
    const worker = { run: async (changes: KnowledgeChangeSet) => {
      if (fail) throw new Error("offline");
      return { projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: false, affectedCount: 0, items: [] };
    } };
    const scheduler = new KnowledgeFreshnessScheduler(worker, configuration);
    scheduler.start();
    scheduler.submit(change(["a.ts"]));
    await scheduler.flush();
    expect(scheduler.state()).toMatchObject({ status: "DEGRADED", failedRuns: 1, pendingProjects: 1 });
    const rollback = await scheduler.applyConfiguration({ ...configuration, enabled: false });
    expect(scheduler.state().status).toBe("DISABLED");
    await rollback();
    await rollback();
    fail = false;
    scheduler.submit(change(["b.ts"], "revision-2"));
    await scheduler.flush();
    expect(scheduler.state()).toMatchObject({ completedRuns: 1, status: "READY" });
    await scheduler.close();
    await scheduler.close();
  });

  it("uses completion-based timer scheduling", async () => {
    const scheduled: Array<() => void> = [];
    const timer: FreshnessSchedulerTimerPort = { schedule: (_delay, task) => { scheduled.push(task); return { cancel: () => undefined }; } };
    const scheduler = new KnowledgeFreshnessScheduler({ run: async (changes) => ({ projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: false, affectedCount: 0, items: [] }) }, configuration, { timer });
    expect(scheduler.start()).toBe(true);
    expect(scheduled).toHaveLength(1);
    await scheduler.stop();
    await scheduler.close();
  });

  it("keeps bounded batches pending and acknowledges only after the final batch", async () => {
    const acknowledgements: KnowledgeChangeSet[] = [];
    const results: string[] = [];
    let calls = 0;
    const source = {
      scan: async () => [change(["a.ts"])],
      acknowledge: (changes: KnowledgeChangeSet) => { acknowledgements.push(changes); },
    };
    const scheduler = new KnowledgeFreshnessScheduler({ run: async (changes) => ({
      projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: calls++ === 0, affectedCount: 1, items: [],
    }) }, configuration, { source, onResult: (result) => results.push(result.codeRevision) });
    await scheduler.flush();
    expect(acknowledgements).toHaveLength(0);
    expect(results).toEqual(["revision-1"]);
    expect(scheduler.state()).toMatchObject({ lastReasonCode: "AFFECTED_KNOWLEDGE_BATCH_PENDING", completedRuns: 1, pendingProjects: 1 });
    await scheduler.flush();
    expect(acknowledgements).toHaveLength(1);
    expect(results).toEqual(["revision-1", "revision-1"]);
    expect(scheduler.state()).toMatchObject({ lastReasonCode: "FRESHNESS_REVALIDATED", completedRuns: 2, pendingProjects: 0 });
    expect(scheduler.submit(change(["a.ts"]))).toBe("DUPLICATE");
    await scheduler.close();
  });

  it("isolates source failure, reports degradation and supports disabled startup", async () => {
    const errors: unknown[] = [];
    const scheduler = new KnowledgeFreshnessScheduler({ run: async (changes) => ({
      projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: false, affectedCount: 0, items: [],
    }) }, configuration, { source: { scan: async () => { throw new Error("git offline"); } }, onError: (error) => errors.push(error) });
    expect(scheduler.start()).toBe(true);
    expect(scheduler.start()).toBe(false);
    await scheduler.flush();
    expect(errors).toHaveLength(1);
    expect(scheduler.state()).toMatchObject({ status: "DEGRADED", failedRuns: 1, lastReasonCode: "FRESHNESS_CHANGE_SOURCE_FAILED" });
    expect(await scheduler.stop()).toBe(true);
    expect(await scheduler.stop()).toBe(false);
    await scheduler.close();

    const disabled = new KnowledgeFreshnessScheduler({ run: async (changes) => ({
      projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: false, affectedCount: 0, items: [],
    }) }, { ...configuration, enabled: false });
    expect(disabled.start()).toBe(true);
    expect(disabled.submit(change(["a.ts"]))).toBe("DUPLICATE");
    const enable = await disabled.applyConfiguration(configuration);
    expect(disabled.state().status).toBe("READY");
    await enable();
    expect(disabled.state().status).toBe("DISABLED");
    await disabled.close();
  });

  it("bounds the number of independently pending projects", async () => {
    const scheduler = new KnowledgeFreshnessScheduler({ run: async (changes) => ({
      projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: false, affectedCount: 0, items: [],
    }) }, configuration);
    for (let index = 0; index < 100; index += 1) scheduler.submit({ ...change([`p${index}.ts`]), projectId: `project-${index}` });
    expect(() => scheduler.submit({ ...change(["overflow.ts"]), projectId: "project-overflow" })).toThrow("LIMIT_EXCEEDED");
    await scheduler.flush();
    expect(scheduler.state()).toMatchObject({ completedRuns: 100, pendingProjects: 0 });
    await scheduler.close();
  });
});
