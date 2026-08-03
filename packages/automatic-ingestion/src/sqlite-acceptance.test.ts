import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SessionCatalogEntry } from "@zhiloop/session-catalog";
import { afterEach, describe, expect, it } from "vitest";

import {
  REAL_CODEX_ACCEPTANCE_STAGES,
  RealCodexAcceptanceCoordinator,
  SqliteRealCodexAcceptanceEvidenceStore,
  type RealCodexAcceptanceCursorObservation,
  type RealCodexAcceptanceResult,
} from "./index.js";

const files: string[] = [];

afterEach(async () => {
  for (const file of files.splice(0)) {
    await rm(file, { force: true });
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
  }
});

function filename(): string {
  const value = join(tmpdir(), `zhiloop-real-acceptance-${crypto.randomUUID()}.sqlite`);
  files.push(value);
  return value;
}

function catalogEntry(sessionId: string, lastActivityAt: string): SessionCatalogEntry {
  return Object.freeze({
    schemaVersion: 1,
    sessionId,
    title: "redacted title",
    titleSource: "SESSION_ID",
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    sourceFormatVersion: "jsonl-v1",
    safeSourceAlias: "transcript:opaque",
    captureStatus: "CAPTURED_CURRENT",
    firstActivityAt: lastActivityAt,
    lastActivityAt,
    timeGroup: "TODAY",
    eventCount: 1,
    turnCount: 1,
    ignoredRecords: 0,
    redactionCount: 0,
  });
}

