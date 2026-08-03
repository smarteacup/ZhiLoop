import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteKnowledgeWorkerCheckpointStore } from "./checkpoint-store.js";
import { KnowledgeWorkerCheckpointConflictError } from "./errors.js";
import { WORKER_STAGES, type KnowledgeWorkerCheckpoint } from "./types.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkpoint(): KnowledgeWorkerCheckpoint {
  const stages = Object.fromEntries(WORKER_STAGES.map((stage) => [stage, { status: "PENDING", attempts: 0 }])) as
    KnowledgeWorkerCheckpoint["stages"];
  return {
    schemaVersion: 1,
    workId: "work-1",
    identityHash: "identity",
    revision: 0,
    status: "RUNNING",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    stages,
    payload: {},
  };
}

describe("SqliteKnowledgeWorkerCheckpointStore", () => {
  it("persists checkpoints across store restarts and enforces CAS", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-checkpoint-"));
    directories.push(directory);
    const databasePath = path.join(directory, "worker.sqlite");
    const initial = checkpoint();
    using first = new SqliteKnowledgeWorkerCheckpointStore(databasePath);
    first.create(initial);
    first.save({ ...initial, revision: 1, updatedAt: "2026-08-01T00:00:01.000Z" }, 0);
    first.close();

    using reopened = new SqliteKnowledgeWorkerCheckpointStore(databasePath);
    expect(reopened.load("work-1")?.revision).toBe(1);
    expect(() => reopened.save({ ...initial, revision: 1 }, 0)).toThrow(KnowledgeWorkerCheckpointConflictError);
    expect(() => reopened.create(initial)).toThrow(KnowledgeWorkerCheckpointConflictError);
  });
});
