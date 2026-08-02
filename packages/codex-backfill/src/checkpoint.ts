import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  BackfillCheckpointStore,
  BackfillCheckpointThreadStatus,
  BackfillRunCheckpoint,
  BackfillSkipReason,
} from "./types.js";

const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const STATUSES = new Set<BackfillCheckpointThreadStatus>(["PROCESSING", "COMPLETED", "SKIPPED"]);
const SKIP_REASONS = new Set<BackfillSkipReason>([
  "SHORT_SESSION", "SENSITIVE_SESSION", "ALREADY_PROCESSED", "DUPLICATE_LISTING", "ACTIVE_SESSION", "OUT_OF_SCOPE", "OVERSIZED_SESSION",
]);

interface RunRow {
  readonly run_id: string;
  readonly request_hash: string;
  readonly scope_key: string;
  readonly status: "RUNNING" | "COMPLETED";
  readonly cursor: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

function now(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("checkpoint clock returned an invalid Date");
  return value.toISOString();
}

function checkpoint(row: RunRow): BackfillRunCheckpoint {
  return Object.freeze({
    runId: row.run_id,
    requestHash: row.request_hash,
    scopeKey: row.scope_key,
    status: row.status,
    ...(row.cursor === null ? {} : { cursor: row.cursor }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  });
}

export interface SqliteBackfillCheckpointOptions {
  readonly clock?: () => Date;
  readonly runIdFactory?: () => string;
}

export class SqliteBackfillCheckpointStore implements BackfillCheckpointStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #runIdFactory: () => string;
  #closed = false;

  constructor(filename: string, options: SqliteBackfillCheckpointOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#runIdFactory = options.runIdFactory ?? randomUUID;
    this.#database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode=WAL;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS backfill_runs (
          run_id TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED')),
          cursor TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS backfill_one_active_request
          ON backfill_runs(request_hash) WHERE status='RUNNING';
        CREATE TABLE IF NOT EXISTS backfill_threads (
          run_id TEXT NOT NULL REFERENCES backfill_runs(run_id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PROCESSING','COMPLETED','SKIPPED')),
          reason TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(run_id, thread_id)
        );
      `);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #open(): void {
    if (this.#closed) throw new Error("backfill checkpoint store is closed");
  }

  #run(runId: string): RunRow {
    const row = this.#database.prepare("SELECT * FROM backfill_runs WHERE run_id=?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new Error(`unknown backfill run: ${runId}`);
    return row;
  }

  startOrResume(requestHash: string, scopeKey: string): { readonly checkpoint: BackfillRunCheckpoint; readonly resumed: boolean } {
    this.#open();
    if (!HASH.test(requestHash)) throw new Error("requestHash must be a SHA-256 digest");
    if (typeof scopeKey !== "string" || scopeKey.length < 1 || scopeKey.length > 4_000) throw new Error("scopeKey is invalid");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT * FROM backfill_runs WHERE request_hash=? AND status='RUNNING'").get(requestHash) as RunRow | undefined;
      if (existing !== undefined) {
        if (existing.scope_key !== scopeKey) throw new Error("active backfill scope conflicts with request hash");
        this.#database.exec("COMMIT");
        return { checkpoint: checkpoint(existing), resumed: true };
      }
      const runId = this.#runIdFactory();
      if (!IDENTIFIER.test(runId)) throw new Error("runIdFactory returned an invalid identifier");
      const timestamp = now(this.#clock);
      this.#database.prepare("INSERT INTO backfill_runs VALUES (?,?,?,'RUNNING',NULL,?,?,NULL)").run(runId, requestHash, scopeKey, timestamp, timestamp);
      const created = this.#run(runId);
      this.#database.exec("COMMIT");
      return { checkpoint: checkpoint(created), resumed: false };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  threadStatus(runId: string, threadId: string): BackfillCheckpointThreadStatus | undefined {
    this.#open();
    if (!IDENTIFIER.test(runId) || !IDENTIFIER.test(threadId)) throw new Error("runId or threadId is invalid");
    const row = this.#database.prepare("SELECT status FROM backfill_threads WHERE run_id=? AND thread_id=?").get(runId, threadId) as { status: BackfillCheckpointThreadStatus } | undefined;
    return row?.status;
  }

  markThread(runId: string, threadId: string, status: BackfillCheckpointThreadStatus, reason?: BackfillSkipReason): void {
    this.#open();
    if (!IDENTIFIER.test(runId) || !IDENTIFIER.test(threadId) || !STATUSES.has(status)) throw new Error("backfill thread checkpoint is invalid");
    if ((status === "SKIPPED") !== (reason !== undefined) || (reason !== undefined && !SKIP_REASONS.has(reason))) throw new Error("backfill skip reason is invalid");
    const run = this.#run(runId);
    if (run.status !== "RUNNING") throw new Error("completed backfill run cannot be modified");
    const existing = this.#database.prepare("SELECT status, reason FROM backfill_threads WHERE run_id=? AND thread_id=?").get(runId, threadId) as { status: BackfillCheckpointThreadStatus; reason: string | null } | undefined;
    if (existing !== undefined && existing.status !== "PROCESSING") {
      if (existing.status !== status || existing.reason !== (reason ?? null)) throw new Error("terminal thread checkpoint cannot be changed");
      return;
    }
    this.#database.prepare(`
      INSERT INTO backfill_threads(run_id,thread_id,status,reason,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(run_id,thread_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at
    `).run(runId, threadId, status, reason ?? null, now(this.#clock));
  }

  advance(runId: string, expectedCursor: string | undefined, nextCursor: string | undefined): void {
    this.#open();
    const timestamp = now(this.#clock);
    const result = this.#database.prepare(`
      UPDATE backfill_runs SET cursor=?,updated_at=?
      WHERE run_id=? AND status='RUNNING' AND cursor IS ?
    `).run(nextCursor ?? null, timestamp, runId, expectedCursor ?? null);
    if (result.changes !== 1) throw new Error("backfill cursor revision conflict");
  }

  complete(runId: string, expectedCursor: string | undefined): void {
    this.#open();
    const timestamp = now(this.#clock);
    const result = this.#database.prepare(`
      UPDATE backfill_runs SET status='COMPLETED',updated_at=?,completed_at=?
      WHERE run_id=? AND status='RUNNING' AND cursor IS ?
    `).run(timestamp, timestamp, runId, expectedCursor ?? null);
    if (result.changes !== 1) throw new Error("backfill completion revision conflict");
  }

  get(runId: string): BackfillRunCheckpoint {
    this.#open();
    return checkpoint(this.#run(runId));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
