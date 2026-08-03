import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  CONTROL_API_SCHEMA_VERSION,
  MAX_PAGE_SIZE,
  capabilitySnapshotSchema,
  diagnosticsSchema,
  eventMetadataSchema,
  jobSnapshotSchema,
  overviewSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  stageSnapshotSchema,
  type CapabilitySnapshot,
  type Diagnostics,
  type EventMetadata,
  type JobSnapshot,
  type Overview,
  type SessionDetail,
  type SessionSummary,
} from "@zhiloop/control-api";
import { createCursorCodec, type CursorCodec, type CursorPayload } from "@zhiloop/control-api/server";

import type {
  OperatorDiagnostic,
  OperationalProjectionSnapshot,
  OperationalProjectionSource,
  OperationalQueryPort,
  OperationalReadModelOptions,
  OverviewRuntime,
  Page,
  PageRequest,
  RebuildResult,
  SessionProjectionInput,
  StageRunProjection,
} from "./types.js";
import { InvalidOperationalCursorError } from "./types.js";
import {
  parseCapability,
  parseEvent,
  parseHealth,
  parseJob,
  parseOperatorDiagnostic,
  parseSession,
  parseStageRun,
} from "./validation.js";

const COMPONENT = "operational-read-model";
const CURRENT_MIGRATION_VERSION = 1;
const DEFAULT_PAGE_SIZE = 50;

interface JsonRow {
  readonly payload_json: string;
}

interface SessionRow {
  readonly session_id: string;
  readonly title: string;
  readonly source: SessionSummary["source"];
  readonly source_status: SessionSummary["sourceStatus"];
  readonly source_version: string | null;
  readonly project_hint: string | null;
  readonly cwd_alias: string | null;
  readonly first_activity_at: string;
  readonly last_activity_at: string;
  readonly capture_status: SessionSummary["captureStatus"];
  readonly event_count: number;
  readonly turn_count: number;
  readonly ignored_records: number;
  readonly redaction_count: number;
  readonly cursor_byte_offset: number | null;
  readonly cursor_line_number: number | null;
  readonly cursor_observed_at: string | null;
}

interface EventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly source: string;
  readonly session_id: string;
  readonly turn_id: string | null;
  readonly occurred_at: string;
  readonly correlation_id: string;
  readonly content_hash: string;
  readonly redaction_count: number;
  readonly payload_purged: number;
}

interface DiagnosticRow {
  readonly diagnostic_id: string;
  readonly component: string;
  readonly code: string;
  readonly severity: OperatorDiagnostic["severity"];
  readonly observed_at: string;
  readonly retryable: number;
  readonly evidence_refs_json: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function filterHash(collection: string, filters: Readonly<Record<string, string>> = {}): string {
  return sha256(JSON.stringify({ collection, ...Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))) }));
}

function requirePage(page: PageRequest | undefined): { readonly limit: number; readonly cursor?: string } {
  const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return page?.cursor === undefined ? { limit } : { limit, cursor: page.cursor };
}

function freezePage<T>(items: readonly T[], nextCursor?: string): Page<T> {
  const frozen = Object.freeze(items.map((item) => Object.freeze(item)));
  return Object.freeze(nextCursor === undefined ? { items: frozen } : { items: frozen, nextCursor });
}

function jsonSnapshot<T>(row: JsonRow | undefined, parse: (value: unknown) => T): T | undefined {
  if (row === undefined) return undefined;
  return parse(JSON.parse(row.payload_json) as unknown);
}

function sessionFromRow(row: SessionRow): SessionProjectionInput {
  const summary = sessionSummarySchema.parse({
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    sessionId: row.session_id,
    title: row.title,
    source: row.source,
    sourceStatus: row.source_status,
    ...(row.source_version === null ? {} : { sourceVersion: row.source_version }),
    captureStatus: row.capture_status,
    ...(row.project_hint === null ? {} : { projectHint: row.project_hint }),
    ...(row.cwd_alias === null ? {} : { cwdAlias: row.cwd_alias }),
    firstActivityAt: row.first_activity_at,
    lastActivityAt: row.last_activity_at,
    eventCount: row.event_count,
    turnCount: row.turn_count,
    ignoredRecords: row.ignored_records,
    redactionCount: row.redaction_count,
  });
  const hasCursor = row.cursor_byte_offset !== null && row.cursor_line_number !== null && row.cursor_observed_at !== null;
  return hasCursor
    ? {
        summary,
        latestCursor: {
          byteOffset: row.cursor_byte_offset as number,
          lineNumber: row.cursor_line_number as number,
          observedAt: row.cursor_observed_at as string,
        },
      }
    : { summary };
}

