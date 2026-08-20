import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { EventEnvelope } from "@zhiloop/domain";
import { parseEventEnvelope } from "@zhiloop/schemas";

import { redactEventPayload } from "./redaction.js";
import type {
  AppendResult,
  CursorCommitResult,
  EventLedgerOptions,
  IngestionCursorRecord,
  LedgerEventRecord,
  LedgerProjectionRecord,
  RetentionResult,
  SessionLedgerStats,
} from "./types.js";

const CURRENT_MIGRATION_VERSION = 1;
const MAX_BATCH_SIZE = 10_000;
const MAX_READ_LIMIT = 1_000;
const MAX_INGESTION_CURSOR_BYTES = 65_536;

interface PreparedEvent {
  readonly event: EventEnvelope;
  readonly payloadJson: string;
  readonly storedPayloadHash: string;
  readonly redactionCount: number;
  readonly occurredAtMs: number;
}

interface EventRow {
  readonly sequence: number;
  readonly schema_version: number;
  readonly event_id: string;
  readonly source: string;
  readonly source_version: string | null;
  readonly source_item_id: string | null;
  readonly event_type: string;
  readonly session_id: string;
  readonly turn_id: string | null;
  readonly occurred_at: string;
  readonly cwd: string | null;
  readonly project_hint: string | null;
  readonly content_hash: string;
  readonly correlation_id: string;
  readonly payload_json: string;
  readonly stored_payload_hash: string;
  readonly redaction_count: number;
  readonly payload_purged: number;
  readonly inserted_at: string;
}

