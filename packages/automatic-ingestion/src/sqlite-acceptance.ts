import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { SessionCatalogQueryPort } from "@zhiloop/session-catalog";

import {
  REAL_CODEX_ACCEPTANCE_STAGES,
  RealCodexIngestionAcceptanceVerifier,
  type RealCodexAcceptanceEvidence,
  type RealCodexAcceptanceEvidencePort,
  type RealCodexAcceptanceRequest,
  type RealCodexAcceptanceResult,
  type RealCodexAcceptanceStage,
} from "./acceptance.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const MAX_IDENTITY_BYTES = 16_384;
const DEFAULT_MAX_SESSIONS = 10_000;

interface EvidenceRow {
  readonly stage: string;
  readonly session_id: string;
  readonly observed_at: string;
  readonly evidence_ref: string;
}

interface RunRow {
  readonly session_id: string;
  readonly task_created_at: string;
  readonly verified_at: string;
  readonly evidence_ref: string;
  readonly result_json: string;
}

export interface RealCodexAcceptanceCursorObservation {
  readonly updatedAt: string;
  /** Already-redacted identity material such as byte offset/line number or a digest. It is hashed before persistence. */
  readonly identity: string;
}

export interface RealCodexAcceptanceCursorPort {
  load(sessionId: string): Promise<RealCodexAcceptanceCursorObservation | undefined>;
}

export interface PersistedRealCodexAcceptance {
  readonly request: RealCodexAcceptanceRequest;
  readonly result: RealCodexAcceptanceResult;
  readonly verifiedAt: string;
  readonly evidenceRef: string;
}

export interface SqliteRealCodexAcceptanceEvidenceStoreOptions {
  readonly clock?: () => Date;
  readonly maxSessions?: number;
}

export interface RealCodexAcceptanceEvidenceWrite {
  readonly stage: RealCodexAcceptanceStage;
  readonly sessionId: string;
  readonly identity: string;
  readonly observedAt?: string;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function now(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("acceptance clock returned an invalid date");
  return value.toISOString();
}

function assertSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("real Codex acceptance sessionId is invalid");
}

function assertStage(stage: string): asserts stage is RealCodexAcceptanceStage {
  if (!REAL_CODEX_ACCEPTANCE_STAGES.includes(stage as RealCodexAcceptanceStage)) {
    throw new Error("real Codex acceptance stage is invalid");
  }
}

function opaqueRef(stage: RealCodexAcceptanceStage | "ACCEPTANCE", sessionId: string, identity: string): string {
  if (Buffer.byteLength(identity, "utf8") > MAX_IDENTITY_BYTES) throw new Error("acceptance evidence identity is too large");
  const digest = createHash("sha256").update(`zhiloop-real-codex-v1\0${stage}\0${sessionId}\0${identity}`).digest("hex");
  return `${stage.toLowerCase()}:${digest}`;
}

function parseResult(serialized: string): RealCodexAcceptanceResult {
  const value = JSON.parse(serialized) as Partial<RealCodexAcceptanceResult>;
  const exactStages = (items: unknown, expected: readonly RealCodexAcceptanceStage[]): boolean => (
    Array.isArray(items)
    && items.length === expected.length
    && items.every((item, index) => item === expected[index])
  );
  if (
    value.schemaVersion !== 1
    || value.status !== "VERIFIED"
    || typeof value.sessionId !== "string"
    || value.reason !== "ACCEPTANCE_SUCCEEDED"
    || !exactStages(value.requiredStages, REAL_CODEX_ACCEPTANCE_STAGES)
    || !exactStages(value.verifiedStages, REAL_CODEX_ACCEPTANCE_STAGES)
    || !exactStages(value.missingStages, [])
    || !exactStages(value.invalidStages, [])
  ) {
    throw new Error("persisted real Codex acceptance result is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "VERIFIED",
    sessionId: value.sessionId,
    requiredStages: REAL_CODEX_ACCEPTANCE_STAGES,
    verifiedStages: REAL_CODEX_ACCEPTANCE_STAGES,
    missingStages: Object.freeze([]),
    invalidStages: Object.freeze([]),
    reason: "ACCEPTANCE_SUCCEEDED",
  });
}

/**
 * Durable, content-free evidence storage. Only an exact session ID, stage,
 * timestamp and opaque digest are persisted; prompt text, transcript paths,
 * payloads, secrets and caller-provided identity material never reach SQLite.
 */
export class SqliteRealCodexAcceptanceEvidenceStore implements RealCodexAcceptanceEvidencePort {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #maxSessions: number;
  #closed = false;