function eventFromRow(row: EventRow): EventMetadata {
  return eventMetadataSchema.parse({
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    sequence: row.sequence,
    eventId: row.event_id,
    eventType: row.event_type,
    source: row.source,
    sessionId: row.session_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    contentHash: row.content_hash,
    redactionCount: row.redaction_count,
    payloadPurged: row.payload_purged === 1,
  });
}

function diagnosticFromRow(row: DiagnosticRow): OperatorDiagnostic {
  return parseOperatorDiagnostic({
    diagnosticId: row.diagnostic_id,
    component: row.component,
    code: row.code,
    severity: row.severity,
    observedAt: row.observed_at,
    retryable: row.retryable === 1,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
  });
}

export class SqliteOperationalReadModel implements OperationalQueryPort {
  readonly #database: DatabaseSync;
  readonly #cursorCodec: CursorCodec;
  readonly #clock: () => Date;
  readonly #faultInjector: OperationalReadModelOptions["faultInjector"];
  #closed = false;

  constructor(filename: string, options: OperationalReadModelOptions) {
    this.#database = new DatabaseSync(filename);
    this.#cursorCodec = createCursorCodec(options.cursorSecret);
    this.#clock = options.clock ?? (() => new Date());
    this.#faultInjector = options.faultInjector;
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA synchronous = NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("operational read model is closed");
  }

