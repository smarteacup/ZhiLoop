import { describe, expect, it, vi } from "vitest";

import type {
  SessionCatalogEntry,
  SessionCatalogListRequest,
  SessionCatalogListResult,
  SessionCatalogQueryPort,
} from "@zhiloop/session-catalog";

import { KnowledgeCompilationService } from "./service.js";
import type {
  AutomaticPreviewDispatchResult,
  CompilationSessionObservation,
  KnowledgeCompilationCheckpoint,
  KnowledgeCompilationCheckpointPort,
  KnowledgeCompilationConfiguration,
} from "./types.js";

const observedAt = "2026-08-18T10:10:00.000Z";

function entry(sessionId: string, overrides: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry {
  return {
    schemaVersion: 1,
    sessionId,
    title: sessionId,
    titleSource: "SOURCE",
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    sourceVersion: `${sessionId}-source-v1`,
    sourceFormatVersion: "1",
    safeSourceAlias: `${sessionId}.jsonl`,
    captureStatus: "CAPTURED_CURRENT",
    firstActivityAt: "2026-08-18T10:00:00.000Z",
    lastActivityAt: "2026-08-18T10:09:30.000Z",
    timeGroup: "TODAY",
    eventCount: 5,
    turnCount: 3,
    ignoredRecords: 0,
    redactionCount: 0,
    ...overrides,
  };
}

class Catalog implements SessionCatalogQueryPort {
  constructor(readonly entries: readonly SessionCatalogEntry[]) {}

  async list(request: SessionCatalogListRequest = {}): Promise<SessionCatalogListResult> {
    const start = request.after === undefined
      ? 0
      : this.entries.findIndex((item) => item.sessionId === request.after!.sessionId) + 1;
    const limit = request.limit ?? 100;
    const items = this.entries.slice(start, start + limit);
    const hasMore = start + items.length < this.entries.length;
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined ? { nextPosition: { lastActivityAt: last.lastActivityAt, sessionId: last.sessionId } } : {}),
      sourceCapabilities: [],
      diagnostics: [],
      revision: "catalog-v1",
      changed: false,
    };
  }

  async get(sessionId: string): Promise<SessionCatalogEntry | undefined> {
    return this.entries.find((item) => item.sessionId === sessionId);
  }
}

class MemoryCheckpoints implements KnowledgeCompilationCheckpointPort {
  readonly values = new Map<string, KnowledgeCompilationCheckpoint>();

  async load(sessionId: string): Promise<KnowledgeCompilationCheckpoint | undefined> {
    return this.values.get(sessionId);
  }

  async compareAndSwap(sessionId: string, expectedVersion: number | undefined, next: KnowledgeCompilationCheckpoint) {
    const current = this.values.get(sessionId);
    if (current?.version !== expectedVersion) return "CONFLICT" as const;
    this.values.set(sessionId, next);
    return "COMMITTED" as const;
  }

  async listDue(): Promise<readonly KnowledgeCompilationCheckpoint[]> {
    return [];
  }
}

function observation(sessionId: string): CompilationSessionObservation {
  return {
    sessionId,
    ledgerSequence: sessionId === "session-1" ? 20 : 30,
    effectiveEventCount: 5,
    effectiveTurnCount: 3,
    sourceVersion: `${sessionId}-source-v1`,
    lastActivityAt: "2026-08-18T10:09:30.000Z",
  };
}

function service(input: {
  readonly entries?: readonly SessionCatalogEntry[];
  readonly checkpoints?: MemoryCheckpoints;
  readonly inspect?: (entry: SessionCatalogEntry) => Promise<CompilationSessionObservation>;
  readonly dispatch?: (sessionId: string, sequence: number) => Promise<AutomaticPreviewDispatchResult>;
  readonly maxSessionsPerRun?: number;
  readonly maxDispatchesPerRun?: number;
  readonly configuration?: KnowledgeCompilationConfiguration;
  readonly catalog?: SessionCatalogQueryPort;
  readonly checkpointPort?: KnowledgeCompilationCheckpointPort;
}) {
  const checkpoints = input.checkpoints ?? new MemoryCheckpoints();
  const dispatchPreview = vi.fn(async (request: { readonly sessionId: string; readonly expectedLedgerSequence: number }) =>
    await (input.dispatch ?? (async (sessionId, sequence) => ({
      status: "ENQUEUED" as const,
      snapshotId: `snapshot-${sessionId}`,
      jobId: `job-${sessionId}`,
      compiledThroughSequence: sequence,
    })))(request.sessionId, request.expectedLedgerSequence));
  const runtime = new KnowledgeCompilationService({
    catalog: input.catalog ?? new Catalog(input.entries ?? [entry("session-1")]),
    observations: { inspect: input.inspect ?? (async (item) => observation(item.sessionId)) },
    checkpoints: input.checkpointPort ?? checkpoints,
    dispatcher: { dispatchPreview },
    pipeline: {
      compilerVersion: "compiler-v1",
      promptVersion: "prompt-v1",
      policyHash: "policy-v1",
      configurationHash: "configuration-v1",
    },
    now: () => new Date(observedAt),
  }, {
    ...input.configuration,
    ...(input.maxSessionsPerRun === undefined ? {} : { maxSessionsPerRun: input.maxSessionsPerRun }),
    ...(input.maxDispatchesPerRun === undefined ? {} : { maxDispatchesPerRun: input.maxDispatchesPerRun }),
  });
  return { runtime, checkpoints, dispatchPreview };
}