describe("SqliteRealCodexAcceptanceEvidenceStore", () => {
  it("persists one ordered content-free stage record across restart", async () => {
    const path = filename();
    const store = new SqliteRealCodexAcceptanceEvidenceStore(path);
    const secretIdentity = "prompt=sk-secret-value path=/Users/private/project";
    for (const [index, stage] of REAL_CODEX_ACCEPTANCE_STAGES.entries()) {
      store.record(stage, "session-exact", `${secretIdentity}:${stage}`, new Date(Date.UTC(2026, 7, 4, 1, 0, 0, index)).toISOString());
    }
    store.record("HOOK", "session-exact", "later duplicate", "2026-08-04T01:00:01.000Z");
    store.close();

    const bytes = await readFile(path, "utf8");
    expect(bytes).not.toContain("sk-secret-value");
    expect(bytes).not.toContain("/Users/private/project");
    expect(bytes).not.toContain("later duplicate");

    const reopened = new SqliteRealCodexAcceptanceEvidenceStore(path);
    const evidence = await reopened.collect("session-exact");
    expect(evidence.map((item) => item.stage)).toEqual(REAL_CODEX_ACCEPTANCE_STAGES);
    expect(evidence[0]?.observedAt).toBe("2026-08-04T01:00:00.000Z");
    expect(evidence.every((item) => /^[a-z]+:[a-f0-9]{64}$/u.test(item.evidenceRef))).toBe(true);
    reopened.close();
  });

  it("bounds retained session evidence and rejects unsafe identities", async () => {
    const store = new SqliteRealCodexAcceptanceEvidenceStore(filename(), { maxSessions: 2 });
    store.record("HOOK", "session-one", "one", "2026-08-04T01:00:00.000Z");
    store.record("HOOK", "session-two", "two", "2026-08-04T01:00:01.000Z");
    store.record("HOOK", "session-three", "three", "2026-08-04T01:00:02.000Z");
    expect(await store.collect("session-one")).toEqual([]);
    expect(await store.collect("session-two")).toHaveLength(1);
    expect(() => store.record("HOOK", "bad session", "identity")).toThrow(/sessionId/u);
    expect(() => store.record("HOOK", "safe-session", "x".repeat(16_385))).toThrow(/too large/u);
    store.close();
  });

  it("validates a bounded batch before committing it atomically", async () => {
    const store = new SqliteRealCodexAcceptanceEvidenceStore(filename());
    const written = store.recordMany([
      { stage: "HOOK", sessionId: "batch-session", identity: "hook", observedAt: "2026-08-04T01:00:00.000Z" },
      { stage: "SPOOL", sessionId: "batch-session", identity: "spool", observedAt: "2026-08-04T01:00:00.001Z" },
      { stage: "LEDGER", sessionId: "batch-session", identity: "ledger", observedAt: "2026-08-04T01:00:00.002Z" },
    ]);
    expect(written.map((item) => item.stage)).toEqual(["HOOK", "SPOOL", "LEDGER"]);
    expect(() => store.recordMany([
      { stage: "CATALOG", sessionId: "atomic-session", identity: "valid" },
      { stage: "CURSOR", sessionId: "bad session", identity: "invalid" },
    ])).toThrow(/sessionId/u);
    expect(await store.collect("atomic-session")).toEqual([]);
    expect(() => store.recordMany(Array.from({ length: 10_001 }, () => ({
      stage: "HOOK" as const,
      sessionId: "bounded-session",
      identity: "same",
    })))).toThrow(/10000/u);
    store.close();
  });

  it("fails closed for invalid clocks, stages, timestamps, closed stores and pruned batch rows", async () => {
    expect(() => new SqliteRealCodexAcceptanceEvidenceStore(":memory:", { maxSessions: 0 })).toThrow(/maxSessions/u);
    const invalidClock = new SqliteRealCodexAcceptanceEvidenceStore(":memory:", { clock: () => new Date(Number.NaN) });
    expect(() => invalidClock.record("HOOK", "clock-session", "identity")).toThrow(/clock/u);
    invalidClock.close();

    const store = new SqliteRealCodexAcceptanceEvidenceStore(filename(), { maxSessions: 1 });
    expect(() => store.record("UNKNOWN" as never, "safe-session", "identity")).toThrow(/stage/u);
    expect(() => store.record("HOOK", "safe-session", "identity", "not-a-timestamp")).toThrow(/timestamp/u);
    expect(store.recordMany([])).toEqual([]);
    expect(() => store.recordMany([
      { stage: "HOOK", sessionId: "pruned-one", identity: "one", observedAt: "2026-08-04T01:00:00.000Z" },
      { stage: "HOOK", sessionId: "pruned-two", identity: "two", observedAt: "2026-08-04T01:00:01.000Z" },
    ])).toThrow(/pruned/u);
    const mismatched: RealCodexAcceptanceResult = {
      schemaVersion: 1,
      status: "NOT_VERIFIED",
      sessionId: "another-session",
      requiredStages: REAL_CODEX_ACCEPTANCE_STAGES,
      verifiedStages: [],
      missingStages: REAL_CODEX_ACCEPTANCE_STAGES,
      invalidStages: [],
      reason: "EVIDENCE_INCOMPLETE_OR_INVALID",
    };
    expect(() => store.saveResult({ sessionId: "safe-session", taskCreatedAt: "2026-08-04T01:00:00.000Z" }, mismatched)).toThrow(/match/u);
    expect(store.latestVerified()).toBeUndefined();
    store.close();
    store.close();
    await expect(store.collect("safe-session")).rejects.toThrow(/closed/u);
  });

  it("rejects a corrupt persisted verified result instead of restoring READY", async () => {
    const path = filename();
    const store = new SqliteRealCodexAcceptanceEvidenceStore(path, { clock: () => new Date("2026-08-04T01:00:05.000Z") });
    const request = { sessionId: "corrupt-session", taskCreatedAt: "2026-08-04T01:00:00.000Z" };
    const verified: RealCodexAcceptanceResult = {
      schemaVersion: 1,
      status: "VERIFIED",
      sessionId: request.sessionId,
      requiredStages: REAL_CODEX_ACCEPTANCE_STAGES,
      verifiedStages: REAL_CODEX_ACCEPTANCE_STAGES,
      missingStages: [],
      invalidStages: [],
      reason: "ACCEPTANCE_SUCCEEDED",
    };
    store.saveResult(request, verified);
    store.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE real_codex_acceptance_runs SET result_json = ?").run(JSON.stringify({ ...verified, verifiedStages: [] }));
    database.close();
    const reopened = new SqliteRealCodexAcceptanceEvidenceStore(path);
    expect(() => reopened.latestVerified()).toThrow(/invalid/u);
    reopened.close();
  });
});

