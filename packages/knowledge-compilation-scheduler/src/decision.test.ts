import { describe, expect, it } from "vitest";

import type { SessionCatalogEntry } from "@zhiloop/session-catalog";

import {
  automaticPreviewIdempotencyKey,
  evaluateKnowledgeCompilationTrigger,
  knowledgeCompilationPipelineHash,
  normalizeKnowledgeCompilationConfiguration,
} from "./decision.js";
import type { KnowledgeCompilationCheckpoint } from "./types.js";

const now = "2026-08-18T10:10:00.000Z";

function session(overrides: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry {
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

function checkpoint(overrides: Partial<KnowledgeCompilationCheckpoint> = {}): KnowledgeCompilationCheckpoint {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    version: 1,
    lastObservedLedgerSequence: 10,
    lastObservedEventCount: 2,
    lastObservedTurnCount: 1,
    lastCompiledLedgerSequence: 10,
    lastCompiledEventCount: 2,
    lastCompiledTurnCount: 1,
    lastActivityAt: "2026-08-18T10:05:00.000Z",
    sourceVersion: "source-v1",
    lastCompiledPipelineHash: "a".repeat(64),
    status: "CURRENT",
    lastReasonCode: "NO_NEW_EVENTS",
    updatedAt: "2026-08-18T10:05:00.000Z",
    ...overrides,
  };
}

const pipeline = {
  compilerVersion: "compiler-v1",
  promptVersion: "prompt-v1",
  policyHash: "policy-v1",
  configurationHash: "config-v1",
};
const pipelineHash = knowledgeCompilationPipelineHash(pipeline);

function evaluate(input: {
  readonly entry?: SessionCatalogEntry;
  readonly previous?: KnowledgeCompilationCheckpoint;
  readonly eventCount?: number;
  readonly turnCount?: number;
  readonly latestEventType?: string;
  readonly lastActivityAt?: string;
  readonly observedAt?: string;
}) {
  const entry = input.entry ?? session();
  return evaluateKnowledgeCompilationTrigger({
    session: entry,
    observation: {
      sessionId: entry.sessionId,
      ledgerSequence: 20,
      effectiveEventCount: input.eventCount ?? 5,
      effectiveTurnCount: input.turnCount ?? 3,
      ...(input.latestEventType === undefined ? {} : { latestEventType: input.latestEventType }),
      sourceVersion: "source-v1",
      lastActivityAt: input.lastActivityAt ?? entry.lastActivityAt,
    },
    ...(input.previous === undefined ? {} : { checkpoint: input.previous }),
    configuration: normalizeKnowledgeCompilationConfiguration(),
    pipelineHash,
    observedAt: input.observedAt ?? now,
  });
}

describe("knowledge compilation trigger", () => {
  it("selects turn, idle, ended and maximum-wait triggers deterministically", () => {
    expect(evaluate({ previous: checkpoint({ lastCompiledPipelineHash: pipelineHash }), turnCount: 4 }).trigger).toBe("TURN_THRESHOLD");
    expect(evaluate({
      previous: checkpoint({ lastCompiledPipelineHash: pipelineHash }),
      turnCount: 2,
      lastActivityAt: "2026-08-18T10:07:00.000Z",
    }).trigger).toBe("SESSION_IDLE");
    expect(evaluate({
      previous: checkpoint({ lastCompiledPipelineHash: pipelineHash }),
      turnCount: 2,
      latestEventType: "session.ended",
    }).trigger).toBe("SESSION_ENDED");
    expect(evaluate({
      previous: checkpoint({
        lastCompiledPipelineHash: pipelineHash,
        firstPendingObservedAt: "2026-08-18T09:30:00.000Z",
      }),
      turnCount: 2,
      lastActivityAt: "2026-08-18T10:09:30.000Z",
    }).trigger).toBe("MAXIMUM_WAIT");
  });

  it("defers incomplete capture, minimum events and no-new-event observations", () => {
    expect(evaluate({ entry: session({ sourceStatus: "UNAVAILABLE" }) }).reasonCode).toBe("SOURCE_UNAVAILABLE");
    expect(evaluate({ entry: session({ captureStatus: "CAPTURED_PARTIAL" }) }).reasonCode).toBe("CAPTURE_NOT_CURRENT");
    expect(evaluate({
      previous: checkpoint({ lastCompiledPipelineHash: pipelineHash }),
      eventCount: 3,
      turnCount: 2,
    }).reasonCode).toBe("MINIMUM_EVENTS_PENDING");
    expect(evaluate({
      previous: checkpoint({
        lastCompiledPipelineHash: pipelineHash,
        lastCompiledLedgerSequence: 20,
        lastCompiledEventCount: 5,
        lastCompiledTurnCount: 3,
      }),
    }).reasonCode).toBe("NO_NEW_EVENTS");
  });

  it("keeps a pending range deferred until an idle or maximum-wait boundary is reached", () => {
    expect(evaluate({
      previous: checkpoint({ lastCompiledPipelineHash: pipelineHash }),
      turnCount: 2,
      lastActivityAt: "2026-08-18T10:09:30.000Z",
    })).toMatchObject({
      eligible: false,
      reasonCode: "WAITING_FOR_TRIGGER",
      nextEligibleAt: "2026-08-18T10:11:30.000Z",
    });
  });

  it("recompiles the immutable range when the pipeline identity changes", () => {
    const result = evaluate({
      previous: checkpoint({
        lastCompiledPipelineHash: "b".repeat(64),
        lastCompiledLedgerSequence: 20,
        lastCompiledEventCount: 5,
        lastCompiledTurnCount: 3,
      }),
    });
    expect(result).toMatchObject({ eligible: true, trigger: "TURN_THRESHOLD" });
  });

  it("validates configuration and creates stable pipeline-bound idempotency keys", () => {
    expect(() => normalizeKnowledgeCompilationConfiguration({ pageSize: 101 })).toThrow("pageSize");
    expect(() => normalizeKnowledgeCompilationConfiguration({ minimumNewTurns: 1.5 })).toThrow("minimumNewTurns");
    expect(() => normalizeKnowledgeCompilationConfiguration({ scanIntervalMs: 999 })).toThrow("scanIntervalMs");
    const first = automaticPreviewIdempotencyKey({ sessionId: "session-1", expectedLedgerSequence: 20, sourceVersion: "v1", pipeline });
    const replay = automaticPreviewIdempotencyKey({ sessionId: "session-1", expectedLedgerSequence: 20, sourceVersion: "v1", pipeline });
    const changed = automaticPreviewIdempotencyKey({ sessionId: "session-1", expectedLedgerSequence: 21, sourceVersion: "v1", pipeline });
    expect(first).toBe(replay);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^knowledge-compile:v1:[a-f0-9]{64}$/u);
    expect(automaticPreviewIdempotencyKey({ sessionId: "session-1", expectedLedgerSequence: 20, pipeline })).not.toBe(first);
  });

  it("rejects invalid observation timestamps", () => {
    expect(() => evaluate({ observedAt: "not-a-timestamp" })).toThrow("observedAt must be an ISO timestamp");
  });
});
