import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

import type {
  CapabilitySnapshot,
  Diagnostics,
  EventMetadata,
  JobSnapshot,
  SessionSummary,
  StageSnapshot,
} from "@zhiloop/control-api";
import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidOperationalCursorError,
  SqliteOperationalReadModel,
  type OperationalProjectionSnapshot,
  type OperatorDiagnostic,
  type SessionProjectionInput,
  type StageRunProjection,
} from "./index.js";

const CURSOR_SECRET = "operational-read-model-test-secret-32-bytes-minimum";
const NOW = "2026-08-03T12:00:00.000Z";
const HASH = "a".repeat(64);
const roots: string[] = [];

function databasePath(name = "operational.sqlite"): string {
  const root = mkdtempSync(join(tmpdir(), "zhiloop-operational-"));
  roots.push(root);
  return join(root, name);
}

function capability(overrides: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return {
    schemaVersion: 1,
    capabilityId: "knowledge.compile",
    status: "DISABLED",
    reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED",
    observedAt: NOW,
    lastTransitionAt: NOW,
    retryable: false,
    evidenceRefs: ["deployment:sidecar:0.1.4"],
    nextAction: "Enable the production knowledge worker",
    ...overrides,
  };
}

function session(sessionId = "session-a", lastActivityAt = NOW): SessionProjectionInput {
  const summary: SessionSummary = {
    schemaVersion: 1,
    sessionId,
    title: `Session ${sessionId}`,
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    sourceVersion: "v1",
    captureStatus: "CAPTURED_CURRENT",
    projectHint: "project-a",
    cwdAlias: "project://project-a",
    firstActivityAt: "2026-08-03T11:00:00.000Z",
    lastActivityAt,
    eventCount: 8,
    turnCount: 2,
    ignoredRecords: 1,
    redactionCount: 3,
  };
  return {
    summary,
    latestCursor: { byteOffset: 512, lineNumber: 12, observedAt: NOW },
  };
}

function stage(runId = "run-a", entityId = "session-a"): StageRunProjection {
  const snapshot: StageSnapshot = {
    schemaVersion: 1,
    entityId,
    stage: "KNOWLEDGE_COMPILE",
    status: "DISABLED",
    reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED",
    observedAt: NOW,
    lastTransitionAt: NOW,
    retryable: false,
    evidenceRefs: ["deployment:sidecar:0.1.4"],
    nextAction: "Enable the production knowledge worker",
  };
  return { runId, snapshot };
}

function job(jobId = "job-a", status: JobSnapshot["status"] = "QUEUED"): JobSnapshot {
  return {
    schemaVersion: 1,
    jobId,
    jobType: "SESSION_CAPTURE",
    status,
    attempt: 0,
    maxAttempts: 3,
    progress: 0,
    reasonCode: status === "FAILED" ? "JOB_FAILED" : "JOB_QUEUED",
    observedAt: NOW,
    lastTransitionAt: NOW,
    retryable: status === "FAILED",
    evidenceRefs: [`job:${jobId}`],
  };
}

function event(sequence = 1, sessionId = "session-a"): EventMetadata {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `event-${sequence}`,
    eventType: "user.prompted",
    source: "codex",
    sessionId,
    turnId: `turn-${sequence}`,
    occurredAt: NOW,
    correlationId: `correlation-${sequence}`,
    contentHash: HASH,
    redactionCount: 1,
    payloadPurged: false,
    contentPreview: `脱敏内容 ${sequence}`,
    contentTruncated: false,
  };
}

function operatorDiagnostic(diagnosticId = "diagnostic-a"): OperatorDiagnostic {
  return {
    diagnosticId,
    component: "conversation-ledger",
    code: "CONSUMER_LAG_OBSERVED",
    severity: "WARNING",
    observedAt: NOW,
    retryable: true,
    evidenceRefs: ["consumer:knowledge-compiler"],
  };
}

