import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { KnowledgeWorkerCheckpointConflictError } from "./errors.js";
import {
  KNOWLEDGE_EXECUTION_MODES,
  type KnowledgeWorkerCheckpoint,
  type KnowledgeWorkerCheckpointStore,
} from "./types.js";

const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_AUTHORIZATION_FIELD_LENGTH = 512;

function validBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_AUTHORIZATION_FIELD_LENGTH;
}

function assertExecutionMetadata(checkpoint: KnowledgeWorkerCheckpoint): void {
  if (checkpoint.lastExecutionMode !== undefined
    && !KNOWLEDGE_EXECUTION_MODES.includes(checkpoint.lastExecutionMode)) {
    throw new Error("knowledge worker checkpoint has an invalid execution mode");
  }
  const authorization = checkpoint.publicationAuthorization;
  if (authorization === undefined) return;
  if (!validBoundedText(authorization.authorizationId)) {
    throw new Error("knowledge worker checkpoint has an invalid publication authorization");
  }
  if (authorization.kind === "EXPLICIT_COMMIT") return;
  if (authorization.kind !== "SAFE_POLICY" || !validBoundedText(authorization.policyHash)) {
    throw new Error("knowledge worker checkpoint has an invalid publication authorization");
  }
}

function serialize(checkpoint: KnowledgeWorkerCheckpoint): string {
  assertExecutionMetadata(checkpoint);
  const payload = JSON.stringify(checkpoint);
  if (Buffer.byteLength(payload, "utf8") > MAX_CHECKPOINT_BYTES) {
    throw new Error(`knowledge worker checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
  }
  return payload;
}

function parse(payload: string): KnowledgeWorkerCheckpoint {
  const checkpoint = JSON.parse(payload) as KnowledgeWorkerCheckpoint;
  if (checkpoint.schemaVersion !== 1 || checkpoint.workId.trim().length === 0 || !Number.isSafeInteger(checkpoint.revision)) {
    throw new Error("knowledge worker checkpoint is corrupt or unsupported");
  }
  assertExecutionMetadata(checkpoint);
  return structuredClone(checkpoint);
}

export class SqliteKnowledgeWorkerCheckpointStore implements KnowledgeWorkerCheckpointStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    chmodSync(resolved, 0o600);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_worker_checkpoints (
        work_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  load(workId: string): KnowledgeWorkerCheckpoint | undefined {
    const row = this.#database.prepare(
      "SELECT payload_json FROM knowledge_worker_checkpoints WHERE work_id = ?",
    ).get(workId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parse(row.payload_json);
  }

  create(checkpoint: KnowledgeWorkerCheckpoint): void {
    if (checkpoint.revision !== 0) throw new Error("new checkpoint revision must be zero");
    try {
      this.#database.prepare(`
        INSERT INTO knowledge_worker_checkpoints(work_id, revision, payload_json, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(checkpoint.workId, checkpoint.revision, serialize(checkpoint), checkpoint.updatedAt);
    } catch (error) {
      throw new KnowledgeWorkerCheckpointConflictError(`checkpoint ${checkpoint.workId} already exists`, { cause: error });
    }
  }

  save(checkpoint: KnowledgeWorkerCheckpoint, expectedRevision: number): void {
    if (checkpoint.revision !== expectedRevision + 1) {
      throw new Error("checkpoint revision must advance by exactly one");
    }
    const result = this.#database.prepare(`
      UPDATE knowledge_worker_checkpoints
      SET revision = ?, payload_json = ?, updated_at = ?
      WHERE work_id = ? AND revision = ?
    `).run(checkpoint.revision, serialize(checkpoint), checkpoint.updatedAt, checkpoint.workId, expectedRevision);
    if (result.changes !== 1) {
      throw new KnowledgeWorkerCheckpointConflictError(
        `checkpoint ${checkpoint.workId} changed concurrently at revision ${expectedRevision}`,
      );
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
