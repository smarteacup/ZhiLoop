import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { legacyMigrationId, migrationCanonical, migrationHash } from "./identity.js";
import {
  LEGACY_MIGRATION_STATUSES,
  type CreateLegacyMigrationPreviewInput,
  type LegacyMigrationItemRecord,
  type LegacyMigrationItemSnapshot,
  type LegacyMigrationItemStatus,
  type LegacyMigrationPage,
  type LegacyMigrationPreview,
  type LegacyMigrationStatus,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9._:@+=-]{1,1000}$/u;
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,200}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,119}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_ITEMS = 100_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const STATUSES = new Set<LegacyMigrationStatus>(LEGACY_MIGRATION_STATUSES);
const ITEM_STATUSES = new Set<LegacyMigrationItemStatus>(["PENDING", "MIGRATED", "SKIPPED", "FAILED", "ROLLED_BACK", "ROLLBACK_CONFLICT"]);
const ITEM_TRANSITIONS: Readonly<Record<LegacyMigrationItemStatus, readonly LegacyMigrationItemStatus[]>> = Object.freeze({
  PENDING: ["MIGRATED", "FAILED"], MIGRATED: ["ROLLED_BACK", "ROLLBACK_CONFLICT"], SKIPPED: [], FAILED: [],
  ROLLED_BACK: [], ROLLBACK_CONFLICT: ["ROLLED_BACK", "ROLLBACK_CONFLICT"],
});
const TRANSITIONS: Readonly<Record<LegacyMigrationStatus, readonly LegacyMigrationStatus[]>> = Object.freeze({
  READY: ["COMMITTING", "ROLLING_BACK"], COMMITTING: ["COMPLETED", "FAILED", "ROLLING_BACK"],
  COMPLETED: ["ROLLING_BACK"], FAILED: ["ROLLING_BACK"], ROLLING_BACK: ["ROLLED_BACK", "ROLLBACK_CONFLICT"],
  ROLLED_BACK: [], ROLLBACK_CONFLICT: ["ROLLING_BACK"],
});

interface MigrationRow {
  readonly migration_id: string; readonly project_id: string; readonly migration_version: string;
  readonly status: string; readonly revision: number; readonly source_registry_revision: number;
  readonly created_at: string; readonly updated_at: string; readonly payload_json: string; readonly payload_hash: string;
}
interface ItemRow {
  readonly migration_id: string; readonly ordinal: number; readonly status: string; readonly updated_at: string;
  readonly payload_json: string; readonly payload_hash: string;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value); for (const child of Object.values(value)) freeze(child, seen); return Object.freeze(value);
}
function id(value: string, name: string): void {
  if (!SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`LEGACY_MIGRATION_${name}_INVALID`);
}
function timestamp(value: string): void {
  if (value.length < 20 || value.length > 40 || Number.isNaN(Date.parse(value))) throw new Error("LEGACY_MIGRATION_TIMESTAMP_INVALID");
}
function bounded(value: unknown): string {
  const payload = migrationCanonical(value);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("LEGACY_MIGRATION_PAYLOAD_LIMIT_EXCEEDED");
  return payload;
}
function validateItem(item: LegacyMigrationItemSnapshot, expectedOrdinal?: number): void {
  if (item.schemaVersion !== 1 || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0
    || (expectedOrdinal !== undefined && item.ordinal !== expectedOrdinal)
    || !Number.isSafeInteger(item.assetVersion) || item.assetVersion < 1
    || !Number.isSafeInteger(item.assetIndexVersion) || item.assetIndexVersion < 1
    || !HASH.test(item.assetContentHash) || item.assertionKinds.length > 10_000
    || item.reasonCodes.length < 1 || item.reasonCodes.length > 32
    || item.reasonCodes.some((reason) => !REASON.test(reason))) throw new Error("LEGACY_MIGRATION_ITEM_INVALID");
  id(item.assetId, "ASSET_ID");
  if (item.candidateId !== undefined) id(item.candidateId, "CANDIDATE_ID");
  if (item.assertionsHash !== undefined && !HASH.test(item.assertionsHash)) throw new Error("LEGACY_MIGRATION_ASSERTIONS_HASH_INVALID");
  if (item.classification === "MIGRATABLE" && (item.candidateId === undefined || item.assertionsHash === undefined
    || item.assertionKinds.length < 1 || item.source === "NONE")) throw new Error("LEGACY_MIGRATION_ITEM_SOURCE_INVALID");
  if (item.classification !== "MIGRATABLE" && (item.candidateId !== undefined || item.assertionsHash !== undefined)) {
    throw new Error("LEGACY_MIGRATION_ITEM_SOURCE_INVALID");
  }
}
function counts(items: readonly LegacyMigrationItemSnapshot[]) {
  return {
    scannedCount: items.length,
    migratableCount: items.filter((item) => item.classification === "MIGRATABLE").length,
    alreadyCurrentCount: items.filter((item) => item.classification === "ALREADY_CURRENT").length,
    skippedCount: items.filter((item) => item.classification === "SKIPPED").length,
  };
}
function basePreview(input: CreateLegacyMigrationPreviewInput): LegacyMigrationPreview {
  if (!SAFE_VERSION.test(input.migrationVersion) || !Number.isSafeInteger(input.sourceRegistryRevision)
    || input.sourceRegistryRevision < 0 || input.items.length > MAX_ITEMS) throw new Error("LEGACY_MIGRATION_PREVIEW_INVALID");
  id(input.projectId, "PROJECT_ID"); timestamp(input.createdAt);
  input.items.forEach((item, ordinal) => validateItem(item, ordinal));
  const keys = input.items.map((item) => `${item.assetId}@${item.assetVersion}`);
  if (new Set(keys).size !== keys.length) throw new Error("LEGACY_MIGRATION_ITEM_DUPLICATE");
  const summaryHash = migrationHash(input.items);
  const counter = counts(input.items);
  return freeze({ schemaVersion: 1, migrationId: legacyMigrationId({ migrationVersion: input.migrationVersion,
    projectId: input.projectId, sourceRegistryRevision: input.sourceRegistryRevision, summaryHash, createdAt: input.createdAt }),
  migrationVersion: input.migrationVersion, projectId: input.projectId, sourceRegistryRevision: input.sourceRegistryRevision,
  status: "READY", revision: 0, ...counter, failedCount: 0, rollbackConflictCount: 0, summaryHash,
  createdAt: input.createdAt, updatedAt: input.createdAt });
}

