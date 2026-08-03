import { describe, expect, it, vi } from "vitest";

import type { BackfillReport } from "@zhiloop/codex-backfill";
import { SessionCaptureError, type CaptureSessionReport } from "@zhiloop/codex-session-capture";
import type {
  SessionCatalogEntry,
  SessionCatalogListRequest,
  SessionCatalogListResult,
  SessionCatalogQueryPort,
} from "@zhiloop/session-catalog";

import {
  AutomaticIngestionScheduler,
  AutomaticIngestionService,
  CodexBackfillRecoveryAdapter,
  InMemoryAutomaticIngestionCheckpointStore,
  InMemorySessionRelationProjection,
  NodeSchedulerTimer,
  RealCodexIngestionAcceptanceVerifier,
  normalizeAutomaticIngestionConfiguration,
  type BackfillRecoveryPort,
  type RealCodexAcceptanceEvidence,
  type ScheduledTaskHandle,
  type SchedulerTimerPort,
  type SessionRelationObservation,
} from "./index.js";

const BASE_TIME = "2026-08-03T00:00:00.000Z";

function entry(sessionId: string, overrides: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry {
  return Object.freeze({
    schemaVersion: 1,
    sessionId,
    title: `session ${sessionId}`,
    titleSource: "SESSION_ID",
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    sourceFormatVersion: "jsonl-v1",
    safeSourceAlias: `session-${sessionId}`,
    captureStatus: "DISCOVERED_NOT_CAPTURED",
    firstActivityAt: BASE_TIME,
    lastActivityAt: BASE_TIME,
    timeGroup: "TODAY",
    eventCount: 0,
    turnCount: 0,
    ignoredRecords: 0,
    redactionCount: 0,
    ...overrides,
  });
}

class MutableCatalog implements SessionCatalogQueryPort {
  entries: SessionCatalogEntry[];
  revision = "revision-1";
  forceCursorLoop = false;

  constructor(entries: readonly SessionCatalogEntry[]) {
    this.entries = [...entries];
  }

  async list(request: SessionCatalogListRequest = {}): Promise<SessionCatalogListResult> {
    const start = request.after === undefined
      ? 0
      : Math.max(0, this.entries.findIndex((item) => item.sessionId === request.after?.sessionId) + 1);
    const limit = request.limit ?? 100;
    const items = this.entries.slice(start, start + limit);
    const last = items.at(-1);
    const hasMore = start + items.length < this.entries.length;
    return {
      items,
      ...(hasMore && last !== undefined ? {
        nextPosition: this.forceCursorLoop && request.after !== undefined
          ? request.after
          : { lastActivityAt: last.lastActivityAt, sessionId: last.sessionId },
      } : {}),
      sourceCapabilities: [],
      diagnostics: [],
      revision: this.revision,
      changed: true,
    };
  }

  async get(sessionId: string): Promise<SessionCatalogEntry | undefined> {
    return this.entries.find((item) => item.sessionId === sessionId);
  }
}

function captureReport(sessionId: string, hasMore = false): CaptureSessionReport {
  return Object.freeze({
    schemaVersion: 1,
    status: "CAPTURED",
    sessionId,
    transcriptPath: `/safe/${sessionId}.jsonl`,
    batches: 1,
    projectedEvents: 1,
    appendedEvents: 1,
    duplicateEvents: 0,
    ignoredRecords: 0,
    eventTypes: Object.freeze({ "conversation.user_message": 1 }),
    cursor: Object.freeze({ byteOffset: 100, lineNumber: 2 }),
    hasMore,
    knowledgeCompiled: false,
  });
}

function clock(initial = BASE_TIME) {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    advance(milliseconds: number) { current = new Date(current.getTime() + milliseconds); },
  };
}

