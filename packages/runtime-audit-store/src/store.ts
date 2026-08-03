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

interface InjectionRow {
  readonly attempt_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly trace_id: string;
  readonly status: string;
  readonly revision: number;
  readonly created_at: string;
  readonly payload_json: string;
}

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
        attempt_id TEXT,
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
    if (record.status !== "PENDING" || record.revision !== 0 || record.completedAt !== undefined
      || record.deliveryEvidenceRef !== undefined || record.deliveredAt !== undefined) {
      throw new Error("new injection attempt must be pending at revision zero");
    }
    this.#validateAttempt(record);
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
      if ((current.revision === expectedRevision + 1
        || (current.revision === expectedRevision + 2 && current.deliveryEvidenceRef !== undefined))
        && current.status === status
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

  acknowledgeInjectionDelivery(
    attemptId: string,
    expectedRevision: number,
    deliveryEvidenceRef: string,
    deliveredAt: string,
  ): InjectionAttemptRecord {
    assertIdentity(attemptId, "attemptId");
    assertIdentity(deliveryEvidenceRef, "deliveryEvidenceRef");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !canonicalTimestamp(deliveredAt)) {
      throw new Error("injection delivery acknowledgement is invalid");
    }
    const current = this.getInjection(attemptId);
    if (current === undefined) throw new Error("injection attempt was not found");
    if (current.deliveryEvidenceRef !== undefined || current.deliveredAt !== undefined) {
      if (current.status === "INJECTED" && current.revision === expectedRevision + 1
        && current.deliveryEvidenceRef === deliveryEvidenceRef && current.deliveredAt === deliveredAt) return current;
      throw new RuntimeAuditConflictError("injection delivery acknowledgement changed concurrently");
    }
    if (current.status !== "INJECTED" || current.revision !== expectedRevision) {
      throw new RuntimeAuditConflictError("only an unacknowledged INJECTED attempt may be acknowledged");
    }
    if (current.completedAt === undefined || Date.parse(deliveredAt) < Date.parse(current.completedAt)) {
      throw new Error("delivery acknowledgement cannot precede injection completion");
    }
    const next: InjectionAttemptRecord = {
      ...current,
      deliveryEvidenceRef,
      deliveredAt,
      revision: current.revision + 1,
    };
    this.#validateAttempt(next);
    const result = this.#database.prepare(`
      UPDATE injection_attempts SET revision=?,payload_json=?
      WHERE attempt_id=? AND revision=? AND status='INJECTED'
    `).run(next.revision, payload(next), attemptId, expectedRevision);
    if (result.changes !== 1) {
      const raced = this.getInjection(attemptId);
      if (raced?.revision === expectedRevision + 1 && raced.status === "INJECTED"
        && raced.deliveryEvidenceRef === deliveryEvidenceRef && raced.deliveredAt === deliveredAt) return raced;
      throw new RuntimeAuditConflictError("injection delivery acknowledgement changed concurrently");
    }
    return structuredClone(next);
  }

  getInjection(attemptId: string): InjectionAttemptRecord | undefined {
    assertIdentity(attemptId, "attemptId");
    const row = this.#database.prepare(`
      SELECT attempt_id,session_id,turn_id,trace_id,status,revision,created_at,payload_json
      FROM injection_attempts WHERE attempt_id=?
    `).get(attemptId) as InjectionRow | undefined;
    if (row === undefined) return undefined;
    return this.#decodeInjectionRow(row);
  }

  #decodeInjectionRow(row: InjectionRow): InjectionAttemptRecord {
    let record: InjectionAttemptRecord;
    try {
      if (Buffer.byteLength(row.payload_json, "utf8") > MAX_RECORD_BYTES) throw new Error("record exceeds byte limit");
      record = parse<InjectionAttemptRecord>(row.payload_json);
      this.#validateAttempt(record);
    }
    catch { throw new Error("persisted injection attempt is corrupt"); }
    if (record.attemptId !== row.attempt_id || record.sessionId !== row.session_id
      || record.turnId !== row.turn_id || record.traceId !== row.trace_id || record.status !== row.status
      || record.revision !== row.revision || record.createdAt !== row.created_at) {
      throw new Error("persisted injection attempt columns do not match payload");
    }
    return record;
  }

  listInjections(sessionId: string, limit = 50): RuntimeAuditPage<InjectionAttemptRecord> {
    assertIdentity(sessionId, "sessionId");
    validateLimit(limit);
    const rows = this.#database.prepare(`
      SELECT attempt_id,session_id,turn_id,trace_id,status,revision,created_at,payload_json
      FROM injection_attempts WHERE session_id=? ORDER BY created_at DESC,attempt_id LIMIT ?
    `).all(sessionId, limit + 1) as unknown as InjectionRow[];
    return { items: rows.slice(0, limit).map((row) => this.#decodeInjectionRow(row)), truncated: rows.length > limit };
  }

  recordMcpExpansion(record: McpExpansionAuditRecord): McpExpansionAuditRecord {
    this.#validateExpansion(record);
    if (record.attemptId !== undefined && this.getInjection(record.attemptId) === undefined) {
      throw new Error("MCP expansion requires a persisted injection attempt when attemptId is present");
    }
    try {
      this.#database.prepare(`
        INSERT INTO mcp_expansions(expansion_id,attempt_id,trace_id,knowledge_id,knowledge_version,occurred_at,payload_json)
        VALUES(?,?,?,?,?,?,?)
      `).run(record.expansionId, record.attemptId ?? null, record.traceId, record.knowledgeId, record.knowledgeVersion, record.occurredAt, payload(record));
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
    const acknowledged = record.deliveryEvidenceRef !== undefined || record.deliveredAt !== undefined;
    if (record.deliveryEvidenceRef !== undefined) assertIdentity(record.deliveryEvidenceRef, "deliveryEvidenceRef");
    if (record.schemaVersion !== 1 || (record.status !== "PENDING" && !TERMINAL.has(record.status))
      || !Number.isSafeInteger(record.rolloutRevision) || record.rolloutRevision < 0
      || !Number.isSafeInteger(record.revision) || record.revision < 0 || !REASON.test(record.reasonCode)
      || !canonicalTimestamp(record.createdAt) || (record.completedAt !== undefined && !canonicalTimestamp(record.completedAt))
      || (record.deliveredAt !== undefined && !canonicalTimestamp(record.deliveredAt))
      || (record.status === "PENDING") !== (record.completedAt === undefined)
      || acknowledged !== (record.deliveryEvidenceRef !== undefined && record.deliveredAt !== undefined)
      || (acknowledged && (record.status !== "INJECTED" || record.revision !== 2
        || record.completedAt === undefined || Date.parse(record.deliveredAt as string) < Date.parse(record.completedAt)))
      || (!acknowledged && record.status !== "PENDING" && record.revision !== 1)
      || (record.status === "PENDING" && record.revision !== 0)
      || record.envelope.runId !== record.runId) throw new Error("injection attempt is invalid");
  }

  #validateExpansion(record: McpExpansionAuditRecord): void {
    for (const [name, value] of [["expansionId", record.expansionId], ["traceId", record.traceId], ["knowledgeId", record.knowledgeId]] as const) {
      assertIdentity(value, name);
    }
    if (record.attemptId !== undefined) assertIdentity(record.attemptId, "attemptId");
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