describe("KnowledgeCompilationService", () => {
  it("queues once and records current progress on repeated scans", async () => {
    const fixture = service({});
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ queuedSessions: 1, failedSessions: 0 });
    const first = fixture.checkpoints.values.get("session-1")!;
    expect(first).toMatchObject({ status: "QUEUED", pendingJobId: "job-session-1", lastCompiledLedgerSequence: 20 });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ queuedSessions: 0, currentSessions: 1 });
    expect(fixture.dispatchPreview).toHaveBeenCalledTimes(1);
    expect(fixture.dispatchPreview.mock.calls[0]![0]).toMatchObject({ executionMode: "PREVIEW_ONLY" });
  });

  it("accepts an existing manual job as the same idempotent outcome", async () => {
    const fixture = service({
      dispatch: async (sessionId, sequence) => ({
        status: "EXISTING",
        snapshotId: `manual-${sessionId}`,
        jobId: `manual-job-${sessionId}`,
        compiledThroughSequence: sequence,
      }),
    });
    await fixture.runtime.runOnce();
    expect(fixture.checkpoints.values.get("session-1")).toMatchObject({
      status: "QUEUED",
      pendingSnapshotId: "manual-session-1",
      pendingJobId: "manual-job-session-1",
    });
  });

  it("fails stale dispatch closed and retries it later", async () => {
    const fixture = service({ dispatch: async () => ({ status: "STALE", reasonCode: "SOURCE_CHANGED" }) });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ retrySessions: 1, queuedSessions: 0 });
    expect(fixture.checkpoints.values.get("session-1")).toMatchObject({
      status: "RETRY_WAIT",
      lastReasonCode: "SOURCE_CHANGED",
    });
  });

  it("isolates one observation failure and continues with other sessions", async () => {
    const fixture = service({
      entries: [entry("broken"), entry("session-1")],
      inspect: async (item) => {
        if (item.sessionId === "broken") throw new Error("broken observation");
        return observation(item.sessionId);
      },
    });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ failedSessions: 1, queuedSessions: 1 });
  });

  it("bounds catalog work and reports incomplete coverage", async () => {
    const fixture = service({ entries: [entry("session-1"), entry("session-2")], maxSessionsPerRun: 1 });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({
      scannedSessions: 1,
      queuedSessions: 1,
      bounded: true,
    });
  });

  it("caps Preview dispatches independently from catalog scanning", async () => {
    const fixture = service({
      entries: [entry("session-1"), entry("session-2")],
      maxDispatchesPerRun: 1,
    });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({
      scannedSessions: 1,
      queuedSessions: 1,
      bounded: true,
    });
    expect(fixture.dispatchPreview).toHaveBeenCalledTimes(1);
  });

  it("does no work when disabled", async () => {
    const fixture = service({ configuration: { enabled: false } });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ scannedSessions: 0, bounded: false });
    expect(fixture.dispatchPreview).not.toHaveBeenCalled();
  });

  it("prefilters unavailable and partial captures without reading Ledger observations", async () => {
    const inspect = vi.fn(async (item: SessionCatalogEntry) => observation(item.sessionId));
    const fixture = service({
      entries: [
        entry("unavailable", { sourceStatus: "UNAVAILABLE", captureStatus: "SOURCE_UNAVAILABLE" }),
        entry("partial", { captureStatus: "CAPTURED_PARTIAL" }),
      ],
      inspect,
    });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ deferredSessions: 2, failedSessions: 0 });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("persists waiting checkpoints for minimum events and trigger time", async () => {
    const fixture = service({
      entries: [entry("few-events"), entry("waiting")],
      inspect: async (item) => ({
        ...observation(item.sessionId),
        effectiveEventCount: item.sessionId === "few-events" ? 1 : 2,
        effectiveTurnCount: item.sessionId === "few-events" ? 0 : 1,
      }),
    });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ deferredSessions: 2 });
    expect(fixture.checkpoints.values.get("few-events")).toMatchObject({ status: "WAITING_IDLE", lastReasonCode: "MINIMUM_EVENTS_PENDING" });
    expect(fixture.checkpoints.values.get("waiting")).toMatchObject({ status: "WAITING_IDLE", lastReasonCode: "WAITING_FOR_TRIGGER" });
  });

  it("handles CURRENT and both ineligible dispatcher outcomes", async () => {
    const current = service({ dispatch: async (_sessionId, sequence) => ({ status: "CURRENT", compiledThroughSequence: sequence }) });
    await expect(current.runtime.runOnce()).resolves.toMatchObject({ currentSessions: 1 });
    expect(current.checkpoints.values.get("session-1")).toMatchObject({ status: "CURRENT", lastReasonCode: "NO_NEW_EVENTS" });

    const ineligible = service({
      entries: [entry("empty"), entry("unsupported")],
      dispatch: async (sessionId) => sessionId === "empty"
        ? { status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" }
        : { status: "INELIGIBLE", reasonCode: "UNSUPPORTED_SOURCE" },
    });
    await expect(ineligible.runtime.runOnce()).resolves.toMatchObject({ failedSessions: 2, queuedSessions: 0 });
    expect(ineligible.checkpoints.values.get("unsupported")).toMatchObject({ status: "FAILED", lastReasonCode: "UNSUPPORTED_SOURCE" });
  });

  it("classifies retryable and permanent dispatch errors independently", async () => {
    const fixture = service({
      entries: [entry("retry"), entry("permanent")],
      dispatch: async (sessionId) => {
        throw Object.assign(new Error(sessionId), { retryable: sessionId === "retry" });
      },
    });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ retrySessions: 1, failedSessions: 1 });
    expect(fixture.checkpoints.values.get("retry")).toMatchObject({ status: "RETRY_WAIT", lastReasonCode: "DISPATCH_RETRYABLE" });
    expect(fixture.checkpoints.values.get("permanent")).toMatchObject({ status: "FAILED", lastReasonCode: "DISPATCH_FAILED" });
  });

  it("rejects a dispatcher result that does not cover the observed revision", async () => {
    const fixture = service({
      dispatch: async (_sessionId, sequence) => ({
        status: "ENQUEUED",
        snapshotId: "snapshot-short",
        jobId: "job-short",
        compiledThroughSequence: sequence - 1,
      }),
    });
    await expect(fixture.runtime.runOnce()).resolves.toMatchObject({ retrySessions: 1, queuedSessions: 0 });
    expect(fixture.checkpoints.values.has("session-1")).toBe(false);
  });

  it("recomputes after a CAS conflict and reports exhaustion without overwriting", async () => {
    class ConflictingStore extends MemoryCheckpoints {
      conflicts = 1;
      override async compareAndSwap(sessionId: string, expectedVersion: number | undefined, next: KnowledgeCompilationCheckpoint) {
        if (this.conflicts > 0) {
          this.conflicts -= 1;
          return "CONFLICT" as const;
        }
        return await super.compareAndSwap(sessionId, expectedVersion, next);
      }
    }
    const recoveredStore = new ConflictingStore();
    const recovered = service({
      checkpointPort: recoveredStore,
      dispatch: async (sessionId, sequence) => ({
        status: recoveredStore.conflicts === 0 ? "EXISTING" : "ENQUEUED",
        snapshotId: `snapshot-${sessionId}`,
        jobId: `job-${sessionId}`,
        compiledThroughSequence: sequence,
      }),
    });
    await expect(recovered.runtime.runOnce()).resolves.toMatchObject({ queuedSessions: 1 });
    expect(recovered.dispatchPreview).toHaveBeenCalledTimes(2);

    const exhaustedStore = new ConflictingStore();
    exhaustedStore.conflicts = 10;
    const exhausted = service({ checkpointPort: exhaustedStore, configuration: { checkpointConflictRetries: 2 } });
    await expect(exhausted.runtime.runOnce()).resolves.toMatchObject({ retrySessions: 1, queuedSessions: 0 });
  });

  it("isolates corrupt checkpoints, invalid catalog entries and cursor loops", async () => {
    const invalid = service({
      entries: [entry("invalid", { lastActivityAt: "not-a-time" })],
    });
    await expect(invalid.runtime.runOnce()).resolves.toMatchObject({ failedSessions: 1 });

    const corrupt = service({
      checkpointPort: {
        load: async () => { throw new Error("corrupt"); },
        compareAndSwap: async () => "COMMITTED",
        listDue: async () => [],
      },
    });
    await expect(corrupt.runtime.runOnce()).resolves.toMatchObject({ failedSessions: 1 });

    const loopingPage = {
      items: [entry("session-1")],
      nextPosition: { lastActivityAt: entry("session-1").lastActivityAt, sessionId: "session-1" },
      sourceCapabilities: [], diagnostics: [], revision: "loop", changed: false,
    };
    const loopingCatalog: SessionCatalogQueryPort = {
      list: async () => loopingPage,
      get: async () => entry("session-1"),
    };
    const looping = service({ catalog: loopingCatalog });
    await expect(looping.runtime.runOnce()).resolves.toMatchObject({ scannedSessions: 1, bounded: true });
  });
});