describe("AutomaticIngestionService", () => {
  it("rejects zero-delay and unbounded scheduler settings", () => {
    expect(() => normalizeAutomaticIngestionConfiguration({ scanIntervalMs: 0 })).toThrow(/scanIntervalMs/u);
    expect(() => normalizeAutomaticIngestionConfiguration({ followDebounceMs: 0 })).toThrow(/followDebounceMs/u);
    expect(() => normalizeAutomaticIngestionConfiguration({ maxSessionsPerScan: 50_001 })).toThrow(/maxSessionsPerScan/u);
  });

  it("discovers incrementally, debounces follow capture, and ignores unrelated catalog revisions", async () => {
    const time = clock();
    const catalog = new MutableCatalog([entry("session-1")]);
    const checkpoints = new InMemoryAutomaticIngestionCheckpointStore();
    const capture = vi.fn(async ({ sessionId }: { sessionId: string }) => captureReport(sessionId));
    const service = new AutomaticIngestionService({ catalog, capture: { capture }, checkpoints, now: time.now }, {
      followDebounceMs: 100,
    });

    const discovered = await service.runOnce();
    expect(discovered.discoveredSessions).toBe(1);
    expect(discovered.capturedSessions).toBe(0);
    time.advance(99);
    expect((await service.runOnce()).capturedSessions).toBe(0);
    time.advance(1);
    expect((await service.runOnce()).capturedSessions).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);

    catalog.revision = "revision-caused-by-another-session";
    const unchanged = await service.runOnce();
    expect(unchanged.changedSessions).toBe(0);
    expect(capture).toHaveBeenCalledTimes(1);

    catalog.entries = [entry("session-1", { lastActivityAt: "2026-08-03T00:00:01.000Z" })];
    expect((await service.runOnce()).changedSessions).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
    time.advance(100);
    expect((await service.runOnce()).capturedSessions).toBe(1);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("bounds catalog paging and reports incomplete coverage", async () => {
    const catalog = new MutableCatalog([entry("one"), entry("two"), entry("three")]);
    const service = new AutomaticIngestionService({
      catalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
      now: clock().now,
    }, { pageSize: 1, maxScanPages: 2, maxSessionsPerScan: 10 });

    const result = await service.runOnce();
    expect(result.scannedSessions).toBe(2);
    expect(result.catalogCoverage).toBe("BOUNDED");
    expect(result.diagnostics.map((item) => item.code)).toContain("SESSION_SCAN_BOUNDED");
  });

  it("detects a catalog cursor loop without spinning", async () => {
    const catalog = new MutableCatalog([entry("one"), entry("two"), entry("three")]);
    catalog.forceCursorLoop = true;
    const service = new AutomaticIngestionService({
      catalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
      now: clock().now,
    }, { pageSize: 1 });

    const result = await service.runOnce();
    expect(result.catalogCoverage).toBe("BOUNDED");
    expect(result.diagnostics.map((item) => item.code)).toContain("CATALOG_CURSOR_LOOP");
  });

  it("enforces the per-run capture budget and continues from durable checkpoints", async () => {
    const time = clock();
    const capture = vi.fn(async ({ sessionId }: { sessionId: string }) => captureReport(sessionId));
    const checkpoints = new InMemoryAutomaticIngestionCheckpointStore();
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([entry("one"), entry("two")]), capture: { capture }, checkpoints, now: time.now,
    }, { followDebounceMs: 100, maxCapturesPerRun: 1 });

    await service.runOnce();
    time.advance(100);
    expect((await service.runOnce()).capturedSessions).toBe(1);
    expect((await service.runOnce()).capturedSessions).toBe(1);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("persists partial completeness and schedules bounded follow work", async () => {
    const time = clock();
    const checkpoints = new InMemoryAutomaticIngestionCheckpointStore();
    const capture = vi.fn()
      .mockResolvedValueOnce(captureReport("partial", true))
      .mockResolvedValueOnce(captureReport("partial", false));
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([entry("partial")]), capture: { capture }, checkpoints, now: time.now,
    }, { followDebounceMs: 100 });

    await service.runOnce();
    time.advance(100);
    await service.runOnce();
    expect((await checkpoints.load("partial"))?.status).toBe("CAPTURED_PARTIAL");
    time.advance(100);
    await service.runOnce();
    expect((await checkpoints.load("partial"))?.status).toBe("CAPTURED_CURRENT");
  });

  it("records source unavailability and retries ordinary capture failures later", async () => {
    const time = clock();
    const catalog = new MutableCatalog([
      entry("unavailable", { sourceStatus: "UNAVAILABLE", captureStatus: "SOURCE_UNAVAILABLE" }),
      entry("retry"),
    ]);
    const checkpoints = new InMemoryAutomaticIngestionCheckpointStore();
    const capture = vi.fn(async () => { throw new Error("temporary capture failure"); });
    const service = new AutomaticIngestionService({ catalog, capture: { capture }, checkpoints, now: time.now }, {
      followDebounceMs: 100,
      retryDelayMs: 1_000,
    });
    await service.runOnce();
    expect((await checkpoints.load("unavailable"))?.status).toBe("SOURCE_UNAVAILABLE");
    time.advance(100);
    const failed = await service.runOnce();
    expect(failed.diagnostics.map((item) => item.code)).toContain("CAPTURE_FAILED");
    expect((await checkpoints.load("retry"))?.status).toBe("RETRY_PENDING");
    expect((await checkpoints.load("retry"))?.nextEligibleAt).toBe("2026-08-03T00:00:01.100Z");
  });

  it("does not claim recovery when backfill finishes without repairing the source checkpoint", async () => {
    const time = clock();
    const checkpoints = new InMemoryAutomaticIngestionCheckpointStore();
    const recovery: BackfillRecoveryPort = {
      recover: async () => ({
        report: {
          dryRun: false, resumed: false, status: "COMPLETED", scope: { level: "GLOBAL" }, threads: [],
          scannedThreads: 0, eligibleThreads: 0, processedThreads: 0, skippedThreads: 0,
          appendedEvents: 0, duplicateEvents: 0, estimatedBytes: 0,
        },
        sourceCheckpoint: "NOT_REBASED",
      }),
    };
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([entry("needs-rebase")]),
      capture: { capture: async () => { throw new SessionCaptureError("TRANSCRIPT_REPLACED"); } },
      checkpoints,
      recovery,
      now: time.now,
    }, { followDebounceMs: 100, retryDelayMs: 1_000 });
    await service.runOnce();
    time.advance(100);
    const result = await service.runOnce();
    expect(result.recoveredSessions).toBe(0);
    expect(result.diagnostics.map((item) => item.code)).toContain("RECOVERY_INCOMPLETE");
    expect((await checkpoints.load("needs-rebase"))?.status).toBe("RECOVERY_PENDING");
  });

  it("surfaces durable checkpoint conflicts without an unbounded retry loop", async () => {
    let swaps = 0;
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([entry("conflict")]),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      checkpoints: {
        load: async () => undefined,
        compareAndSwap: async () => { swaps += 1; return "CONFLICT"; },
        listEligible: async () => [],
      },
    }, { checkpointConflictRetries: 2 });
    const report = await service.runOnce();
    expect(swaps).toBe(2);
    expect(report.diagnostics.map((item) => item.code)).toContain("CHECKPOINT_CONFLICT");
  });

  it("keeps a stable recovery key across restart and composes idempotent backfill", async () => {
    const time = clock();
    const catalog = new MutableCatalog([entry("rotated")]);
    const checkpoints = new InMemoryAutomaticIngestionCheckpointStore();
    const keys: string[] = [];
    const recovery: BackfillRecoveryPort = {
      recover: vi.fn(async (request) => {
        keys.push(request.attemptKey);
        if (keys.length === 1) throw new Error("temporary backfill outage");
        return Object.freeze({
          report: Object.freeze({
            dryRun: false,
            resumed: true,
            status: "COMPLETED",
            scope: { level: "GLOBAL" },
            threads: [],
            scannedThreads: 1,
            eligibleThreads: 1,
            processedThreads: 1,
            skippedThreads: 0,
            appendedEvents: 0,
            duplicateEvents: 1,
            estimatedBytes: 10,
          } satisfies BackfillReport),
          sourceCheckpoint: "REBASED",
        });
      }),
    };
    const failingCapture = { capture: vi.fn(async () => { throw new SessionCaptureError("TRANSCRIPT_TRUNCATED"); }) };
    let service = new AutomaticIngestionService({ catalog, capture: failingCapture, checkpoints, recovery, now: time.now }, {
      followDebounceMs: 100,
      retryDelayMs: 1_000,
    });
    await service.runOnce();
    time.advance(100);
    const failedRecovery = await service.runOnce();
    expect(failedRecovery.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["TRANSCRIPT_TRUNCATED", "RECOVERY_FAILED"]));
    expect((await checkpoints.load("rotated"))?.status).toBe("RECOVERY_PENDING");

    catalog.entries = [entry("rotated", { lastActivityAt: "2026-08-03T00:00:00.500Z" })];
    await service.runOnce();
    expect((await checkpoints.load("rotated"))?.status).toBe("RECOVERY_PENDING");

    time.advance(1_000);
    service = new AutomaticIngestionService({ catalog, capture: failingCapture, checkpoints, recovery, now: time.now }, {
      followDebounceMs: 100,
      retryDelayMs: 1_000,
    });
    expect((await service.runOnce()).recoveredSessions).toBe(1);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect((await checkpoints.load("rotated"))?.status).toBe("FOLLOW_PENDING");
  });

  it("records child relations without blocking primary capture when relation observation fails", async () => {
    const time = clock();
    const stored: SessionRelationObservation[] = [];
    let relationCalls = 0;
    const capture = vi.fn(async ({ sessionId }: { sessionId: string }) => captureReport(sessionId));
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([entry("parent")]),
      capture: { capture },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
      relationSource: {
        list: async () => {
          relationCalls += 1;
          if (relationCalls > 1) throw new Error("child source unavailable");
          return { items: [{ parentSessionId: "parent", childSessionId: "child", kind: "SUB_AGENT", observedAt: BASE_TIME, source: "HOOK" }] };
        },
      },
      relationStore: { upsertMany: async (items) => { stored.push(...items); } },
      now: time.now,
    }, { followDebounceMs: 100 });

    expect((await service.runOnce()).observedRelations).toBe(1);
    expect(stored).toHaveLength(1);
    time.advance(100);
    const report = await service.runOnce();
    expect(report.relationCoverage).toBe("FAILED");
    expect(report.capturedSessions).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("delivers primary capture while child aggregation is still pending", async () => {
    const time = clock();
    let relationCalls = 0;
    let releaseRelation: (() => void) | undefined;
    const capture = vi.fn(async ({ sessionId }: { sessionId: string }) => captureReport(sessionId));
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([entry("primary")]),
      capture: { capture },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
      relationSource: {
        list: async () => {
          relationCalls += 1;
          if (relationCalls === 1) return { items: [] };
          await new Promise<void>((resolve) => { releaseRelation = resolve; });
          return { items: [] };
        },
      },
      relationStore: { upsertMany: async () => undefined },
      now: time.now,
    }, { followDebounceMs: 100 });
    await service.runOnce();
    time.advance(100);

    const running = service.runOnce();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(releaseRelation).toBeTypeOf("function");
    releaseRelation?.();
    await running;
  });

  it("bounds empty relation pages independently of child count", async () => {
    let calls = 0;
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([]),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
      relationSource: { list: async () => ({ items: [], nextCursor: `cursor-${++calls}` }) },
      relationStore: { upsertMany: async () => undefined },
    }, { maxRelationPages: 2 });

    const report = await service.runOnce();
    expect(calls).toBe(2);
    expect(report.relationCoverage).toBe("BOUNDED");
    expect(report.diagnostics.map((item) => item.code)).toContain("RELATION_SCAN_BOUNDED");
  });
});

