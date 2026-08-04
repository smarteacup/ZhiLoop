import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  CONTROL_API_SCHEMA_VERSION,
  idempotencyKeySchema,
  jobAttemptSnapshotSchema,
  jobSnapshotSchema,
  type JobAttemptSnapshot,
  type JobSnapshot,
} from "@zhiloop/control-api";

import { parseStoredJobJson, serializeJobJson } from "./serialization.js";
import {
  JobIdempotencyConflictError,
  JobLeaseLostError,
  type CancellationRequestResult,
  type ClaimJobResult,
  type DurableJobRecord,
  type DurableJobStoreOptions,
  type EnqueueJobRequest,
  type EnqueueJobResult,
  type JobAttemptList,
  type JobCheckpointRecord,
  type JobClaim,
  type JobFailureInput,
  type JobHeartbeat,
  type JobList,
  type JobLeaseReference,
  type JobOperatorCommandRequest,
  type JobOperatorCommandResult,
  type JobRetryPolicy,
  type ListJobsRequest,
  JobStaleRevisionError,
  JobStateConflictError,
  JobNotFoundError,
} from "./types.js";

const CURRENT_MIGRATION_VERSION = 2;
const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 3_600_000;
const DEFAULT_RETRY_POLICY: JobRetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 300_000, jitterRatio: 0.2 };
const JOB_TYPE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SAFE_IDENTIFIER = /^[^\0\r\n]+$/u;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const JOB_STATUSES = new Set<JobRow["status"]>(["QUEUED", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "CANCELLED"]);