  #migrate(): void {
    const metaExists = this.#database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'operational_read_model_meta'
    `).get() as { present: number } | undefined;
    const existing = metaExists === undefined
      ? undefined
      : this.#database.prepare(
          "SELECT migration_version FROM operational_read_model_meta WHERE component = ?",
        ).get(COMPONENT) as { migration_version: number } | undefined;
    if (existing !== undefined && existing.migration_version > CURRENT_MIGRATION_VERSION) {
      throw new Error(
        `operational read-model migration ${existing.migration_version} is newer than supported version ${CURRENT_MIGRATION_VERSION}`,
      );
    }
    if (existing?.migration_version === CURRENT_MIGRATION_VERSION) return;
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS operational_read_model_meta (
          component TEXT PRIMARY KEY,
          migration_version INTEGER NOT NULL CHECK(migration_version >= 0),
          rebuilt_at TEXT
        );
        CREATE TABLE IF NOT EXISTS capability_snapshots (
          capability_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          last_transition_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS capability_snapshots_status_idx
          ON capability_snapshots(status, capability_id);
        CREATE TABLE IF NOT EXISTS session_catalog (
          session_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          source TEXT NOT NULL,
          source_status TEXT NOT NULL,
          source_version TEXT,
          project_hint TEXT,
          cwd_alias TEXT,
          first_activity_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_catalog_activity_idx
          ON session_catalog(last_activity_at DESC, session_id ASC);
        CREATE TABLE IF NOT EXISTS session_projections (
          session_id TEXT PRIMARY KEY,
          capture_status TEXT NOT NULL,
          event_count INTEGER NOT NULL CHECK(event_count >= 0),
          turn_count INTEGER NOT NULL CHECK(turn_count >= 0),
          ignored_records INTEGER NOT NULL CHECK(ignored_records >= 0),
          redaction_count INTEGER NOT NULL CHECK(redaction_count >= 0),
          cursor_byte_offset INTEGER CHECK(cursor_byte_offset >= 0),
          cursor_line_number INTEGER CHECK(cursor_line_number >= 0),
          cursor_observed_at TEXT,
          FOREIGN KEY(session_id) REFERENCES session_catalog(session_id) ON DELETE CASCADE,
          CHECK((cursor_byte_offset IS NULL AND cursor_line_number IS NULL AND cursor_observed_at IS NULL)
             OR (cursor_byte_offset IS NOT NULL AND cursor_line_number IS NOT NULL AND cursor_observed_at IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS stage_runs (
          run_id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          last_transition_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stage_runs_entity_idx
          ON stage_runs(entity_id, last_transition_at DESC, run_id ASC);
        CREATE TABLE IF NOT EXISTS job_snapshots (
          job_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS job_snapshots_observed_idx
          ON job_snapshots(observed_at DESC, job_id ASC);
        CREATE TABLE IF NOT EXISTS projected_event_metadata (
          sequence INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          source TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT,
          occurred_at TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          redaction_count INTEGER NOT NULL CHECK(redaction_count >= 0),
          payload_purged INTEGER NOT NULL CHECK(payload_purged IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS projected_event_session_sequence_idx
          ON projected_event_metadata(session_id, sequence DESC);
        CREATE TABLE IF NOT EXISTS operator_diagnostics (
          diagnostic_id TEXT PRIMARY KEY,
          component TEXT NOT NULL,
          code TEXT NOT NULL,
          severity TEXT NOT NULL CHECK(severity IN ('INFO', 'WARNING', 'ERROR')),
          observed_at TEXT NOT NULL,
          retryable INTEGER NOT NULL CHECK(retryable IN (0, 1)),
          evidence_refs_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operator_diagnostics_observed_idx
          ON operator_diagnostics(observed_at DESC, diagnostic_id ASC);
        CREATE TABLE IF NOT EXISTS operational_health (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consumer_lag_projections (
          consumer_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL CHECK(sequence >= 0),
          lag INTEGER NOT NULL CHECK(lag >= 0),
          updated_at TEXT NOT NULL
        );
      `);
      this.#faultInjector?.("migration.after-schema");
      this.#database.prepare(`
        INSERT INTO operational_read_model_meta(component, migration_version)
        VALUES (?, ?)
        ON CONFLICT(component) DO UPDATE SET migration_version = excluded.migration_version
      `).run(COMPONENT, CURRENT_MIGRATION_VERSION);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #transaction<T>(action: () => T): T {
    this.#assertOpen();
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

  #decodeCursor(cursor: string | undefined, expectedFilterHash: string): CursorPayload | undefined {
    if (cursor === undefined) return undefined;
    try {
      const decoded = this.#cursorCodec.decode(cursor);
      if (decoded.filterHash !== expectedFilterHash) throw new InvalidOperationalCursorError();
      return decoded;
    } catch (error) {
      if (error instanceof InvalidOperationalCursorError) throw error;
      throw new InvalidOperationalCursorError();
    }
  }

  #nextCursor<T>(rows: readonly T[], limit: number, encode: (row: T) => CursorPayload): string | undefined {
    if (rows.length <= limit) return undefined;
    const last = rows[limit - 1];
    if (last === undefined) return undefined;
    return this.#cursorCodec.encode(encode(last));
  }

  #writeCapability(input: CapabilitySnapshot): void {
    const value = parseCapability(input);
    this.#database.prepare(`
      INSERT INTO capability_snapshots(capability_id, status, observed_at, last_transition_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(capability_id) DO UPDATE SET status=excluded.status, observed_at=excluded.observed_at,
        last_transition_at=excluded.last_transition_at, payload_json=excluded.payload_json
    `).run(value.capabilityId, value.status, value.observedAt, value.lastTransitionAt, JSON.stringify(value));
  }

  #writeSession(input: SessionProjectionInput): void {
    const value = parseSession(input);
    const summary = value.summary;
    this.#database.prepare(`
      INSERT INTO session_catalog(
        session_id, title, source, source_status, source_version, project_hint, cwd_alias,
        first_activity_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, source=excluded.source,
        source_status=excluded.source_status, source_version=excluded.source_version,
        project_hint=excluded.project_hint, cwd_alias=excluded.cwd_alias,
        first_activity_at=excluded.first_activity_at, last_activity_at=excluded.last_activity_at
    `).run(
      summary.sessionId, summary.title, summary.source, summary.sourceStatus, summary.sourceVersion ?? null,
      summary.projectHint ?? null, summary.cwdAlias ?? null, summary.firstActivityAt, summary.lastActivityAt,
    );
    this.#database.prepare(`
      INSERT INTO session_projections(
        session_id, capture_status, event_count, turn_count, ignored_records, redaction_count,
        cursor_byte_offset, cursor_line_number, cursor_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET capture_status=excluded.capture_status,
        event_count=excluded.event_count, turn_count=excluded.turn_count,
        ignored_records=excluded.ignored_records, redaction_count=excluded.redaction_count,
        cursor_byte_offset=excluded.cursor_byte_offset, cursor_line_number=excluded.cursor_line_number,
        cursor_observed_at=excluded.cursor_observed_at
    `).run(
      summary.sessionId, summary.captureStatus, summary.eventCount, summary.turnCount,
      summary.ignoredRecords, summary.redactionCount, value.latestCursor?.byteOffset ?? null,
      value.latestCursor?.lineNumber ?? null, value.latestCursor?.observedAt ?? null,
    );
  }

  #writeStage(input: StageRunProjection): void {
    const value = parseStageRun(input);
    this.#database.prepare(`
      INSERT INTO stage_runs(run_id, entity_id, stage, status, observed_at, last_transition_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET entity_id=excluded.entity_id, stage=excluded.stage,
        status=excluded.status, observed_at=excluded.observed_at,
        last_transition_at=excluded.last_transition_at, payload_json=excluded.payload_json
    `).run(
      value.runId, value.snapshot.entityId, value.snapshot.stage, value.snapshot.status,
      value.snapshot.observedAt, value.snapshot.lastTransitionAt, JSON.stringify(value.snapshot),
    );
  }

  #writeJob(input: JobSnapshot): void {
    const value = parseJob(input);
    this.#database.prepare(`
      INSERT INTO job_snapshots(job_id, status, observed_at, payload_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, observed_at=excluded.observed_at,
        payload_json=excluded.payload_json
    `).run(value.jobId, value.status, value.observedAt, JSON.stringify(value));
  }

  #writeEvent(input: EventMetadata): void {
    const value = parseEvent(input);
    this.#database.prepare(`
      INSERT INTO projected_event_metadata(
        sequence, event_id, event_type, source, session_id, turn_id, occurred_at, correlation_id,
        content_hash, redaction_count, payload_purged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sequence) DO UPDATE SET event_id=excluded.event_id, event_type=excluded.event_type,
        source=excluded.source, session_id=excluded.session_id, turn_id=excluded.turn_id,
        occurred_at=excluded.occurred_at, correlation_id=excluded.correlation_id,
        content_hash=excluded.content_hash, redaction_count=excluded.redaction_count,
        payload_purged=excluded.payload_purged
    `).run(
      value.sequence, value.eventId, value.eventType, value.source, value.sessionId, value.turnId ?? null,
      value.occurredAt, value.correlationId, value.contentHash, value.redactionCount, value.payloadPurged ? 1 : 0,
    );
  }

  #writeOperatorDiagnostic(input: OperatorDiagnostic): void {
    const value = parseOperatorDiagnostic(input);
    this.#database.prepare(`
      INSERT INTO operator_diagnostics(
        diagnostic_id, component, code, severity, observed_at, retryable, evidence_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(diagnostic_id) DO UPDATE SET component=excluded.component, code=excluded.code,
        severity=excluded.severity, observed_at=excluded.observed_at, retryable=excluded.retryable,
        evidence_refs_json=excluded.evidence_refs_json
    `).run(
      value.diagnosticId, value.component, value.code, value.severity, value.observedAt,
      value.retryable ? 1 : 0, JSON.stringify(value.evidenceRefs),
    );
  }

  #writeHealth(input: Diagnostics): void {
    const value = parseHealth(input);
    this.#database.prepare(`
      INSERT INTO operational_health(singleton, observed_at, payload_json) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET observed_at=excluded.observed_at, payload_json=excluded.payload_json
    `).run(value.observedAt, JSON.stringify(value));
    this.#database.prepare("DELETE FROM consumer_lag_projections").run();
    const insert = this.#database.prepare(`
      INSERT INTO consumer_lag_projections(consumer_id, sequence, lag, updated_at) VALUES (?, ?, ?, ?)
    `);
    for (const lag of value.consumerLags) insert.run(lag.consumerId, lag.sequence, lag.lag, lag.updatedAt);
  }

  projectCapability(input: CapabilitySnapshot): void {
    this.#transaction(() => this.#writeCapability(input));
  }

  projectSession(input: SessionProjectionInput): void {
    this.#transaction(() => this.#writeSession(input));
  }

  projectStageRun(input: StageRunProjection): void {
    this.#transaction(() => this.#writeStage(input));
  }

  projectJob(input: JobSnapshot): void {
    this.#transaction(() => this.#writeJob(input));
  }

  projectEventMetadata(input: EventMetadata): void {
    this.#transaction(() => this.#writeEvent(input));
  }

  projectOperatorDiagnostic(input: OperatorDiagnostic): void {
    this.#transaction(() => this.#writeOperatorDiagnostic(input));
  }

  projectHealth(input: Diagnostics): void {
    this.#transaction(() => this.#writeHealth(input));
  }

  rebuild(source: OperationalProjectionSource | OperationalProjectionSnapshot): RebuildResult {
    const snapshot: OperationalProjectionSnapshot = "snapshot" in source
      ? source.snapshot()
      : source;
    const rebuiltAt = this.#clock().toISOString();
    return this.#transaction(() => {
      this.#database.exec(`
        DELETE FROM consumer_lag_projections;
        DELETE FROM operational_health;
        DELETE FROM operator_diagnostics;
        DELETE FROM projected_event_metadata;
        DELETE FROM job_snapshots;
        DELETE FROM stage_runs;
        DELETE FROM session_projections;
        DELETE FROM session_catalog;
        DELETE FROM capability_snapshots;
      `);
      this.#faultInjector?.("rebuild.after-clear");
      for (const value of snapshot.capabilities) this.#writeCapability(value);
      for (const value of snapshot.sessions) this.#writeSession(value);
      for (const value of snapshot.stages) this.#writeStage(value);
      for (const value of snapshot.jobs) this.#writeJob(value);
      for (const value of snapshot.events) this.#writeEvent(value);
      for (const value of snapshot.diagnostics) this.#writeOperatorDiagnostic(value);
      if (snapshot.health !== undefined) this.#writeHealth(snapshot.health);
      this.#database.prepare(
        "UPDATE operational_read_model_meta SET rebuilt_at = ? WHERE component = ?",
      ).run(rebuiltAt, COMPONENT);
      return Object.freeze({
        capabilities: snapshot.capabilities.length,
        sessions: snapshot.sessions.length,
        stages: snapshot.stages.length,
        jobs: snapshot.jobs.length,
        events: snapshot.events.length,
        diagnostics: snapshot.diagnostics.length,
        rebuiltAt,
      });
    });
  }

  listCapabilities(page?: PageRequest): Page<CapabilitySnapshot> {
    this.#assertOpen();
    const requested = requirePage(page);
    const hash = filterHash("capabilities");
    const cursor = this.#decodeCursor(requested.cursor, hash);
    const rows = this.#database.prepare(`
      SELECT payload_json FROM capability_snapshots
      WHERE (? IS NULL OR capability_id > ?)
      ORDER BY capability_id ASC LIMIT ?
    `).all(cursor?.sortKey ?? null, cursor?.sortKey ?? null, requested.limit + 1) as unknown as JsonRow[];
    const nextCursor = this.#nextCursor(rows, requested.limit, (row) => {
      const value = capabilitySnapshotSchema.parse(JSON.parse(row.payload_json) as unknown);
      return { version: 1, sortKey: value.capabilityId, tieBreaker: value.capabilityId, filterHash: hash };
    });
    return freezePage(rows.slice(0, requested.limit).map((row) => capabilitySnapshotSchema.parse(JSON.parse(row.payload_json) as unknown)), nextCursor);
  }

  listSessions(page?: PageRequest): Page<SessionSummary> {
    this.#assertOpen();
    const requested = requirePage(page);
    const hash = filterHash("sessions");
    const cursor = this.#decodeCursor(requested.cursor, hash);
    const rows = this.#database.prepare(`
      SELECT c.session_id, c.title, c.source, c.source_status, c.source_version, c.project_hint,
             c.cwd_alias, c.first_activity_at, c.last_activity_at, p.capture_status, p.event_count,
             p.turn_count, p.ignored_records, p.redaction_count, p.cursor_byte_offset,
             p.cursor_line_number, p.cursor_observed_at
      FROM session_catalog c JOIN session_projections p ON p.session_id = c.session_id
      WHERE (? IS NULL OR c.last_activity_at < ? OR (c.last_activity_at = ? AND c.session_id > ?))
      ORDER BY c.last_activity_at DESC, c.session_id ASC LIMIT ?
    `).all(
      cursor?.sortKey ?? null, cursor?.sortKey ?? null, cursor?.sortKey ?? null,
      cursor?.tieBreaker ?? null, requested.limit + 1,
    ) as unknown as SessionRow[];
    const nextCursor = this.#nextCursor(rows, requested.limit, (row) => ({
      version: 1,
      sortKey: row.last_activity_at,
      tieBreaker: row.session_id,
      filterHash: hash,
    }));
    return freezePage(rows.slice(0, requested.limit).map((row) => sessionFromRow(row).summary), nextCursor);
  }

  getSession(sessionId: string): SessionDetail | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT c.session_id, c.title, c.source, c.source_status, c.source_version, c.project_hint,
             c.cwd_alias, c.first_activity_at, c.last_activity_at, p.capture_status, p.event_count,
             p.turn_count, p.ignored_records, p.redaction_count, p.cursor_byte_offset,
             p.cursor_line_number, p.cursor_observed_at
      FROM session_catalog c JOIN session_projections p ON p.session_id = c.session_id
      WHERE c.session_id = ?
    `).get(sessionId) as SessionRow | undefined;
    if (row === undefined) return undefined;
    const projected = sessionFromRow(row);
    const stages = this.#database.prepare(`
      SELECT payload_json FROM stage_runs WHERE entity_id = ?
      ORDER BY last_transition_at DESC, run_id ASC LIMIT 100
    `).all(sessionId) as unknown as JsonRow[];
    return sessionDetailSchema.parse({
      summary: projected.summary,
      stages: stages.map((stage) => stageSnapshotSchema.parse(JSON.parse(stage.payload_json) as unknown)),
      injections: [],
      ...(projected.latestCursor === undefined ? {} : { latestCursor: projected.latestCursor }),
    });
  }

  listSessionEvents(sessionId: string, page?: PageRequest): Page<EventMetadata> {
    this.#assertOpen();
    const requested = requirePage(page);
    const hash = filterHash("session-events", { sessionId });
    const cursor = this.#decodeCursor(requested.cursor, hash);
    const cursorSequence = cursor === undefined ? undefined : Number(cursor.sortKey);
    if (cursorSequence !== undefined && (!Number.isSafeInteger(cursorSequence) || cursorSequence < 1)) {
      throw new InvalidOperationalCursorError();
    }
    const rows = this.#database.prepare(`
      SELECT sequence, event_id, event_type, source, session_id, turn_id, occurred_at,
             correlation_id, content_hash, redaction_count, payload_purged
      FROM projected_event_metadata
      WHERE session_id = ? AND (? IS NULL OR sequence < ?)
      ORDER BY sequence DESC LIMIT ?
    `).all(sessionId, cursorSequence ?? null, cursorSequence ?? null, requested.limit + 1) as unknown as EventRow[];
    const nextCursor = this.#nextCursor(rows, requested.limit, (row) => ({
      version: 1,
      sortKey: String(row.sequence),
      tieBreaker: row.event_id,
      filterHash: hash,
    }));
    return freezePage(rows.slice(0, requested.limit).map(eventFromRow), nextCursor);
  }

  listStages(entityId: string, page?: PageRequest): Page<StageRunProjection> {
    this.#assertOpen();
    const requested = requirePage(page);
    const hash = filterHash("stages", { entityId });
    const cursor = this.#decodeCursor(requested.cursor, hash);
    const rows = this.#database.prepare(`
      SELECT run_id, last_transition_at, payload_json FROM stage_runs
      WHERE entity_id = ? AND (? IS NULL OR last_transition_at < ? OR (last_transition_at = ? AND run_id > ?))
      ORDER BY last_transition_at DESC, run_id ASC LIMIT ?
    `).all(
      entityId, cursor?.sortKey ?? null, cursor?.sortKey ?? null, cursor?.sortKey ?? null,
      cursor?.tieBreaker ?? null, requested.limit + 1,
    ) as unknown as Array<JsonRow & { readonly run_id: string; readonly last_transition_at: string }>;
    const nextCursor = this.#nextCursor(rows, requested.limit, (row) => ({
      version: 1, sortKey: row.last_transition_at, tieBreaker: row.run_id, filterHash: hash,
    }));
    return freezePage(rows.slice(0, requested.limit).map((row) => parseStageRun({
      runId: row.run_id,
      snapshot: stageSnapshotSchema.parse(JSON.parse(row.payload_json) as unknown),
    })), nextCursor);
  }

  listJobs(page?: PageRequest): Page<JobSnapshot> {
    this.#assertOpen();
    const requested = requirePage(page);
    const hash = filterHash("jobs");
    const cursor = this.#decodeCursor(requested.cursor, hash);
    const rows = this.#database.prepare(`
      SELECT job_id, observed_at, payload_json FROM job_snapshots
      WHERE (? IS NULL OR observed_at < ? OR (observed_at = ? AND job_id > ?))
      ORDER BY observed_at DESC, job_id ASC LIMIT ?
    `).all(
      cursor?.sortKey ?? null, cursor?.sortKey ?? null, cursor?.sortKey ?? null,
      cursor?.tieBreaker ?? null, requested.limit + 1,
    ) as unknown as Array<JsonRow & { readonly job_id: string; readonly observed_at: string }>;
    const nextCursor = this.#nextCursor(rows, requested.limit, (row) => ({
      version: 1, sortKey: row.observed_at, tieBreaker: row.job_id, filterHash: hash,
    }));
    return freezePage(rows.slice(0, requested.limit).map((row) => jobSnapshotSchema.parse(JSON.parse(row.payload_json) as unknown)), nextCursor);
  }

  listOperatorDiagnostics(page?: PageRequest): Page<OperatorDiagnostic> {
    this.#assertOpen();
    const requested = requirePage(page);
    const hash = filterHash("operator-diagnostics");
    const cursor = this.#decodeCursor(requested.cursor, hash);
    const rows = this.#database.prepare(`
      SELECT diagnostic_id, component, code, severity, observed_at, retryable, evidence_refs_json
      FROM operator_diagnostics
      WHERE (? IS NULL OR observed_at < ? OR (observed_at = ? AND diagnostic_id > ?))
      ORDER BY observed_at DESC, diagnostic_id ASC LIMIT ?
    `).all(
      cursor?.sortKey ?? null, cursor?.sortKey ?? null, cursor?.sortKey ?? null,
      cursor?.tieBreaker ?? null, requested.limit + 1,
    ) as unknown as DiagnosticRow[];
    const nextCursor = this.#nextCursor(rows, requested.limit, (row) => ({
      version: 1, sortKey: row.observed_at, tieBreaker: row.diagnostic_id, filterHash: hash,
    }));
    return freezePage(rows.slice(0, requested.limit).map(diagnosticFromRow), nextCursor);
  }

  getDiagnostics(): Diagnostics | undefined {
    this.#assertOpen();
    return jsonSnapshot(
      this.#database.prepare("SELECT payload_json FROM operational_health WHERE singleton = 1").get() as JsonRow | undefined,
      (value) => diagnosticsSchema.parse(value),
    );
  }

  getOverview(runtime: OverviewRuntime): Overview {
    this.#assertOpen();
    const firstCapabilityPage = this.listCapabilities({ limit: MAX_PAGE_SIZE });
    const secondCapabilityPage = firstCapabilityPage.nextCursor === undefined
      ? undefined
      : this.listCapabilities({ limit: MAX_PAGE_SIZE, cursor: firstCapabilityPage.nextCursor });
    const capabilities = secondCapabilityPage === undefined
      ? firstCapabilityPage.items
      : [...firstCapabilityPage.items, ...secondCapabilityPage.items];
    const recentSessions = this.listSessions({ limit: 20 }).items;
    const counts = this.#database.prepare(`
      SELECT
        SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'RETRY_WAIT' THEN 1 ELSE 0 END) AS retry_wait,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
      FROM job_snapshots
    `).get() as { queued: number | null; running: number | null; retry_wait: number | null; failed: number | null };
    return overviewSchema.parse({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      observedAt: runtime.observedAt,
      rolloutMode: runtime.rolloutMode,
      sidecarVersion: runtime.sidecarVersion,
      capabilities: [...capabilities],
      recentSessions: [...recentSessions],
      jobs: {
        queued: counts.queued ?? 0,
        running: counts.running ?? 0,
        retryWait: counts.retry_wait ?? 0,
        failed: counts.failed ?? 0,
      },
      alertCount: runtime.alertCount,
    });
  }

  exportSnapshot(): OperationalProjectionSnapshot {
    this.#assertOpen();
    const capabilityRows = this.#database.prepare(
      "SELECT payload_json FROM capability_snapshots ORDER BY capability_id ASC",
    ).all() as unknown as JsonRow[];
    const sessionRows = this.#database.prepare(`
      SELECT c.session_id, c.title, c.source, c.source_status, c.source_version, c.project_hint,
             c.cwd_alias, c.first_activity_at, c.last_activity_at, p.capture_status, p.event_count,
             p.turn_count, p.ignored_records, p.redaction_count, p.cursor_byte_offset,
             p.cursor_line_number, p.cursor_observed_at
      FROM session_catalog c JOIN session_projections p ON p.session_id = c.session_id
      ORDER BY c.session_id ASC
    `).all() as unknown as SessionRow[];
    const stageRows = this.#database.prepare(
      "SELECT run_id, payload_json FROM stage_runs ORDER BY run_id ASC",
    ).all() as unknown as Array<JsonRow & { readonly run_id: string }>;
    const jobRows = this.#database.prepare(
      "SELECT payload_json FROM job_snapshots ORDER BY job_id ASC",
    ).all() as unknown as JsonRow[];
    const eventRows = this.#database.prepare(`
      SELECT sequence, event_id, event_type, source, session_id, turn_id, occurred_at,
             correlation_id, content_hash, redaction_count, payload_purged
      FROM projected_event_metadata ORDER BY sequence ASC
    `).all() as unknown as EventRow[];
    const diagnosticRows = this.#database.prepare(`
      SELECT diagnostic_id, component, code, severity, observed_at, retryable, evidence_refs_json
      FROM operator_diagnostics ORDER BY diagnostic_id ASC
    `).all() as unknown as DiagnosticRow[];
    const health = this.getDiagnostics();
    return Object.freeze({
      capabilities: Object.freeze(capabilityRows.map((row) => capabilitySnapshotSchema.parse(JSON.parse(row.payload_json) as unknown))),
      sessions: Object.freeze(sessionRows.map(sessionFromRow)),
      stages: Object.freeze(stageRows.map((row) => parseStageRun({
        runId: row.run_id,
        snapshot: stageSnapshotSchema.parse(JSON.parse(row.payload_json) as unknown),
      }))),
      jobs: Object.freeze(jobRows.map((row) => jobSnapshotSchema.parse(JSON.parse(row.payload_json) as unknown))),
      events: Object.freeze(eventRows.map(eventFromRow)),
      diagnostics: Object.freeze(diagnosticRows.map(diagnosticFromRow)),
      ...(health === undefined ? {} : { health }),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
