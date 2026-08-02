import { describe, expect, it } from "vitest";

import { SqliteBackfillCheckpointStore } from "./checkpoint.js";

const HASH = "a".repeat(64);
const NOW = "2026-08-02T09:00:00.000Z";

describe("SqliteBackfillCheckpointStore", () => {
  it("creates one active run, resumes it, fences the cursor, and completes it", () => {
    const store = new SqliteBackfillCheckpointStore(":memory:", { clock: () => new Date(NOW), runIdFactory: () => "run-1" });
    const first = store.startOrResume(HASH, "scope-1");
    const resumed = store.startOrResume(HASH, "scope-1");
    expect(first).toMatchObject({ resumed: false, checkpoint: { runId: "run-1", status: "RUNNING" } });
    expect(resumed).toMatchObject({ resumed: true, checkpoint: { runId: "run-1" } });
    store.advance("run-1", undefined, "cursor-1");
    expect(store.get("run-1")).toMatchObject({ cursor: "cursor-1" });
    expect(() => store.advance("run-1", undefined, "cursor-2")).toThrow("revision conflict");
    store.advance("run-1", "cursor-1", undefined);
    store.complete("run-1", undefined);
    expect(store.get("run-1")).toMatchObject({ status: "COMPLETED", completedAt: NOW });
    expect(() => store.markThread("run-1", "thread-1", "PROCESSING")).toThrow("completed");
    store.close();
    store.close();
    expect(() => store.get("run-1")).toThrow("closed");
  });

  it("tracks resumable and terminal per-thread state without allowing terminal rewrites", () => {
    const store = new SqliteBackfillCheckpointStore(":memory:", { runIdFactory: () => "run-2" });
    store.startOrResume(HASH, "scope-2");
    expect(store.threadStatus("run-2", "thread-1")).toBeUndefined();
    store.markThread("run-2", "thread-1", "PROCESSING");
    store.markThread("run-2", "thread-1", "PROCESSING");
    store.markThread("run-2", "thread-1", "COMPLETED");
    store.markThread("run-2", "thread-1", "COMPLETED");
    expect(store.threadStatus("run-2", "thread-1")).toBe("COMPLETED");
    expect(() => store.markThread("run-2", "thread-1", "SKIPPED", "SHORT_SESSION")).toThrow("cannot be changed");
    store.markThread("run-2", "thread-2", "SKIPPED", "SENSITIVE_SESSION");
    expect(store.threadStatus("run-2", "thread-2")).toBe("SKIPPED");
    store.close();
  });

  it("validates identities, hashes, reasons, clocks, and active scope consistency", () => {
    const store = new SqliteBackfillCheckpointStore(":memory:", { runIdFactory: () => "bad id" });
    expect(() => store.startOrResume("bad", "scope")).toThrow("SHA-256");
    expect(() => store.startOrResume(HASH, "")).toThrow("scopeKey");
    expect(() => store.startOrResume(HASH, "scope")).toThrow("runIdFactory");
    store.close();

    const valid = new SqliteBackfillCheckpointStore(":memory:", { runIdFactory: () => "run-valid" });
    valid.startOrResume(HASH, "scope");
    expect(() => valid.startOrResume(HASH, "other-scope")).toThrow("scope conflicts");
    expect(() => valid.threadStatus("bad id", "thread")).toThrow("invalid");
    expect(() => valid.markThread("run-valid", "thread", "SKIPPED")).toThrow("skip reason");
    expect(() => valid.markThread("run-valid", "thread", "PROCESSING", "SHORT_SESSION")).toThrow("skip reason");
    expect(() => valid.get("missing")).toThrow("unknown");
    valid.close();

    const badClock = new SqliteBackfillCheckpointStore(":memory:", { clock: () => new Date(Number.NaN), runIdFactory: () => "run-clock" });
    expect(() => badClock.startOrResume("b".repeat(64), "scope")).toThrow("clock");
    badClock.close();
  });
});
