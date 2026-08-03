import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ClosureRunRecord,
  InjectionAttemptRecord,
  InjectionDeliveryStatus,
  McpExpansionAuditRecord,
  RuntimeAuditPage,
} from "./types.js";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_LIMIT = 100;
const TERMINAL = new Set<InjectionDeliveryStatus>([
  "SHADOWED", "INJECTED", "NO_CONTEXT", "ROLLED_BACK", "TIMEOUT", "ERROR",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,99}$/u;

export class RuntimeAuditConflictError extends Error {
  override readonly name = "RuntimeAuditConflictError";
}

function canonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function payload(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) throw new Error("runtime audit record exceeds byte limit");
  return serialized;
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be within 1..${MAX_LIMIT}`);
}

function assertIdentity(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${name} is invalid`);
}

function parse<T>(serialized: string): T {
  return structuredClone(JSON.parse(serialized) as T);
}

export class SqliteRuntimeAuditStore implements Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    chmodSync(resolved, 0o600);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS injection_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS injection_session_idx ON injection_attempts(session_id, created_at DESC, attempt_id);
      CREATE TABLE IF NOT EXISTS mcp_expansions (
        expansion_id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        knowledge_id TEXT NOT NULL,
        knowledge_version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(attempt_id) REFERENCES injection_attempts(attempt_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS mcp_attempt_idx ON mcp_expansions(attempt_id, occurred_at, expansion_id);
      CREATE TABLE IF NOT EXISTS closure_runs (
        closure_run_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS closure_session_idx ON closure_runs(session_id, created_at DESC, closure_run_id);
    `);
  }

  beginInjection(record: InjectionAttemptRecord): InjectionAttemptRecord {
    this.#validateAttempt(record);
    if (record.status !== "PENDING" || record.revision !== 0 || record.completedAt !== undefined) {
      throw new Error("new injection attempt must be pending at revision zero");
    }
    const serialized = payload(record);
    try {
      this.#database.prepare(`
        INSERT INTO injection_attempts(attempt_id,session_id,turn_id,trace_id,status,revision,created_at,payload_json)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(record.attemptId, record.sessionId, record.turnId, record.traceId, record.status, record.revision, record.createdAt, serialized);
    } catch (error) {
      const existing = this.getInjection(record.attemptId);
      if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(record)) return existing;
      throw new RuntimeAuditConflictError("injection attempt identity already exists", { cause: error });
    }
    return structuredClone(record);
  }

  completeInjection(
    attemptId: string,
    expectedRevision: number,
    status: Exclude<InjectionDeliveryStatus, "PENDING">,
    reasonCode: string,
    completedAt: string,
  ): InjectionAttemptRecord {
    assertIdentity(attemptId, "attemptId");
    if (!TERMINAL.has(status) || !REASON.test(reasonCode) || !canonicalTimestamp(completedAt)) {
      throw new Error("injection completion is invalid");
    }
    const current = this.getInjection(attemptId);
    if (current === undefined) throw new Error("injection attempt was not found");
    if (current.revision !== expectedRevision || current.status !== "PENDING") {
      if (current.revision === expectedRevision + 1 && current.status === status
        && current.reasonCode === reasonCode && current.completedAt === completedAt) return current;
      throw new RuntimeAuditConflictError("injection attempt changed concurrently");
    }
    const next: InjectionAttemptRecord = { ...current, status, reasonCode, completedAt, revision: current.revision + 1 };
    const result = this.#database.prepare(`
      UPDATE injection_attempts SET status=?,revision=?,payload_json=? WHERE attempt_id=? AND revision=? AND status='PENDING'
    `).run(status, next.revision, payload(next), attemptId, expectedRevision);
    if (result.changes !== 1) throw new RuntimeAuditConflictError("injection attempt changed concurrently");
    return structuredClone(next);
  }

  getInjection(attemptId: string): InjectionAttemptRecord | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM injection_attempts WHERE attempt_id=?")
      .get(attemptId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parse<InjectionAttemptRecord>(row.payload_json);
  }

  listInjections(sessionId: string, limit = 50): RuntimeAuditPage<InjectionAttemptRecord> {
    assertIdentity(sessionId, "sessionId");
    validateLimit(limit);
    const rows = this.#database.prepare(`
      SELECT payload_json FROM injection_attempts WHERE session_id=? ORDER BY created_at DESC,attempt_id LIMIT ?
    `).all(sessionId, limit + 1) as Array<{ payload_json: string }>;
    return { items: rows.slice(0, limit).map((row) => parse(row.payload_json)), truncated: rows.length > limit };
  }

  recordMcpExpansion(record: McpExpansionAuditRecord): McpExpansionAuditRecord {
    this.#validateExpansion(record);
    if (this.getInjection(record.attemptId) === undefined) throw new Error("MCP expansion requires a persisted injection attempt");
    try {
      this.#database.prepare(`
        INSERT INTO mcp_expansions(expansion_id,attempt_id,trace_id,knowledge_id,knowledge_version,occurred_at,payload_json)
        VALUES(?,?,?,?,?,?,?)
      `).run(record.expansionId, record.attemptId, record.traceId, record.knowledgeId, record.knowledgeVersion, record.occurredAt, payload(record));
    } catch (error) {
      const existing = this.getMcpExpansion(record.expansionId);
      if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(record)) return existing;
      throw new RuntimeAuditConflictError("MCP expansion identity already exists", { cause: error });
    }
    return structuredClone(record);
  }

  getMcpExpansion(expansionId: string): McpExpansionAuditRecord | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM mcp_expansions WHERE expansion_id=?")
      .get(expansionId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parse<McpExpansionAuditRecord>(row.payload_json);
  }

  listMcpExpansions(attemptId: string, limit = 50): RuntimeAuditPage<McpExpansionAuditRecord> {
    assertIdentity(attemptId, "attemptId");
    validateLimit(limit);
    const rows = this.#database.prepare(`
      SELECT payload_json FROM mcp_expansions WHERE attempt_id=? ORDER BY occurred_at,expansion_id LIMIT ?
    `).all(attemptId, limit + 1) as Array<{ payload_json: string }>;
    return { items: rows.slice(0, limit).map((row) => parse(row.payload_json)), truncated: rows.length > limit };
  }

  recordClosure(record: ClosureRunRecord): ClosureRunRecord {
    this.#validateClosure(record);
    try {
      this.#database.prepare(`
        INSERT INTO closure_runs(closure_run_id,session_id,turn_id,created_at,payload_json) VALUES(?,?,?,?,?)
      `).run(record.closureRunId, record.sessionId, record.turnId, record.createdAt, payload(record));
    } catch (error) {
      const existing = this.getClosure(record.closureRunId);
      if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(record)) return existing;
      throw new RuntimeAuditConflictError("closure run identity already exists", { cause: error });
    }
    return structuredClone(record);
  }

  getClosure(closureRunId: string): ClosureRunRecord | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM closure_runs WHERE closure_run_id=?")
      .get(closureRunId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parse<ClosureRunRecord>(row.payload_json);
  }

  listClosures(sessionId: string, limit = 50): RuntimeAuditPage<ClosureRunRecord> {
    assertIdentity(sessionId, "sessionId");
    validateLimit(limit);
    const rows = this.#database.prepare(`
      SELECT payload_json FROM closure_runs WHERE session_id=? ORDER BY created_at DESC,closure_run_id LIMIT ?
    `).all(sessionId, limit + 1) as Array<{ payload_json: string }>;
    return { items: rows.slice(0, limit).map((row) => parse(row.payload_json)), truncated: rows.length > limit };
  }

  #validateAttempt(record: InjectionAttemptRecord): void {
    for (const [name, value] of [["attemptId", record.attemptId], ["sessionId", record.sessionId], ["turnId", record.turnId], ["traceId", record.traceId], ["runId", record.runId]] as const) {
      assertIdentity(value, name);
    }
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.rolloutRevision) || record.rolloutRevision < 0
      || !Number.isSafeInteger(record.revision) || record.revision < 0 || !REASON.test(record.reasonCode)
      || !canonicalTimestamp(record.createdAt) || (record.completedAt !== undefined && !canonicalTimestamp(record.completedAt))
      || record.envelope.runId !== record.runId) throw new Error("injection attempt is invalid");
  }

  #validateExpansion(record: McpExpansionAuditRecord): void {
    for (const [name, value] of [["expansionId", record.expansionId], ["attemptId", record.attemptId], ["traceId", record.traceId], ["knowledgeId", record.knowledgeId]] as const) {
      assertIdentity(value, name);
    }
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.knowledgeVersion) || record.knowledgeVersion < 1
      || !Number.isSafeInteger(record.latencyMs) || record.latencyMs < 0 || !canonicalTimestamp(record.occurredAt)
      || (record.fromDetailLevel === "L2_COMPACT" && record.toDetailLevel !== "L3_EVIDENCED")) {
      throw new Error("MCP expansion audit is invalid");
    }
  }

  #validateClosure(record: ClosureRunRecord): void {
    for (const [name, value] of [["closureRunId", record.closureRunId], ["sessionId", record.sessionId], ["turnId", record.turnId], ["contractId", record.taskContract.contractId]] as const) {
      assertIdentity(value, name);
    }
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.continuationCount) || record.continuationCount < 0
      || record.continuationCount > 100 || !canonicalTimestamp(record.createdAt)
      || (record.recursiveStopRejected && record.continuationCount === 0)
      || record.gates.length > 100 || new Set(record.gates.map((gate) => gate.gateId)).size !== record.gates.length
      || (record.interaction?.required === true && record.interaction.question?.trim().length === 0)) {
      throw new Error("closure run is invalid");
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void { this.close(); }
}
