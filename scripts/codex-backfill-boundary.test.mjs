import assert from "node:assert/strict";
import test from "node:test";

import { CodexBackfillService, SqliteBackfillCheckpointStore } from "../packages/codex-backfill/dist/index.js";
import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";

const cwd = "/workspace/backfill";
const historicalThread = {
  id: "thread-history-1", sessionId: "thread-history-1", preview: "Implement history import", cwd,
  createdAt: 1785643200, updatedAt: 1785643202, cliVersion: "0.144.4", modelProvider: "openai",
  ephemeral: false, source: "cli", turns: [1, 2].map((ordinal) => ({
    id: `turn-${ordinal}`, status: "completed", itemsView: "full", error: null,
    startedAt: 1785643200 + ordinal, completedAt: 1785643200 + ordinal + 0.5, durationMs: 500,
    items: [
      { type: "userMessage", id: `user-${ordinal}`, content: [{ type: "text", text: `request ${ordinal}`, text_elements: [] }] },
      { type: "agentMessage", id: `agent-${ordinal}`, text: `answer ${ordinal}`, phase: "final_answer", memoryCitation: null },
    ],
  })),
};
const summary = {
  id: historicalThread.id, preview: historicalThread.preview, cwd: historicalThread.cwd,
  createdAt: historicalThread.createdAt, updatedAt: historicalThread.updatedAt,
  cliVersion: historicalThread.cliVersion,
};
const history = {
  listThreads: async () => ({ data: [summary] }),
  readThread: async () => historicalThread,
};

test("CKL-702: dry-run is side-effect free and explicit backfill reaches the immutable Ledger", async () => {
  const ledger = new SqliteEventLedger(":memory:");
  const scope = { level: "PROJECT", projectId: "project-history", cwd };
  const preview = await new CodexBackfillService(history).execute({ scope });
  assert.equal(preview.status, "DRY_RUN");
  assert.equal(preview.eligibleThreads, 1);
  assert.equal(ledger.count(), 0);

  const checkpoints = new SqliteBackfillCheckpointStore(":memory:", { runIdFactory: () => "run-history-1" });
  const applied = await new CodexBackfillService(history, { checkpoint: checkpoints, eventSink: ledger }).execute({ scope, dryRun: false });
  assert.equal(applied.status, "COMPLETED");
  assert.equal(applied.processedThreads, 1);
  assert.equal(applied.appendedEvents, 5);
  assert.equal(ledger.count(), 5);
  assert.equal(checkpoints.get("run-history-1").status, "COMPLETED");
  checkpoints.close();
  ledger.close();
});
