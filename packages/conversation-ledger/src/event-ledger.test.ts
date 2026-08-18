import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventEnvelope } from "@zhiloop/domain";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventLedger } from "./event-ledger.js";

const temporaryDirectories: string[] = [];
const CLOCK = () => new Date("2026-08-01T12:00:00.000Z");

function event(index: number, payload: unknown = { message: `event-${index}` }): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${index}`,
    source: "codex-hook",
    sourceItemId: `source-${index}`,
    eventType: "tool.completed",
    sessionId: "session-ledger-1",
    turnId: `turn-${Math.floor(index / 10)}`,
    occurredAt: new Date(Date.UTC(2026, 7, 1, 10, 0, index % 60)).toISOString(),
    cwd: "/workspace/sample-project",
    contentHash: `original-content-hash-${index}`,
    correlationId: `correlation-${Math.floor(index / 10)}`,
    payload,
  };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "zhiloop-ledger-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "ledger.db");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite Event Ledger", () => {
  it("appends an event idempotently", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    expect(ledger.append(event(1))).toEqual({ status: "appended", sequence: 1, redactionCount: 0 });
    expect(ledger.append(event(1))).toEqual({ status: "duplicate", sequence: 1 });
    expect(ledger.count()).toBe(1);
    expect(ledger.readAfter(0)).toMatchObject([
      {
        sequence: 1,
        event: { eventId: "event-1", payload: { message: "event-1" } },
        payloadPurged: false,
        insertedAt: "2026-08-01T12:00:00.000Z",
      },
    ]);
    ledger.close();
  });

  it("reports a session-local latest sequence without coupling it to unrelated writes", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    expect(ledger.latestSequenceForSession("session-ledger-1")).toBe(0);
    expect(ledger.append(event(1))).toMatchObject({ sequence: 1 });
    expect(ledger.append({ ...event(2), sessionId: "session-ledger-2" })).toMatchObject({ sequence: 2 });
    expect(ledger.latestSequenceForSession("session-ledger-1")).toBe(1);
    expect(ledger.latestSequenceForSession("session-ledger-2")).toBe(2);
    expect(() => ledger.latestSequenceForSession("")).toThrow("sessionId");
    ledger.close();
  });

  it("reports bounded session stats without reading payloads", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    ledger.append({ ...event(1), turnId: "turn-1", eventType: "user.prompted" });
    ledger.append({ ...event(2), turnId: "turn-1", eventType: "turn.stopped" });
    ledger.append({ ...event(3), turnId: "turn-2", eventType: "session.ended" });
    ledger.append({ ...event(4), sessionId: "session-ledger-2", turnId: "other-turn" });
    expect(ledger.sessionStats("session-ledger-1")).toEqual({
      sessionId: "session-ledger-1",
      latestSequence: 3,
      eventCount: 3,
      turnCount: 2,
      latestEventType: "session.ended",
      lastOccurredAt: "2026-08-01T10:00:03.000Z",
    });
    expect(ledger.sessionStats("missing")).toEqual({
      sessionId: "missing",
      latestSequence: 0,
      eventCount: 0,
      turnCount: 0,
    });
    ledger.close();
  });

  it("writes and reads a batch of 1000 events in sequence order", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    const results = ledger.appendBatch(Array.from({ length: 1000 }, (_, index) => event(index + 1)));
    expect(results).toHaveLength(1000);
    expect(results.every((result) => result.status === "appended")).toBe(true);
    expect(ledger.readAfter(0, 1000)).toHaveLength(1000);
    expect(ledger.readAfter(995, 10).map((record) => record.event.eventId)).toEqual([
      "event-996",
      "event-997",
      "event-998",
      "event-999",
      "event-1000",
    ]);
    ledger.close();
  });

  it("rolls back the whole batch when any event is invalid", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    const invalid = { ...event(2), schemaVersion: 2 } as unknown as EventEnvelope;
    expect(() => ledger.appendBatch([event(1), invalid])).toThrow("unsupported event schemaVersion");
    expect(ledger.count()).toBe(0);
    ledger.close();
  });

  it("rejects an eventId collision with different content and rolls back the transaction", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    const first = event(1);
    const conflicting = { ...event(2, { message: "different" }), eventId: first.eventId };
    expect(() => ledger.appendBatch([first, conflicting])).toThrow("eventId conflict");
    expect(ledger.count()).toBe(0);
    ledger.close();
  });

  it("allows a repeated observation time but rejects identity metadata collisions", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    const first = event(1);
    expect(ledger.append(first).status).toBe("appended");
    expect(ledger.append({ ...first, occurredAt: "2026-08-01T11:00:00.000Z" })).toEqual({
      status: "duplicate",
      sequence: 1,
    });
    expect(() => ledger.append({ ...first, eventType: "file.changed" })).toThrow("eventId conflict");
    expect(ledger.count()).toBe(1);
    ledger.close();
  });

  it("redacts secret keys and token patterns before persistence", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    const original = event(1, {
      password: "plain-password",
      nested: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        "x-api-key": "header-secret",
        command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://example.test",
        apiKeyHint: "not-secret-by-key-name",
      },
      tokens: ["sk-abcdefghijklmnopqrstuvwxyz123456", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
    });
    const appended = ledger.append(original);
    expect(appended).toMatchObject({ status: "appended", redactionCount: 6 });
    const record = ledger.readAfter(0)[0];
    expect(record?.event.payload).toEqual({
      password: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        "x-api-key": "[REDACTED]",
        command: "curl -H 'Authorization: [REDACTED]' https://example.test",
        apiKeyHint: "not-secret-by-key-name",
      },
      tokens: ["[REDACTED]", "[REDACTED]"],
    });
    expect(record?.event.contentHash).toBe(original.contentHash);
    expect(record?.storedPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain("plain-password");
    expect(JSON.stringify(record)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    ledger.close();
  });

  it("rejects non-JSON and cyclic payloads", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => ledger.append(event(1, cyclic))).toThrow("cyclic reference");
    expect(() => ledger.append(event(2, { date: new Date() }))).toThrow("non-JSON object");
    expect(() => ledger.append(event(3, { value: Number.NaN }))).toThrow("non-finite number");
    expect(() => ledger.append(event(4, { value: undefined }))).toThrow("non-JSON value");
    expect(ledger.count()).toBe(0);
    ledger.close();
  });

  it("detects stored payload corruption before returning an event", async () => {
    const filename = await databasePath();
    const ledger = new SqliteEventLedger(filename, { clock: CLOCK });
    ledger.append(event(1));
    ledger.close();

    const database = new DatabaseSync(filename);
    database.prepare("UPDATE events SET payload_json = ? WHERE event_id = ?").run('{"message":"tampered"}', "event-1");
    database.close();

    const reopened = new SqliteEventLedger(filename, { clock: CLOCK });
    expect(() => reopened.readAfter(0)).toThrow("integrity verification");
    reopened.close();
  });

  it("refuses a database created by a newer migration", async () => {
    const filename = await databasePath();
    const database = new DatabaseSync(filename);
    database.exec("PRAGMA user_version = 2");
    database.close();
    expect(() => new SqliteEventLedger(filename, { clock: CLOCK })).toThrow("newer than supported");
  });

  it("restricts an on-disk ledger to the current user", async () => {
    const filename = await databasePath();
    const ledger = new SqliteEventLedger(filename, { clock: CLOCK });
    ledger.append(event(1));
    if (process.platform !== "win32") {
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      expect((await stat(`${filename}-wal`)).mode & 0o077).toBe(0);
    }
    ledger.close();
  });
});

describe("consumer cursors and replay", () => {
  it("replays events after a crash until the cursor is committed", async () => {
    const filename = await databasePath();
    const writer = new SqliteEventLedger(filename, { clock: CLOCK });
    writer.appendBatch([event(1), event(2), event(3)]);
    const firstDelivery = writer.readForConsumer("episode-builder");
    expect(firstDelivery.map((record) => record.event.eventId)).toEqual(["event-1", "event-2", "event-3"]);
    writer.close();

    const restarted = new SqliteEventLedger(filename, { clock: CLOCK });
    expect(restarted.readForConsumer("episode-builder").map((record) => record.event.eventId)).toEqual([
      "event-1",
      "event-2",
      "event-3",
    ]);
    expect(restarted.commitCursor("episode-builder", 3)).toEqual({
      status: "advanced",
      previousSequence: 0,
      sequence: 3,
    });
    expect(restarted.readForConsumer("episode-builder")).toEqual([]);
    restarted.close();
  });

  it("keeps consumer cursors monotonic and bounded by the ledger", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    ledger.appendBatch([event(1), event(2)]);
    expect(ledger.commitCursor("waiting-worker", 0)).toEqual({ status: "registered", sequence: 0 });
    expect(ledger.commitCursor("waiting-worker", 0)).toEqual({ status: "unchanged", sequence: 0 });
    expect(ledger.commitCursor("worker", 1).status).toBe("advanced");
    expect(ledger.commitCursor("worker", 1)).toEqual({ status: "unchanged", sequence: 1 });
    expect(ledger.commitCursor("worker", 0)).toEqual({
      status: "rejected-rewind",
      currentSequence: 1,
      attemptedSequence: 0,
    });
    expect(() => ledger.commitCursor("worker", 3)).toThrow("beyond the latest event");
    expect(ledger.cursor("worker")).toBe(1);
    ledger.close();
  });

  it("purges only events consumed by every registered consumer", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    ledger.appendBatch([event(1), event(2), event(3)]);
    expect(ledger.purgeOccurredBefore("2026-08-02T00:00:00.000Z")).toEqual({
      purgedPayloads: 0,
      safeThroughSequence: 0,
      blockedByMissingConsumer: true,
      hasMore: false,
    });
    ledger.commitCursor("compiler", 3);
    ledger.commitCursor("observability", 2);
    expect(ledger.purgeOccurredBefore("2026-08-02T00:00:00.000Z", 1)).toEqual({
      purgedPayloads: 1,
      safeThroughSequence: 2,
      blockedByMissingConsumer: false,
      hasMore: true,
    });
    expect(ledger.purgeOccurredBefore("2026-08-02T00:00:00.000Z", 1)).toEqual({
      purgedPayloads: 1,
      safeThroughSequence: 2,
      blockedByMissingConsumer: false,
      hasMore: false,
    });
    expect(ledger.readAfter(0).map((record) => ({ id: record.event.eventId, payload: record.event.payload, purged: record.payloadPurged }))).toEqual([
      { id: "event-1", payload: null, purged: true },
      { id: "event-2", payload: null, purged: true },
      { id: "event-3", payload: { message: "event-3" }, purged: false },
    ]);
    expect(ledger.append(event(1))).toEqual({ status: "duplicate", sequence: 1 });
    expect(ledger.purgeOccurredBefore("2026-08-02T00:00:00.000Z")).toEqual({
      purgedPayloads: 0,
      safeThroughSequence: 2,
      blockedByMissingConsumer: false,
      hasMore: false,
    });
    ledger.close();
  });

  it("rejects invalid cursor, limit, retention, and closed-ledger operations", () => {
    const ledger = new SqliteEventLedger(":memory:", { clock: CLOCK });
    expect(() => ledger.readAfter(-1)).toThrow("sequence");
    expect(() => ledger.readAfter(0, 1001)).toThrow("limit");
    expect(() => ledger.cursor("")).toThrow("consumerId");
    expect(() => ledger.purgeOccurredBefore("not-a-date")).toThrow("cutoff");
    expect(() => ledger.purgeOccurredBefore("2026-08-02T00:00:00.000Z", 1001)).toThrow("limit");
    ledger.close();
    ledger.close();
    expect(() => ledger.count()).toThrow("closed");
    expect(() => ledger.latestSequenceForSession("session-ledger-1")).toThrow("closed");
  });
});

describe("ingestion cursors", () => {
  it("persists and replaces integrity-protected structured cursors without changing migration version", async () => {
    const filename = await databasePath();
    const ledger = new SqliteEventLedger(filename, { clock: CLOCK });
    expect(ledger.loadIngestionCursor("codex-transcript:session-a")).toBeUndefined();
    ledger.commitIngestionCursor("codex-transcript:session-a", { byteOffset: 10, lineNumber: 2 });
    expect(ledger.loadIngestionCursor("codex-transcript:session-a")).toEqual({
      ingestionId: "codex-transcript:session-a",
      cursor: { byteOffset: 10, lineNumber: 2 },
      updatedAt: "2026-08-01T12:00:00.000Z",
    });
    ledger.commitIngestionCursor("codex-transcript:session-a", { byteOffset: 20, lineNumber: 4 });
    ledger.close();

    const reopened = new SqliteEventLedger(filename, { clock: CLOCK });
    expect(reopened.loadIngestionCursor<{ byteOffset: number }>("codex-transcript:session-a")?.cursor.byteOffset).toBe(20);
    expect(reopened.rebaseIngestionCursor("codex-transcript:session-a")).toBe("REBASED");
    expect(reopened.loadIngestionCursor("codex-transcript:session-a")).toBeUndefined();
    expect(reopened.rebaseIngestionCursor("codex-transcript:session-a")).toBe("NOT_FOUND");
    reopened.close();
    const database = new DatabaseSync(filename, { readOnly: true });
    expect((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    database.close();
  });

  it("rejects invalid and oversized cursor state and detects tampering", async () => {
    const filename = await databasePath();
    const ledger = new SqliteEventLedger(filename, { clock: CLOCK });
    expect(() => ledger.commitIngestionCursor("", {})).toThrow("ingestionId");
    expect(() => ledger.commitIngestionCursor("source", null)).toThrow("object");
    expect(() => ledger.commitIngestionCursor("source", { value: "x".repeat(70_000) })).toThrow("64 KiB");
    ledger.commitIngestionCursor("source", { byteOffset: 10 });
    ledger.close();
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE ingestion_cursors SET cursor_json = ? WHERE ingestion_id = ?").run("{}", "source");
    database.close();
    const reopened = new SqliteEventLedger(filename, { clock: CLOCK });
    expect(() => reopened.loadIngestionCursor("source")).toThrow("integrity");
    reopened.close();
  });
});
