import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  AutomaticIngestionCheckpoint,
  AutomaticIngestionCheckpointPort,
  EligibleCheckpointRequest,
  IngestionProgressStatus,
} from "./types.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const STATUSES = new Set<IngestionProgressStatus>([
  "FOLLOW_PENDING", "CAPTURED_PARTIAL", "CAPTURED_CURRENT", "SOURCE_UNAVAILABLE", "RETRY_PENDING", "RECOVERY_PENDING",
]);

interface CheckpointRow {
  readonly checkpoint_json: string;
}

function validIsoTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseCheckpoint(value: unknown): AutomaticIngestionCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("checkpoint must be an object");
  const checkpoint = value as Partial<AutomaticIngestionCheckpoint>;
  if (
    checkpoint.schemaVersion !== 1
    || typeof checkpoint.sessionId !== "string"
    || !SAFE_SESSION_ID.test(checkpoint.sessionId)
    || !Number.isSafeInteger(checkpoint.version)
    || (checkpoint.version as number) < 1
    || (checkpoint.source !== "CODEX_APP_SERVER" && checkpoint.source !== "CODEX_TRANSCRIPT")
    || typeof checkpoint.safeSourceAlias !== "string"
    || checkpoint.safeSourceAlias.length < 1
    || checkpoint.safeSourceAlias.length > 1_000
    || typeof checkpoint.sourceRevision !== "string"
    || checkpoint.sourceRevision.length < 1
    || checkpoint.sourceRevision.length > 4_000
    || !validIsoTimestamp(checkpoint.lastObservedActivityAt as string)
    || !STATUSES.has(checkpoint.status as IngestionProgressStatus)
    || !validIsoTimestamp(checkpoint.updatedAt as string)
    || (checkpoint.nextEligibleAt !== undefined && !validIsoTimestamp(checkpoint.nextEligibleAt))
  ) throw new Error("checkpoint is invalid");
  return Object.freeze({ ...checkpoint } as AutomaticIngestionCheckpoint);
}

/** Durable compare-and-swap checkpoint projection for production Sidecar composition. */
export class SqliteAutomaticIngestionCheckpointStore implements AutomaticIngestionCheckpointPort {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    this.#database = new DatabaseSync(filename);
    if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
    this.#database.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
    if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS automatic_ingestion_checkpoints (
        session_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version >= 1),
        status TEXT NOT NULL,
        next_eligible_at TEXT,
        checkpoint_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automatic_ingestion_due_idx
        ON automatic_ingestion_checkpoints(status, next_eligible_at, session_id);
    `);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("automatic ingestion checkpoint store is closed");
  }

  async load(sessionId: string): Promise<AutomaticIngestionCheckpoint | undefined> {
    this.#assertOpen();
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("sessionId is invalid");
    const row = this.#database.prepare("SELECT checkpoint_json FROM automatic_ingestion_checkpoints WHERE session_id = ?").get(sessionId) as unknown as CheckpointRow | undefined;
    return row === undefined ? undefined : parseCheckpoint(JSON.parse(row.checkpoint_json) as unknown);
  }

  async compareAndSwap(
    sessionId: string,
    expectedVersion: number | undefined,
    nextInput: AutomaticIngestionCheckpoint,
  ): Promise<"COMMITTED" | "CONFLICT"> {
    this.#assertOpen();
    const next = parseCheckpoint(nextInput);
    if (
      next.sessionId !== sessionId
      || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))
      || next.version !== (expectedVersion ?? 0) + 1
    ) return "CONFLICT";
    const serialized = JSON.stringify(next);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      let committed: boolean;
      if (expectedVersion === undefined) {
        const result = this.#database.prepare(`
          INSERT INTO automatic_ingestion_checkpoints(session_id, version, status, next_eligible_at, checkpoint_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING
        `).run(sessionId, next.version, next.status, next.nextEligibleAt ?? null, serialized, next.updatedAt);
        committed = result.changes === 1;
      } else {
        const result = this.#database.prepare(`
          UPDATE automatic_ingestion_checkpoints
          SET version = ?, status = ?, next_eligible_at = ?, checkpoint_json = ?, updated_at = ?
          WHERE session_id = ? AND version = ?
        `).run(next.version, next.status, next.nextEligibleAt ?? null, serialized, next.updatedAt, sessionId, expectedVersion);
        committed = result.changes === 1;
      }
      this.#database.exec("COMMIT");
      return committed ? "COMMITTED" : "CONFLICT";
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async listEligible(request: EligibleCheckpointRequest): Promise<readonly AutomaticIngestionCheckpoint[]> {
    this.#assertOpen();
    if (!validIsoTimestamp(request.atOrBefore) || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50_000) {
      throw new Error("eligible checkpoint request is invalid");
    }
    const statuses = [...new Set(request.statuses)];
    if (statuses.length < 1 || statuses.some((status) => !STATUSES.has(status))) throw new Error("eligible checkpoint statuses are invalid");
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.#database.prepare(`
      SELECT checkpoint_json FROM automatic_ingestion_checkpoints
      WHERE next_eligible_at IS NOT NULL AND next_eligible_at <= ? AND status IN (${placeholders})
      ORDER BY next_eligible_at ASC, session_id ASC LIMIT ?
    `).all(request.atOrBefore, ...statuses, request.limit) as unknown as CheckpointRow[];
    return Object.freeze(rows.map((row) => parseCheckpoint(JSON.parse(row.checkpoint_json) as unknown)));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
