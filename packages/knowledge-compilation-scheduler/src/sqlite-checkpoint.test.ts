import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteKnowledgeCompilationCheckpointStore } from "./sqlite-checkpoint.js";
import type { KnowledgeCompilationCheckpoint } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

function checkpoint(version = 1, overrides: Partial<KnowledgeCompilationCheckpoint> = {}): KnowledgeCompilationCheckpoint {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    version,
    lastObservedLedgerSequence: 20,
    lastObservedEventCount: 5,
    lastObservedTurnCount: 3,
    lastCompiledLedgerSequence: 10,
    lastCompiledEventCount: 2,
    lastCompiledTurnCount: 1,
    firstPendingObservedAt: "2026-08-18T10:00:00.000Z",
    lastActivityAt: "2026-08-18T10:01:00.000Z",
    sourceVersion: "source-v1",
    nextEligibleAt: "2026-08-18T10:03:00.000Z",
    status: "WAITING_IDLE",
    lastReasonCode: "WAITING_FOR_TRIGGER",
    updatedAt: "2026-08-18T10:01:00.000Z",
    ...overrides,
  };
}

describe("SqliteKnowledgeCompilationCheckpointStore", () => {
  it("commits with compare-and-swap and lists due checkpoints", async () => {
    const store = new SqliteKnowledgeCompilationCheckpointStore(":memory:");
    await expect(store.compareAndSwap("session-1", undefined, checkpoint())).resolves.toBe("COMMITTED");
    await expect(store.compareAndSwap("session-1", undefined, checkpoint())).resolves.toBe("CONFLICT");
    const winner = checkpoint(2, { status: "RETRY_WAIT", lastReasonCode: "DISPATCH_RETRYABLE" });
    const loser = checkpoint(2, { status: "FAILED", lastReasonCode: "DISPATCH_FAILED" });
    await expect(store.compareAndSwap("session-1", 1, winner)).resolves.toBe("COMMITTED");
    await expect(store.compareAndSwap("session-1", 1, loser)).resolves.toBe("CONFLICT");
    await expect(store.listDue({ atOrBefore: "2026-08-18T10:04:00.000Z", limit: 10 }))
      .resolves.toEqual([winner]);
    store.close();
  });

  it("recovers after restart and rejects corrupt persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-compilation-"));
    directories.push(directory);
    const filename = join(directory, "checkpoints.sqlite");
    const first = new SqliteKnowledgeCompilationCheckpointStore(filename);
    await first.compareAndSwap("session-1", undefined, checkpoint());
    first.close();

    const second = new SqliteKnowledgeCompilationCheckpointStore(filename);
    await expect(second.load("session-1")).resolves.toEqual(checkpoint());
    second.close();

    const database = new DatabaseSync(filename);
    database.prepare("UPDATE knowledge_compilation_checkpoints SET checkpoint_json = ? WHERE session_id = ?")
      .run(JSON.stringify({ schemaVersion: 999 }), "session-1");
    database.close();
    const corrupt = new SqliteKnowledgeCompilationCheckpointStore(filename);
    await expect(corrupt.load("session-1")).rejects.toThrow("invalid");
    corrupt.close();
  });
});