interface JobRow {
  readonly job_id: string;
  readonly job_type: string;
  readonly revision: number;
  readonly idempotency_key: string;
  readonly idempotency_fingerprint: string;
  readonly input_json: string;
  readonly input_hash: string;
  readonly status: "QUEUED" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly fencing_token: number;
  readonly progress: number;
  readonly reason_code: JobSnapshot["reasonCode"];
  readonly next_attempt_at: string | null;
  readonly next_attempt_at_ms: number | null;
  readonly current_attempt_id: string | null;
  readonly current_worker_id: string | null;
  readonly lease_acquired_at: string | null;
  readonly lease_heartbeat_at: string | null;
  readonly lease_expires_at: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly cancellation_status: "NOT_REQUESTED" | "REQUESTED" | "ACKNOWLEDGED" | "REJECTED";
  readonly cancellation_requested_at: string | null;
  readonly cancellation_resolved_at: string | null;
  readonly last_failure_code: string | null;
  readonly last_failure_retryable: number | null;
  readonly last_failure_at: string | null;
  readonly created_at: string;
  readonly created_at_ms: number;
  readonly updated_at: string;
  readonly last_transition_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface JobCommandRow {
  readonly idempotency_key: string;
  readonly fingerprint: string;
  readonly job_id: string;
  readonly action: "CANCEL" | "RETRY";
  readonly disposition: "APPLIED" | "NOOP";
}

interface CheckpointRow {
  readonly job_id: string;
  readonly revision: number;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly progress: number;
  readonly updated_at: string;
}

interface AttemptRow {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly attempt_number: number;
  readonly status: JobAttemptSnapshot["status"];
  readonly worker_id: string;
  readonly fencing_token: number;
  readonly lease_status: "ACTIVE" | "EXPIRED" | "RELEASED";
  readonly started_at: string;
  readonly heartbeat_at: string;
  readonly lease_expires_at: string;
  readonly finished_at: string | null;
  readonly checkpoint_revision: number;
  readonly failure_code: string | null;
  readonly failure_retryable: number | null;
  readonly failure_at: string | null;
}

function timestamp(clock: () => Date): { readonly iso: string; readonly ms: number } {
  const value = clock();
  const ms = value.getTime();
  if (!Number.isFinite(ms)) throw new Error("job clock returned an invalid Date");
  return { iso: value.toISOString(), ms };
}

function validateIdentifier(value: string, field: string, maximum = 200): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${field} is invalid`);
  }
}

function validateLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 10 || value > MAX_LEASE_MS) {
    throw new Error(`leaseMs must be between 10 and ${MAX_LEASE_MS}`);
  }
}

function retryPolicy(input: Partial<JobRetryPolicy> | undefined): JobRetryPolicy {
  const value = { ...DEFAULT_RETRY_POLICY, ...input };
  if (!Number.isSafeInteger(value.baseDelayMs) || value.baseDelayMs < 10 || value.baseDelayMs > 3_600_000) {
    throw new Error("baseDelayMs must be between 10 and 3600000");
  }
  if (!Number.isSafeInteger(value.maxDelayMs) || value.maxDelayMs < value.baseDelayMs || value.maxDelayMs > 86_400_000) {
    throw new Error("maxDelayMs must be bounded and not less than baseDelayMs");
  }
  if (!Number.isFinite(value.jitterRatio) || value.jitterRatio < 0 || value.jitterRatio > 1) {
    throw new Error("jitterRatio must be between 0 and 1");
  }
  return Object.freeze(value);
}

function retryDelay(policy: JobRetryPolicy, attempt: number, random: () => number): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error("job random source must return a number between 0 and 1");
  const exponent = Math.min(52, Math.max(0, attempt - 1));
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
  const factor = 1 - policy.jitterRatio + 2 * policy.jitterRatio * sample;
  return Math.max(1, Math.min(policy.maxDelayMs, Math.round(base * factor)));
}

function terminal(status: JobRow["status"]): boolean {
  return TERMINAL.has(status);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export class SqliteDurableJobStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #random: () => number;
  readonly #defaultLeaseMs: number;
  readonly #retryPolicy: JobRetryPolicy;
  #closed = false;

  public constructor(filename: string, options: DurableJobStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `job_${randomUUID()}`);
    this.#random = options.random ?? Math.random;
    this.#defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    validateLeaseMs(this.#defaultLeaseMs);
    this.#retryPolicy = retryPolicy(options.retryPolicy);
    this.#database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("job store is closed");
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS durable_job_meta (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version >= 0)
      );
    `);
    const existing = this.#database.prepare(
      "SELECT version FROM durable_job_meta WHERE component = 'job-runtime'",
    ).get() as { version: number } | undefined;
    if (existing !== undefined && existing.version > CURRENT_MIGRATION_VERSION) {
      throw new Error(`job runtime migration ${existing.version} is newer than supported version ${CURRENT_MIGRATION_VERSION}`);
    }
    if (existing !== undefined && existing.version < 1) {
      throw new Error(`job runtime migration ${existing.version} is not supported`);
    }
    if (existing?.version === CURRENT_MIGRATION_VERSION) return;
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      const lockedExisting = this.#database.prepare(
        "SELECT version FROM durable_job_meta WHERE component = 'job-runtime'",
      ).get() as { version: number } | undefined;
      if (lockedExisting?.version === CURRENT_MIGRATION_VERSION) {
        this.#database.exec("COMMIT");
        return;
      }
      if (lockedExisting !== undefined && lockedExisting.version !== 1) {
        throw new Error(`job runtime migration ${lockedExisting.version} is not supported`);
      }
      if (lockedExisting?.version === 1) {
        this.#database.exec(`
          ALTER TABLE durable_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0);
          CREATE TABLE durable_job_commands (
            idempotency_key TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            job_id TEXT NOT NULL REFERENCES durable_jobs(job_id) ON DELETE RESTRICT,
            action TEXT NOT NULL CHECK(action IN ('CANCEL','RETRY')),
            disposition TEXT NOT NULL CHECK(disposition IN ('APPLIED','NOOP')),
            expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
            job_revision_after INTEGER NOT NULL CHECK(job_revision_after >= 0),
            created_at TEXT NOT NULL
          );
          CREATE INDEX durable_job_commands_job_idx ON durable_job_commands(job_id, created_at);
          UPDATE durable_job_meta SET version=2 WHERE component='job-runtime';
        `);
        this.#database.exec("COMMIT");
        return;
      }
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS durable_jobs (
          job_id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
          idempotency_key TEXT NOT NULL UNIQUE,
          idempotency_fingerprint TEXT NOT NULL,
          input_json TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 1000),
          fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
          progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
          reason_code TEXT NOT NULL,
          next_attempt_at TEXT,
          next_attempt_at_ms INTEGER,
          current_attempt_id TEXT,
          current_worker_id TEXT,
          lease_acquired_at TEXT,
          lease_heartbeat_at TEXT,
          lease_expires_at TEXT,
          lease_expires_at_ms INTEGER,
          cancellation_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
            CHECK(cancellation_status IN ('NOT_REQUESTED','REQUESTED','ACKNOWLEDGED','REJECTED')),
          cancellation_requested_at TEXT,
          cancellation_resolved_at TEXT,
          last_failure_code TEXT,
          last_failure_retryable INTEGER CHECK(last_failure_retryable IN (0,1)),
          last_failure_at TEXT,
          created_at TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          last_transition_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          CHECK(attempt_count <= max_attempts),
          CHECK((status = 'RUNNING') = (current_attempt_id IS NOT NULL)),
          CHECK((status = 'RUNNING') = (current_worker_id IS NOT NULL)),
          CHECK((status = 'RUNNING') = (lease_expires_at_ms IS NOT NULL)),
          CHECK((status = 'RETRY_WAIT') = (next_attempt_at_ms IS NOT NULL)),
          CHECK((status IN ('SUCCEEDED','FAILED','CANCELLED')) = (completed_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS durable_jobs_claim_idx
          ON durable_jobs(status, next_attempt_at_ms, lease_expires_at_ms, created_at_ms, job_id);
        CREATE TABLE IF NOT EXISTS durable_job_attempts (
          attempt_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES durable_jobs(job_id) ON DELETE RESTRICT,
          attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 1000),
          status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','RETRYABLE_FAILED','TERMINAL_FAILED','CANCELLED','LEASE_LOST')),
          worker_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
          lease_status TEXT NOT NULL CHECK(lease_status IN ('ACTIVE','EXPIRED','RELEASED')),
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          lease_expires_at_ms INTEGER NOT NULL,
          finished_at TEXT,
          checkpoint_revision INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_revision >= 0),
          failure_code TEXT,
          failure_retryable INTEGER CHECK(failure_retryable IN (0,1)),
          failure_at TEXT,
          UNIQUE(job_id, attempt_number),
          UNIQUE(job_id, fencing_token),
          CHECK((status = 'RUNNING') = (finished_at IS NULL)),
          CHECK((status IN ('RETRYABLE_FAILED','TERMINAL_FAILED','LEASE_LOST')) = (failure_code IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS durable_job_attempts_job_idx
          ON durable_job_attempts(job_id, attempt_number DESC);
        CREATE TABLE IF NOT EXISTS durable_job_checkpoints (
          job_id TEXT PRIMARY KEY REFERENCES durable_jobs(job_id) ON DELETE RESTRICT,
          revision INTEGER NOT NULL CHECK(revision > 0),
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS durable_job_commands (
          idempotency_key TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          job_id TEXT NOT NULL REFERENCES durable_jobs(job_id) ON DELETE RESTRICT,
          action TEXT NOT NULL CHECK(action IN ('CANCEL','RETRY')),
          disposition TEXT NOT NULL CHECK(disposition IN ('APPLIED','NOOP')),
          expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
          job_revision_after INTEGER NOT NULL CHECK(job_revision_after >= 0),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS durable_job_commands_job_idx
          ON durable_job_commands(job_id, created_at);
        INSERT INTO durable_job_meta(component, version) VALUES ('job-runtime', 2)
          ON CONFLICT(component) DO UPDATE SET version=excluded.version;
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #jobRow(jobId: string): JobRow | undefined {
    return this.#database.prepare("SELECT * FROM durable_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  }

  #checkpointRow(jobId: string): CheckpointRow | undefined {
    return this.#database.prepare("SELECT * FROM durable_job_checkpoints WHERE job_id = ?").get(jobId) as CheckpointRow | undefined;
  }

  #checkpoint(row: CheckpointRow | undefined): JobCheckpointRecord | undefined {
    if (row === undefined) return undefined;
    return Object.freeze({
      revision: row.revision,
      payloadHash: row.payload_hash,
      progress: row.progress,
      updatedAt: row.updated_at,
      data: parseStoredJobJson(row.payload_json, row.payload_hash),
    });
  }

  #snapshot(row: JobRow, checkpoint = this.#checkpointRow(row.job_id)): JobSnapshot {
    const cancellation = row.cancellation_status === "NOT_REQUESTED"
      ? { status: "NOT_REQUESTED" as const }
      : {
          status: row.cancellation_status,
          requestedAt: row.cancellation_requested_at as string,
          ...(row.cancellation_resolved_at === null ? {} : { resolvedAt: row.cancellation_resolved_at }),
        };
    const value = {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      jobId: row.job_id,
      jobType: row.job_type,
      revision: row.revision,
      status: row.status,
      attempt: row.attempt_count,
      maxAttempts: row.max_attempts,
      progress: row.progress,
      reasonCode: row.reason_code,
      observedAt: row.updated_at,
      lastTransitionAt: row.last_transition_at,
      retryable: row.status === "QUEUED" || row.status === "RUNNING" || row.status === "RETRY_WAIT",
      evidenceRefs: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
      ...(row.status !== "RUNNING" ? {} : {
        lease: {
          attemptId: row.current_attempt_id as string,
          workerId: row.current_worker_id as string,
          fencingToken: row.fencing_token,
          status: "ACTIVE" as const,
          acquiredAt: row.lease_acquired_at as string,
          heartbeatAt: row.lease_heartbeat_at as string,
          expiresAt: row.lease_expires_at as string,
        },
      }),
      ...(checkpoint === undefined ? {} : {
        checkpoint: {
          revision: checkpoint.revision,
          payloadHash: checkpoint.payload_hash,
          progress: checkpoint.progress,
          updatedAt: checkpoint.updated_at,
        },
      }),
      cancellation,
      ...(row.last_failure_code === null ? {} : {
        lastFailure: {
          code: row.last_failure_code,
          retryable: row.last_failure_retryable === 1,
          occurredAt: row.last_failure_at as string,
        },
      }),
      idempotency: {
        key: row.idempotency_key,
        inputHash: row.input_hash,
        status: terminal(row.status) ? "COMPLETED" as const : "RESERVED" as const,
      },
    };
    return Object.freeze(jobSnapshotSchema.parse(value));
  }

  #record(row: JobRow): DurableJobRecord {
    const checkpointRow = this.#checkpointRow(row.job_id);
    const checkpoint = this.#checkpoint(checkpointRow);
    return Object.freeze({
      snapshot: this.#snapshot(row, checkpointRow),
      input: deepFreeze(parseStoredJobJson(row.input_json, row.input_hash)),
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
  }

  public enqueue(request: EnqueueJobRequest): EnqueueJobResult {
    this.#assertOpen();
    if (!JOB_TYPE.test(request.jobType)) throw new Error("jobType is invalid");
    if (!idempotencyKeySchema.safeParse(request.idempotencyKey).success) throw new Error("idempotencyKey is invalid");
    if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 1_000) {
      throw new Error("maxAttempts must be between 1 and 1000");
    }
    const input = serializeJobJson(request.input);
    const fingerprint = serializeJobJson({ jobType: request.jobType, inputHash: input.hash, maxAttempts: request.maxAttempts }).hash;
    const created = timestamp(this.#clock);
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM durable_jobs WHERE idempotency_key = ?",
      ).get(request.idempotencyKey) as JobRow | undefined;
      if (existing !== undefined) {
        if (existing.idempotency_fingerprint !== fingerprint) throw new JobIdempotencyConflictError();
        return Object.freeze({ status: "EXISTING" as const, job: this.#record(existing) });
      }
      const jobId = this.#idFactory();
      validateIdentifier(jobId, "jobId");
      this.#database.prepare(`
        INSERT INTO durable_jobs (
          job_id, job_type, idempotency_key, idempotency_fingerprint, input_json, input_hash,
          status, max_attempts, reason_code, created_at, created_at_ms, updated_at, last_transition_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, 'JOB_QUEUED', ?, ?, ?, ?)
      `).run(
        jobId, request.jobType, request.idempotencyKey, fingerprint, input.json, input.hash,
        request.maxAttempts, created.iso, created.ms, created.iso, created.iso,
      );
      const row = this.#jobRow(jobId);
      if (row === undefined) throw new Error("enqueued job could not be resolved");
      return Object.freeze({ status: "CREATED" as const, job: this.#record(row) });
    });
  }

  public get(jobId: string): DurableJobRecord | undefined {
    this.#assertOpen();
    validateIdentifier(jobId, "jobId");
    const row = this.#jobRow(jobId);
    return row === undefined ? undefined : this.#record(row);
  }

  public getByIdempotencyKey(idempotencyKey: string): DurableJobRecord | undefined {
    this.#assertOpen();
    if (!idempotencyKeySchema.safeParse(idempotencyKey).success) throw new Error("idempotencyKey is invalid");
    const row = this.#database.prepare(
      "SELECT * FROM durable_jobs WHERE idempotency_key = ?",
    ).get(idempotencyKey) as JobRow | undefined;
    return row === undefined ? undefined : this.#record(row);
  }

  public list(request: ListJobsRequest): JobList {
    this.#assertOpen();
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
      throw new Error("job list limit must be between 1 and 1000");
    }
    const statuses = request.statuses === undefined ? [] : [...new Set(request.statuses)];
    if (statuses.some((status) => !JOB_STATUSES.has(status))) throw new Error("job list status is invalid");
    let afterMs: number | undefined;
    if (request.after !== undefined) {
      validateIdentifier(request.after.jobId, "after.jobId");
      afterMs = Date.parse(request.after.createdAt);
      if (!Number.isFinite(afterMs) || new Date(afterMs).toISOString() !== request.after.createdAt) {
        throw new Error("after.createdAt is invalid");
      }
    }
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    }
    if (request.after !== undefined && afterMs !== undefined) {
      where.push("(created_at_ms > ? OR (created_at_ms = ? AND job_id > ?))");
      parameters.push(afterMs, afterMs, request.after.jobId);
    }
    const rows = this.#database.prepare(`
      SELECT * FROM durable_jobs ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY created_at_ms ASC, job_id ASC LIMIT ?
    `).all(...parameters, request.limit + 1) as unknown as JobRow[];
    const hasMore = rows.length > request.limit;
    const page = hasMore ? rows.slice(0, request.limit) : rows;
    const items = Object.freeze(page.map((row) => this.#snapshot(row)));
    const last = page.at(-1);
    return Object.freeze({
      items,
      ...(hasMore && last !== undefined ? { next: Object.freeze({ createdAt: last.created_at, jobId: last.job_id }) } : {}),
    });
  }

  #expireAttempt(row: JobRow, now: { readonly iso: string; readonly ms: number }): void {
    if (row.current_attempt_id === null) throw new Error("expired running job has no attempt");
    this.#database.prepare(`
      UPDATE durable_job_attempts
      SET status='LEASE_LOST', lease_status='EXPIRED', finished_at=?, failure_code='JOB_LEASE_EXPIRED',
          failure_retryable=1, failure_at=?
      WHERE attempt_id=? AND status='RUNNING'
    `).run(now.iso, now.iso, row.current_attempt_id);
  }

  #markExhausted(row: JobRow, now: { readonly iso: string; readonly ms: number }): void {
    this.#database.prepare(`
      UPDATE durable_jobs SET status='FAILED', revision=revision+1, reason_code='JOB_MAX_ATTEMPTS_EXHAUSTED',
        current_attempt_id=NULL, current_worker_id=NULL, lease_acquired_at=NULL, lease_heartbeat_at=NULL,
        lease_expires_at=NULL, lease_expires_at_ms=NULL, completed_at=?, updated_at=?, last_transition_at=?,
        last_failure_code='JOB_LEASE_EXPIRED', last_failure_retryable=1, last_failure_at=?
      WHERE job_id=?
    `).run(now.iso, now.iso, now.iso, now.iso, row.job_id);
  }

  #cancelExpired(row: JobRow, now: { readonly iso: string; readonly ms: number }): void {
    this.#database.prepare(`
      UPDATE durable_jobs SET status='CANCELLED', revision=revision+1, reason_code='JOB_CANCELLED',
        current_attempt_id=NULL, current_worker_id=NULL, lease_acquired_at=NULL, lease_heartbeat_at=NULL,
        lease_expires_at=NULL, lease_expires_at_ms=NULL, cancellation_status='ACKNOWLEDGED',
        cancellation_resolved_at=?, completed_at=?, updated_at=?, last_transition_at=? WHERE job_id=?
    `).run(now.iso, now.iso, now.iso, now.iso, row.job_id);
  }

  public claimNext(workerId: string, leaseMs = this.#defaultLeaseMs): ClaimJobResult {
    this.#assertOpen();
    validateIdentifier(workerId, "workerId");
    validateLeaseMs(leaseMs);
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      for (let recovery = 0; recovery < 100; recovery += 1) {
        const row = this.#database.prepare(`
          SELECT * FROM durable_jobs
          WHERE status='QUEUED'
             OR (status='RETRY_WAIT' AND next_attempt_at_ms <= ?)
             OR (status='RUNNING' AND lease_expires_at_ms <= ?)
          ORDER BY
            CASE status WHEN 'RUNNING' THEN 0 WHEN 'RETRY_WAIT' THEN 1 ELSE 2 END,
            COALESCE(lease_expires_at_ms, next_attempt_at_ms, created_at_ms) ASC,
            created_at_ms ASC, job_id ASC
          LIMIT 1
        `).get(now.ms, now.ms) as JobRow | undefined;
        if (row === undefined) return Object.freeze({ status: "EMPTY" as const });
        if (row.status === "RUNNING") {
          this.#expireAttempt(row, now);
          if (row.cancellation_status === "REQUESTED") {
            this.#cancelExpired(row, now);
            continue;
          }
          if (row.attempt_count >= row.max_attempts) {
            this.#markExhausted(row, now);
            continue;
          }
        }
        const attempt = row.attempt_count + 1;
        const fencingToken = row.fencing_token + 1;
        const attemptId = `${row.job_id}:attempt:${attempt}`;
        validateIdentifier(attemptId, "attemptId", 500);
        const expiresAtMs = now.ms + leaseMs;
        const expiresAt = new Date(expiresAtMs).toISOString();
        const checkpointRevision = this.#checkpointRow(row.job_id)?.revision ?? 0;
        this.#database.prepare(`
          INSERT INTO durable_job_attempts (
            attempt_id, job_id, attempt_number, status, worker_id, fencing_token, lease_status,
            started_at, heartbeat_at, lease_expires_at, lease_expires_at_ms, checkpoint_revision
          ) VALUES (?, ?, ?, 'RUNNING', ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
        `).run(
          attemptId, row.job_id, attempt, workerId, fencingToken, now.iso, now.iso,
          expiresAt, expiresAtMs, checkpointRevision,
        );
        this.#database.prepare(`
          UPDATE durable_jobs SET status='RUNNING', revision=revision+1, attempt_count=?, fencing_token=?, reason_code='JOB_RUNNING',
            next_attempt_at=NULL, next_attempt_at_ms=NULL, current_attempt_id=?, current_worker_id=?,
            lease_acquired_at=?, lease_heartbeat_at=?, lease_expires_at=?, lease_expires_at_ms=?,
            started_at=COALESCE(started_at, ?), completed_at=NULL, updated_at=?, last_transition_at=?
          WHERE job_id=?
        `).run(
          attempt, fencingToken, attemptId, workerId, now.iso, now.iso, expiresAt, expiresAtMs,
          now.iso, now.iso, now.iso, row.job_id,
        );
        const claimed = this.#jobRow(row.job_id);
        if (claimed === undefined) throw new Error("claimed job could not be resolved");
        const checkpoint = this.#checkpoint(this.#checkpointRow(row.job_id));
        const claim: JobClaim = Object.freeze({
          jobId: row.job_id,
          jobType: row.job_type,
          attemptId,
          workerId,
          fencingToken,
          idempotencyKey: row.idempotency_key,
          input: deepFreeze(parseStoredJobJson(row.input_json, row.input_hash)),
          ...(checkpoint === undefined ? {} : { checkpoint }),
          snapshot: this.#snapshot(claimed),
        });
        return Object.freeze({ status: "ACQUIRED" as const, claim });
      }
      return Object.freeze({ status: "EMPTY" as const });
    });
  }

  #activeLease(reference: JobLeaseReference, now: { readonly iso: string; readonly ms: number }): JobRow {
    const row = this.#jobRow(reference.jobId);
    if (row === undefined || row.status !== "RUNNING" || row.current_attempt_id !== reference.attemptId
      || row.current_worker_id !== reference.workerId || row.fencing_token !== reference.fencingToken
      || row.lease_expires_at_ms === null || row.lease_expires_at_ms <= now.ms) {
      throw new JobLeaseLostError();
    }
    return row;
  }

  public heartbeat(reference: JobLeaseReference, leaseMs = this.#defaultLeaseMs): JobHeartbeat {
    this.#assertOpen();
    validateLeaseMs(leaseMs);
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const row = this.#activeLease(reference, now);
      const expiresAtMs = now.ms + leaseMs;
      const expiresAt = new Date(expiresAtMs).toISOString();
      this.#database.prepare(`
        UPDATE durable_jobs SET lease_heartbeat_at=?, lease_expires_at=?, lease_expires_at_ms=?, updated_at=? WHERE job_id=?
      `).run(now.iso, expiresAt, expiresAtMs, now.iso, row.job_id);
      this.#database.prepare(`
        UPDATE durable_job_attempts SET heartbeat_at=?, lease_expires_at=?, lease_expires_at_ms=? WHERE attempt_id=?
      `).run(now.iso, expiresAt, expiresAtMs, reference.attemptId);
      return Object.freeze({ leaseExpiresAt: expiresAt, cancellationRequested: row.cancellation_status === "REQUESTED" });
    });
  }

  public saveCheckpoint(reference: JobLeaseReference, data: unknown, progress: number): JobCheckpointRecord {
    this.#assertOpen();
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error("checkpoint progress must be between 0 and 1");
    const payload = serializeJobJson(data);
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const row = this.#activeLease(reference, now);
      if (progress < row.progress) throw new Error("checkpoint progress must be monotonic");
      const previous = this.#checkpointRow(row.job_id);
      const revision = (previous?.revision ?? 0) + 1;
      this.#database.prepare(`
        INSERT INTO durable_job_checkpoints(job_id, revision, payload_json, payload_hash, progress, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET revision=excluded.revision, payload_json=excluded.payload_json,
          payload_hash=excluded.payload_hash, progress=excluded.progress, updated_at=excluded.updated_at
      `).run(row.job_id, revision, payload.json, payload.hash, progress, now.iso);
      this.#database.prepare("UPDATE durable_jobs SET revision=revision+1, progress=?, updated_at=? WHERE job_id=?")
        .run(progress, now.iso, row.job_id);
      this.#database.prepare("UPDATE durable_job_attempts SET checkpoint_revision=? WHERE attempt_id=?")
        .run(revision, reference.attemptId);
      return Object.freeze({ revision, payloadHash: payload.hash, progress, updatedAt: now.iso, data: payload.value });
    });
  }

  public isCancellationRequested(reference: JobLeaseReference): boolean {
    this.#assertOpen();
    const row = this.#activeLease(reference, timestamp(this.#clock));
    return row.cancellation_status === "REQUESTED";
  }

  #finishAttempt(reference: JobLeaseReference, status: JobAttemptSnapshot["status"], now: string, failure?: JobFailureInput): void {
    this.#database.prepare(`
      UPDATE durable_job_attempts SET status=?, lease_status='RELEASED', finished_at=?,
        failure_code=?, failure_retryable=?, failure_at=? WHERE attempt_id=?
    `).run(
      status, now, failure?.code ?? null, failure === undefined ? null : failure.retryable ? 1 : 0,
      failure === undefined ? null : now, reference.attemptId,
    );
  }

  #clearLeaseSql(): string {
    return "current_attempt_id=NULL, current_worker_id=NULL, lease_acquired_at=NULL, lease_heartbeat_at=NULL, lease_expires_at=NULL, lease_expires_at_ms=NULL";
  }

  public succeed(reference: JobLeaseReference): DurableJobRecord {
    this.#assertOpen();
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const row = this.#activeLease(reference, now);
      this.#finishAttempt(reference, "SUCCEEDED", now.iso);
      const cancellationStatus = row.cancellation_status === "REQUESTED" ? "REJECTED" : row.cancellation_status;
      const cancellationResolvedAt = row.cancellation_status === "REQUESTED" ? now.iso : row.cancellation_resolved_at;
      this.#database.prepare(`
        UPDATE durable_jobs SET status='SUCCEEDED', revision=revision+1, progress=1, reason_code='JOB_SUCCEEDED', ${this.#clearLeaseSql()},
          cancellation_status=?, cancellation_resolved_at=?, completed_at=?, updated_at=?, last_transition_at=?
        WHERE job_id=?
      `).run(cancellationStatus, cancellationResolvedAt, now.iso, now.iso, now.iso, row.job_id);
      const completed = this.#jobRow(row.job_id);
      if (completed === undefined) throw new Error("completed job could not be resolved");
      return this.#record(completed);
    });
  }

  public fail(reference: JobLeaseReference, failure: JobFailureInput): DurableJobRecord {
    this.#assertOpen();
    if (!FAILURE_CODE.test(failure.code)) throw new Error("job failure code is invalid");
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const row = this.#activeLease(reference, now);
      if (row.cancellation_status === "REQUESTED") {
        this.#finishAttempt(reference, "CANCELLED", now.iso);
        this.#database.prepare(`
          UPDATE durable_jobs SET status='CANCELLED', revision=revision+1, reason_code='JOB_CANCELLED', ${this.#clearLeaseSql()},
            cancellation_status='ACKNOWLEDGED', cancellation_resolved_at=?, completed_at=?, updated_at=?, last_transition_at=?
          WHERE job_id=?
        `).run(now.iso, now.iso, now.iso, now.iso, row.job_id);
      } else if (failure.retryable && row.attempt_count < row.max_attempts) {
        const delay = retryDelay(this.#retryPolicy, row.attempt_count, this.#random);
        const retryAt = new Date(now.ms + delay).toISOString();
        this.#finishAttempt(reference, "RETRYABLE_FAILED", now.iso, failure);
        this.#database.prepare(`
          UPDATE durable_jobs SET status='RETRY_WAIT', revision=revision+1, reason_code='JOB_RETRY_WAIT', ${this.#clearLeaseSql()},
            next_attempt_at=?, next_attempt_at_ms=?, last_failure_code=?, last_failure_retryable=1,
            last_failure_at=?, updated_at=?, last_transition_at=? WHERE job_id=?
        `).run(retryAt, now.ms + delay, failure.code, now.iso, now.iso, now.iso, row.job_id);
      } else {
        const reason = failure.retryable ? "JOB_MAX_ATTEMPTS_EXHAUSTED" : "JOB_NON_RETRYABLE_FAILURE";
        this.#finishAttempt(reference, "TERMINAL_FAILED", now.iso, failure);
        this.#database.prepare(`
          UPDATE durable_jobs SET status='FAILED', revision=revision+1, reason_code=?, ${this.#clearLeaseSql()},
            last_failure_code=?, last_failure_retryable=?, last_failure_at=?, completed_at=?, updated_at=?, last_transition_at=?
          WHERE job_id=?
        `).run(reason, failure.code, failure.retryable ? 1 : 0, now.iso, now.iso, now.iso, now.iso, row.job_id);
      }
      const failed = this.#jobRow(row.job_id);
      if (failed === undefined) throw new Error("failed job could not be resolved");
      return this.#record(failed);
    });
  }

  #operatorCommand(
    action: "CANCEL" | "RETRY",
    request: JobOperatorCommandRequest,
    apply: (row: JobRow, now: { readonly iso: string; readonly ms: number }) => "APPLIED" | "NOOP",
  ): JobOperatorCommandResult {
    this.#assertOpen();
    validateIdentifier(request.jobId, "jobId");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative safe integer");
    }
    if (!idempotencyKeySchema.safeParse(request.idempotencyKey).success) throw new Error("idempotencyKey is invalid");
    const fingerprint = serializeJobJson({ action, jobId: request.jobId, expectedRevision: request.expectedRevision }).hash;
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM durable_job_commands WHERE idempotency_key = ?",
      ).get(request.idempotencyKey) as JobCommandRow | undefined;
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new JobIdempotencyConflictError();
        const current = this.#jobRow(existing.job_id);
        if (current === undefined) throw new Error("job command references a missing job");
        return Object.freeze({
          schemaVersion: CONTROL_API_SCHEMA_VERSION,
          action: existing.action,
          disposition: "REPLAYED" as const,
          job: this.#snapshot(current),
        });
      }
      const row = this.#jobRow(request.jobId);
      if (row === undefined) throw new JobNotFoundError();
      if (row.revision !== request.expectedRevision) throw new JobStaleRevisionError();
      const disposition = apply(row, now);
      const updated = this.#jobRow(row.job_id);
      if (updated === undefined) throw new Error("job command result could not be resolved");
      this.#database.prepare(`
        INSERT INTO durable_job_commands (
          idempotency_key, fingerprint, job_id, action, disposition,
          expected_revision, job_revision_after, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.idempotencyKey, fingerprint, row.job_id, action, disposition,
        request.expectedRevision, updated.revision, now.iso,
      );
      return Object.freeze({
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        action,
        disposition,
        job: this.#snapshot(updated),
      });
    });
  }

  /**
   * Operator cancellation is revision-bound. Queued/waiting jobs stop immediately;
   * a running job only records a request and must acknowledge it at a safe handler boundary.
   */
  public cancel(request: JobOperatorCommandRequest): JobOperatorCommandResult {
    return this.#operatorCommand("CANCEL", request, (row, now) => {
      if (terminal(row.status) || row.cancellation_status === "REQUESTED") return "NOOP";
      if (row.status === "RUNNING") {
        this.#database.prepare(`
          UPDATE durable_jobs SET revision=revision+1, cancellation_status='REQUESTED', cancellation_requested_at=?,
            reason_code='JOB_CANCELLATION_REQUESTED', updated_at=? WHERE job_id=?
        `).run(now.iso, now.iso, row.job_id);
        return "APPLIED";
      }
      this.#database.prepare(`
        UPDATE durable_jobs SET status='CANCELLED', revision=revision+1, reason_code='JOB_CANCELLED',
          next_attempt_at=NULL, next_attempt_at_ms=NULL, cancellation_status='ACKNOWLEDGED',
          cancellation_requested_at=?, cancellation_resolved_at=?, completed_at=?, updated_at=?, last_transition_at=?
        WHERE job_id=?
      `).run(now.iso, now.iso, now.iso, now.iso, now.iso, row.job_id);
      return "APPLIED";
    });
  }

  /**
   * Manual retry keeps the original durable job and idempotency/effect key. A terminal
   * retry grants exactly one additional attempt, so the bounded-attempt invariant remains intact.
   */
  public manualRetry(request: JobOperatorCommandRequest): JobOperatorCommandResult {
    return this.#operatorCommand("RETRY", request, (row, now) => {
      const retryableTerminal = row.status === "FAILED" && row.last_failure_retryable === 1;
      if (row.status !== "RETRY_WAIT" && !retryableTerminal) {
        throw new JobStateConflictError("only retry-wait or retryable failed jobs can be retried");
      }
      if (row.attempt_count >= 1_000) throw new JobStateConflictError("job attempt limit is exhausted");
      const maximum = row.status === "FAILED" ? Math.max(row.max_attempts, row.attempt_count + 1) : row.max_attempts;
      this.#database.prepare(`
        UPDATE durable_jobs SET status='QUEUED', revision=revision+1, max_attempts=?, reason_code='JOB_QUEUED',
          next_attempt_at=NULL, next_attempt_at_ms=NULL, completed_at=NULL, updated_at=?, last_transition_at=?
        WHERE job_id=?
      `).run(maximum, now.iso, now.iso, row.job_id);
      return "APPLIED";
    });
  }

  public requestCancellation(jobId: string): CancellationRequestResult {
    this.#assertOpen();
    validateIdentifier(jobId, "jobId");
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const row = this.#jobRow(jobId);
      if (row === undefined) throw new Error("job was not found");
      if (terminal(row.status)) return Object.freeze({ status: "ALREADY_TERMINAL" as const, job: this.#record(row) });
      if (row.cancellation_status === "REJECTED") return Object.freeze({ status: "REJECTED" as const, job: this.#record(row) });
      if (row.cancellation_status === "REQUESTED") return Object.freeze({ status: "ALREADY_REQUESTED" as const, job: this.#record(row) });
      if (row.status === "RUNNING") {
        this.#database.prepare(`
          UPDATE durable_jobs SET revision=revision+1, cancellation_status='REQUESTED', cancellation_requested_at=?,
            reason_code='JOB_CANCELLATION_REQUESTED', updated_at=? WHERE job_id=?
        `).run(now.iso, now.iso, row.job_id);
        const requested = this.#jobRow(row.job_id) as JobRow;
        return Object.freeze({ status: "REQUESTED" as const, job: this.#record(requested) });
      }
      this.#database.prepare(`
        UPDATE durable_jobs SET status='CANCELLED', revision=revision+1, reason_code='JOB_CANCELLED', next_attempt_at=NULL,
          next_attempt_at_ms=NULL, cancellation_status='ACKNOWLEDGED', cancellation_requested_at=?,
          cancellation_resolved_at=?, completed_at=?, updated_at=?, last_transition_at=? WHERE job_id=?
      `).run(now.iso, now.iso, now.iso, now.iso, now.iso, row.job_id);
      const cancelled = this.#jobRow(row.job_id) as JobRow;
      return Object.freeze({ status: "CANCELLED" as const, job: this.#record(cancelled) });
    });
  }

  public acknowledgeCancellation(reference: JobLeaseReference): DurableJobRecord {
    this.#assertOpen();
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const row = this.#activeLease(reference, now);
      if (row.cancellation_status !== "REQUESTED") throw new Error("job cancellation was not requested");
      this.#finishAttempt(reference, "CANCELLED", now.iso);
      this.#database.prepare(`
        UPDATE durable_jobs SET status='CANCELLED', revision=revision+1, reason_code='JOB_CANCELLED', ${this.#clearLeaseSql()},
          cancellation_status='ACKNOWLEDGED', cancellation_resolved_at=?, completed_at=?, updated_at=?, last_transition_at=?
        WHERE job_id=?
      `).run(now.iso, now.iso, now.iso, now.iso, row.job_id);
      return this.#record(this.#jobRow(row.job_id) as JobRow);
    });
  }

  public rejectCancellation(reference: JobLeaseReference): DurableJobRecord {
    this.#assertOpen();
    const now = timestamp(this.#clock);
    return this.#transaction(() => {
      const row = this.#activeLease(reference, now);
      if (row.cancellation_status !== "REQUESTED") throw new Error("job cancellation was not requested");
      this.#database.prepare(`
        UPDATE durable_jobs SET revision=revision+1, cancellation_status='REJECTED', cancellation_resolved_at=?,
          reason_code='JOB_RUNNING', updated_at=? WHERE job_id=?
      `).run(now.iso, now.iso, row.job_id);
      return this.#record(this.#jobRow(row.job_id) as JobRow);
    });
  }

  public listAttempts(jobId: string): JobAttemptList {
    this.#assertOpen();
    validateIdentifier(jobId, "jobId");
    const rows = this.#database.prepare(`
      SELECT * FROM durable_job_attempts WHERE job_id=? ORDER BY attempt_number ASC LIMIT 1000
    `).all(jobId) as unknown as AttemptRow[];
    const items = rows.map((row) => jobAttemptSnapshotSchema.parse({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      attempt: row.attempt_number,
      status: row.status,
      workerId: row.worker_id,
      fencingToken: row.fencing_token,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      checkpointRevision: row.checkpoint_revision,
      ...(row.failure_code === null ? {} : {
        failure: { code: row.failure_code, retryable: row.failure_retryable === 1, occurredAt: row.failure_at as string },
      }),
    }));
    return Object.freeze({ items: Object.freeze(items) });
  }

  public close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