export class SqliteLegacyKnowledgeMigrationStore {
  readonly #database: DatabaseSync;
  #closed = false;
  constructor(filename: string) {
    const target = filename === ":memory:" ? filename : resolve(filename);
    if (filename !== ":memory:") mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(target);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(target, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS legacy_knowledge_migrations(
          migration_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, migration_version TEXT NOT NULL,
          source_registry_revision INTEGER NOT NULL CHECK(source_registry_revision>=0), status TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS legacy_migration_project_page
          ON legacy_knowledge_migrations(project_id,created_at DESC,migration_id DESC);
        CREATE TABLE IF NOT EXISTS legacy_knowledge_migration_items(
          migration_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), status TEXT NOT NULL,
          updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
          PRIMARY KEY(migration_id,ordinal),
          FOREIGN KEY(migration_id) REFERENCES legacy_knowledge_migrations(migration_id) ON DELETE RESTRICT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS legacy_knowledge_migration_effects(
          effect_key TEXT PRIMARY KEY, migration_id TEXT NOT NULL, ordinal INTEGER, operation TEXT NOT NULL,
          input_hash TEXT NOT NULL, result_json TEXT NOT NULL, result_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(migration_id) REFERENCES legacy_knowledge_migrations(migration_id) ON DELETE RESTRICT
        ) STRICT;
      `);
    } catch (error) { this.#database.close(); this.#closed = true; throw error; }
  }
  #open(): void { if (this.#closed) throw new Error("LEGACY_MIGRATION_STORE_CLOSED"); }
  #migrationRow(migrationId: string): MigrationRow | undefined {
    return this.#database.prepare("SELECT * FROM legacy_knowledge_migrations WHERE migration_id=?").get(migrationId) as unknown as MigrationRow | undefined;
  }
  #decodeMigration(row: MigrationRow): LegacyMigrationPreview {
    if (!STATUSES.has(row.status as LegacyMigrationStatus) || !HASH.test(row.payload_hash)
      || migrationHash(row.payload_json) !== row.payload_hash) throw new Error("LEGACY_MIGRATION_CORRUPT");
    let value: LegacyMigrationPreview; try { value = JSON.parse(row.payload_json) as LegacyMigrationPreview; }
    catch { throw new Error("LEGACY_MIGRATION_CORRUPT"); }
    if (value.schemaVersion !== 1 || value.migrationId !== row.migration_id || value.projectId !== row.project_id
      || value.migrationVersion !== row.migration_version || value.sourceRegistryRevision !== row.source_registry_revision
      || value.status !== row.status || value.revision !== row.revision || value.createdAt !== row.created_at
      || value.updatedAt !== row.updated_at || !HASH.test(value.summaryHash)) throw new Error("LEGACY_MIGRATION_CORRUPT");
    return freeze(value);
  }
  #decodeItem(row: ItemRow): LegacyMigrationItemRecord {
    if (!ITEM_STATUSES.has(row.status as LegacyMigrationItemStatus) || !HASH.test(row.payload_hash)
      || migrationHash(row.payload_json) !== row.payload_hash) throw new Error("LEGACY_MIGRATION_ITEM_CORRUPT");
    let value: LegacyMigrationItemRecord; try { value = JSON.parse(row.payload_json) as LegacyMigrationItemRecord; }
    catch { throw new Error("LEGACY_MIGRATION_ITEM_CORRUPT"); }
    validateItem(value, row.ordinal);
    if (value.migrationId !== row.migration_id || value.status !== row.status || value.updatedAt !== row.updated_at) {
      throw new Error("LEGACY_MIGRATION_ITEM_CORRUPT");
    }
    return freeze(value);
  }
  createPreview(input: CreateLegacyMigrationPreviewInput): LegacyMigrationPreview {
    this.#open(); const preview = basePreview(input); const payload = bounded(preview);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#migrationRow(preview.migrationId);
      if (existing !== undefined) {
        const decoded = this.#decodeMigration(existing);
        if (migrationCanonical(decoded) !== payload) throw new Error("LEGACY_MIGRATION_IDEMPOTENCY_CONFLICT");
        this.#database.exec("COMMIT"); return decoded;
      }
      this.#database.prepare(`INSERT INTO legacy_knowledge_migrations
        (migration_id,project_id,migration_version,source_registry_revision,status,revision,created_at,updated_at,payload_json,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(preview.migrationId, preview.projectId, preview.migrationVersion,
          preview.sourceRegistryRevision, preview.status, preview.revision, preview.createdAt, preview.updatedAt, payload, migrationHash(payload));
      const insert = this.#database.prepare(`INSERT INTO legacy_knowledge_migration_items
        (migration_id,ordinal,status,updated_at,payload_json,payload_hash) VALUES(?,?,?,?,?,?)`);
      for (const item of input.items) {
        const record: LegacyMigrationItemRecord = { ...item, migrationId: preview.migrationId,
          status: item.classification === "MIGRATABLE" ? "PENDING" : "SKIPPED", updatedAt: preview.createdAt };
        const itemPayload = bounded(record);
        insert.run(preview.migrationId, item.ordinal, record.status, record.updatedAt, itemPayload, migrationHash(itemPayload));
      }
      this.#database.exec("COMMIT"); return preview;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  get(migrationId: string): LegacyMigrationPreview | undefined {
    this.#open(); id(migrationId, "ID"); const row = this.#migrationRow(migrationId); return row === undefined ? undefined : this.#decodeMigration(row);
  }
  list(projectId: string, limit = 100): readonly LegacyMigrationPreview[] {
    this.#open(); id(projectId, "PROJECT_ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("LEGACY_MIGRATION_LIST_LIMIT_INVALID");
    return freeze((this.#database.prepare(`SELECT * FROM legacy_knowledge_migrations WHERE project_id=?
      ORDER BY created_at DESC,migration_id DESC LIMIT ?`).all(projectId, limit) as unknown as MigrationRow[]).map((row) => this.#decodeMigration(row)));
  }
  items(request: { readonly migrationId: string; readonly limit: number; readonly afterOrdinal?: number }): LegacyMigrationPage {
    this.#open(); id(request.migrationId, "ID");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000
      || (request.afterOrdinal !== undefined && (!Number.isSafeInteger(request.afterOrdinal) || request.afterOrdinal < 0))) {
      throw new Error("LEGACY_MIGRATION_PAGE_INVALID");
    }
    const rows = (request.afterOrdinal === undefined
      ? this.#database.prepare(`SELECT * FROM legacy_knowledge_migration_items WHERE migration_id=? ORDER BY ordinal LIMIT ?`)
        .all(request.migrationId, request.limit + 1)
      : this.#database.prepare(`SELECT * FROM legacy_knowledge_migration_items WHERE migration_id=? AND ordinal>?
          ORDER BY ordinal LIMIT ?`).all(request.migrationId, request.afterOrdinal, request.limit + 1)) as unknown as ItemRow[];
    const selected = rows.slice(0, request.limit).map((row) => this.#decodeItem(row));
    return freeze({ items: selected, ...(rows.length > request.limit ? { nextOrdinal: selected.at(-1)!.ordinal } : {}) });
  }
  itemsReverse(request: { readonly migrationId: string; readonly limit: number; readonly beforeOrdinal?: number }): LegacyMigrationPage {
    this.#open(); id(request.migrationId, "ID");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000
      || (request.beforeOrdinal !== undefined && (!Number.isSafeInteger(request.beforeOrdinal) || request.beforeOrdinal < 0))) {
      throw new Error("LEGACY_MIGRATION_PAGE_INVALID");
    }
    const rows = (request.beforeOrdinal === undefined
      ? this.#database.prepare(`SELECT * FROM legacy_knowledge_migration_items WHERE migration_id=? ORDER BY ordinal DESC LIMIT ?`)
        .all(request.migrationId, request.limit + 1)
      : this.#database.prepare(`SELECT * FROM legacy_knowledge_migration_items WHERE migration_id=? AND ordinal<?
          ORDER BY ordinal DESC LIMIT ?`).all(request.migrationId, request.beforeOrdinal, request.limit + 1)) as unknown as ItemRow[];
    const selected = rows.slice(0, request.limit).map((row) => this.#decodeItem(row));
    return freeze({ items: selected, ...(rows.length > request.limit ? { nextOrdinal: selected.at(-1)!.ordinal } : {}) });
  }
  transition(request: { readonly migrationId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly status: LegacyMigrationStatus; readonly updatedAt: string; readonly jobId?: string; readonly failureCode?: string;
    readonly failedCount?: number; readonly rollbackConflictCount?: number }): LegacyMigrationPreview {
    this.#open(); id(request.migrationId, "ID"); id(request.effectKey, "EFFECT_KEY"); timestamp(request.updatedAt);
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !STATUSES.has(request.status)
      || (request.jobId !== undefined && !SAFE_ID.test(request.jobId))
      || (request.failureCode !== undefined && !REASON.test(request.failureCode))) throw new Error("LEGACY_MIGRATION_TRANSITION_INVALID");
    const inputHash = migrationHash(request);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const priorEffect = this.#database.prepare("SELECT * FROM legacy_knowledge_migration_effects WHERE effect_key=?")
        .get(request.effectKey) as { input_hash: string; result_json: string; result_hash: string } | undefined;
      if (priorEffect !== undefined) {
        if (priorEffect.input_hash !== inputHash || migrationHash(priorEffect.result_json) !== priorEffect.result_hash) {
          throw new Error("LEGACY_MIGRATION_EFFECT_CONFLICT");
        }
        const replay = JSON.parse(priorEffect.result_json) as LegacyMigrationPreview;
        this.#database.exec("COMMIT"); return freeze(replay);
      }
      const row = this.#migrationRow(request.migrationId);
      if (row === undefined) throw new Error("LEGACY_MIGRATION_NOT_FOUND");
      const current = this.#decodeMigration(row);
      if (current.revision !== request.expectedRevision) throw new Error("LEGACY_MIGRATION_REVISION_CONFLICT");
      if (!TRANSITIONS[current.status].includes(request.status)) throw new Error("LEGACY_MIGRATION_STATUS_CONFLICT");
      const next: LegacyMigrationPreview = freeze({ ...current, status: request.status, revision: current.revision + 1,
        updatedAt: request.updatedAt, ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
        ...(request.failureCode === undefined ? {} : { failureCode: request.failureCode }),
        ...(request.failedCount === undefined ? {} : { failedCount: request.failedCount }),
        ...(request.rollbackConflictCount === undefined ? {} : { rollbackConflictCount: request.rollbackConflictCount }) });
      const payload = bounded(next);
      const write = this.#database.prepare(`UPDATE legacy_knowledge_migrations SET status=?,revision=?,updated_at=?,payload_json=?,payload_hash=?
        WHERE migration_id=? AND revision=?`).run(next.status, next.revision, next.updatedAt, payload, migrationHash(payload),
          next.migrationId, current.revision);
      if (write.changes !== 1) throw new Error("LEGACY_MIGRATION_REVISION_CONFLICT");
      const result = bounded(next);
      this.#database.prepare(`INSERT INTO legacy_knowledge_migration_effects
        (effect_key,migration_id,ordinal,operation,input_hash,result_json,result_hash,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(request.effectKey, request.migrationId, null, `STATUS_${request.status}`, inputHash, result, migrationHash(result), request.updatedAt);
      this.#database.exec("COMMIT"); return next;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  recordItem(request: { readonly migrationId: string; readonly ordinal: number; readonly effectKey: string;
    readonly status: Exclude<LegacyMigrationItemStatus, "PENDING">; readonly updatedAt: string;
    readonly verificationRunId?: string; readonly freshnessStatus?: "FRESH" | "CONFLICT" | "UNKNOWN";
    readonly createdRecipe?: boolean; readonly createdFreshness?: boolean; readonly reasonCodes?: readonly string[] }): LegacyMigrationItemRecord {
    this.#open(); id(request.migrationId, "ID"); id(request.effectKey, "EFFECT_KEY"); timestamp(request.updatedAt);
    if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 0
      || (request.verificationRunId !== undefined && !SAFE_ID.test(request.verificationRunId))
      || request.reasonCodes?.some((reason) => !REASON.test(reason))) throw new Error("LEGACY_MIGRATION_ITEM_RESULT_INVALID");
    const inputHash = migrationHash(request);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const effect = this.#database.prepare("SELECT * FROM legacy_knowledge_migration_effects WHERE effect_key=?")
        .get(request.effectKey) as { input_hash: string; result_json: string; result_hash: string } | undefined;
      if (effect !== undefined) {
        if (effect.input_hash !== inputHash || migrationHash(effect.result_json) !== effect.result_hash) throw new Error("LEGACY_MIGRATION_EFFECT_CONFLICT");
        const replay = JSON.parse(effect.result_json) as LegacyMigrationItemRecord;
        this.#database.exec("COMMIT"); return freeze(replay);
      }
      const row = this.#database.prepare("SELECT * FROM legacy_knowledge_migration_items WHERE migration_id=? AND ordinal=?")
        .get(request.migrationId, request.ordinal) as unknown as ItemRow | undefined;
      if (row === undefined) throw new Error("LEGACY_MIGRATION_ITEM_NOT_FOUND");
      const current = this.#decodeItem(row);
      if (!ITEM_TRANSITIONS[current.status].includes(request.status)) {
        throw new Error("LEGACY_MIGRATION_ITEM_STATE_CONFLICT");
      }
      const next: LegacyMigrationItemRecord = freeze({ ...current, status: request.status, updatedAt: request.updatedAt,
        ...(request.verificationRunId === undefined ? {} : { verificationRunId: request.verificationRunId }),
        ...(request.freshnessStatus === undefined ? {} : { freshnessStatus: request.freshnessStatus }),
        ...(request.createdRecipe === undefined ? {} : { createdRecipe: request.createdRecipe }),
        ...(request.createdFreshness === undefined ? {} : { createdFreshness: request.createdFreshness }),
        ...(request.reasonCodes === undefined ? {} : { reasonCodes: [...new Set(request.reasonCodes)].sort() }) });
      const payload = bounded(next);
      this.#database.prepare(`UPDATE legacy_knowledge_migration_items SET status=?,updated_at=?,payload_json=?,payload_hash=?
        WHERE migration_id=? AND ordinal=?`).run(next.status, next.updatedAt, payload, migrationHash(payload), request.migrationId, request.ordinal);
      this.#database.prepare(`INSERT INTO legacy_knowledge_migration_effects
        (effect_key,migration_id,ordinal,operation,input_hash,result_json,result_hash,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(request.effectKey, request.migrationId, request.ordinal, `ITEM_${request.status}`, inputHash, payload, migrationHash(payload), request.updatedAt);
      this.#database.exec("COMMIT"); return next;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  close(): void { if (this.#closed) return; this.#database.close(); this.#closed = true; }
  [Symbol.dispose](): void { this.close(); }
}