describe("RealCodexAcceptanceCoordinator", () => {
  it("remains NOT_VERIFIED until the exact fresh catalog and cursor observations exist", async () => {
    const taskCreatedAt = "2026-08-04T01:00:00.000Z";
    const store = new SqliteRealCodexAcceptanceEvidenceStore(filename(), {
      clock: () => new Date("2026-08-04T01:00:05.000Z"),
    });
    store.record("HOOK", "new-session", "hook", "2026-08-04T01:00:01.000Z");
    store.record("SPOOL", "new-session", "spool", "2026-08-04T01:00:02.000Z");
    store.record("LEDGER", "new-session", "ledger", "2026-08-04T01:00:03.000Z");
    const cursor: { value?: RealCodexAcceptanceCursorObservation } = {};
    const coordinator = new RealCodexAcceptanceCoordinator({
      evidence: store,
      catalog: { get: async (sessionId) => catalogEntry(sessionId, "2026-08-04T01:00:04.000Z") },
      cursor: { load: async () => cursor.value },
      clock: () => new Date("2026-08-04T01:00:05.000Z"),
    });
    const incomplete = await coordinator.verify({ sessionId: "new-session", taskCreatedAt });
    expect(incomplete.result).toMatchObject({ status: "NOT_VERIFIED", missingStages: ["CURSOR"] });

    cursor.value = { updatedAt: "2026-08-04T01:00:04.500Z", identity: "offset=10,line=2" };
    const complete = await coordinator.verify({ sessionId: "new-session", taskCreatedAt });
    expect(complete.result).toMatchObject({ status: "VERIFIED", missingStages: [], invalidStages: [] });
    expect(store.latestVerified()).toMatchObject({
      request: { sessionId: "new-session", taskCreatedAt },
      result: { status: "VERIFIED" },
      evidenceRef: expect.stringMatching(/^acceptance:[a-f0-9]{64}$/u),
    });
    store.close();
  });

  it("does not turn stale or wrong-session source state into fresh evidence", async () => {
    const store = new SqliteRealCodexAcceptanceEvidenceStore(filename(), {
      clock: () => new Date("2026-08-04T01:00:05.000Z"),
    });
    const coordinator = new RealCodexAcceptanceCoordinator({
      evidence: store,
      catalog: { get: async () => catalogEntry("another-session", "2026-08-03T01:00:00.000Z") },
      cursor: { load: async () => ({ updatedAt: "2026-08-03T01:00:00.000Z", identity: "stale" }) },
    });
    const result = await coordinator.verify({
      sessionId: "new-session",
      taskCreatedAt: "2026-08-04T01:00:00.000Z",
    });
    expect(result.result.status).toBe("NOT_VERIFIED");
    expect(result.result.missingStages).toEqual(REAL_CODEX_ACCEPTANCE_STAGES);
    await expect(coordinator.verify({ sessionId: "bad session", taskCreatedAt: "invalid" })).rejects.toThrow(/sessionId/u);
    await expect(coordinator.verify({ sessionId: "new-session", taskCreatedAt: "invalid" })).rejects.toThrow(/request/u);
    store.close();
  });

  it("refuses to reuse an already-observed session ID for a newer acceptance run", async () => {
    const store = new SqliteRealCodexAcceptanceEvidenceStore(filename(), {
      clock: () => new Date("2026-08-05T01:00:05.000Z"),
    });
    for (const [index, stage] of REAL_CODEX_ACCEPTANCE_STAGES.entries()) {
      store.record(stage, "reused-session", stage, new Date(Date.parse("2026-08-04T01:00:00.000Z") + index).toISOString());
    }
    const coordinator = new RealCodexAcceptanceCoordinator({
      evidence: store,
      catalog: { get: async () => catalogEntry("reused-session", "2026-08-05T01:00:03.000Z") },
      cursor: { load: async () => ({ updatedAt: "2026-08-05T01:00:04.000Z", identity: "new-cursor" }) },
      clock: () => new Date("2026-08-05T01:00:05.000Z"),
    });
    const result = await coordinator.verify({
      sessionId: "reused-session",
      taskCreatedAt: "2026-08-05T01:00:00.000Z",
    });
    expect(result.result.status).toBe("NOT_VERIFIED");
    expect(result.result.invalidStages).toEqual(REAL_CODEX_ACCEPTANCE_STAGES);
    store.close();
  });
});