describe("SessionRelationProjection", () => {
  it("exposes traceable parent and child metadata without aggregation", async () => {
    const projection = new InMemorySessionRelationProjection();
    await projection.upsertMany([
      { parentSessionId: "parent", childSessionId: "child", kind: "SUB_AGENT", observedAt: BASE_TIME, source: "HOOK" },
    ]);
    expect(await projection.getForSession("parent", 10)).toEqual([
      { parentSessionId: "parent", childSessionId: "child", kind: "SUB_AGENT", observedAt: BASE_TIME, source: "HOOK" },
    ]);
    expect(await projection.getForSession("child", 10)).toHaveLength(1);
    await expect(projection.getForSession("child", 0)).rejects.toThrow(/limit/u);
  });
});

describe("CodexBackfillRecoveryAdapter", () => {
  const report = Object.freeze({
    dryRun: false,
    resumed: false,
    status: "COMPLETED",
    scope: { level: "GLOBAL" },
    threads: [],
    scannedThreads: 0,
    eligibleThreads: 0,
    processedThreads: 0,
    skippedThreads: 0,
    appendedEvents: 0,
    duplicateEvents: 0,
    estimatedBytes: 0,
  } satisfies BackfillReport);

  it("requires both live backfill and explicit source checkpoint repair", async () => {
    const rebase = vi.fn(async () => "NOT_REBASED" as const);
    const adapter = new CodexBackfillRecoveryAdapter(
      { execute: vi.fn(async () => report) },
      { create: () => ({ scope: { level: "GLOBAL" }, dryRun: false }) },
      { rebase },
    );
    const result = await adapter.recover({
      session: entry("rotated"),
      diagnostic: "TRANSCRIPT_REPLACED",
      attemptKey: "rotated:revision:TRANSCRIPT_REPLACED",
    });
    expect(result.report.status).toBe("COMPLETED");
    expect(result.sourceCheckpoint).toBe("NOT_REBASED");
    expect(rebase).toHaveBeenCalledOnce();
  });

  it("rejects dry-run recovery plans", async () => {
    const adapter = new CodexBackfillRecoveryAdapter(
      { execute: vi.fn(async () => report) },
      { create: () => ({ scope: { level: "GLOBAL" }, dryRun: true }) },
      { rebase: async () => "REBASED" },
    );
    await expect(adapter.recover({
      session: entry("rotated"),
      diagnostic: "TRANSCRIPT_TRUNCATED",
      attemptKey: "attempt",
    })).rejects.toThrow(/live codex backfill/u);
  });
});

