import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { normalizeConversations } from "../packages/conversation-normalizer/dist/index.js";
import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";
import { CodexHookHandler, LocalEventSpool, runCodexHookCommand } from "../packages/hook-runtime/dist/index.js";
import { adaptCodexHook } from "../packages/ingestion-codex/dist/index.js";

const fixturePath = path.resolve("fixtures/p1/codex-hook-session.jsonl");

async function loadFixture() {
  const lines = (await readFile(fixturePath, "utf8")).trim().split("\n");
  return lines.map((line, index) => {
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed.observedAt, "string", `fixture line ${index + 1} observedAt`);
    assert.equal(typeof parsed.hook, "object", `fixture line ${index + 1} hook`);
    return parsed;
  });
}

function adaptFixture(rows) {
  return rows.map((row, index) => {
    const result = adaptCodexHook(row.hook, { observedAt: row.observedAt });
    assert.equal(result.ok, true, `fixture line ${index + 1} must adapt`);
    return result.value;
  });
}

test("P1 Gate: recorded fixture is idempotent across three Ledger replays and fully traceable", async () => {
  const rows = await loadFixture();
  const events = adaptFixture(rows);
  const expectedEventCount = new Set(events.map((event) => event.eventId)).size;
  assert.equal(rows.length, 5);
  assert.equal(expectedEventCount, 4, "the repeated Stop must collapse to one event identity");
  const ledger = new SqliteEventLedger(":memory:");
  try {
    for (let replay = 0; replay < 3; replay += 1) {
      ledger.appendBatch(events);
      assert.equal(ledger.count(), expectedEventCount, `replay ${replay + 1} must not add duplicate rows`);
    }

    const records = ledger.readAfter(0, 100);
    const normalized = normalizeConversations(records, { asOf: "2026-08-01T08:10:00.000Z" });
    assert.equal(normalized.sessions.length, 1);
    assert.equal(normalized.sessions[0].turns.length, 1);
    assert.equal(normalized.sessions[0].status, "CLOSED");
    assert.equal(normalized.sessions[0].turns[0].status, "CLOSED");

    const turnEventIds = new Set(normalized.sessions.flatMap((session) => (
      session.turns.flatMap((turn) => turn.events.map((event) => event.eventId))
    )));
    const sessionEventIds = new Set(normalized.sessions.flatMap((session) => (
      session.sessionEvents.map((event) => event.eventId)
    )));
    for (const record of records) {
      assert.equal(record.event.source, "codex-hook");
      assert.equal(record.event.sessionId, "p1-session");
      assert.ok(
        turnEventIds.has(record.event.eventId) || sessionEventIds.has(record.event.eventId),
        `${record.event.eventId} must trace to a normalized Turn or Session boundary`,
      );
    }
  } finally {
    ledger.close();
  }
});

test("P1 Gate: total Daemon failure does not interrupt the simulated Codex Hook flow", async () => {
  const rows = await loadFixture();
  const expectedEvents = adaptFixture(rows);
  const expectedEventCount = new Set(expectedEvents.map((event) => event.eventId)).size;
  assert.equal(rows.length, 5);
  assert.equal(expectedEventCount, 4);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-p1-gate-"));
  const spool = new LocalEventSpool(path.join(temporaryRoot, "spool"));
  let completedHooks = 0;
  try {
    for (const row of rows) {
      const handler = new CodexHookHandler({
        sink: { enqueue: async () => { throw new Error("simulated daemon outage"); } },
        spool,
        adapterOptions: { observedAt: row.observedAt },
      });
      const command = await runCodexHookCommand(Readable.from([JSON.stringify(row.hook)]), handler);
      assert.equal(command.exitCode, 0);
      assert.equal(command.capture.status, "spooled");
      completedHooks += 1;
    }
    assert.equal(completedHooks, rows.length, "all simulated Codex hooks must continue");

    const ledger = new SqliteEventLedger(":memory:");
    try {
      const recovered = await spool.drain({
        enqueue: async (event) => { ledger.append(event); },
      });
      assert.equal(recovered.stopReason, null);
      assert.equal(recovered.remaining, 0);
      assert.equal(recovered.delivered, expectedEventCount);
      assert.equal(ledger.count(), expectedEventCount);
      const serializedPayloads = JSON.stringify(ledger.readAfter(0).map((record) => record.event.payload));
      assert.doesNotMatch(serializedPayloads, /fixture-token-value/);
      assert.match(serializedPayloads, /\[REDACTED\]/);
    } finally {
      ledger.close();
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
