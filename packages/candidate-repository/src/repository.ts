import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeCandidate } from "@zhiloop/domain";
import {
  knowledgeExtractionInputHash,
  knowledgeExtractionKey,
  type KnowledgeExtractionDiagnostic,
  type KnowledgeExtractionFailureReason,
  type KnowledgeExtractionRequest,
  type KnowledgeExtractionResult,
} from "@zhiloop/knowledge-compiler";
import { parseKnowledgeCandidate } from "@zhiloop/schemas";

import type {
  CandidateClaimOptions,
  CandidateCompilationBatch,
  CandidateCompilationClaim,
  CandidateCompilationIdentity,
  CandidateListOptions,
  CandidateRepositoryOptions,
} from "./types.js";

const CURRENT_MIGRATION_VERSION = 1;
const DEFAULT_LEASE_MS = 300_000;
const MAX_LEASE_MS = 3_600_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;
const MAX_CANDIDATES_PER_BATCH = 10_000;
const MAX_CANDIDATE_BATCH_JSON_CHARS = 16_000_000;
const MAX_RESULT_ATTEMPTS = 10;
const MAX_DIAGNOSTICS = 100;
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,100}$/;
const DIAGNOSTIC_CODES = new Set<KnowledgeExtractionDiagnostic["code"]>([
  "SCHEMA_INVALID",
  "UNREFERENCED_SOURCE",
  "PROJECT_MISMATCH",
  "GENERATED_CANDIDATE_INVALID",
]);
const FAILURE_REASONS = new Set<KnowledgeExtractionFailureReason>([
  "TIMEOUT",
  "ADAPTER_UNAVAILABLE",
  "INVALID_OUTPUT",
  "RETRY_SCHEDULER_FAILED",
  "ADAPTER_REJECTED",
  "ABORTED",
]);

