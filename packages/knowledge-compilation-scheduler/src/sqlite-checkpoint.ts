import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  KnowledgeCompilationCheckpoint,
  KnowledgeCompilationCheckpointPort,
  KnowledgeCompilationReasonCode,
  KnowledgeCompilationStatus,
} from "./types.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const STATUSES = new Set<KnowledgeCompilationStatus>([
  "OBSERVING", "WAITING_IDLE", "QUEUED", "RETRY_WAIT", "CURRENT", "FAILED",
]);
const REASONS = new Set<KnowledgeCompilationReasonCode>([
  "TURN_THRESHOLD", "SESSION_IDLE", "SESSION_ENDED", "MAXIMUM_WAIT", "CAPTURE_NOT_CURRENT",
  "SOURCE_UNAVAILABLE", "NO_NEW_EVENTS", "MINIMUM_EVENTS_PENDING", "WAITING_FOR_TRIGGER",
  "CAPTURE_CHANGED", "SOURCE_CHANGED", "LEDGER_CHANGED", "NO_EXTRACTABLE_EVENTS",
  "UNSUPPORTED_SOURCE", "DISPATCH_RETRYABLE", "DISPATCH_FAILED", "CHECKPOINT_CONFLICT",
  "CHECKPOINT_INVALID", "CATALOG_ENTRY_INVALID", "CATALOG_CURSOR_LOOP", "SESSION_SCAN_BOUNDED",
]);

interface CheckpointRow {
  readonly checkpoint_json: string;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseKnowledgeCompilationCheckpoint(value: unknown): KnowledgeCompilationCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("knowledge compilation checkpoint must be an object");
  const checkpoint = value as Partial<KnowledgeCompilationCheckpoint>;
  if (
    checkpoint.schemaVersion !== 1
    || typeof checkpoint.sessionId !== "string"
    || !SAFE_SESSION_ID.test(checkpoint.sessionId)
    || !Number.isSafeInteger(checkpoint.version)
    || (checkpoint.version as number) < 1
    || !nonnegative(checkpoint.lastObservedLedgerSequence)
    || !nonnegative(checkpoint.lastObservedEventCount)
    || !nonnegative(checkpoint.lastObservedTurnCount)
    || !nonnegative(checkpoint.lastCompiledLedgerSequence)
    || !nonnegative(checkpoint.lastCompiledEventCount)
    || !nonnegative(checkpoint.lastCompiledTurnCount)
    || !validTimestamp(checkpoint.lastActivityAt)
    || !STATUSES.has(checkpoint.status as KnowledgeCompilationStatus)
    || !REASONS.has(checkpoint.lastReasonCode as KnowledgeCompilationReasonCode)
    || !validTimestamp(checkpoint.updatedAt)
    || (checkpoint.firstPendingObservedAt !== undefined && !validTimestamp(checkpoint.firstPendingObservedAt))
    || (checkpoint.nextEligibleAt !== undefined && !validTimestamp(checkpoint.nextEligibleAt))
    || (checkpoint.sourceVersion !== undefined && (typeof checkpoint.sourceVersion !== "string" || checkpoint.sourceVersion.length > 4_000))
    || (checkpoint.lastCompiledPipelineHash !== undefined && !/^[a-f0-9]{64}$/u.test(checkpoint.lastCompiledPipelineHash))
    || (checkpoint.pendingSnapshotId !== undefined && (typeof checkpoint.pendingSnapshotId !== "string" || checkpoint.pendingSnapshotId.length > 1_000))
    || (checkpoint.pendingJobId !== undefined && (typeof checkpoint.pendingJobId !== "string" || checkpoint.pendingJobId.length > 1_000))
  ) throw new Error("knowledge compilation checkpoint is invalid");
  return Object.freeze({ ...checkpoint } as KnowledgeCompilationCheckpoint);
}

export class SqliteKnowledgeCompilationCheckpointStore implements KnowledgeCompilationCheckpointPort {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    this.#database = new DatabaseSync(filename);
    if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
    this.#database.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
    if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_compilation_checkpoints (
        session_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version >= 1),
        status TEXT NOT NULL,
        next_eligible_at TEXT,
        checkpoint_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_compilation_due_idx
        ON knowledge_compilation_checkpoints(status, next_eligible_at, session_id);
    `);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("knowledge compilation checkpoint store is closed");
  }

  async load(sessionId: string): Promise<KnowledgeCompilationCheckpoint | undefined> {
    this.#assertOpen();
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("sessionId is invalid");
    const row = this.#database.prepare(
      "SELECT checkpoint_json FROM knowledge_compilation_checkpoints WHERE session_id = ?",
    ).get(sessionId) as unknown as CheckpointRow | undefined;
    return row === undefined ? undefined : parseKnowledgeCompilationCheckpoint(JSON.parse(row.checkpoint_json) as unknown);
  }

  async compareAndSwap(
    sessionId: string,
    expectedVersion: number | undefined,
    nextInput: KnowledgeCompilationCheckpoint,
  ): Promise<"COMMITTED" | "CONFLICT"> {
    this.#assertOpen();
    const next = parseKnowledgeCompilationCheckpoint(nextInput);
    if (next.sessionId !== sessionId) throw new Error("checkpoint sessionId does not match key");
    const json = JSON.stringify(next);
    if (expectedVersion === undefined) {
      if (next.version !== 1) throw new Error("new checkpoint version must be 1");
      const result = this.#database.prepare(`
        INSERT INTO knowledge_compilation_checkpoints(
          session_id, version, status, next_eligible_at, checkpoint_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO NOTHING
      `).run(sessionId, next.version, next.status, next.nextEligibleAt ?? null, json, next.updatedAt);
      return result.changes === 1 ? "COMMITTED" : "CONFLICT";
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || next.version !== expectedVersion + 1) {
      throw new Error("checkpoint version must advance by one");
    }
    const result = this.#database.prepare(`
      UPDATE knowledge_compilation_checkpoints
      SET version = ?, status = ?, next_eligible_at = ?, checkpoint_json = ?, updated_at = ?
      WHERE session_id = ? AND version = ?
    `).run(next.version, next.status, next.nextEligibleAt ?? null, json, next.updatedAt, sessionId, expectedVersion);
    return result.changes === 1 ? "COMMITTED" : "CONFLICT";
  }

  async listDue(request: { readonly atOrBefore: string; readonly limit: number }): Promise<readonly KnowledgeCompilationCheckpoint[]> {
    this.#assertOpen();
    if (!validTimestamp(request.atOrBefore)) throw new Error("atOrBefore must be an ISO timestamp");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 10_000) throw new Error("limit must be between 1 and 10000");
    const rows = this.#database.prepare(`
      SELECT checkpoint_json FROM knowledge_compilation_checkpoints
      WHERE status IN ('WAITING_IDLE', 'RETRY_WAIT')
        AND next_eligible_at IS NOT NULL
        AND next_eligible_at <= ?
      ORDER BY next_eligible_at ASC, session_id ASC
      LIMIT ?
    `).all(request.atOrBefore, request.limit) as unknown as CheckpointRow[];
    return Object.freeze(rows.map((row) => parseKnowledgeCompilationCheckpoint(JSON.parse(row.checkpoint_json) as unknown)));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}
