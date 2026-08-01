import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SqliteEventLedger, type LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type { EventEnvelope, EventSource, EventType } from "@zhiloop/domain";

import { normalizeConversations } from "./normalizer.js";

interface RecordFixture {
  readonly label: string;
  readonly sequence: number;
  readonly eventType: EventType;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly occurredAt?: string;
  readonly cwd?: string;
  readonly projectHint?: string;
  readonly source?: EventSource;
}

const baseTime = "2026-08-01T08:00:00.000Z";
const openAsOf = "2026-08-01T08:10:00.000Z";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(input: RecordFixture): LedgerEventRecord {
  const event: EventEnvelope = {
    schemaVersion: 1,
    eventId: hash(`event:${input.label}`),
    source: input.source ?? "codex-hook",
    sourceItemId: input.label,
    eventType: input.eventType,
    sessionId: input.sessionId ?? "session-1",
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    occurredAt: input.occurredAt ?? baseTime,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.projectHint === undefined ? {} : { projectHint: input.projectHint }),
    contentHash: hash(`content:${input.label}`),
    correlationId: hash(`correlation:${input.sessionId ?? "session-1"}`),
    payload: { label: input.label },
  };
  return {
    sequence: input.sequence,
    event,
    storedPayloadHash: hash(JSON.stringify(event.payload)),
    redactionCount: 0,
    payloadPurged: false,
    insertedAt: "2026-08-01T09:00:00.000Z",
  };
}

function eventIds(result: ReturnType<typeof normalizeConversations>, session = 0, turn = 0): readonly string[] {
  return result.sessions[session]?.turns[turn]?.events.map((event) => event.eventId) ?? [];
}

