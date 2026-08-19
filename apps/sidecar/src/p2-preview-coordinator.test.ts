import type { EventEnvelope } from "@zhiloop/domain";
import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import {
  automaticPreviewIdempotencyKey,
  type AutomaticPreviewDispatchRequest,
} from "@zhiloop/knowledge-compilation-scheduler";
import type { SessionCatalogEntry } from "@zhiloop/session-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  P2AutomaticCompilationAdapter,
  P2DurableAutomaticCompilationAdapter,
  type P2CandidatePreviewPort,
} from "./p2-preview-coordinator.js";
import { P2SidecarRuntime } from "./p2-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("P2DurableAutomaticCompilationAdapter", () => {
  it("validates and plans without directly creating a Snapshot, then queues one durable outer job", async () => {
    const ledger = new SqliteEventLedger(":memory:");
    const coordinate = vi.fn(async () => ({ status: "INELIGIBLE" as const, reasonCode: "NO_EXTRACTABLE_EVENTS" as const }));
    const plan = vi.fn(async () => ({ status: "READY" as const, sourceRange: { from: 1, to: 3 }, compiledThroughSequence: 3 }));
    const coordinator: P2CandidatePreviewPort = { pipelineIdentity: () => pipeline, plan, coordinate };
    const enqueue = vi.fn(() => ({ status: "CREATED" as const, job: { snapshot: { jobId: "evolution-job-1" } } }));
    const adapter = new P2DurableAutomaticCompilationAdapter({ get: async () => catalogEntry() }, ledger, coordinator,
      { enqueue } as never, 7);
    await expect(adapter.dispatchPreview(request())).resolves.toEqual({ status: "QUEUED", jobId: "evolution-job-1",
      compiledThroughSequence: 3 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ jobType: "KNOWLEDGE_COMPILE", sessionId: "session-1",
      sourceRange: { from: 1, to: 3 }, pipelineHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }), 7);
    expect(coordinate).not.toHaveBeenCalled();
    ledger.close();
  });
});

function event(index: number, eventType: EventEnvelope["eventType"], turnId: string): EventEnvelope {
  return {
    schemaVersion: 1 as const,
    eventId: `event-${index}`,
    source: "codex-transcript",
    sourceVersion: "source-v1",
    sourceItemId: `line-${index}`,
    eventType,
    sessionId: "session-1",
    turnId,
    occurredAt: `2026-08-18T10:00:0${index}.000Z`,
    contentHash: `content-${index}`,
    correlationId: turnId,
    payload: { message: "sensitive content is not returned by stats" },
  };
}

function catalogEntry(overrides: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    title: "Session",
    titleSource: "SOURCE",
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    sourceVersion: "source-v1",
    sourceFormatVersion: "1",
    safeSourceAlias: "session.jsonl",
    captureStatus: "CAPTURED_CURRENT",
    firstActivityAt: "2026-08-18T10:00:01.000Z",
    lastActivityAt: "2026-08-18T10:00:03.000Z",
    timeGroup: "TODAY",
    eventCount: 3,
    turnCount: 2,
    ignoredRecords: 0,
    redactionCount: 0,
    ...overrides,
  };
}

const pipeline = {
  compilerVersion: "compiler-v1",
  promptVersion: "prompt-v1",
  policyHash: "policy-v1",
  configurationHash: "configuration-v1",
};

function request(overrides: Partial<AutomaticPreviewDispatchRequest> = {}): AutomaticPreviewDispatchRequest {
  const merged = {
    schemaVersion: 1 as const,
    sessionId: "session-1",
    expectedLedgerSequence: 3,
    sourceVersion: "source-v1",
    executionMode: "PREVIEW_ONLY" as const,
    trigger: "SESSION_ENDED" as const,
    requestedAt: "2026-08-18T10:10:00.000Z",
    ...pipeline,
    ...overrides,
  };
  return {
    ...merged,
    idempotencyKey: overrides.idempotencyKey ?? automaticPreviewIdempotencyKey({
      sessionId: merged.sessionId,
      expectedLedgerSequence: merged.expectedLedgerSequence,
      ...(merged.sourceVersion === undefined ? {} : { sourceVersion: merged.sourceVersion }),
      pipeline: merged,
    }),
  };
}

