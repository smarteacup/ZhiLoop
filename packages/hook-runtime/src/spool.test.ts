import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { EventEnvelope } from "@zhiloop/domain";
import { adaptCodexHook } from "@zhiloop/ingestion-codex";

import { LocalEventSpool, SpoolConflictError } from "./spool.js";
import type { HookEventSink } from "./types.js";

function event(prompt: string, observedAt = "2026-08-01T08:00:00.000Z"): EventEnvelope {
  const result = adaptCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    turn_id: `turn-${prompt}`,
    cwd: "/workspace/project",
    prompt,
  }, { observedAt });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("LocalEventSpool", () => {
  let temporaryRoot: string;
  let spoolDirectory: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-hook-spool-"));
    spoolDirectory = path.join(temporaryRoot, "spool");
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("atomically stores a redacted event in a private directory", async () => {
    const spool = new LocalEventSpool(spoolDirectory, {
      clock: () => new Date("2026-08-01T08:01:00.000Z"),
      randomId: () => "fixed",
    });
    const secret = `Bearer ${"b".repeat(24)}`;
    const stored = await spool.store(event(`credential=${secret}`));

    expect(stored).toMatchObject({ status: "stored" });
    if (stored.status === "stored") expect(stored.redactionCount).toBeGreaterThanOrEqual(1);
    const files = await readdir(spoolDirectory);
    expect(files).toEqual([stored.fileName]);
    const contents = await readFile(path.join(spoolDirectory, stored.fileName), "utf8");
    expect(contents).not.toContain(secret);
    expect(contents).toContain("[REDACTED]");
    expect(contents).toMatch(/"redactionCount":[1-9][0-9]*/);
    if (process.platform !== "win32") {
      expect((await stat(spoolDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(spoolDirectory, stored.fileName))).mode & 0o777).toBe(0o600);
    }
  });

  it("deduplicates identical event IDs and rejects conflicting envelopes", async () => {
    const spool = new LocalEventSpool(spoolDirectory);
    const original = event("same");

    await expect(spool.store(original)).resolves.toMatchObject({ status: "stored" });
    await expect(spool.store(original)).resolves.toMatchObject({ status: "duplicate" });
    expect((await readdir(spoolDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await expect(spool.store({ ...original, payload: { kind: "user-prompt", prompt: "changed" } })).rejects.toBeInstanceOf(
      SpoolConflictError,
    );
  });

  it("drains records in source time order and removes only acknowledged files", async () => {
    const spool = new LocalEventSpool(spoolDirectory);
    const later = event("later", "2026-08-01T08:02:00.000Z");
    const earlier = event("earlier", "2026-08-01T08:01:00.000Z");
    await spool.store(later);
    await spool.store(earlier);
    const delivered: string[] = [];
    const sink: HookEventSink = {
      enqueue: async (item) => { delivered.push(item.eventId); },
    };

    await expect(spool.drain(sink)).resolves.toEqual({
      delivered: 2,
      remaining: 0,
      diagnostics: [],
      stopReason: null,
      scanTruncated: false,
    });
    expect(delivered).toEqual([earlier.eventId, later.eventId]);
  });

  it("retains the current and later records when the sink rejects", async () => {
    const spool = new LocalEventSpool(spoolDirectory);
    await spool.store(event("one"));
    await spool.store(event("two", "2026-08-01T08:01:00.000Z"));

    await expect(spool.drain({ enqueue: async () => { throw new Error("offline"); } })).resolves.toMatchObject({
      delivered: 0,
      remaining: 2,
      stopReason: "sink-error",
    });
  });

  it("reports corrupt files without blocking recovery of valid records", async () => {
    const spool = new LocalEventSpool(spoolDirectory);
    const corrupt = await spool.store(event("corrupt"));
    await writeFile(path.join(spoolDirectory, corrupt.fileName), "{", "utf8");
    const valid = event("valid", "2026-08-01T08:01:00.000Z");
    await spool.store(valid);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const result = await spool.drain({ enqueue });
    expect(result).toMatchObject({ delivered: 1, remaining: 0, stopReason: null });
    expect(result.diagnostics).toEqual([{ fileName: corrupt.fileName, code: "invalid-record", quarantined: true }]);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ eventId: valid.eventId });
    expect((await readdir(spoolDirectory)).some((name) => name.startsWith(`${corrupt.fileName}.corrupt-`))).toBe(true);
  });

  it("bounds each recovery scan", async () => {
    const spool = new LocalEventSpool(spoolDirectory, { maxScanFiles: 1 });
    await spool.store(event("one"));
    await spool.store(event("two", "2026-08-01T08:01:00.000Z"));

    await expect(spool.drain({ enqueue: async () => undefined })).resolves.toMatchObject({
      delivered: 1,
      remaining: 1,
      scanTruncated: true,
    });
  });

  it("honors cancellation without consuming an event", async () => {
    const spool = new LocalEventSpool(spoolDirectory);
    await spool.store(event("cancelled"));
    const controller = new AbortController();
    controller.abort();
    const enqueue = vi.fn();

    await expect(spool.drain({ enqueue }, { signal: controller.signal })).resolves.toMatchObject({
      delivered: 0,
      remaining: 1,
      stopReason: "aborted",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("retains an acknowledged record when cleanup fails so replay remains safe", async () => {
    const spool = new LocalEventSpool(spoolDirectory);
    const stored = await spool.store(event("cleanup"));
    if (process.platform === "win32") return;
    try {
      const result = await spool.drain({
        enqueue: async () => { await chmod(spoolDirectory, 0o500); },
      });
      expect(result).toMatchObject({ delivered: 1, remaining: 1, stopReason: "cleanup-error" });
      expect(await readdir(spoolDirectory)).toContain(stored.fileName);
    } finally {
      await chmod(spoolDirectory, 0o700);
    }
  });

  it("classifies invalid, oversized, and filename-mismatched records", async () => {
    await mkdir(spoolDirectory, { recursive: true });
    const invalidNames = ["0", "1", "2", "3"].map((prefix) => `${prefix.repeat(64)}.json`);
    const validEvent = event("fixture");
    const invalidRecords = [
      {},
      { spoolVersion: 1, queuedAt: "not-a-date", redactionCount: 0, event: validEvent },
      { spoolVersion: 1, queuedAt: "2026-08-01T08:00:00.000Z", redactionCount: -1, event: validEvent },
      { spoolVersion: 1, queuedAt: "2026-08-01T08:00:00.000Z", redactionCount: 0, event: {} },
    ];
    await Promise.all(invalidNames.map(async (name, index) => {
      await writeFile(path.join(spoolDirectory, name), JSON.stringify(invalidRecords[index]), "utf8");
    }));
    const invalidResult = await new LocalEventSpool(spoolDirectory).drain({ enqueue: async () => undefined });
    expect(invalidResult.diagnostics).toHaveLength(4);
    expect(invalidResult.diagnostics.every((item) => item.code === "invalid-record" && item.quarantined)).toBe(true);

    const oversizedName = `${"4".repeat(64)}.json`;
    await writeFile(path.join(spoolDirectory, oversizedName), "x".repeat(200), "utf8");
    const oversized = await new LocalEventSpool(spoolDirectory, { maxRecordBytes: 100 }).drain({
      enqueue: async () => undefined,
    });
    expect(oversized.diagnostics).toEqual([{ fileName: oversizedName, code: "oversized-record", quarantined: true }]);

    const spool = new LocalEventSpool(spoolDirectory);
    const stored = await spool.store(event("wrong-name"));
    const wrongName = `${"5".repeat(64)}.json`;
    await rename(path.join(spoolDirectory, stored.fileName), path.join(spoolDirectory, wrongName));
    const mismatch = await spool.drain({ enqueue: async () => undefined });
    expect(mismatch.diagnostics).toEqual([{ fileName: wrongName, code: "filename-mismatch", quarantined: true }]);
  });

  it("rejects unsafe storage paths, clocks, filenames, and record sizes", async () => {
    const target = path.join(temporaryRoot, "target");
    await mkdir(target);
    await symlink(target, spoolDirectory);
    await expect(new LocalEventSpool(spoolDirectory).store(event("symlink"))).rejects.toThrow("real directory");
    await rm(spoolDirectory);

    expect(new LocalEventSpool(target).directory).toBe(path.resolve(target));
    await expect(new LocalEventSpool(path.join(temporaryRoot, "bad-clock"), {
      clock: () => new Date(Number.NaN),
    }).store(event("clock"))).rejects.toThrow("invalid date");
    await expect(new LocalEventSpool(path.join(temporaryRoot, "bad-random"), {
      randomId: () => "../escape",
    }).store(event("random"))).rejects.toThrow("safe filename");
    await expect(new LocalEventSpool(path.join(temporaryRoot, "too-small"), {
      maxRecordBytes: 10,
    }).store(event("large"))).rejects.toThrow("size limit");
    await expect(new LocalEventSpool(path.join(temporaryRoot, "count-overflow")).store(
      event(`Bearer ${"e".repeat(24)}`),
      Number.MAX_SAFE_INTEGER,
    )).rejects.toThrow("safe integer range");
  });

  it("resolves concurrent stores with one durable file", async () => {
    let sequence = 0;
    const spool = new LocalEventSpool(spoolDirectory, { randomId: () => `race-${sequence++}` });
    const original = event("race");
    const results = await Promise.all([spool.store(original), spool.store(original)]);

    expect(results.map((result) => result.status).sort()).toEqual(["duplicate", "stored"]);
    expect((await readdir(spoolDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("replays through the SQLite ledger with the same idempotency identity", async () => {
    const spool = new LocalEventSpool(spoolDirectory);
    const original = event(`secret Bearer ${"c".repeat(24)}`);
    const ledger = new SqliteEventLedger(":memory:");
    try {
      expect(ledger.append(original).status).toBe("appended");
      await spool.store(original);
      await expect(spool.drain({
        enqueue: async (recovered) => { ledger.append(recovered); },
      })).resolves.toMatchObject({ delivered: 1, remaining: 0 });
      expect(ledger.count()).toBe(1);

      await spool.store(original);
      await spool.drain({ enqueue: async (recovered) => { ledger.append(recovered); } });
      expect(ledger.count()).toBe(1);
      expect(JSON.stringify(ledger.readAfter(0)[0]?.event.payload)).not.toContain("Bearer");
    } finally {
      ledger.close();
    }
  });

  it("validates storage and drain bounds", async () => {
    expect(() => new LocalEventSpool("")).toThrow("spool directory must not be empty");
    expect(() => new LocalEventSpool(spoolDirectory, { maxRecordBytes: 0 })).toThrow();
    const spool = new LocalEventSpool(spoolDirectory);
    await expect(spool.store(event("invalid-count"), -1)).rejects.toThrow();
    await expect(spool.drain({ enqueue: async () => undefined }, { limit: 0 })).rejects.toThrow();
    await expect(spool.drain({ enqueue: async () => undefined }, { limit: 1001 })).rejects.toThrow();
  });
});
