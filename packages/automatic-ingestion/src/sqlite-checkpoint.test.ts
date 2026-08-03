import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteAutomaticIngestionCheckpointStore } from "./sqlite-checkpoint.js";
import type { AutomaticIngestionCheckpoint } from "./types.js";

const stores: SqliteAutomaticIngestionCheckpointStore[] = [];
const directories: string[] = [];

function checkpoint(sessionId: string, version: number, nextEligibleAt: string): AutomaticIngestionCheckpoint {
  return {
    schemaVersion: 1,
    sessionId,
    version,
    source: "CODEX_TRANSCRIPT",
    safeSourceAlias: `session-${sessionId}`,
    sourceRevision: `revision-${version}`,
    lastObservedActivityAt: "2026-08-03T00:00:00.000Z",
    status: "FOLLOW_PENDING",
    nextEligibleAt,
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteAutomaticIngestionCheckpointStore", () => {
  it("persists CAS versions across restart and rejects stale writers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-ingestion-checkpoint-"));
    directories.push(directory);
    const filename = join(directory, "ingestion.sqlite");
    const first = new SqliteAutomaticIngestionCheckpointStore(filename);
    expect(await first.compareAndSwap("one", undefined, checkpoint("one", 1, "2026-08-03T00:00:01.000Z"))).toBe("COMMITTED");
    expect(await first.compareAndSwap("one", undefined, checkpoint("one", 1, "2026-08-03T00:00:02.000Z"))).toBe("CONFLICT");
    first.close();

    const second = new SqliteAutomaticIngestionCheckpointStore(filename);
    stores.push(second);
    expect((await second.load("one"))?.version).toBe(1);
    expect(await second.compareAndSwap("one", 1, checkpoint("one", 2, "2026-08-03T00:00:02.000Z"))).toBe("COMMITTED");
    expect(await second.compareAndSwap("one", 1, checkpoint("one", 2, "2026-08-03T00:00:03.000Z"))).toBe("CONFLICT");
  });

  it("returns bounded due work in deterministic order", async () => {
    const store = new SqliteAutomaticIngestionCheckpointStore(":memory:");
    stores.push(store);
    await store.compareAndSwap("later", undefined, checkpoint("later", 1, "2026-08-03T00:00:02.000Z"));
    await store.compareAndSwap("b", undefined, checkpoint("b", 1, "2026-08-03T00:00:01.000Z"));
    await store.compareAndSwap("a", undefined, checkpoint("a", 1, "2026-08-03T00:00:01.000Z"));
    const due = await store.listEligible({ atOrBefore: "2026-08-03T00:00:01.000Z", limit: 2, statuses: ["FOLLOW_PENDING"] });
    expect(due.map(({ sessionId }) => sessionId)).toEqual(["a", "b"]);
  });

  it("fails closed on malformed checkpoint and queries", async () => {
    const store = new SqliteAutomaticIngestionCheckpointStore(":memory:");
    stores.push(store);
    await expect(store.compareAndSwap("different", undefined, checkpoint("one", 1, "2026-08-03T00:00:01.000Z"))).resolves.toBe("CONFLICT");
    await expect(store.listEligible({ atOrBefore: "invalid", limit: 1, statuses: ["FOLLOW_PENDING"] })).rejects.toThrow("invalid");
    await expect(store.listEligible({ atOrBefore: "2026-08-03T00:00:00.000Z", limit: 1, statuses: [] })).rejects.toThrow("statuses");
    store.close();
    await expect(store.load("one")).rejects.toThrow("closed");
  });
});
