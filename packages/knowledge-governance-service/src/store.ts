import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { GovernanceStoreConflictError } from "./errors.js";
import type {
  EligibilityGatePort,
  GovernanceOperation,
  GovernanceOperationStore,
  KnowledgeEditDraft,
} from "./types.js";

const MAX_RECORD_BYTES = 8 * 1024 * 1024;

function serialize(value: unknown): string {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, "utf8") > MAX_RECORD_BYTES) throw new Error("governance record exceeds byte limit");
  return payload;
}

function parseDraft(payload: string): KnowledgeEditDraft {
  const value = JSON.parse(payload) as KnowledgeEditDraft;
  if (value.draftId.trim().length === 0 || !Number.isSafeInteger(value.expectedVersion)) {
    throw new Error("governance draft is corrupt");
  }
  return structuredClone(value);
}

function parseOperation(payload: string): GovernanceOperation {
  const value = JSON.parse(payload) as GovernanceOperation;
  if (value.schemaVersion !== 1 || value.operationId.trim().length === 0
    || typeof value.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestHash)
    || !Number.isSafeInteger(value.revision)) {
    throw new Error("governance operation is corrupt");
  }
  return structuredClone(value);
}

export class SqliteGovernanceOperationStore implements GovernanceOperationStore, EligibilityGatePort, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    chmodSync(resolved, 0o600);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS governance_drafts (
        draft_id TEXT PRIMARY KEY NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        asset_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        operation_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS governance_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        idempotency_key TEXT UNIQUE NOT NULL,
        asset_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS governance_operations_asset_idx
        ON governance_operations(asset_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS governance_eligibility_exclusions (
        asset_id TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  getDraft(draftId: string): KnowledgeEditDraft | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM governance_drafts WHERE draft_id=?")
      .get(draftId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parseDraft(row.payload_json);
  }

  getDraftByIdempotencyKey(idempotencyKey: string): KnowledgeEditDraft | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM governance_drafts WHERE idempotency_key=?")
      .get(idempotencyKey) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parseDraft(row.payload_json);
  }

  createDraft(draft: KnowledgeEditDraft): void {
    const payload = serialize(draft);
    try {
      this.#database.prepare(`
        INSERT INTO governance_drafts(
          draft_id,idempotency_key,asset_id,expected_version,status,operation_id,payload_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `).run(
        draft.draftId,
        draft.idempotencyKey,
        draft.assetId,
        draft.expectedVersion,
        draft.status,
        draft.committedOperationId ?? null,
        payload,
        draft.createdAt,
      );
    } catch (error) {
      throw new GovernanceStoreConflictError("draft identity already exists", { cause: error });
    }
  }

  markDraftCommitted(draftId: string, operationId: string): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare("SELECT payload_json FROM governance_drafts WHERE draft_id=?")
        .get(draftId) as { payload_json: string } | undefined;
      if (row === undefined) throw new GovernanceStoreConflictError("draft was not found");
      const draft = parseDraft(row.payload_json);
      if (draft.status === "COMMITTED" && draft.committedOperationId === operationId) {
        this.#database.exec("COMMIT");
        return;
      }
      if (draft.status !== "VALIDATED") throw new GovernanceStoreConflictError("draft is already committed");
      const committed: KnowledgeEditDraft = { ...draft, status: "COMMITTED", committedOperationId: operationId };
      this.#database.prepare(`
        UPDATE governance_drafts SET status='COMMITTED', operation_id=?, payload_json=? WHERE draft_id=?
      `).run(operationId, serialize(committed), draftId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getOperation(operationId: string): GovernanceOperation | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM governance_operations WHERE operation_id=?")
      .get(operationId) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parseOperation(row.payload_json);
  }

  getOperationByIdempotencyKey(idempotencyKey: string): GovernanceOperation | undefined {
    const row = this.#database.prepare("SELECT payload_json FROM governance_operations WHERE idempotency_key=?")
      .get(idempotencyKey) as { payload_json: string } | undefined;
    return row === undefined ? undefined : parseOperation(row.payload_json);
  }

  createOperation(operation: GovernanceOperation): void {
    const payload = serialize(operation);
    try {
      this.#database.prepare(`
        INSERT INTO governance_operations(operation_id,idempotency_key,asset_id,revision,status,payload_json,updated_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        operation.operationId,
        operation.idempotencyKey,
        operation.assetId,
        operation.revision,
        operation.status,
        payload,
        operation.updatedAt,
      );
    } catch (error) {
      throw new GovernanceStoreConflictError("operation identity already exists", { cause: error });
    }
  }

  saveOperation(operation: GovernanceOperation, expectedRevision: number): void {
    if (operation.revision !== expectedRevision + 1) throw new Error("operation revision must advance by one");
    const result = this.#database.prepare(`
      UPDATE governance_operations SET revision=?,status=?,payload_json=?,updated_at=?
      WHERE operation_id=? AND revision=?
    `).run(
      operation.revision,
      operation.status,
      serialize(operation),
      operation.updatedAt,
      operation.operationId,
      expectedRevision,
    );
    if (result.changes !== 1) throw new GovernanceStoreConflictError("operation changed concurrently");
  }

  exclude(assetId: string, operationId: string): void {
    if (assetId.trim().length === 0 || operationId.trim().length === 0) throw new Error("eligibility exclusion identity is invalid");
    this.#database.prepare(`
      INSERT INTO governance_eligibility_exclusions(asset_id,operation_id,created_at)
      VALUES(?,?,?)
      ON CONFLICT(asset_id) DO UPDATE SET operation_id=excluded.operation_id,created_at=excluded.created_at
    `).run(assetId, operationId, new Date().toISOString());
  }

  include(assetId: string, operationId: string): void {
    this.#database.prepare(
      "DELETE FROM governance_eligibility_exclusions WHERE asset_id=? AND operation_id=?",
    ).run(assetId, operationId);
  }

  isExcluded(assetId: string): boolean {
    return this.#database.prepare(
      "SELECT 1 AS present FROM governance_eligibility_exclusions WHERE asset_id=?",
    ).get(assetId) !== undefined;
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
