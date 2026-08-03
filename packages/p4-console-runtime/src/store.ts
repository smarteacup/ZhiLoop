import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ClosureRunRecord, InjectionAttemptRecord, McpExpansionAuditRecord } from "@zhiloop/runtime-audit-store";

import { closureRunSchema, injectionAttemptSchema, mcpExpansionSchema } from "./contracts.js";

export interface AuditPosition { readonly occurredAt: string; readonly id: string }
export interface AuditSlice<T> { readonly items: readonly T[]; readonly hasMore: boolean }

export interface RuntimeAuditQueryPort {
  listInjections(sessionId: string, limit: number, after?: AuditPosition): AuditSlice<InjectionAttemptRecord>;
  getInjection(sessionId: string, attemptId: string): InjectionAttemptRecord | undefined;
  listMcpExpansions(sessionId: string, attemptId: string, limit: number, after?: AuditPosition): AuditSlice<McpExpansionAuditRecord>;
  listClosures(sessionId: string, limit: number, after?: AuditPosition): AuditSlice<ClosureRunRecord>;
  getClosure(sessionId: string, closureRunId: string): ClosureRunRecord | undefined;
}

export class P4AuditStoreError extends Error {
  override readonly name = "P4AuditStoreError";
}

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const OPERATION_KINDS = new Set(["FEEDBACK", "HIGH_RISK_PREVIEW", "HIGH_RISK_COMMIT"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateOperationHeader(operation: Omit<P4StoredOperation, "response">): void {
  if (!SAFE_ID.test(operation.idempotencyKey) || !OPERATION_KINDS.has(operation.kind)
    || !HASH.test(operation.requestHash) || !validIso(operation.createdAt)) {
    throw new P4AuditStoreError("stored operation metadata failed strict validation");
  }
}

function parseJson<T>(value: string, parser: { parse(input: unknown): unknown }): T {
  if (Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES) throw new P4AuditStoreError("audit record exceeds the safe render limit");
  try {
    return parser.parse(JSON.parse(value)) as T;
  } catch {
    throw new P4AuditStoreError("audit record failed strict schema validation");
  }
}

function validateBound(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new P4AuditStoreError("page limit must be within 1..100");
}

export class SqliteRuntimeAuditQueryAdapter implements RuntimeAuditQueryPort, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    if (databasePath === ":memory:" || databasePath.trim().length === 0 || databasePath.includes("\0")) {
      throw new Error("runtime audit database path is invalid");
    }
    this.#database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
    this.#database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
  }

  listInjections(sessionId: string, limit: number, after?: AuditPosition): AuditSlice<InjectionAttemptRecord> {
    validateBound(limit);
    const rows = (after === undefined
      ? this.#database.prepare(`SELECT payload_json FROM injection_attempts WHERE session_id=? ORDER BY created_at DESC,attempt_id ASC LIMIT ?`).all(sessionId, limit + 1)
      : this.#database.prepare(`SELECT payload_json FROM injection_attempts WHERE session_id=? AND (created_at < ? OR (created_at = ? AND attempt_id > ?)) ORDER BY created_at DESC,attempt_id ASC LIMIT ?`).all(sessionId, after.occurredAt, after.occurredAt, after.id, limit + 1)) as Array<{ payload_json: string }>;
    return { items: rows.slice(0, limit).map((row) => parseJson<InjectionAttemptRecord>(row.payload_json, injectionAttemptSchema)), hasMore: rows.length > limit };
  }

  getInjection(sessionId: string, attemptId: string): InjectionAttemptRecord | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM injection_attempts WHERE session_id=? AND attempt_id=?")
      .get(sessionId, attemptId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parseJson<InjectionAttemptRecord>(row.payload_json, injectionAttemptSchema);
  }

  listMcpExpansions(sessionId: string, attemptId: string, limit: number, after?: AuditPosition): AuditSlice<McpExpansionAuditRecord> {
    validateBound(limit);
    if (this.getInjection(sessionId, attemptId) === undefined) return { items: [], hasMore: false };
    const rows = (after === undefined
      ? this.#database.prepare(`SELECT payload_json FROM mcp_expansions WHERE attempt_id=? ORDER BY occurred_at ASC,expansion_id ASC LIMIT ?`).all(attemptId, limit + 1)
      : this.#database.prepare(`SELECT payload_json FROM mcp_expansions WHERE attempt_id=? AND (occurred_at > ? OR (occurred_at = ? AND expansion_id > ?)) ORDER BY occurred_at ASC,expansion_id ASC LIMIT ?`).all(attemptId, after.occurredAt, after.occurredAt, after.id, limit + 1)) as Array<{ payload_json: string }>;
    return { items: rows.slice(0, limit).map((row) => parseJson<McpExpansionAuditRecord>(row.payload_json, mcpExpansionSchema)), hasMore: rows.length > limit };
  }

  listClosures(sessionId: string, limit: number, after?: AuditPosition): AuditSlice<ClosureRunRecord> {
    validateBound(limit);
    const rows = (after === undefined
      ? this.#database.prepare(`SELECT payload_json FROM closure_runs WHERE session_id=? ORDER BY created_at DESC,closure_run_id ASC LIMIT ?`).all(sessionId, limit + 1)
      : this.#database.prepare(`SELECT payload_json FROM closure_runs WHERE session_id=? AND (created_at < ? OR (created_at = ? AND closure_run_id > ?)) ORDER BY created_at DESC,closure_run_id ASC LIMIT ?`).all(sessionId, after.occurredAt, after.occurredAt, after.id, limit + 1)) as Array<{ payload_json: string }>;
    return { items: rows.slice(0, limit).map((row) => parseJson<ClosureRunRecord>(row.payload_json, closureRunSchema)), hasMore: rows.length > limit };
  }

  getClosure(sessionId: string, closureRunId: string): ClosureRunRecord | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM closure_runs WHERE session_id=? AND closure_run_id=?")
      .get(sessionId, closureRunId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parseJson<ClosureRunRecord>(row.payload_json, closureRunSchema);
  }

  close(): void { if (!this.#closed) { this.#database.close(); this.#closed = true; } }
  [Symbol.dispose](): void { this.close(); }
}

export interface P4StoredOperation {
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly requestHash: string;
  readonly response: unknown;
  readonly createdAt: string;
}

export interface P4OperationStore {
  get(idempotencyKey: string): P4StoredOperation | undefined;
  commit(operation: P4StoredOperation): "STORED" | "IDEMPOTENT";
}

export class P4OperationConflictError extends Error {
  override readonly name = "P4OperationConflictError";
}

export class SqliteP4OperationStore implements P4OperationStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    if (databasePath.trim().length === 0 || databasePath.includes("\0")) throw new Error("operation database path is invalid");
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    chmodSync(resolved, 0o600);
    this.#database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS p4_console_operations (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;`);
  }

  get(idempotencyKey: string): P4StoredOperation | undefined {
    if (!SAFE_ID.test(idempotencyKey)) throw new P4AuditStoreError("operation idempotency key is invalid");
    const row = this.#database.prepare("SELECT kind,request_hash,response_json,created_at FROM p4_console_operations WHERE idempotency_key=?")
      .get(idempotencyKey) as { kind: string; request_hash: string; response_json: string; created_at: string } | undefined;
    if (row === undefined) return undefined;
    if (Buffer.byteLength(row.response_json, "utf8") > MAX_PAYLOAD_BYTES) throw new P4AuditStoreError("operation response exceeds the safe render limit");
    const header = { idempotencyKey, kind: row.kind, requestHash: row.request_hash, createdAt: row.created_at };
    validateOperationHeader(header);
    let response: unknown;
    try { response = JSON.parse(row.response_json) as unknown; }
    catch { throw new P4AuditStoreError("stored operation response is invalid JSON"); }
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw new P4AuditStoreError("stored operation response must be an object");
    }
    return { ...header, response };
  }

  commit(operation: P4StoredOperation): "STORED" | "IDEMPOTENT" {
    validateOperationHeader(operation);
    const existing = this.get(operation.idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestHash !== operation.requestHash || existing.kind !== operation.kind) throw new P4OperationConflictError("idempotency key semantic conflict");
      return "IDEMPOTENT";
    }
    const response = JSON.stringify(operation.response);
    if (Buffer.byteLength(response, "utf8") > MAX_PAYLOAD_BYTES) throw new P4AuditStoreError("operation response exceeds the persistence limit");
    try {
      this.#database.prepare("INSERT INTO p4_console_operations VALUES (?,?,?,?,?)")
        .run(operation.idempotencyKey, operation.kind, operation.requestHash, response, operation.createdAt);
      return "STORED";
    } catch (error) {
      const raced = this.get(operation.idempotencyKey);
      if (raced?.requestHash === operation.requestHash && raced.kind === operation.kind) return "IDEMPOTENT";
      throw new P4OperationConflictError("idempotency key semantic conflict", { cause: error });
    }
  }

  close(): void { if (!this.#closed) { this.#database.close(); this.#closed = true; } }
  [Symbol.dispose](): void { this.close(); }
}
