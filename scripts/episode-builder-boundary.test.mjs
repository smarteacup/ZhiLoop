import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeConversations } from "../packages/conversation-normalizer/dist/index.js";
import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";
import { buildEpisodes } from "../packages/episode-builder/dist/index.js";

const builderSource = "packages/episode-builder/src/builder.ts";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function event(label, eventType, occurredAt, turnId, payload) {
  return {
    schemaVersion: 1,
    eventId: hash(`event:${label}`),
    source: "codex-hook",
    sourceItemId: label,
    eventType,
    sessionId: "episode-e2e",
    ...(turnId === undefined ? {} : { turnId }),
    occurredAt,
    cwd: "/workspace/zhiloop",
    contentHash: hash(`content:${label}`),
    correlationId: hash("episode-e2e"),
    payload,
  };
}

test("Episode Builder uses the Ledger only as a compile-time port", async () => {
  const source = await readFile(builderSource, "utf8");
  assert.match(source, /import\s+type\s+\{\s*LedgerEventRecord\s*\}\s+from\s+["']@zhiloop\/conversation-ledger["']/);
  assert.doesNotMatch(source, /import\s+\{[^}]*\}\s+from\s+["']@zhiloop\/conversation-ledger["']/);
  assert.doesNotMatch(source, /node:sqlite|SqliteEventLedger|OpenAI|model/i);
});

test("CKL-201: an Episode is fully rebuildable from SQLite Ledger evidence", () => {
  const events = [
    event("start", "session.started", "2026-08-01T08:00:00.000Z", undefined, { kind: "session-started" }),
    event("prompt", "user.prompted", "2026-08-01T08:00:01.000Z", "turn-1", { kind: "user-prompt", prompt: "实现 Episode Builder" }),
    event("stop", "turn.stopped", "2026-08-01T08:00:02.000Z", "turn-1", { kind: "turn-stopped", stopHookActive: false, lastAssistantMessage: "实现完成" }),
    event("end", "session.ended", "2026-08-01T08:00:03.000Z", undefined, { kind: "session-ended", reason: "other" }),
  ];
  const ledger = new SqliteEventLedger(":memory:", { clock: () => new Date("2026-08-01T09:00:00.000Z") });
  try {
    ledger.appendBatch(events);
    const records = ledger.readAfter(0, 100);
    const normalized = normalizeConversations(records, { asOf: "2026-08-01T08:10:00.000Z" });
    const first = buildEpisodes(records, normalized.sessions);
    const replay = buildEpisodes(ledger.readAfter(0, 100), normalized.sessions);

    assert.deepEqual(replay, first);
    assert.equal(first.episodes.length, 1);
    assert.equal(first.episodes[0].builderVersion, "episode-builder-v2");
    assert.equal(first.episodes[0].goal, "实现 Episode Builder");
    assert.deepEqual(first.episodes[0].userStatements, [{
      turnId: first.episodes[0].turnIds[0],
      sourceEventId: records[1].event.eventId,
      kind: "GOAL",
      statement: "实现 Episode Builder",
      occurredAt: "2026-08-01T08:00:01.000Z",
    }]);
    assert.equal(first.episodes[0].status, "COMPLETED");
    assert.deepEqual(first.episodes[0].evidenceRefs, records.map((record) => record.event.eventId));
  } finally {
    ledger.close();
  }
});