function health(): Diagnostics {
  return {
    schemaVersion: 1,
    observedAt: NOW,
    ledgerSequence: 120,
    spoolDepth: 2,
    consumerLags: [{ consumerId: "knowledge-compiler", sequence: 100, lag: 20, updatedAt: NOW }],
    worker: {
      healthy: true,
      lastCycleAt: NOW,
      consumed: 8,
      produced: 5,
      retryableFailures: 1,
    },
    storage: { healthy: true, databaseBytes: 4096, availableBytes: 1_000_000 },
  };
}

function snapshot(): OperationalProjectionSnapshot {
  return {
    capabilities: [capability()],
    sessions: [session()],
    stages: [stage()],
    jobs: [job()],
    events: [event()],
    diagnostics: [operatorDiagnostic()],
    health: health(),
  };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("SqliteOperationalReadModel migrations", () => {
  it("migrates a component-local version forward without using PRAGMA user_version", () => {
    const filename = databasePath();
    const seed = new DatabaseSync(filename);
    seed.exec(`
      PRAGMA user_version = 77;
      CREATE TABLE operational_read_model_meta (
        component TEXT PRIMARY KEY,
        migration_version INTEGER NOT NULL,
        rebuilt_at TEXT
      );
      INSERT INTO operational_read_model_meta(component, migration_version)
      VALUES ('operational-read-model', 2);
      CREATE TABLE projected_event_metadata (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        occurred_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        redaction_count INTEGER NOT NULL,
        payload_purged INTEGER NOT NULL
      );
      INSERT INTO projected_event_metadata(
        sequence, event_id, event_type, source, session_id, occurred_at,
        correlation_id, content_hash, redaction_count, payload_purged
      ) VALUES (1, 'old-event', 'user.prompted', 'codex', 'session-a',
        '${NOW}', 'old-correlation', '${HASH}', 1, 0);
    `);
    seed.close();

    const model = new SqliteOperationalReadModel(filename, { cursorSecret: CURSOR_SECRET });
    model.close();

    const checked = new DatabaseSync(filename, { readOnly: true });
    const version = checked.prepare(
      "SELECT migration_version FROM operational_read_model_meta WHERE component = 'operational-read-model'",
    ).get() as { migration_version: number };
    const pragma = checked.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.migration_version).toBe(3);
    expect(pragma.user_version).toBe(77);
    expect(checked.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='session_projections'",
    ).get()).toEqual({ count: 1 });
    expect(checked.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='capture_command_receipts'",
    ).get()).toEqual({ count: 1 });
    expect((checked.prepare("PRAGMA table_info(projected_event_metadata)").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(["content_preview", "content_truncated"]));
    expect(checked.prepare("SELECT count(*) AS count FROM projected_event_metadata").get()).toEqual({ count: 0 });
    checked.close();
  });

  it("rolls back the entire migration on failure and rejects future versions", () => {
    const failedPath = databasePath("failed.sqlite");
    expect(() => new SqliteOperationalReadModel(failedPath, {
      cursorSecret: CURSOR_SECRET,
      faultInjector(point) {
        if (point === "migration.after-schema") throw new Error("simulated migration failure");
      },
    })).toThrow("simulated migration failure");

    const failed = new DatabaseSync(failedPath, { readOnly: true });
    const tables = failed.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'operational_%'
    `).all();
    expect(tables).toEqual([]);
    failed.close();

    const futurePath = databasePath("future.sqlite");
    const future = new DatabaseSync(futurePath);
    future.exec(`
      CREATE TABLE operational_read_model_meta (
        component TEXT PRIMARY KEY,
        migration_version INTEGER NOT NULL,
        rebuilt_at TEXT
      );
      INSERT INTO operational_read_model_meta(component, migration_version)
      VALUES ('operational-read-model', 99);
    `);
    future.close();
    expect(() => new SqliteOperationalReadModel(futurePath, { cursorSecret: CURSOR_SECRET }))
      .toThrow("newer than supported version");
  });
});

describe("SqliteOperationalReadModel projections", () => {
  it("rebuilds every projection equivalently and rolls back a failed rebuild", () => {
    const filename = databasePath();
    const model = new SqliteOperationalReadModel(filename, { cursorSecret: CURSOR_SECRET });
    const expected = snapshot();
    expect(model.rebuild(expected)).toMatchObject({
      capabilities: 1,
      sessions: 1,
      stages: 1,
      jobs: 1,
      events: 1,
      diagnostics: 1,
    });
    expect(model.exportSnapshot()).toEqual(expected);
    model.projectCapability(capability({ capabilityId: "capture.session", status: "READY", reasonCode: "COMPONENT_READY" }));
    expect(model.exportSnapshot().capabilities).toHaveLength(2);
    model.rebuild({ snapshot: () => expected });
    expect(model.exportSnapshot()).toEqual(expected);
    model.close();

    const rollbackModel = new SqliteOperationalReadModel(filename, {
      cursorSecret: CURSOR_SECRET,
      faultInjector(point) {
        if (point === "rebuild.after-clear") throw new Error("simulated rebuild failure");
      },
    });
    expect(() => rollbackModel.rebuild({ ...expected, capabilities: [] })).toThrow("simulated rebuild failure");
    expect(rollbackModel.exportSnapshot()).toEqual(expected);
    rollbackModel.close();
  });

  it("serves strict Control API views and stable signed cursor pages", () => {
    const model = new SqliteOperationalReadModel(databasePath(), { cursorSecret: CURSOR_SECRET });
    model.rebuild({
      ...snapshot(),
      sessions: [
        session("session-b", NOW),
        session("session-a", NOW),
        session("session-c", "2026-08-03T10:00:00.000Z"),
      ],
      jobs: [job("job-a", "QUEUED"), job("job-b", "FAILED")],
    });

    const first = model.listSessions({ limit: 2 });
    expect(first.items.map((item) => item.sessionId)).toEqual(["session-a", "session-b"]);
    expect(first.nextCursor).toBeDefined();
    const firstCursor = first.nextCursor;
    if (firstCursor === undefined) throw new Error("expected a second session page");
    expect(model.listSessions({ limit: 2, cursor: firstCursor }).items.map((item) => item.sessionId))
      .toEqual(["session-c"]);
    const last = firstCursor.at(-1);
    const tampered = `${firstCursor.slice(0, -1)}${last === "a" ? "b" : "a"}`;
    expect(() => model.listSessions({ cursor: tampered })).toThrow(InvalidOperationalCursorError);
    expect(() => model.listSessionEvents("session-a", { cursor: firstCursor })).toThrow(InvalidOperationalCursorError);

    expect(model.getSession("session-a")).toMatchObject({
      summary: { sessionId: "session-a" },
      stages: expect.any(Array),
      injections: [],
      latestCursor: { byteOffset: 512, lineNumber: 12 },
    });
    expect(model.getDiagnostics()).toEqual(health());
    expect(model.getOverview({ observedAt: NOW, rolloutMode: "SHADOW", sidecarVersion: "0.1.4", alertCount: 1 }))
      .toMatchObject({
        schemaVersion: 1,
        rolloutMode: "SHADOW",
        jobs: { queued: 1, running: 0, retryWait: 0, failed: 1 },
        alertCount: 1,
      });
    model.close();
  });

  it("keeps a maximum-size P0 Overview below the 300ms P95 gate", () => {
    const model = new SqliteOperationalReadModel(databasePath(), { cursorSecret: CURSOR_SECRET });
    model.rebuild({
      capabilities: Array.from({ length: 200 }, (_value, index) => capability({ capabilityId: `capability.${index}` })),
      sessions: Array.from({ length: 20 }, (_value, index) => session(`session-${index}`, new Date(Date.parse(NOW) - index).toISOString())),
      stages: [],
      jobs: [],
      events: [],
      diagnostics: [],
    });
    const runtime = { observedAt: NOW, rolloutMode: "SHADOW" as const, sidecarVersion: "0.1.4", alertCount: 0 };
    model.getOverview(runtime);
    const latencies = Array.from({ length: 200 }, () => {
      const startedAt = performance.now();
      model.getOverview(runtime);
      return performance.now() - startedAt;
    }).sort((left, right) => left - right);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1] as number;
    expect(p95).toBeLessThan(300);
    model.close();
  });
});

describe("SqliteOperationalReadModel event pagination and privacy", () => {
  it("keyset-paginates 100,000 events without gaps, duplicates, or an unbounded response", { timeout: 30_000 }, () => {
    const filename = databasePath();
    const initial = new SqliteOperationalReadModel(filename, { cursorSecret: CURSOR_SECRET });
    initial.close();
    const seed = new DatabaseSync(filename);
    seed.exec("BEGIN IMMEDIATE");
    const insert = seed.prepare(`
      INSERT INTO projected_event_metadata(
        sequence, event_id, event_type, source, session_id, turn_id, occurred_at,
        correlation_id, content_hash, redaction_count, payload_purged
      ) VALUES (?, ?, 'user.prompted', 'codex', 'session-large', NULL, ?, ?, ?, 1, 0)
    `);
    for (let sequence = 1; sequence <= 100_000; sequence += 1) {
      insert.run(
        sequence,
        `event-${sequence}`,
        new Date(Date.parse(NOW) + sequence).toISOString(),
        `correlation-${sequence}`,
        HASH,
      );
    }
    seed.exec("COMMIT");
    seed.close();

    const model = new SqliteOperationalReadModel(filename, { cursorSecret: CURSOR_SECRET });
    const startedAt = performance.now();
    const first = model.listSessionEvents("session-large", { limit: 100 });
    const firstLatency = performance.now() - startedAt;
    expect(firstLatency).toBeLessThan(500);
    expect(first.items).toHaveLength(100);
    expect(first.items[0]?.sequence).toBe(100_000);
    expect(first.items[99]?.sequence).toBe(99_901);

    let cursor = first.nextCursor;
    let count = first.items.length;
    let previous = first.items.at(-1)?.sequence ?? Number.MAX_SAFE_INTEGER;
    while (cursor !== undefined) {
      const page = model.listSessionEvents("session-large", { limit: 100, cursor });
      expect(page.items.length).toBeLessThanOrEqual(100);
      for (const item of page.items) {
        expect(item.sequence).toBeLessThan(previous);
        previous = item.sequence;
      }
      count += page.items.length;
      cursor = page.nextCursor;
    }
    expect(count).toBe(100_000);
    expect(previous).toBe(1);
    model.close();
  });

  it("rejects payload-shaped inputs and never exposes prompt or secret text in event/diagnostic outputs", () => {
    const filename = databasePath();
    const model = new SqliteOperationalReadModel(filename, { cursorSecret: CURSOR_SECRET });
    const secret = "sk-project-raw-secret-must-never-be-stored";
    const prompt = "raw user prompt: rotate production credentials";

    expect(() => model.projectEventMetadata({ ...event(), payload: { prompt, secret } } as unknown as EventMetadata))
      .toThrow();
    expect(() => model.projectOperatorDiagnostic({
      ...operatorDiagnostic(),
      safeSummary: `${prompt} ${secret}`,
    } as unknown as OperatorDiagnostic)).toThrow();
    expect(() => model.projectOperatorDiagnostic({
      ...operatorDiagnostic(),
      evidenceRefs: [`prompt:${prompt}`],
    })).toThrow();

    model.projectEventMetadata(event());
    model.projectOperatorDiagnostic(operatorDiagnostic());
    const rendered = JSON.stringify({
      events: model.listSessionEvents("session-a"),
      diagnostics: model.listOperatorDiagnostics(),
      snapshot: model.exportSnapshot(),
    });
    expect(rendered).not.toContain(prompt);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('"payload":');
    expect(rendered).not.toContain("safeSummary");

    model.close();
    const raw = new DatabaseSync(filename, { readOnly: true });
    const eventColumns = raw.prepare("PRAGMA table_info(projected_event_metadata)").all() as unknown as Array<{ name: string }>;
    const diagnosticColumns = raw.prepare("PRAGMA table_info(operator_diagnostics)").all() as unknown as Array<{ name: string }>;
    expect(eventColumns.map((column) => column.name)).not.toContain("payload_json");
    expect(diagnosticColumns.map((column) => column.name)).not.toContain("message");
    expect(diagnosticColumns.map((column) => column.name)).not.toContain("summary");
    raw.close();
  });
});