interface ProjectionRow {
  readonly sequence: number;
  readonly source: string;
  readonly session_id: string;
  readonly turn_id: string | null;
  readonly occurred_at: string;
  readonly redaction_count: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertConsumerId(consumerId: string): void {
  if (consumerId.length < 1 || consumerId.length > 200) throw new Error("consumerId must contain 1 to 200 characters");
}

function assertIngestionId(ingestionId: string): void {
  if (ingestionId.length < 1 || ingestionId.length > 300 || /[\0\r\n]/u.test(ingestionId)) {
    throw new Error("ingestionId must contain 1 to 300 safe characters");
  }
}

function assertSessionId(sessionId: string): void {
  if (sessionId.length < 1 || sessionId.length > 500 || /[\0\r\n]/u.test(sessionId)) {
    throw new Error("sessionId must contain 1 to 500 safe characters");
  }
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative safe integer");
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_READ_LIMIT}`);
  }
}

function prepareEvent(input: EventEnvelope): PreparedEvent {
  const parsed = parseEventEnvelope(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const redacted = redactEventPayload(parsed.value.payload);
  const payloadJson = JSON.stringify(redacted.value);
  const occurredAtMs = Date.parse(parsed.value.occurredAt);
  if (Number.isNaN(occurredAtMs)) throw new Error("event occurredAt is invalid");
  return {
    event: parsed.value,
    payloadJson,
    storedPayloadHash: sha256(payloadJson),
    redactionCount: redacted.redactionCount,
    occurredAtMs,
  };
}

function rowToRecord(row: EventRow): LedgerEventRecord {
  if (sha256(row.payload_json) !== row.stored_payload_hash) {
    throw new Error(`ledger event ${row.event_id} failed stored payload integrity verification`);
  }
  const payload = deepFreeze(JSON.parse(row.payload_json) as unknown);
  const event: EventEnvelope = {
    schemaVersion: 1,
    eventId: row.event_id,
    source: row.source as EventEnvelope["source"],
    ...(row.source_version === null ? {} : { sourceVersion: row.source_version }),
    ...(row.source_item_id === null ? {} : { sourceItemId: row.source_item_id }),
    eventType: row.event_type as EventEnvelope["eventType"],
    sessionId: row.session_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    occurredAt: row.occurred_at,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.project_hint === null ? {} : { projectHint: row.project_hint }),
    contentHash: row.content_hash,
    correlationId: row.correlation_id,
    payload,
  };
  const parsed = parseEventEnvelope(event);
  if (!parsed.ok || row.schema_version !== 1) throw new Error(`ledger event ${row.event_id} is corrupt or unsupported`);
  return Object.freeze({
    sequence: row.sequence,
    event: Object.freeze(event),
    storedPayloadHash: row.stored_payload_hash,
    redactionCount: row.redaction_count,
    payloadPurged: row.payload_purged === 1,
    insertedAt: row.inserted_at,
  });
}

export class SqliteEventLedger {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  #closed = false;

  constructor(filename: string, options: EventLedgerOptions = {}) {
    this.#database = new DatabaseSync(filename);
    this.#clock = options.clock ?? (() => new Date());
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
      this.#ensureIngestionCursorSchema();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("event ledger is closed");
  }

  #migrate(): void {
    const row = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > CURRENT_MIGRATION_VERSION) {
      throw new Error(`ledger migration ${row.user_version} is newer than supported version ${CURRENT_MIGRATION_VERSION}`);
    }
    if (row.user_version === CURRENT_MIGRATION_VERSION) return;
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          schema_version INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL,
          source_version TEXT,
          source_item_id TEXT,
          event_type TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT,
          occurred_at TEXT NOT NULL,
          occurred_at_ms INTEGER NOT NULL,
          cwd TEXT,
          project_hint TEXT,
          content_hash TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          stored_payload_hash TEXT NOT NULL,
          redaction_count INTEGER NOT NULL DEFAULT 0 CHECK (redaction_count >= 0),
          payload_purged INTEGER NOT NULL DEFAULT 0 CHECK (payload_purged IN (0, 1)),
          inserted_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_session_sequence_idx ON events(session_id, sequence);
        CREATE INDEX IF NOT EXISTS events_occurred_sequence_idx ON events(occurred_at_ms, sequence);
        CREATE TABLE IF NOT EXISTS consumer_cursors (
          consumer_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #ensureIngestionCursorSchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_cursors (
        ingestion_id TEXT PRIMARY KEY,
        cursor_json TEXT NOT NULL,
        cursor_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  #transaction<T>(action: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  append(event: EventEnvelope): AppendResult {
    return this.appendBatch([event])[0] as AppendResult;
  }

  appendBatch(events: readonly EventEnvelope[]): readonly AppendResult[] {
    this.#assertOpen();
    if (events.length > MAX_BATCH_SIZE) throw new Error(`batch must contain at most ${MAX_BATCH_SIZE} events`);
    const prepared = events.map(prepareEvent);
    if (prepared.length === 0) return [];
    const insertedAt = this.#clock().toISOString();
    const insert = this.#database.prepare(`
      INSERT OR IGNORE INTO events (
        schema_version, event_id, source, source_version, source_item_id, event_type,
        session_id, turn_id, occurred_at, occurred_at_ms, cwd, project_hint,
        content_hash, correlation_id, payload_json, stored_payload_hash,
        redaction_count, inserted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const find = this.#database.prepare(`
      SELECT sequence, source, source_item_id, event_type, session_id, turn_id,
             content_hash, correlation_id, stored_payload_hash, payload_purged
      FROM events WHERE event_id = ?
    `);
    return this.#transaction(() => prepared.map((item) => {
      const event = item.event;
      const result = insert.run(
        event.schemaVersion,
        event.eventId,
        event.source,
        event.sourceVersion ?? null,
        event.sourceItemId ?? null,
        event.eventType,
        event.sessionId,
        event.turnId ?? null,
        event.occurredAt,
        item.occurredAtMs,
        event.cwd ?? null,
        event.projectHint ?? null,
        event.contentHash,
        event.correlationId,
        item.payloadJson,
        item.storedPayloadHash,
        item.redactionCount,
        insertedAt,
      );
      if (result.changes === 1) {
        return { status: "appended", sequence: Number(result.lastInsertRowid), redactionCount: item.redactionCount };
      }
      const existing = find.get(event.eventId) as
        | {
            sequence: number;
            source: string;
            source_item_id: string | null;
            event_type: string;
            session_id: string;
            turn_id: string | null;
            content_hash: string;
            correlation_id: string;
            stored_payload_hash: string;
            payload_purged: number;
          }
        | undefined;
      if (existing === undefined) throw new Error("duplicate event could not be resolved");
      if (
        existing.source !== event.source ||
        existing.source_item_id !== (event.sourceItemId ?? null) ||
        existing.event_type !== event.eventType ||
        existing.session_id !== event.sessionId ||
        existing.turn_id !== (event.turnId ?? null) ||
        existing.content_hash !== event.contentHash ||
        existing.correlation_id !== event.correlationId ||
        (existing.payload_purged === 0 && existing.stored_payload_hash !== item.storedPayloadHash)
      ) {
        throw new Error(`eventId conflict for ${event.eventId}`);
      }
      return { status: "duplicate", sequence: existing.sequence };
    }));
  }

  readAfter(sequence: number, limit = 100): readonly LedgerEventRecord[] {
    this.#assertOpen();
    assertSequence(sequence);
    assertLimit(limit);
    const rows = this.#database.prepare(`
      SELECT sequence, schema_version, event_id, source, source_version, source_item_id,
             event_type, session_id, turn_id, occurred_at, cwd, project_hint,
             content_hash, correlation_id, payload_json, stored_payload_hash,
             redaction_count, payload_purged, inserted_at
      FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(sequence, limit) as unknown as EventRow[];
    return rows.map(rowToRecord);
  }