describe("durable checkpoint contract", () => {
  it("uses optimistic versions and deterministic due ordering", async () => {
    const store = new InMemoryAutomaticIngestionCheckpointStore();
    const first = {
      schemaVersion: 1 as const,
      sessionId: "one",
      version: 1,
      source: "CODEX_TRANSCRIPT" as const,
      safeSourceAlias: "one",
      sourceRevision: "r1",
      lastObservedActivityAt: BASE_TIME,
      status: "FOLLOW_PENDING" as const,
      nextEligibleAt: BASE_TIME,
      updatedAt: BASE_TIME,
    };
    expect(await store.compareAndSwap("one", undefined, first)).toBe("COMMITTED");
    expect(await store.compareAndSwap("one", undefined, first)).toBe("CONFLICT");
    expect((await store.listEligible({ atOrBefore: BASE_TIME, limit: 1, statuses: ["FOLLOW_PENDING"] }))[0]?.sessionId).toBe("one");
  });
});

describe("AutomaticIngestionScheduler", () => {
  it("starts with a positive interval, does not duplicate schedules, and cancels safely", () => {
    const delays: number[] = [];
    let cancelled = false;
    const timer: SchedulerTimerPort = {
      schedule(delayMs: number): ScheduledTaskHandle {
        delays.push(delayMs);
        return { cancel: () => { cancelled = true; } };
      },
    };
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([]),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
    }, { scanIntervalMs: 1_000 });
    const scheduler = new AutomaticIngestionScheduler(service, { timer });

    expect(scheduler.start()).toBe(true);
    expect(scheduler.start()).toBe(false);
    expect(delays).toEqual([1_000]);
    expect(scheduler.stop()).toBe(true);
    expect(cancelled).toBe(true);
    expect(scheduler.stop()).toBe(false);
  });

  it("runs scheduled work, publishes a report, and schedules only after completion", async () => {
    const tasks: Array<{ task: () => void; cancelled: boolean }> = [];
    const timer: SchedulerTimerPort = {
      schedule: (_delay, task) => {
        const scheduled = { task, cancelled: false };
        tasks.push(scheduled);
        return { cancel: () => { scheduled.cancelled = true; } };
      },
    };
    const reports = vi.fn();
    const service = new AutomaticIngestionService({
      catalog: new MutableCatalog([]),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
    });
    const scheduler = new AutomaticIngestionScheduler(service, { timer, onReport: reports });
    scheduler.start();
    tasks[0]?.task();
    await vi.waitFor(() => expect(reports).toHaveBeenCalledOnce());
    expect(tasks).toHaveLength(2);
    scheduler.stop();
    expect(tasks[1]?.cancelled).toBe(true);
  });

  it("deduplicates concurrent manual triggers and reports errors", async () => {
    let release: (() => void) | undefined;
    const catalog: SessionCatalogQueryPort = {
      list: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        throw new Error("catalog failed");
      },
      get: async () => undefined,
    };
    const onError = vi.fn();
    const service = new AutomaticIngestionService({
      catalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      checkpoints: new InMemoryAutomaticIngestionCheckpointStore(),
    });
    const scheduler = new AutomaticIngestionScheduler(service, { onError });
    const first = scheduler.trigger();
    const second = scheduler.trigger();
    release?.();
    await expect(first).rejects.toThrow(/catalog failed/u);
    await expect(second).rejects.toThrow(/catalog failed/u);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("supports the default Node timer and cancellation", async () => {
    vi.useFakeTimers();
    try {
      const callback = vi.fn();
      const timer = new NodeSchedulerTimer();
      const cancelled = timer.schedule(10, callback);
      await vi.advanceTimersByTimeAsync(10);
      expect(callback).toHaveBeenCalledOnce();
      const notCalled = vi.fn();
      const handle = timer.schedule(10, notCalled);
      handle.cancel();
      cancelled.cancel();
      await vi.advanceTimersByTimeAsync(10);
      expect(notCalled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RealCodexIngestionAcceptanceVerifier", () => {
  const stages = ["HOOK", "SPOOL", "LEDGER", "CATALOG", "CURSOR"] as const;

  function evidence(count: number, sessionId = "new-task"): RealCodexAcceptanceEvidence[] {
    return stages.slice(0, count).map((stage, index) => ({
      stage,
      sessionId,
      observedAt: new Date(Date.parse(BASE_TIME) + index).toISOString(),
      evidenceRef: `${stage.toLowerCase()}-${index}`,
    }));
  }

  it("remains NOT_VERIFIED until every live stage has fresh evidence", async () => {
    const verifier = new RealCodexIngestionAcceptanceVerifier({ collect: async () => evidence(4) });
    const result = await verifier.verify({ sessionId: "new-task", taskCreatedAt: BASE_TIME });
    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.missingStages).toEqual(["CURSOR"]);
  });

  it("rejects stale, wrong-session, duplicate, and out-of-order evidence", async () => {
    const invalid = evidence(5);
    invalid[0] = { ...invalid[0]!, observedAt: "2026-08-02T23:59:59.000Z" };
    invalid[2] = { ...invalid[2]!, sessionId: "another-task" };
    invalid.push({ ...invalid[1]! });
    const verifier = new RealCodexIngestionAcceptanceVerifier({ collect: async () => invalid });
    const result = await verifier.verify({ sessionId: "new-task", taskCreatedAt: BASE_TIME });
    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.invalidStages).toEqual(expect.arrayContaining(["HOOK", "SPOOL", "LEDGER"]));
  });

  it("verifies only the complete Hook to cursor chain for the new task", async () => {
    const verifier = new RealCodexIngestionAcceptanceVerifier({ collect: async () => evidence(5) });
    const result = await verifier.verify({ sessionId: "new-task", taskCreatedAt: BASE_TIME });
    expect(result.status).toBe("VERIFIED");
    expect(result.verifiedStages).toEqual(stages);
    expect(result.missingStages).toEqual([]);
  });

  it("rejects malformed acceptance requests before reading evidence", async () => {
    const collect = vi.fn(async () => evidence(5));
    const verifier = new RealCodexIngestionAcceptanceVerifier({ collect });
    await expect(verifier.verify({ sessionId: "bad session", taskCreatedAt: "not-a-date" })).rejects.toThrow(/invalid/u);
    expect(collect).not.toHaveBeenCalled();
  });
});