interface BatchRow {
  readonly extraction_key: string;
  readonly input_hash: string;
  readonly episode_id: string;
  readonly builder_version: string;
  readonly compiler_version: string;
  readonly prompt_version: string;
  readonly status: "RUNNING" | "RETRYABLE" | "SUCCEEDED" | "FAILED";
  readonly claim_token: string | null;
  readonly lease_expires_at: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly run_count: number;
  readonly last_attempts: number;
  readonly failure_reason: string | null;
  readonly diagnostics_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface CandidateRow {
  readonly candidate_id: string;
  readonly extraction_key: string;
  readonly ordinal: number;
  readonly status: string;
  readonly subject_key: string;
  readonly kind: string;
  readonly compiler_version: string;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly created_at: string;
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

function assertNonEmpty(value: string, field: string, maxLength = 500): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${field} must contain 1 to ${maxLength} characters`);
  }
}

function assertVersion(value: string, field: string): void {
  if (!SAFE_VERSION.test(value)) throw new Error(`${field} is invalid`);
}

function now(clock: () => Date): { readonly iso: string; readonly ms: number } {
  const value = clock();
  const ms = value.getTime();
  if (!Number.isFinite(ms)) throw new Error("repository clock returned an invalid Date");
  return { iso: value.toISOString(), ms };
}

function assertLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_MS) {
    throw new Error(`leaseMs must be between 1 and ${MAX_LEASE_MS}`);
  }
}

function assertResultShape(result: KnowledgeExtractionResult): void {
  if (result.status !== "SUCCEEDED" && result.status !== "RETRYABLE" && result.status !== "FAILED") {
    throw new Error(`unsupported extraction result status: ${String(result.status)}`);
  }
  if (!Number.isSafeInteger(result.attempts) || result.attempts < 0 || result.attempts > MAX_RESULT_ATTEMPTS) {
    throw new Error(`result attempts must be between 0 and ${MAX_RESULT_ATTEMPTS}`);
  }
  if (result.status !== "SUCCEEDED" && result.candidates.length !== 0) {
    throw new Error("failed extraction result cannot contain candidates");
  }
  if (result.status === "SUCCEEDED" && result.diagnostics.length !== 0) {
    throw new Error("successful extraction result cannot contain diagnostics");
  }
  if (result.status !== "SUCCEEDED" && !FAILURE_REASONS.has(result.reason)) {
    throw new Error(`unsupported extraction failure reason: ${String(result.reason)}`);
  }
  if (result.diagnostics.length > MAX_DIAGNOSTICS || result.diagnostics.some((diagnostic) =>
    !DIAGNOSTIC_CODES.has(diagnostic.code) || typeof diagnostic.path !== "string")) {
    throw new Error("extraction result diagnostics are invalid");
  }
}

function identity(request: KnowledgeExtractionRequest): CandidateCompilationIdentity {
  assertNonEmpty(request.input.episodeId, "episodeId");
  assertVersion(request.input.builderVersion, "builderVersion");
  assertVersion(request.compilerVersion, "compilerVersion");
  assertVersion(request.promptVersion, "promptVersion");
  const inputHash = knowledgeExtractionInputHash(request);
  return Object.freeze({
    extractionKey: knowledgeExtractionKey(request),
    inputHash,
    episodeId: request.input.episodeId,
    builderVersion: request.input.builderVersion,
    compilerVersion: request.compilerVersion,
    promptVersion: request.promptVersion,
  });
}

function parseDiagnostics(value: string): readonly KnowledgeExtractionDiagnostic[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) =>
    typeof item !== "object" || item === null || Array.isArray(item)
    || !DIAGNOSTIC_CODES.has((item as Record<string, unknown>)["code"] as KnowledgeExtractionDiagnostic["code"])
    || typeof (item as Record<string, unknown>)["path"] !== "string")) {
    throw new Error("candidate compilation diagnostics are corrupt");
  }
  return deepFreeze(parsed as KnowledgeExtractionDiagnostic[]);
}

function parseCandidateRow(row: CandidateRow): KnowledgeCandidate {
  if (sha256(row.payload_json) !== row.payload_hash) {
    throw new Error(`candidate ${row.candidate_id} failed payload integrity verification`);
  }
  const parsedJson = JSON.parse(row.payload_json) as unknown;
  const parsed = parseKnowledgeCandidate(parsedJson);
  if (!parsed.ok || parsed.value.candidateId !== row.candidate_id) {
    throw new Error(`candidate ${row.candidate_id} is corrupt or unsupported`);
  }
  if (
    parsed.value.status !== row.status
    || parsed.value.subjectKey !== row.subject_key
    || parsed.value.kind !== row.kind
    || parsed.value.compilerVersion !== row.compiler_version
    || parsed.value.createdAt !== row.created_at
  ) {
    throw new Error(`candidate ${row.candidate_id} index columns failed integrity verification`);
  }
  return deepFreeze(structuredClone(parsed.value));
}

function assertIdentityMatches(row: BatchRow, expected: CandidateCompilationIdentity): void {
  if (
    row.extraction_key !== expected.extractionKey
    || row.input_hash !== expected.inputHash
    || row.episode_id !== expected.episodeId
    || row.builder_version !== expected.builderVersion
    || row.compiler_version !== expected.compilerVersion
    || row.prompt_version !== expected.promptVersion
  ) {
    throw new Error(`candidate compilation identity conflict for ${expected.extractionKey}`);
  }
}

export class SqliteCandidateRepository {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #tokenFactory: () => string;
  readonly #defaultLeaseMs: number;
  #closed = false;

  constructor(filename: string, options: CandidateRepositoryOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? randomUUID;
    this.#defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    assertLeaseMs(this.#defaultLeaseMs);
    this.#database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("candidate repository is closed");
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS candidate_repository_meta (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0)
      );
    `);
    const existing = this.#database.prepare(
      "SELECT version FROM candidate_repository_meta WHERE component = 'candidate-repository'",
    ).get() as { version: number } | undefined;
    if (existing !== undefined && existing.version > CURRENT_MIGRATION_VERSION) {
      throw new Error(
        `candidate repository migration ${existing.version} is newer than supported version ${CURRENT_MIGRATION_VERSION}`,
      );
    }
    if (existing?.version === CURRENT_MIGRATION_VERSION) return;
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS candidate_compilations (
          extraction_key TEXT PRIMARY KEY,
          input_hash TEXT NOT NULL,
          episode_id TEXT NOT NULL,
          builder_version TEXT NOT NULL,
          compiler_version TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('RUNNING', 'RETRYABLE', 'SUCCEEDED', 'FAILED')),
          claim_token TEXT,
          lease_expires_at TEXT,
          lease_expires_at_ms INTEGER,
          run_count INTEGER NOT NULL CHECK (run_count >= 1),
          last_attempts INTEGER NOT NULL DEFAULT 0 CHECK (last_attempts >= 0),
          failure_reason TEXT,
          diagnostics_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE (episode_id, builder_version, input_hash, compiler_version, prompt_version),
          CHECK ((status = 'RUNNING') = (claim_token IS NOT NULL)),
          CHECK ((status = 'RUNNING') = (lease_expires_at IS NOT NULL)),
          CHECK ((status = 'RUNNING') = (lease_expires_at_ms IS NOT NULL)),
          CHECK ((status IN ('RETRYABLE', 'FAILED')) = (failure_reason IS NOT NULL)),
          CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (completed_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS candidate_compilations_episode_idx
          ON candidate_compilations(episode_id, compiler_version, status);
        CREATE TABLE IF NOT EXISTS knowledge_candidates (
          candidate_id TEXT PRIMARY KEY,
          extraction_key TEXT NOT NULL REFERENCES candidate_compilations(extraction_key) ON DELETE RESTRICT,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          status TEXT NOT NULL CHECK (status = 'PROPOSED'),
          subject_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          compiler_version TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (extraction_key, ordinal)
        );
        CREATE INDEX IF NOT EXISTS knowledge_candidates_visibility_idx
          ON knowledge_candidates(status, compiler_version, candidate_id);
        INSERT INTO candidate_repository_meta(component, version)
          VALUES ('candidate-repository', 1)
          ON CONFLICT(component) DO UPDATE SET version = excluded.version;
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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

  #batchRow(extractionKey: string): BatchRow | undefined {
    return this.#database.prepare(`
      SELECT extraction_key, input_hash, episode_id, builder_version, compiler_version, prompt_version,
             status, claim_token, lease_expires_at, lease_expires_at_ms, run_count, last_attempts,
             failure_reason, diagnostics_json, created_at, updated_at, completed_at
      FROM candidate_compilations WHERE extraction_key = ?
    `).get(extractionKey) as BatchRow | undefined;
  }

  #toBatch(row: BatchRow): CandidateCompilationBatch {
    const candidateRows = this.#database.prepare(`
      SELECT candidate_id, extraction_key, ordinal, status, subject_key, kind, compiler_version,
             payload_json, payload_hash, created_at
      FROM knowledge_candidates WHERE extraction_key = ? ORDER BY ordinal ASC
    `).all(row.extraction_key) as unknown as CandidateRow[];
    const failureReason = row.failure_reason;
    if (failureReason !== null && !FAILURE_REASONS.has(failureReason as KnowledgeExtractionFailureReason)) {
      throw new Error(`candidate compilation ${row.extraction_key} has an invalid failure reason`);
    }
    if (row.status !== "SUCCEEDED" && candidateRows.length > 0) {
      throw new Error(`candidate compilation ${row.extraction_key} contains candidates before success`);
    }
    return deepFreeze({
      extractionKey: row.extraction_key,
      inputHash: row.input_hash,
      episodeId: row.episode_id,
      builderVersion: row.builder_version,
      compilerVersion: row.compiler_version,
      promptVersion: row.prompt_version,
      status: row.status,
      runCount: row.run_count,
      lastAttempts: row.last_attempts,
      ...(failureReason === null ? {} : { failureReason: failureReason as KnowledgeExtractionFailureReason }),
      diagnostics: parseDiagnostics(row.diagnostics_json),
      candidates: candidateRows.map(parseCandidateRow),
      ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    });
  }

  claim(request: KnowledgeExtractionRequest, options: CandidateClaimOptions = {}): CandidateCompilationClaim {
    this.#assertOpen();
    const expected = identity(request);
    const leaseMs = options.leaseMs ?? this.#defaultLeaseMs;
    assertLeaseMs(leaseMs);
    const timestamp = now(this.#clock);
    const expiresAtMs = timestamp.ms + leaseMs;
    const expiresAt = new Date(expiresAtMs).toISOString();

    return this.#transaction(() => {
      let row = this.#batchRow(expected.extractionKey);
      if (row !== undefined) {
        assertIdentityMatches(row, expected);
        if (row.status === "SUCCEEDED") {
          return deepFreeze({ status: "ALREADY_SUCCEEDED" as const, batch: this.#toBatch(row) });
        }
        if (row.status === "FAILED") {
          return deepFreeze({ status: "TERMINAL_FAILED" as const, batch: this.#toBatch(row) });
        }
        if (row.status === "RUNNING" && (row.lease_expires_at_ms ?? 0) > timestamp.ms) {
          return deepFreeze({ status: "IN_PROGRESS" as const, batch: this.#toBatch(row) });
        }
      }
      const runCount = (row?.run_count ?? 0) + 1;
      const entropy = this.#tokenFactory();
      assertNonEmpty(entropy, "claimToken entropy", 500);
      const claimToken = sha256(`candidate-claim-v1\0${expected.extractionKey}\0${runCount}\0${entropy}`);
      if (row === undefined) {
        this.#database.prepare(`
          INSERT INTO candidate_compilations (
            extraction_key, input_hash, episode_id, builder_version, compiler_version, prompt_version,
            status, claim_token, lease_expires_at, lease_expires_at_ms, run_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, 1, ?, ?)
        `).run(
          expected.extractionKey,
          expected.inputHash,
          expected.episodeId,
          expected.builderVersion,
          expected.compilerVersion,
          expected.promptVersion,
          claimToken,
          expiresAt,
          expiresAtMs,
          timestamp.iso,
          timestamp.iso,
        );
      } else {
        this.#database.prepare(`
          UPDATE candidate_compilations
          SET status = 'RUNNING', claim_token = ?, lease_expires_at = ?, lease_expires_at_ms = ?,
              run_count = ?, failure_reason = NULL, diagnostics_json = '[]',
              completed_at = NULL, updated_at = ?
          WHERE extraction_key = ?
        `).run(claimToken, expiresAt, expiresAtMs, runCount, timestamp.iso, expected.extractionKey);
      }
      row = this.#batchRow(expected.extractionKey);
      if (row === undefined) throw new Error("claimed compilation could not be resolved");
      return deepFreeze({ status: "ACQUIRED" as const, claimToken, batch: this.#toBatch(row) });
    });
  }

  renewClaim(
    extractionKey: string,
    claimToken: string,
    options: CandidateClaimOptions = {},
  ): CandidateCompilationBatch {
    this.#assertOpen();
    assertNonEmpty(extractionKey, "extractionKey");
    assertNonEmpty(claimToken, "claimToken", 500);
    const leaseMs = options.leaseMs ?? this.#defaultLeaseMs;
    assertLeaseMs(leaseMs);
    const timestamp = now(this.#clock);
    const expiresAtMs = timestamp.ms + leaseMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    return this.#transaction(() => {
      const row = this.#batchRow(extractionKey);
      if (row === undefined) throw new Error(`candidate compilation ${extractionKey} was not claimed`);
      if (row.status !== "RUNNING" || row.claim_token !== claimToken) {
        throw new Error(`stale or invalid claim token for ${extractionKey}`);
      }
      this.#database.prepare(`
        UPDATE candidate_compilations
        SET lease_expires_at = ?, lease_expires_at_ms = ?, updated_at = ?
        WHERE extraction_key = ?
      `).run(expiresAt, expiresAtMs, timestamp.iso, extractionKey);
      const updated = this.#batchRow(extractionKey);
      if (updated === undefined) throw new Error("renewed compilation could not be resolved");
      return this.#toBatch(updated);
    });
  }

  saveResult(claimToken: string, result: KnowledgeExtractionResult): CandidateCompilationBatch {
    this.#assertOpen();
    assertNonEmpty(claimToken, "claimToken", 500);
    const timestamp = now(this.#clock);
    assertResultShape(result);
    if (result.candidates.length > MAX_CANDIDATES_PER_BATCH) {
      throw new Error(`candidate batch must contain at most ${MAX_CANDIDATES_PER_BATCH} candidates`);
    }
    const seenCandidateIds = new Set<string>();
    let totalJsonChars = 0;
    const preparedCandidates = result.candidates.map((candidate, ordinal) => {
      const parsed = parseKnowledgeCandidate(candidate);
      if (!parsed.ok) throw new Error(`candidate ${ordinal} does not match the Candidate schema`);
      if (seenCandidateIds.has(parsed.value.candidateId)) throw new Error(`duplicate candidateId: ${parsed.value.candidateId}`);
      seenCandidateIds.add(parsed.value.candidateId);
      if (parsed.value.compilerVersion !== result.compilerVersion || !parsed.value.sourceEpisodes.includes(result.episodeId)) {
        throw new Error(`candidate ${parsed.value.candidateId} does not match its compilation identity`);
      }
      const payloadJson = JSON.stringify(parsed.value);
      totalJsonChars += payloadJson.length;
      if (totalJsonChars > MAX_CANDIDATE_BATCH_JSON_CHARS) {
        throw new Error(`candidate batch JSON must not exceed ${MAX_CANDIDATE_BATCH_JSON_CHARS} characters`);
      }
      return { candidate: parsed.value, ordinal, payloadJson, payloadHash: sha256(payloadJson) };
    });
    const diagnosticsJson = JSON.stringify(result.diagnostics);

    return this.#transaction(() => {
      const row = this.#batchRow(result.extractionKey);
      if (row === undefined) throw new Error(`candidate compilation ${result.extractionKey} was not claimed`);
      if (row.status !== "RUNNING" || row.claim_token !== claimToken) {
        throw new Error(`stale or invalid claim token for ${result.extractionKey}`);
      }
      if (
        row.input_hash !== result.inputHash
        || row.episode_id !== result.episodeId
        || row.builder_version !== result.builderVersion
        || row.compiler_version !== result.compilerVersion
        || row.prompt_version !== result.promptVersion
      ) {
        throw new Error(`result identity does not match candidate compilation ${result.extractionKey}`);
      }
      const insert = this.#database.prepare(`
        INSERT INTO knowledge_candidates (
          candidate_id, extraction_key, ordinal, status, subject_key, kind, compiler_version,
          payload_json, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of preparedCandidates) {
        insert.run(
          item.candidate.candidateId,
          result.extractionKey,
          item.ordinal,
          item.candidate.status,
          item.candidate.subjectKey,
          item.candidate.kind,
          item.candidate.compilerVersion,
          item.payloadJson,
          item.payloadHash,
          item.candidate.createdAt,
        );
      }
      const failureReason = result.status === "SUCCEEDED" ? null : result.reason;
      this.#database.prepare(`
        UPDATE candidate_compilations
        SET status = ?, claim_token = NULL, lease_expires_at = NULL, lease_expires_at_ms = NULL,
            last_attempts = ?, failure_reason = ?, diagnostics_json = ?, updated_at = ?, completed_at = ?
        WHERE extraction_key = ?
      `).run(
        result.status,
        result.attempts,
        failureReason,
        diagnosticsJson,
        timestamp.iso,
        result.status === "RETRYABLE" ? null : timestamp.iso,
        result.extractionKey,
      );
      const updated = this.#batchRow(result.extractionKey);
      if (updated === undefined) throw new Error("saved compilation could not be resolved");
      return this.#toBatch(updated);
    });
  }

  getBatch(extractionKey: string): CandidateCompilationBatch | undefined {
    this.#assertOpen();
    assertNonEmpty(extractionKey, "extractionKey");
    const row = this.#batchRow(extractionKey);
    return row === undefined ? undefined : this.#toBatch(row);
  }

  listCandidates(options: CandidateListOptions = {}): readonly KnowledgeCandidate[] {
    this.#assertOpen();
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
    }
    if (options.episodeId !== undefined) assertNonEmpty(options.episodeId, "episodeId");
    if (options.compilerVersion !== undefined) assertVersion(options.compilerVersion, "compilerVersion");
    const conditions = ["b.status = 'SUCCEEDED'"];
    const parameters: Array<string | number> = [];
    if (options.includeProposed !== true) conditions.push("c.status <> 'PROPOSED'");
    if (options.episodeId !== undefined) {
      conditions.push("b.episode_id = ?");
      parameters.push(options.episodeId);
    }
    if (options.compilerVersion !== undefined) {
      conditions.push("c.compiler_version = ?");
      parameters.push(options.compilerVersion);
    }
    parameters.push(limit);
    const rows = this.#database.prepare(`
      SELECT c.candidate_id, c.extraction_key, c.ordinal, c.status, c.subject_key, c.kind,
             c.compiler_version, c.payload_json, c.payload_hash, c.created_at
      FROM knowledge_candidates c
      JOIN candidate_compilations b ON b.extraction_key = c.extraction_key
      WHERE ${conditions.join(" AND ")}
      ORDER BY c.created_at ASC, c.candidate_id ASC LIMIT ?
    `).all(...parameters) as unknown as CandidateRow[];
    return deepFreeze(rows.map(parseCandidateRow));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