  readProjectionAfter(sequence: number, limit = 100): readonly LedgerProjectionRecord[] {
    this.#assertOpen();
    assertSequence(sequence);
    assertLimit(limit);
    const rows = this.#database.prepare(`
      SELECT sequence, source, session_id, turn_id, occurred_at, redaction_count
      FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(sequence, limit) as unknown as ProjectionRow[];
    return rows.map((row) => Object.freeze({
      sequence: row.sequence,
      source: row.source as EventEnvelope["source"],
      sessionId: row.session_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      occurredAt: row.occurred_at,
      redactionCount: row.redaction_count,
    }));
  }

  count(): number {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
    return row.count;
  }

  /** Latest global Ledger sequence owned by one session, or zero when absent. */
  latestSequenceForSession(sessionId: string): number {
    this.#assertOpen();
    assertSessionId(sessionId);
    const row = this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE session_id = ?
    `).get(sessionId) as { sequence: number };
    return row.sequence;
  }

  /** Aggregate session progress without materializing or exposing Ledger payloads. */
  sessionStats(sessionId: string): SessionLedgerStats {
    this.#assertOpen();
    assertSessionId(sessionId);
    const row = this.#database.prepare(`
      SELECT
        COALESCE(MAX(sequence), 0) AS latest_sequence,
        COUNT(*) AS event_count,
        COUNT(DISTINCT turn_id) AS turn_count,
        (SELECT event_type FROM events latest WHERE latest.session_id = ? ORDER BY sequence DESC LIMIT 1) AS latest_event_type,
        (SELECT occurred_at FROM events latest WHERE latest.session_id = ? ORDER BY sequence DESC LIMIT 1) AS last_occurred_at
      FROM events WHERE session_id = ?
    `).get(sessionId, sessionId, sessionId) as {
      latest_sequence: number;
      event_count: number;
      turn_count: number;
      latest_event_type: EventEnvelope["eventType"] | null;
      last_occurred_at: string | null;
    };
    return Object.freeze({
      sessionId,
      latestSequence: row.latest_sequence,
      eventCount: row.event_count,
      turnCount: row.turn_count,
      ...(row.latest_event_type === null ? {} : { latestEventType: row.latest_event_type }),
      ...(row.last_occurred_at === null ? {} : { lastOccurredAt: row.last_occurred_at }),
    });
  }

  loadIngestionCursor<TCursor = unknown>(ingestionId: string): IngestionCursorRecord<TCursor> | undefined {
    this.#assertOpen();
    assertIngestionId(ingestionId);
    const row = this.#database.prepare(`
      SELECT cursor_json, cursor_hash, updated_at FROM ingestion_cursors WHERE ingestion_id = ?
    `).get(ingestionId) as { cursor_json: string; cursor_hash: string; updated_at: string } | undefined;
    if (row === undefined) return undefined;
    if (sha256(row.cursor_json) !== row.cursor_hash) throw new Error(`ingestion cursor ${ingestionId} failed integrity verification`);
    return Object.freeze({
      ingestionId,
      cursor: deepFreeze(JSON.parse(row.cursor_json) as TCursor),
      updatedAt: row.updated_at,
    });
  }

  commitIngestionCursor(ingestionId: string, cursor: unknown): void {
    this.#assertOpen();
    assertIngestionId(ingestionId);
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) throw new Error("ingestion cursor must be an object");
    const cursorJson = JSON.stringify(cursor);
    if (Buffer.byteLength(cursorJson, "utf8") > MAX_INGESTION_CURSOR_BYTES) throw new Error("ingestion cursor exceeds 64 KiB");
    this.#database.prepare(`
      INSERT INTO ingestion_cursors (ingestion_id, cursor_json, cursor_hash, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(ingestion_id) DO UPDATE SET
        cursor_json = excluded.cursor_json,
        cursor_hash = excluded.cursor_hash,
        updated_at = excluded.updated_at
    `).run(ingestionId, cursorJson, sha256(cursorJson), this.#clock().toISOString());
  }

  /** Explicitly discards a source checkpoint so an idempotent full replay can rebuild it. */
  rebaseIngestionCursor(ingestionId: string): "REBASED" | "NOT_FOUND" {
    this.#assertOpen();
    assertIngestionId(ingestionId);
    const result = this.#database.prepare("DELETE FROM ingestion_cursors WHERE ingestion_id = ?").run(ingestionId);
    return result.changes === 1 ? "REBASED" : "NOT_FOUND";
  }

  cursor(consumerId: string): number {
    this.#assertOpen();
    assertConsumerId(consumerId);
    const row = this.#database.prepare("SELECT sequence FROM consumer_cursors WHERE consumer_id = ?").get(consumerId) as
      | { sequence: number }
      | undefined;
    return row?.sequence ?? 0;
  }

  commitCursor(consumerId: string, sequence: number): CursorCommitResult {
    this.#assertOpen();
    assertConsumerId(consumerId);
    assertSequence(sequence);
    return this.#transaction(() => {
      const maximum = (this.#database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get() as { sequence: number }).sequence;
      if (sequence > maximum) throw new Error("cursor cannot advance beyond the latest event");
      const existing = this.#database.prepare("SELECT sequence FROM consumer_cursors WHERE consumer_id = ?").get(consumerId) as
        | { sequence: number }
        | undefined;
      const previous = existing?.sequence ?? 0;
      if (sequence < previous) return { status: "rejected-rewind", currentSequence: previous, attemptedSequence: sequence };
      if (sequence === previous && existing !== undefined) return { status: "unchanged", sequence };
      const updatedAt = this.#clock().toISOString();
      this.#database.prepare(`
        INSERT INTO consumer_cursors (consumer_id, sequence, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(consumer_id) DO UPDATE SET sequence = excluded.sequence, updated_at = excluded.updated_at
      `).run(consumerId, sequence, updatedAt);
      if (existing === undefined && sequence === 0) return { status: "registered", sequence };
      return { status: "advanced", previousSequence: previous, sequence };
    });
  }

  readForConsumer(consumerId: string, limit = 100): readonly LedgerEventRecord[] {
    return this.readAfter(this.cursor(consumerId), limit);
  }

  purgeOccurredBefore(cutoff: string, limit = 1_000): RetentionResult {
    this.#assertOpen();
    assertLimit(limit);
    const cutoffMs = Date.parse(cutoff);
    if (Number.isNaN(cutoffMs)) throw new Error("retention cutoff must be an ISO date-time");
    return this.#transaction(() => {
      const consumerCount = (this.#database.prepare("SELECT COUNT(*) AS count FROM consumer_cursors").get() as { count: number }).count;
      if (consumerCount === 0) {
        return { purgedPayloads: 0, safeThroughSequence: 0, blockedByMissingConsumer: true, hasMore: false };
      }
      const safeThroughSequence = (this.#database.prepare("SELECT MIN(sequence) AS sequence FROM consumer_cursors").get() as { sequence: number }).sequence;
      const emptyPayloadHash = sha256("null");
      const result = this.#database.prepare(`
        UPDATE events
        SET payload_json = 'null', stored_payload_hash = ?, payload_purged = 1
        WHERE sequence IN (
          SELECT sequence FROM events
          WHERE occurred_at_ms < ? AND sequence <= ? AND payload_purged = 0
          ORDER BY sequence ASC LIMIT ?
        )
      `).run(
        emptyPayloadHash,
        cutoffMs,
        safeThroughSequence,
        limit,
      );
      const remaining = this.#database.prepare(`
        SELECT 1 AS present FROM events
        WHERE occurred_at_ms < ? AND sequence <= ? AND payload_purged = 0 LIMIT 1
      `).get(cutoffMs, safeThroughSequence);
      return {
        purgedPayloads: Number(result.changes),
        safeThroughSequence,
        blockedByMissingConsumer: false,
        hasMore: remaining !== undefined,
      };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