describe("P2AutomaticCompilationAdapter", () => {
  it("observes aggregate Ledger progress without exposing event payloads", async () => {
    const ledger = new SqliteEventLedger(":memory:");
    ledger.append(event(1, "user.prompted", "turn-1"));
    ledger.append(event(2, "turn.stopped", "turn-1"));
    ledger.append(event(3, "session.ended", "turn-2"));
    const coordinator: P2CandidatePreviewPort = {
      pipelineIdentity: () => pipeline,
      plan: async () => ({ status: "CURRENT", compiledThroughSequence: 3 }),
      coordinate: async () => ({ status: "CURRENT", compiledThroughSequence: 3 }),
    };
    const adapter = new P2AutomaticCompilationAdapter({ get: async () => catalogEntry() }, ledger, coordinator);
    const observation = await adapter.inspect(catalogEntry());
    expect(observation).toEqual({
      sessionId: "session-1",
      ledgerSequence: 3,
      effectiveEventCount: 3,
      effectiveTurnCount: 2,
      latestEventType: "session.ended",
      sourceVersion: "source-v1",
      lastActivityAt: "2026-08-18T10:00:03.000Z",
    });
    expect(JSON.stringify(observation)).not.toContain("sensitive content");
    ledger.close();
  });

  it("revalidates pipeline, source and capture state before Preview-only dispatch", async () => {
    const ledger = new SqliteEventLedger(":memory:");
    const coordinate = vi.fn(async () => ({
      status: "ENQUEUED" as const,
      snapshotId: "snapshot-1",
      jobId: "job-1",
      compiledThroughSequence: 3,
    }));
    let current = catalogEntry();
    const coordinator: P2CandidatePreviewPort = { pipelineIdentity: () => pipeline,
      plan: async () => ({ status: "READY", sourceRange: { from: 1, to: 3 }, compiledThroughSequence: 3 }), coordinate };
    const adapter = new P2AutomaticCompilationAdapter({ get: async () => current }, ledger, coordinator);
    await expect(adapter.dispatchPreview(request())).resolves.toMatchObject({ status: "ENQUEUED", jobId: "job-1" });
    expect(coordinate).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedLedgerSequence: 3,
      requestId: expect.stringMatching(/^auto-[a-f0-9]{64}$/u),
    });

    current = catalogEntry({ sourceVersion: "source-v2" });
    await expect(adapter.dispatchPreview(request())).resolves.toEqual({ status: "STALE", reasonCode: "SOURCE_CHANGED" });
    current = catalogEntry({ captureStatus: "CAPTURED_PARTIAL" });
    await expect(adapter.dispatchPreview(request({ sourceVersion: "source-v2" }))).resolves.toEqual({ status: "STALE", reasonCode: "CAPTURE_NOT_CURRENT" });
    await expect(adapter.dispatchPreview(request({ compilerVersion: "other" }))).resolves.toEqual({ status: "STALE", reasonCode: "SOURCE_CHANGED" });
    await expect(adapter.dispatchPreview(request({ idempotencyKey: `knowledge-compile:v1:${"0".repeat(64)}` }))).rejects.toThrow("idempotency");
    expect("enqueuePolicyCommit" in adapter).toBe(false);
    ledger.close();
  });
});

