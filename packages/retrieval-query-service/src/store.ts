import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type {
  ConsoleRetrievalTrace,
  RetrievalQueryResponse,
  RetrievalReplayInput,
  RetrievalTraceStore,
  StoredRetrievalOperation,
} from "./types.js";
import { RetrievalRequestConflictError } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

function serialize(value: unknown): string {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`retrieval record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return payload;
}

function validTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateTrace(value: ConsoleRetrievalTrace): ConsoleRetrievalTrace {
  value = value.scenarioDirectory === undefined
    ? { ...value, scenarioDirectory: [] }
    : value;
  if (value.schemaVersion !== 1 || !SAFE_ID.test(value.traceId) || !SAFE_ID.test(value.runId)
    || !SAFE_ID.test(value.requestId) || !HASH.test(value.requestHash) || !validTimestamp(value.createdAt)
    || value.queryContext.schemaVersion !== 1 || value.queryContext.prompt.length === 0
    || value.results.length > 100 || value.filters.length > 5_000 || value.scenarioDirectory.length > 20
    || value.injection.result === "SHADOWED" && !value.injection.reasonCodes.includes("P3_SHADOW_READ_ONLY")) {
    throw new Error("retrieval trace is corrupt or unsupported");
  }
  const resultKeys = value.results.map((item) => `${item.knowledgeId}@${item.version}`);
  const selectedKeys = value.envelope.selected.map((item) => `${item.knowledgeId}@${item.version}`);
  const omittedKeys = value.envelope.omitted.map((item) => `${item.knowledgeId}@${item.version}`);
  const scenarioIds = value.scenarioDirectory.map((item) => item.scenarioId);
  if (new Set(resultKeys).size !== resultKeys.length || new Set(selectedKeys).size !== selectedKeys.length
    || new Set(omittedKeys).size !== omittedKeys.length || selectedKeys.some((key) => omittedKeys.includes(key))
    || new Set(scenarioIds).size !== scenarioIds.length
    || value.scenarioDirectory.some((item) => item.title.length === 0 || item.summary.length === 0
      || !Number.isFinite(item.score) || item.score < 0 || item.knowledgePointers.length > 1_000
      || item.taskIntents.length > 100 || item.entryPoints.length > 100
      || new Set(item.knowledgePointers).size !== item.knowledgePointers.length
      || new Set(item.taskIntents).size !== item.taskIntents.length
      || new Set(item.entryPoints).size !== item.entryPoints.length)
    || value.results.some((item, index) => item.finalRank !== index + 1 || item.contributions.length === 0
      || item.rerankReasonCodes.length === 0 || item.sourceEpisodeIds.length === 0)
    || !["RISK_", "AMBIGUITY_", "CONFLICT_", "BUDGET_"].every((prefix) => (
      value.envelope.reasonCodes.some((reason) => reason.startsWith(prefix))
    ))) {
    throw new Error("retrieval trace completeness validation failed");
  }
  return structuredClone(value);
}

function validateReplayInput(value: RetrievalReplayInput): RetrievalReplayInput {
  if (value.schemaVersion !== 1 || value.queryContext.schemaVersion !== 1
    || value.queryContext.prompt.length === 0 || value.retrieval.items.length > 100) {
    throw new Error("retrieval replay input is corrupt or unsupported");
  }
  return structuredClone(value);
}

function responseTraces(response: RetrievalQueryResponse): readonly ConsoleRetrievalTrace[] {
  return response.kind === "SEARCH"
    ? [response.trace]
    : [response.current, ...(response.draft === undefined ? [] : [response.draft])];
}

function validateOperation(value: StoredRetrievalOperation): StoredRetrievalOperation {
  if (value.schemaVersion !== 1 || !SAFE_ID.test(value.requestId) || !HASH.test(value.requestHash)
    || !validTimestamp(value.createdAt) || value.response.schemaVersion !== 1
    || value.traces.length < 1 || value.traces.length > 2) {
    throw new Error("retrieval operation is corrupt or unsupported");
  }
  const responseValues = responseTraces(value.response).map(validateTrace);
  const storedValues = value.traces.map((item) => validateTrace(item.trace));
  const responseIds = responseValues.map((item) => item.traceId);
  const storedIds = storedValues.map((item) => item.traceId);
  if (new Set(storedIds).size !== storedIds.length || responseIds.length !== storedIds.length
    || responseIds.some((traceId, index) => traceId !== storedIds[index])
    || storedValues.some((trace) => trace.requestId !== value.requestId || trace.requestHash !== value.requestHash)) {
    throw new Error("retrieval operation trace binding is invalid");
  }
  for (const item of value.traces) if (item.replayInput !== undefined) validateReplayInput(item.replayInput);
  return structuredClone(value);
}

function parseTrace(payload: string): ConsoleRetrievalTrace {
  return validateTrace(JSON.parse(payload) as ConsoleRetrievalTrace);
}

function parseReplayInput(payload: string | null): RetrievalReplayInput | undefined {
  return payload === null ? undefined : validateReplayInput(JSON.parse(payload) as RetrievalReplayInput);
}

export class InMemoryRetrievalTraceStore implements RetrievalTraceStore {
  readonly #operations = new Map<string, StoredRetrievalOperation>();
  readonly #traces = new Map<string, { trace: ConsoleRetrievalTrace; replayInput?: RetrievalReplayInput }>();

  getOperation(requestId: string): StoredRetrievalOperation | undefined {
    const value = this.#operations.get(requestId);
    return value === undefined ? undefined : structuredClone(value);
  }

  getTrace(traceId: string): ConsoleRetrievalTrace | undefined {
    const value = this.#traces.get(traceId)?.trace;
    return value === undefined ? undefined : structuredClone(value);
  }

  getReplayInput(traceId: string): RetrievalReplayInput | undefined {
    const value = this.#traces.get(traceId)?.replayInput;
    return value === undefined ? undefined : structuredClone(value);
  }

  commit(input: StoredRetrievalOperation): "STORED" | "IDEMPOTENT" {
    const operation = validateOperation(input);
    const existing = this.#operations.get(operation.requestId);
    if (existing !== undefined) {
      if (existing.requestHash !== operation.requestHash) {
        throw new RetrievalRequestConflictError("requestId was already used for different retrieval semantics");
      }
      return "IDEMPOTENT";
    }
    for (const item of operation.traces) {
      if (this.#traces.has(item.trace.traceId)) throw new RetrievalRequestConflictError("traceId already exists");
    }
    this.#operations.set(operation.requestId, structuredClone(operation));
    for (const item of operation.traces) this.#traces.set(item.trace.traceId, structuredClone(item));
    return "STORED";
  }
}

export class SqliteRetrievalTraceStore implements RetrievalTraceStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    chmodSync(resolved, 0o600);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_query_operations (
        request_id TEXT PRIMARY KEY NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retrieval_query_traces (
        trace_id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        trace_json TEXT NOT NULL,
        replay_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(request_id, ordinal),
        FOREIGN KEY(request_id) REFERENCES retrieval_query_operations(request_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS retrieval_query_traces_created_idx
        ON retrieval_query_traces(created_at DESC, trace_id ASC);
    `);
  }

  getOperation(requestId: string): StoredRetrievalOperation | undefined {
    const row = this.#database.prepare(`
      SELECT request_hash,response_json,created_at FROM retrieval_query_operations WHERE request_id=?
    `).get(requestId) as { request_hash: string; response_json: string; created_at: string } | undefined;
    if (row === undefined) return undefined;
    const response = JSON.parse(row.response_json) as RetrievalQueryResponse;
    const traces = this.#database.prepare(`
      SELECT trace_json,replay_json FROM retrieval_query_traces WHERE request_id=? ORDER BY ordinal ASC
    `).all(requestId) as unknown as readonly { trace_json: string; replay_json: string | null }[];
    return validateOperation({
      schemaVersion: 1,
      requestId,
      requestHash: row.request_hash,
      response,
      traces: traces.map((item) => {
        const replayInput = parseReplayInput(item.replay_json);
        return {
          trace: parseTrace(item.trace_json),
          ...(replayInput === undefined ? {} : { replayInput }),
        };
      }),
      createdAt: row.created_at,
    });
  }

  getTrace(traceId: string): ConsoleRetrievalTrace | undefined {
    const row = this.#database.prepare("SELECT trace_json FROM retrieval_query_traces WHERE trace_id=?")
      .get(traceId) as { trace_json: string } | undefined;
    return row === undefined ? undefined : parseTrace(row.trace_json);
  }

  getReplayInput(traceId: string): RetrievalReplayInput | undefined {
    const row = this.#database.prepare("SELECT replay_json FROM retrieval_query_traces WHERE trace_id=?")
      .get(traceId) as { replay_json: string | null } | undefined;
    return row === undefined ? undefined : parseReplayInput(row.replay_json);
  }

  commit(input: StoredRetrievalOperation): "STORED" | "IDEMPOTENT" {
    const operation = validateOperation(input);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(
        "SELECT request_hash FROM retrieval_query_operations WHERE request_id=?",
      ).get(operation.requestId) as { request_hash: string } | undefined;
      if (existing !== undefined) {
        if (existing.request_hash !== operation.requestHash) {
          throw new RetrievalRequestConflictError("requestId was already used for different retrieval semantics");
        }
        this.#database.exec("COMMIT");
        return "IDEMPOTENT";
      }
      this.#database.prepare(`
        INSERT INTO retrieval_query_operations(request_id,request_hash,response_json,created_at)
        VALUES(?,?,?,?)
      `).run(operation.requestId, operation.requestHash, serialize(operation.response), operation.createdAt);
      const insert = this.#database.prepare(`
        INSERT INTO retrieval_query_traces(trace_id,request_id,ordinal,trace_json,replay_json,created_at)
        VALUES(?,?,?,?,?,?)
      `);
      operation.traces.forEach((item, ordinal) => insert.run(
        item.trace.traceId,
        operation.requestId,
        ordinal,
        serialize(item.trace),
        item.replayInput === undefined ? null : serialize(item.replayInput),
        item.trace.createdAt,
      ));
      this.#database.exec("COMMIT");
      return "STORED";
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (error instanceof RetrievalRequestConflictError) throw error;
      throw new RetrievalRequestConflictError("retrieval operation identity already exists", { cause: error });
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