  constructor(filename: string, options: SqliteRealCodexAcceptanceEvidenceStoreOptions = {}) {
    this.#database = new DatabaseSync(filename);
    this.#clock = options.clock ?? (() => new Date());
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1 || this.#maxSessions > 100_000) {
      this.#database.close();
      throw new Error("acceptance maxSessions must be between 1 and 100000");
    }
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS real_codex_acceptance_evidence (
          session_id TEXT NOT NULL,
          stage TEXT NOT NULL CHECK (stage IN ('HOOK', 'SPOOL', 'LEDGER', 'CATALOG', 'CURSOR')),
          observed_at TEXT NOT NULL,
          evidence_ref TEXT NOT NULL UNIQUE,
          PRIMARY KEY (session_id, stage)
        );
        CREATE INDEX IF NOT EXISTS real_codex_acceptance_observed_idx
          ON real_codex_acceptance_evidence(observed_at DESC, session_id ASC);
        CREATE TABLE IF NOT EXISTS real_codex_acceptance_runs (
          session_id TEXT NOT NULL,
          task_created_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'NOT_VERIFIED')),
          verified_at TEXT NOT NULL,
          evidence_ref TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY (session_id, task_created_at)
        );
        CREATE INDEX IF NOT EXISTS real_codex_acceptance_verified_idx
          ON real_codex_acceptance_runs(status, verified_at DESC, session_id ASC);
      `);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("acceptance evidence store is closed");
  }

  #prune(): void {
    this.#database.prepare(`
      DELETE FROM real_codex_acceptance_evidence
      WHERE session_id NOT IN (
        SELECT session_id FROM real_codex_acceptance_evidence
        GROUP BY session_id ORDER BY MAX(observed_at) DESC, session_id ASC LIMIT ?
      )
    `).run(this.#maxSessions);
    this.#database.prepare(`
      DELETE FROM real_codex_acceptance_runs
      WHERE rowid NOT IN (
        SELECT rowid FROM real_codex_acceptance_runs
        ORDER BY verified_at DESC, session_id ASC LIMIT ?
      )
    `).run(this.#maxSessions);
  }

  record(stage: RealCodexAcceptanceStage, sessionId: string, identity: string, observedAt = now(this.#clock)): RealCodexAcceptanceEvidence {
    const persisted = this.recordMany([{ stage, sessionId, identity, observedAt }])[0];
    if (persisted === undefined) throw new Error("acceptance evidence batch unexpectedly returned no result");
    return persisted;
  }

  recordMany(writes: readonly RealCodexAcceptanceEvidenceWrite[]): readonly RealCodexAcceptanceEvidence[] {
    this.#assertOpen();
    if (writes.length > 10_000) throw new Error("acceptance evidence batch exceeds 10000 records");
    const prepared = writes.map((write) => {
      assertStage(write.stage);
      assertSessionId(write.sessionId);
      const observedAt = write.observedAt ?? now(this.#clock);
      if (!validTimestamp(observedAt)) throw new Error("acceptance evidence timestamp is invalid");
      return Object.freeze({
        stage: write.stage,
        sessionId: write.sessionId,
        observedAt,
        evidenceRef: opaqueRef(write.stage, write.sessionId, write.identity),
      });
    });
    if (prepared.length === 0) return Object.freeze([]);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.#database.prepare(`
        INSERT OR IGNORE INTO real_codex_acceptance_evidence(session_id, stage, observed_at, evidence_ref)
        VALUES (?, ?, ?, ?)
      `);
      for (const item of prepared) {
        insert.run(item.sessionId, item.stage, item.observedAt, item.evidenceRef);
      }
      this.#prune();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    const find = this.#database.prepare(`
      SELECT stage, session_id, observed_at, evidence_ref
      FROM real_codex_acceptance_evidence WHERE session_id = ? AND stage = ?
    `);
    return Object.freeze(prepared.map((item) => {
      const persisted = find.get(item.sessionId, item.stage) as EvidenceRow | undefined;
      if (persisted === undefined) throw new Error("acceptance evidence was pruned before it could be read");
      assertStage(persisted.stage);
      return Object.freeze({
        stage: persisted.stage,
        sessionId: persisted.session_id,
        observedAt: persisted.observed_at,
        evidenceRef: persisted.evidence_ref,
      });
    }));
  }

  async collect(sessionId: string): Promise<readonly RealCodexAcceptanceEvidence[]> {
    this.#assertOpen();
    assertSessionId(sessionId);
    const rows = this.#database.prepare(`
      SELECT stage, session_id, observed_at, evidence_ref
      FROM real_codex_acceptance_evidence
      WHERE session_id = ?
      ORDER BY CASE stage
        WHEN 'HOOK' THEN 1 WHEN 'SPOOL' THEN 2 WHEN 'LEDGER' THEN 3 WHEN 'CATALOG' THEN 4 WHEN 'CURSOR' THEN 5
      END ASC
    `).all(sessionId) as unknown as EvidenceRow[];
    return Object.freeze(rows.map((row) => {
      assertStage(row.stage);
      return Object.freeze({
        stage: row.stage,
        sessionId: row.session_id,
        observedAt: row.observed_at,
        evidenceRef: row.evidence_ref,
      });
    }));
  }

  saveResult(request: RealCodexAcceptanceRequest, result: RealCodexAcceptanceResult): PersistedRealCodexAcceptance {
    this.#assertOpen();
    assertSessionId(request.sessionId);
    if (!validTimestamp(request.taskCreatedAt) || result.sessionId !== request.sessionId) {
      throw new Error("acceptance result does not match its request");
    }
    const verifiedAt = now(this.#clock);
    const evidenceRef = opaqueRef("ACCEPTANCE", request.sessionId, `${request.taskCreatedAt}\0${result.status}`);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO real_codex_acceptance_runs(
          session_id, task_created_at, status, verified_at, evidence_ref, result_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, task_created_at) DO UPDATE SET
          status = excluded.status,
          verified_at = excluded.verified_at,
          evidence_ref = excluded.evidence_ref,
          result_json = excluded.result_json
      `).run(request.sessionId, request.taskCreatedAt, result.status, verifiedAt, evidenceRef, JSON.stringify(result));
      this.#prune();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return Object.freeze({ request: Object.freeze({ ...request }), result, verifiedAt, evidenceRef });
  }

  latestVerified(): PersistedRealCodexAcceptance | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT session_id, task_created_at, verified_at, evidence_ref, result_json
      FROM real_codex_acceptance_runs
      WHERE status = 'VERIFIED'
      ORDER BY verified_at DESC, session_id ASC LIMIT 1
    `).get() as RunRow | undefined;
    if (row === undefined) return undefined;
    const result = parseResult(row.result_json);
    if (
      result.sessionId !== row.session_id
      || !SAFE_SESSION_ID.test(row.session_id)
      || !validTimestamp(row.task_created_at)
      || !validTimestamp(row.verified_at)
      || !/^acceptance:[a-f0-9]{64}$/u.test(row.evidence_ref)
    ) {
      throw new Error("persisted acceptance run has invalid identity or timestamp metadata");
    }
    return Object.freeze({
      request: Object.freeze({ sessionId: row.session_id, taskCreatedAt: row.task_created_at }),
      result,
      verifiedAt: row.verified_at,
      evidenceRef: row.evidence_ref,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}

export interface RealCodexAcceptanceCoordinatorOptions {
  readonly evidence: SqliteRealCodexAcceptanceEvidenceStore;
  readonly catalog: Pick<SessionCatalogQueryPort, "get">;
  readonly cursor: RealCodexAcceptanceCursorPort;
  readonly clock?: () => Date;
}

/** Observes only exact, fresh catalog/cursor facts and then runs the fail-closed gate. */
export class RealCodexAcceptanceCoordinator {
  readonly #evidence: SqliteRealCodexAcceptanceEvidenceStore;
  readonly #catalog: Pick<SessionCatalogQueryPort, "get">;
  readonly #cursor: RealCodexAcceptanceCursorPort;
  readonly #clock: () => Date;
  readonly #verifier: RealCodexIngestionAcceptanceVerifier;

  constructor(options: RealCodexAcceptanceCoordinatorOptions) {
    this.#evidence = options.evidence;
    this.#catalog = options.catalog;
    this.#cursor = options.cursor;
    this.#clock = options.clock ?? (() => new Date());
    this.#verifier = new RealCodexIngestionAcceptanceVerifier(options.evidence);
  }

  async verify(request: RealCodexAcceptanceRequest): Promise<PersistedRealCodexAcceptance> {
    assertSessionId(request.sessionId);
    if (!validTimestamp(request.taskCreatedAt)) throw new Error("real Codex acceptance request is invalid");
    const taskCreatedAt = Date.parse(request.taskCreatedAt);
    const catalog = await this.#catalog.get(request.sessionId);
    if (
      catalog !== undefined
      && catalog.sessionId === request.sessionId
      && catalog.sourceStatus === "AVAILABLE"
      && Date.parse(catalog.lastActivityAt) >= taskCreatedAt
    ) {
      this.#evidence.record(
        "CATALOG",
        request.sessionId,
        JSON.stringify([catalog.source, catalog.sourceFormatVersion, catalog.safeSourceAlias, catalog.lastActivityAt]),
        now(this.#clock),
      );
    }
    const cursor = await this.#cursor.load(request.sessionId);
    if (cursor !== undefined && validTimestamp(cursor.updatedAt) && Date.parse(cursor.updatedAt) >= taskCreatedAt) {
      this.#evidence.record("CURSOR", request.sessionId, `${cursor.updatedAt}\0${cursor.identity}`, now(this.#clock));
    }
    const result = await this.#verifier.verify(request);
    return this.#evidence.saveResult(request, result);
  }
}