describe("P2CandidatePreviewCoordinator", () => {
  it("creates, reuses and pipeline-recompiles immutable Preview snapshots", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "zhiloop-preview-coordinator-"));
    directories.push(stateDirectory);
    const ledger = new SqliteEventLedger(":memory:");
    ledger.append(event(1, "user.prompted", "turn-1"));
    expect(ledger.append(event(1, "user.prompted", "turn-1")).status).toBe("duplicate");
    ledger.append(event(2, "turn.stopped", "turn-1"));
    ledger.append(event(3, "session.ended", "turn-2"));
    ledger.commitIngestionCursor("codex-transcript:session-1", { byteOffset: 400, lineNumber: 4 });
    const runtime = await P2SidecarRuntime.create({
      stateDirectory,
      projectJob: () => undefined,
      knowledgeWorker: {
        runtime: { run: async () => { throw new Error("worker is not polled in this test"); } },
        requestFor: () => { throw new Error("worker is not polled in this test"); },
      },
      snapshotSource: {
        observe: async (snapshotRequest) => {
          const records = ledger.readAfter(0, 100).filter((record) =>
            record.event.sessionId === snapshotRequest.sessionId
            && record.sequence >= snapshotRequest.sourceSequence.from
            && record.sequence <= snapshotRequest.sourceSequence.to);
          return {
            captureRevision: ledger.latestSequenceForSession(snapshotRequest.sessionId),
            sourceReferences: records.map((record) => ({
              eventId: record.event.eventId,
              sourceSequence: record.sequence,
              ...(record.event.turnId === undefined ? {} : { turnId: record.event.turnId }),
            })),
            observedAt: "2026-08-18T10:10:00.000Z",
          };
        },
      },
    });
    await runtime.start();
    let configurationHash = "c".repeat(64);
    const inspectTranscriptSource = async () => ({
      schemaVersion: 1 as const,
      sessionId: "session-1",
      previewRevision: 1,
      transcriptIdentityHash: "a".repeat(64),
      projectedEvents: 0,
      ignoredRecords: 0,
      eventTypes: {},
      items: [],
      itemsTruncated: false,
      cursor: { byteOffset: 400, lineNumber: 4 },
      hasMore: false,
      expiresAt: "2026-08-18T10:20:00.000Z",
    });
    const coordinator = new (await import("./p2-preview-coordinator.js")).P2CandidatePreviewCoordinator({
      runtime,
      ledger,
      inspectTranscriptSource,
      configurationHash: () => configurationHash,
    });
    expect(ledger.readAfter(0).map((record) => record.sequence)).toEqual([1, 3, 4]);
    await expect(coordinator.coordinate({ sessionId: "session-1", expectedLedgerSequence: 4, requestId: "first" }))
      .resolves.toMatchObject({ status: "ENQUEUED", compiledThroughSequence: 4 });
    await expect(coordinator.coordinate({ sessionId: "session-1", expectedLedgerSequence: 4, requestId: "current" }))
      .resolves.toEqual({ status: "CURRENT", compiledThroughSequence: 4 });
    configurationHash = "d".repeat(64);
    await expect(coordinator.coordinate({ sessionId: "session-1", expectedLedgerSequence: 4, requestId: "recompile" }))
      .resolves.toMatchObject({ status: "ENQUEUED", compiledThroughSequence: 4 });
    await expect(coordinator.coordinate({ sessionId: "session-1", expectedLedgerSequence: 2, requestId: "stale" }))
      .resolves.toEqual({ status: "STALE", reasonCode: "LEDGER_CHANGED" });
    await runtime.close();
    ledger.close();
  });

  it("fails closed for unavailable sources, stale capture cursors and empty sessions", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "zhiloop-preview-empty-"));
    directories.push(stateDirectory);
    const ledger = new SqliteEventLedger(":memory:");
    ledger.commitIngestionCursor("codex-transcript:session-1", { byteOffset: 0, lineNumber: 0 });
    const runtime = await P2SidecarRuntime.create({
      stateDirectory,
      projectJob: () => undefined,
      knowledgeWorker: {
        runtime: { run: async () => { throw new Error("unused"); } },
        requestFor: () => { throw new Error("unused"); },
      },
      snapshotSource: { observe: async () => { throw new Error("unused"); } },
    });
    await runtime.start();
    const source = {
      schemaVersion: 1 as const,
      sessionId: "session-1",
      previewRevision: 1,
      transcriptIdentityHash: "b".repeat(64),
      projectedEvents: 0,
      ignoredRecords: 0,
      eventTypes: {},
      items: [],
      itemsTruncated: false,
      cursor: { byteOffset: 0, lineNumber: 0 },
      hasMore: false,
      expiresAt: "2026-08-18T10:20:00.000Z",
    };
    const { P2CandidatePreviewCoordinator } = await import("./p2-preview-coordinator.js");
    const unavailable = new P2CandidatePreviewCoordinator({
      runtime, ledger, inspectTranscriptSource: async () => { throw new Error("missing"); }, configurationHash: () => "config",
    });
    await expect(unavailable.coordinate({ sessionId: "session-1", expectedLedgerSequence: 0, requestId: "missing" }))
      .resolves.toEqual({ status: "INELIGIBLE", reasonCode: "UNSUPPORTED_SOURCE" });
    const empty = new P2CandidatePreviewCoordinator({
      runtime, ledger, inspectTranscriptSource: async () => source, configurationHash: () => "config",
    });
    await expect(empty.coordinate({ sessionId: "session-1", expectedLedgerSequence: 0, requestId: "empty" }))
      .resolves.toEqual({ status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" });
    const stale = new P2CandidatePreviewCoordinator({
      runtime,
      ledger,
      inspectTranscriptSource: async () => ({ ...source, cursor: { byteOffset: 1, lineNumber: 1 } }),
      configurationHash: () => "config",
    });
    await expect(stale.coordinate({ sessionId: "session-1", expectedLedgerSequence: 0, requestId: "cursor" }))
      .resolves.toEqual({ status: "STALE", reasonCode: "CAPTURE_NOT_CURRENT" });
    await runtime.close();
    ledger.close();
  });
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
