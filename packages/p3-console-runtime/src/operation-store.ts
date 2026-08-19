import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  p3AskResponseSchema,
  p3SearchResponseSchema,
  p3SimulationResponseSchema,
} from "./contracts.js";
import type { P3RuntimeResponse } from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,499}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function validTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseResponse(value: unknown): P3RuntimeResponse {
  if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error("P3 operation response is invalid");
  const record = value as Record<string, unknown>;
  const trace = (candidate: unknown): unknown => typeof candidate === "object" && candidate !== null
    && !("scenarios" in candidate) ? { ...candidate, scenarios: [] } : candidate;
  switch (record["kind"]) {
    case "SEARCH": return p3SearchResponseSchema.parse({ ...record, trace: trace(record["trace"]) });
    case "SIMULATION": return p3SimulationResponseSchema.parse({
      ...record,
      current: trace(record["current"]),
      ...(record["draft"] === undefined ? {} : { draft: trace(record["draft"]) }),
    });
    case "ASK": return p3AskResponseSchema.parse({ ...record, trace: trace(record["trace"]) });
    default: throw new Error("P3 operation response kind is unsupported");
  }
}

function validateOperation(operation: StoredP3ConsoleOperation): StoredP3ConsoleOperation {
  if (operation.schemaVersion !== 1 || !SAFE_ID.test(operation.requestId) || !HASH.test(operation.requestHash)
    || !validTimestamp(operation.createdAt)) throw new Error("P3 operation metadata is invalid");
  const response = parseResponse(operation.response);
  if (response.kind === "ASK" && response.answer.queryId !== operation.requestId) {
    throw new Error("P3 ASK operation is not bound to its requestId");
  }
  const responseJson = JSON.stringify(response);
  if (Buffer.byteLength(responseJson, "utf8") > MAX_RESPONSE_BYTES) throw new Error("P3 operation response exceeds its byte limit");
  return structuredClone({ ...operation, response });
}

function serialize(response: P3RuntimeResponse): string {
  const payload = JSON.stringify(response);
  if (Buffer.byteLength(payload, "utf8") > MAX_RESPONSE_BYTES) throw new Error("P3 operation response exceeds its byte limit");
  return payload;
}

export interface StoredP3ConsoleOperation {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestHash: string;
  readonly response: P3RuntimeResponse;
  readonly createdAt: string;
}

export interface P3ConsoleOperationStore {
  get(requestId: string): StoredP3ConsoleOperation | undefined;
  commit(operation: StoredP3ConsoleOperation): "STORED" | "IDEMPOTENT";
}

export class P3SemanticConflictError extends Error {
  override readonly name = "P3SemanticConflictError";
}

export class InMemoryP3ConsoleOperationStore implements P3ConsoleOperationStore {
  readonly #operations = new Map<string, StoredP3ConsoleOperation>();

  get(requestId: string): StoredP3ConsoleOperation | undefined {
    const value = this.#operations.get(requestId);
    return value === undefined ? undefined : structuredClone(value);
  }

  commit(operation: StoredP3ConsoleOperation): "STORED" | "IDEMPOTENT" {
    const validated = validateOperation(operation);
    const existing = this.#operations.get(validated.requestId);
    if (existing !== undefined) {
      if (existing.requestHash !== validated.requestHash) {
        throw new P3SemanticConflictError("requestId was already used for different P3 semantics");
      }
      return "IDEMPOTENT";
    }
    this.#operations.set(validated.requestId, validated);
    return "STORED";
  }
}

export class SqliteP3ConsoleOperationStore implements P3ConsoleOperationStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    if (typeof databasePath !== "string" || databasePath.trim().length === 0 || databasePath.includes("\0")
      || databasePath === ":memory:") throw new Error("a durable P3 operation database path is required");
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    try {
      chmodSync(resolved, 0o600);
      this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS p3_console_operations (
          request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id) BETWEEN 3 AND 500),
          request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
          response_json TEXT NOT NULL CHECK(length(CAST(response_json AS BLOB)) <= ${MAX_RESPONSE_BYTES}),
          created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 20 AND 40)
        ) STRICT;
      `);
      const table = this.#database.prepare(
        "SELECT strict FROM pragma_table_list WHERE name='p3_console_operations' AND type='table'",
      ).get() as { strict: number } | undefined;
      if (table?.strict !== 1) throw new Error("P3 operation table must use SQLite STRICT mode");
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("P3 operation store is closed");
  }

  get(requestId: string): StoredP3ConsoleOperation | undefined {
    this.#assertOpen();
    if (!SAFE_ID.test(requestId)) throw new Error("P3 operation requestId is invalid");
    const row = this.#database.prepare(`
      SELECT request_hash,
             CASE WHEN length(CAST(response_json AS BLOB)) <= ? THEN response_json ELSE NULL END AS response_json,
             created_at
      FROM p3_console_operations WHERE request_id=?
    `).get(MAX_RESPONSE_BYTES, requestId) as {
      request_hash: string;
      response_json: string | null;
      created_at: string;
    } | undefined;
    if (row === undefined) return undefined;
    if (row.response_json === null) {
      throw new Error("persisted P3 operation response exceeds its byte limit");
    }
    let response: unknown;
    try {
      response = JSON.parse(row.response_json) as unknown;
    } catch {
      throw new Error("persisted P3 operation response is invalid JSON");
    }
    return validateOperation({
      schemaVersion: 1,
      requestId,
      requestHash: row.request_hash,
      response: parseResponse(response),
      createdAt: row.created_at,
    });
  }

  commit(operation: StoredP3ConsoleOperation): "STORED" | "IDEMPOTENT" {
    this.#assertOpen();
    const validated = validateOperation(operation);
    const payload = serialize(validated.response);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.#database.prepare(`
        INSERT INTO p3_console_operations(request_id,request_hash,response_json,created_at)
        VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING
      `).run(validated.requestId, validated.requestHash, payload, validated.createdAt);
      if (inserted.changes === 1) {
        this.#database.exec("COMMIT");
        return "STORED";
      }
      const existing = this.#database.prepare(
        "SELECT request_hash FROM p3_console_operations WHERE request_id=?",
      ).get(validated.requestId) as { request_hash: string } | undefined;
      if (existing === undefined) throw new P3SemanticConflictError("P3 operation CAS result could not be observed");
      if (existing.request_hash !== validated.requestHash) {
        throw new P3SemanticConflictError("requestId was already used for different P3 semantics");
      }
      this.#database.exec("COMMIT");
      return "IDEMPOTENT";
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
