import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";
import { CodexAppServerEventAdapter } from "../packages/ingestion-codex/dist/index.js";

const fixtureUrl = new URL("../test-fixtures/codex-app-server/v2/stream.jsonl", import.meta.url);

async function fixture() {
  return (await readFile(fixtureUrl, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

function collect(notifications, observedAt) {
  const adapter = new CodexAppServerEventAdapter({ observedAt, sourceVersion: "0.144.4" });
  return notifications.flatMap((notification) => {
    const result = adapter.adapt(notification);
    assert.equal(result.ok, true);
    return result.value.events;
  });
}

test("CKL-701: reconnect replay is deterministic and does not duplicate App Server events in the Ledger", async () => {
  const notifications = await fixture();
  const firstConnection = collect(notifications, "2026-08-02T08:00:02.000Z");
  const secondConnection = collect(notifications, "2026-08-02T09:00:02.000Z");
  assert.equal(firstConnection.length, 5);
  assert.deepEqual(firstConnection.map((event) => event.eventId), secondConnection.map((event) => event.eventId));

  const ledger = new SqliteEventLedger(":memory:");
  assert.deepEqual(firstConnection.map((event) => ledger.append(event).status), Array(5).fill("appended"));
  assert.deepEqual(secondConnection.map((event) => ledger.append(event).status), Array(5).fill("duplicate"));
  assert.equal(ledger.count(), 5);
  ledger.close();
});