describe("normalizeConversations", () => {
  it("sorts out-of-order events by source timestamp, source order, then event ID", () => {
    const prompt = fixture({ label: "prompt", sequence: 3, eventType: "user.prompted", turnId: "turn-1", occurredAt: "2026-08-01T08:00:01.000Z" });
    const earlierTool = fixture({ label: "tool-earlier", sequence: 2, eventType: "tool.completed", turnId: "turn-1", occurredAt: baseTime });
    const laterSequence = fixture({ label: "tool-later-sequence", sequence: 4, eventType: "tool.completed", turnId: "turn-1", occurredAt: "2026-08-01T08:00:01.000Z" });

    const result = normalizeConversations([laterSequence, prompt, earlierTool], { asOf: openAsOf });
    expect(eventIds(result)).toEqual([earlierTool.event.eventId, prompt.event.eventId, laterSequence.event.eventId]);
  });

  it("folds repeated Stop events into one closed Turn", () => {
    const records = [
      fixture({ label: "prompt", sequence: 1, eventType: "user.prompted", turnId: "turn-1" }),
      fixture({ label: "stop-1", sequence: 2, eventType: "turn.stopped", turnId: "turn-1", occurredAt: "2026-08-01T08:00:01.000Z" }),
      fixture({ label: "stop-2", sequence: 3, eventType: "turn.stopped", turnId: "turn-1", occurredAt: "2026-08-01T08:00:02.000Z" }),
    ];

    const session = normalizeConversations(records, { asOf: openAsOf }).sessions[0];
    expect(session?.turns).toHaveLength(1);
    expect(session?.turns[0]).toMatchObject({
      turnId: "turn-1",
      status: "CLOSED",
      closeReason: "STOP_EVENT",
      endedAt: "2026-08-01T08:00:02.000Z",
      stopEventCount: 2,
    });
  });

  it("does not treat an intermediate Stop followed by work as the final boundary", () => {
    const result = normalizeConversations([
      fixture({ label: "prompt", sequence: 1, eventType: "user.prompted", turnId: "turn-1" }),
      fixture({ label: "stop", sequence: 2, eventType: "turn.stopped", turnId: "turn-1", occurredAt: "2026-08-01T08:00:01.000Z" }),
      fixture({ label: "continued-tool", sequence: 3, eventType: "tool.completed", turnId: "turn-1", occurredAt: "2026-08-01T08:00:02.000Z" }),
    ], { asOf: openAsOf });

    expect(result.sessions[0]?.turns[0]).toMatchObject({ status: "OPEN", stopEventCount: 1 });
  });

  it("assigns missing Turn IDs deterministically and keeps repeated no-ID Stops together", () => {
    const records = [
      fixture({ label: "prompt", sequence: 1, eventType: "user.prompted" }),
      fixture({ label: "tool", sequence: 2, eventType: "tool.completed", occurredAt: "2026-08-01T08:00:01.000Z" }),
      fixture({ label: "stop-1", sequence: 3, eventType: "turn.stopped", occurredAt: "2026-08-01T08:00:02.000Z" }),
      fixture({ label: "stop-2", sequence: 4, eventType: "turn.stopped", occurredAt: "2026-08-01T08:00:03.000Z" }),
    ];
    const first = normalizeConversations(records, { asOf: openAsOf });
    const replay = normalizeConversations([...records].reverse(), { asOf: openAsOf });

    expect(first.sessions[0]?.turns).toHaveLength(1);
    expect(first.sessions[0]?.turns[0]).toMatchObject({ syntheticId: true, stopEventCount: 2 });
    expect(first.sessions[0]?.turns[0]?.turnId).toBe(replay.sessions[0]?.turns[0]?.turnId);
  });

  it("promotes an active synthetic Turn when a later event supplies its explicit ID", () => {
    const result = normalizeConversations([
      fixture({ label: "prompt", sequence: 1, eventType: "user.prompted" }),
      fixture({ label: "tool", sequence: 2, eventType: "tool.completed", turnId: "turn-real", occurredAt: "2026-08-01T08:00:01.000Z" }),
      fixture({ label: "stop", sequence: 3, eventType: "turn.stopped", turnId: "turn-real", occurredAt: "2026-08-01T08:00:02.000Z" }),
    ], { asOf: openAsOf });

    expect(result.sessions[0]?.turns).toHaveLength(1);
    expect(result.sessions[0]?.turns[0]).toMatchObject({ turnId: "turn-real", syntheticId: false, stopEventCount: 1 });
    expect(result.sessions[0]?.turns[0]?.events).toHaveLength(3);
  });

  it("closes an unfinished Turn at the next prompt", () => {
    const session = normalizeConversations([
      fixture({ label: "prompt-1", sequence: 1, eventType: "user.prompted", turnId: "turn-1" }),
      fixture({ label: "tool", sequence: 2, eventType: "tool.completed", turnId: "turn-1", occurredAt: "2026-08-01T08:00:01.000Z" }),
      fixture({ label: "prompt-2", sequence: 3, eventType: "user.prompted", turnId: "turn-2", occurredAt: "2026-08-01T08:00:02.000Z" }),
    ], { asOf: openAsOf }).sessions[0];

    expect(session?.turns[0]).toMatchObject({ status: "CLOSED", closeReason: "NEXT_TURN", endedAt: "2026-08-01T08:00:02.000Z" });
    expect(session?.turns[1]).toMatchObject({ status: "OPEN" });
  });

  it("closes a Session and its active Turn from SessionEnd", () => {
    const started = fixture({ label: "start", sequence: 1, eventType: "session.started", cwd: "/repo" });
    const prompt = fixture({ label: "prompt", sequence: 2, eventType: "user.prompted", turnId: "turn-1", occurredAt: "2026-08-01T08:00:01.000Z", cwd: "/repo" });
    const ended = fixture({ label: "end", sequence: 3, eventType: "session.ended", occurredAt: "2026-08-01T08:00:02.000Z", cwd: "/repo" });
    const session = normalizeConversations([ended, prompt, started], { asOf: openAsOf }).sessions[0];

    expect(session).toMatchObject({ status: "CLOSED", closeReason: "SOURCE_END", closedAt: ended.event.occurredAt });
    expect(session?.sessionEvents.map((event) => event.eventId)).toEqual([started.event.eventId, ended.event.eventId]);
    expect(session?.turns[0]).toMatchObject({ status: "CLOSED", closeReason: "SESSION_CLOSED", endedAt: ended.event.occurredAt });
  });

  it("diagnoses events after SessionEnd without producing a backwards boundary", () => {
    const ended = fixture({ label: "end", sequence: 2, eventType: "session.ended", occurredAt: "2026-08-01T08:00:01.000Z" });
    const late = fixture({ label: "late", sequence: 3, eventType: "tool.completed", turnId: "turn-1", occurredAt: "2026-08-01T08:00:02.000Z" });
    const result = normalizeConversations([
      fixture({ label: "prompt", sequence: 1, eventType: "user.prompted", turnId: "turn-1" }),
      ended,
      late,
    ], { asOf: openAsOf });

    expect(result.sessions[0]).toMatchObject({ closeReason: "SOURCE_END", closedAt: late.event.occurredAt });
    expect(result.sessions[0]?.turns[0]?.endedAt).toBe(late.event.occurredAt);
    expect(result.diagnostics).toEqual([{
      code: "EVENT_AFTER_SESSION_END",
      sessionId: "session-1",
      eventId: late.event.eventId,
      sourceOrder: 3,
    }]);
  });

  it("closes a missing SessionEnd from the next non-overlapping Session in the same context", () => {
    const first = fixture({ label: "first", sequence: 1, eventType: "user.prompted", sessionId: "session-1", cwd: "/repo" });
    const next = fixture({ label: "next", sequence: 2, eventType: "session.started", sessionId: "session-2", cwd: "/repo", occurredAt: "2026-08-01T08:05:00.000Z" });
    const result = normalizeConversations([next, first], { asOf: "2026-08-01T08:06:00.000Z" });

    expect(result.sessions[0]).toMatchObject({ sessionId: "session-1", closeReason: "NEXT_SESSION", closedAt: next.event.occurredAt });
    expect(result.sessions[1]).toMatchObject({ sessionId: "session-2", status: "OPEN" });
  });

  it("uses source order when a successor starts at the same timestamp", () => {
    const first = fixture({ label: "first", sequence: 1, eventType: "user.prompted", sessionId: "a", cwd: "/repo" });
    const next = fixture({ label: "next", sequence: 2, eventType: "session.started", sessionId: "b", cwd: "/repo" });
    const result = normalizeConversations([next, first], { asOf: "2026-08-01T08:01:00.000Z" });

    expect(result.sessions[0]).toMatchObject({ sessionId: "a", closeReason: "NEXT_SESSION", closedAt: baseTime });
  });

  it("does not close overlapping Sessions as successors", () => {
    const result = normalizeConversations([
      fixture({ label: "a-1", sequence: 1, eventType: "user.prompted", sessionId: "a", cwd: "/repo" }),
      fixture({ label: "b-1", sequence: 2, eventType: "user.prompted", sessionId: "b", cwd: "/repo", occurredAt: "2026-08-01T08:01:00.000Z" }),
      fixture({ label: "a-2", sequence: 3, eventType: "tool.completed", sessionId: "a", turnId: "a-turn", cwd: "/repo", occurredAt: "2026-08-01T08:02:00.000Z" }),
    ], { asOf: "2026-08-01T08:03:00.000Z" });

    expect(result.sessions.map((session) => session.status)).toEqual(["OPEN", "OPEN"]);
  });

  it("never closes an interleaved Turn before its last event", () => {
    const result = normalizeConversations([
      fixture({ label: "a-prompt", sequence: 1, eventType: "user.prompted", turnId: "turn-a" }),
      fixture({ label: "b-prompt", sequence: 2, eventType: "user.prompted", turnId: "turn-b", occurredAt: "2026-08-01T08:01:00.000Z" }),
      fixture({ label: "a-late-tool", sequence: 3, eventType: "tool.completed", turnId: "turn-a", occurredAt: "2026-08-01T08:02:00.000Z" }),
      fixture({ label: "c-prompt", sequence: 4, eventType: "user.prompted", turnId: "turn-c", occurredAt: "2026-08-01T08:03:00.000Z" }),
    ], { asOf: "2026-08-01T08:04:00.000Z" });

    expect(result.sessions[0]?.turns.find((turn) => turn.turnId === "turn-a")).toMatchObject({
      closeReason: "NEXT_TURN",
      endedAt: "2026-08-01T08:03:00.000Z",
    });
  });

  it("does not infer a successor without a project context", () => {
    const result = normalizeConversations([
      fixture({ label: "first", sequence: 1, eventType: "user.prompted", sessionId: "a" }),
      fixture({ label: "next", sequence: 2, eventType: "session.started", sessionId: "b", occurredAt: "2026-08-01T08:01:00.000Z" }),
    ], { asOf: "2026-08-01T08:02:00.000Z" });

    expect(result.sessions.map((session) => session.status)).toEqual(["OPEN", "OPEN"]);
  });

  it("prefers projectHint over an earlier cwd when matching successor Sessions", () => {
    const next = fixture({ label: "next", sequence: 3, eventType: "session.started", sessionId: "b", projectHint: "project-1", occurredAt: "2026-08-01T08:02:00.000Z" });
    const result = normalizeConversations([
      fixture({ label: "cwd", sequence: 1, eventType: "session.started", sessionId: "a", cwd: "/repo" }),
      fixture({ label: "project", sequence: 2, eventType: "user.prompted", sessionId: "a", projectHint: "project-1", occurredAt: "2026-08-01T08:01:00.000Z" }),
      next,
    ], { asOf: "2026-08-01T08:03:00.000Z" });

    expect(result.sessions[0]).toMatchObject({ contextKey: "project:project-1", closeReason: "NEXT_SESSION" });
  });

  it("closes inactive Sessions and active Turns at the deterministic timeout instant", () => {
    const result = normalizeConversations([
      fixture({ label: "prompt", sequence: 1, eventType: "user.prompted", turnId: "turn-1" }),
    ], { asOf: "2026-08-01T08:00:10.000Z", inactivityTimeoutMs: 5_000 });

    expect(result.sessions[0]).toMatchObject({
      closeReason: "INACTIVITY_TIMEOUT",
      closedAt: "2026-08-01T08:00:05.000Z",
    });
    expect(result.sessions[0]?.turns[0]).toMatchObject({ closeReason: "SESSION_CLOSED", endedAt: "2026-08-01T08:00:05.000Z" });
  });

  it("allows successor inference to be disabled independently of timeout", () => {
    const result = normalizeConversations([
      fixture({ label: "first", sequence: 1, eventType: "user.prompted", sessionId: "a", cwd: "/repo" }),
      fixture({ label: "next", sequence: 2, eventType: "session.started", sessionId: "b", cwd: "/repo", occurredAt: "2026-08-01T08:01:00.000Z" }),
    ], { asOf: "2026-08-01T08:02:00.000Z", closeFromNextSession: false });

    expect(result.sessions[0]?.status).toBe("OPEN");
  });

  it("reports multiple SessionEnd events but still creates one Session", () => {
    const firstEnd = fixture({ label: "end-1", sequence: 2, eventType: "session.ended", occurredAt: "2026-08-01T08:00:01.000Z" });
    const secondEnd = fixture({ label: "end-2", sequence: 3, eventType: "session.ended", occurredAt: "2026-08-01T08:00:02.000Z" });
    const result = normalizeConversations([
      fixture({ label: "prompt", sequence: 1, eventType: "user.prompted", turnId: "turn-1" }),
      secondEnd,
      firstEnd,
    ], { asOf: openAsOf });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.closedAt).toBe(secondEnd.event.occurredAt);
    expect(result.diagnostics).toEqual([{
      code: "MULTIPLE_SESSION_END",
      sessionId: "session-1",
      eventId: secondEnd.event.eventId,
      sourceOrder: 3,
    }]);
  });

  it("creates a deterministic orphan Turn for work before a prompt", () => {
    const tool = fixture({ label: "orphan", sequence: 1, eventType: "tool.completed" });
    const first = normalizeConversations([tool], { asOf: openAsOf });
    const second = normalizeConversations([tool], { asOf: openAsOf });

    expect(first.sessions[0]?.turns[0]).toMatchObject({ syntheticId: true, status: "OPEN" });
    expect(first.sessions[0]?.turns[0]?.turnId).toBe(second.sessions[0]?.turns[0]?.turnId);
  });

  it("collects sources deterministically across Hook and transcript events", () => {
    const result = normalizeConversations([
      fixture({ label: "transcript", sequence: 2, eventType: "user.prompted", source: "codex-transcript" }),
      fixture({ label: "hook", sequence: 1, eventType: "session.started", source: "codex-hook" }),
    ], { asOf: openAsOf });

    expect(result.sessions[0]?.sources).toEqual(["codex-hook", "codex-transcript"]);
  });

  it("diagnoses duplicate source order deterministically", () => {
    const left = fixture({ label: "a", sequence: 1, eventType: "user.prompted", turnId: "turn-1" });
    const right = fixture({ label: "z", sequence: 1, eventType: "tool.completed", turnId: "turn-1" });
    const first = normalizeConversations([right, left], { asOf: openAsOf });
    const replay = normalizeConversations([left, right], { asOf: openAsOf });

    expect(first).toEqual(replay);
    expect(first.diagnostics).toHaveLength(1);
    expect(first.diagnostics[0]?.eventId).toBe([left.event.eventId, right.event.eventId].sort()[1]);
  });

  it("validates options and ledger ordering fields", () => {
    expect(() => normalizeConversations([], { asOf: "invalid" })).toThrow("asOf");
    expect(() => normalizeConversations([], { asOf: "2026-02-30T08:00:00.000Z" })).toThrow("asOf");
    expect(() => normalizeConversations([], { asOf: "2026-08-01T25:00:00.000Z" })).toThrow("asOf");
    expect(() => normalizeConversations([], { asOf: openAsOf, inactivityTimeoutMs: 0 })).toThrow("inactivityTimeoutMs");
    expect(() => normalizeConversations([], { asOf: openAsOf, inactivityTimeoutMs: 366 * 24 * 60 * 60 * 1_000 })).toThrow(
      "inactivityTimeoutMs",
    );
    expect(() => normalizeConversations([], {
      asOf: openAsOf,
      closeFromNextSession: "yes" as unknown as boolean,
    })).toThrow("closeFromNextSession");
    expect(() => normalizeConversations([{ ...fixture({ label: "sequence", sequence: 1, eventType: "user.prompted" }), sequence: 0 }], {
      asOf: openAsOf,
    })).toThrow("ledger sequence");
    const invalidTime = fixture({ label: "time", sequence: 1, eventType: "user.prompted" });
    expect(() => normalizeConversations([{
      ...invalidTime,
      event: { ...invalidTime.event, occurredAt: "invalid" },
    }], { asOf: openAsOf })).toThrow("invalid occurredAt");
  });

  it("returns frozen, empty output for an empty ledger", () => {
    const result = normalizeConversations([], { asOf: openAsOf });
    expect(result).toEqual({ sessions: [], diagnostics: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sessions)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  it("normalizes real SQLite ledger records without duplicating a Turn", () => {
    const ledger = new SqliteEventLedger(":memory:");
    try {
      const prompt = fixture({ label: "ledger-prompt", sequence: 1, eventType: "user.prompted", turnId: "turn-1" }).event;
      const transcriptStop = fixture({
        label: "ledger-transcript-stop",
        sequence: 2,
        eventType: "turn.stopped",
        turnId: "turn-1",
        source: "codex-transcript",
        occurredAt: "2026-08-01T08:00:02.000Z",
      }).event;
      const hookStop = fixture({
        label: "ledger-hook-stop",
        sequence: 3,
        eventType: "turn.stopped",
        turnId: "turn-1",
        occurredAt: "2026-08-01T08:00:01.000Z",
      }).event;
      ledger.appendBatch([prompt, transcriptStop, hookStop]);

      const result = normalizeConversations(ledger.readAfter(0), { asOf: openAsOf });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.turns).toHaveLength(1);
      expect(result.sessions[0]?.turns[0]).toMatchObject({ stopEventCount: 2, closeReason: "STOP_EVENT" });
      expect(result.sessions[0]?.turns[0]?.events.map((event) => event.eventId)).toEqual([
        prompt.eventId,
        hookStop.eventId,
        transcriptStop.eventId,
      ]);
    } finally {
      ledger.close();
    }
  });
});
