import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { EvidenceRef, KnowledgeAsset, KnowledgeRelation } from "@zhiloop/domain";
import {
  calculateKnowledgeContentHash,
  type MarkdownKnowledgeRepository,
  type StoredKnowledgeVersion,
} from "@zhiloop/markdown-repository";
import { parseKnowledgeAsset } from "@zhiloop/schemas";

import {
  KnowledgeProjectionConflictError,
  KnowledgeProjectionRebuildError,
  type KnowledgeProjectionOptions,
  type KnowledgeListOptions,
  type KnowledgeSearchOptions,
  type KnowledgeSearchResult,
  type ProjectedEvidence,
  type ProjectedKnowledgeAsset,
  type ProjectedKnowledgeVersion,
  type ProjectedRelations,
  type ProjectionRebuildDiagnostic,
  type ProjectionRebuildResult,
  type ProjectionWriteResult,
} from "./types.js";

const CURRENT_MIGRATION_VERSION = 1;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;
const MAX_QUERY_CHARS = 2_000;
const DEFAULT_ELIGIBLE_STATUSES = ["ACCEPTED", "IMPLEMENTED", "VERIFIED"] as const;

interface AssetRow {
  readonly asset_id: string;
  readonly current_version: number;
  readonly tombstone: number;
  readonly tombstone_reason: string | null;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly content_hash: string;
  readonly status: string;
  readonly subject_key: string;
  readonly kind: string;
  readonly index_version: number;
}

interface VersionRow extends AssetRow {
  readonly document_path: string;
}

interface SearchRow extends AssetRow {
  readonly fts_rank: number;
}

interface ProjectionSnapshot {
  readonly active: StoredKnowledgeVersion;
  readonly versions: readonly StoredKnowledgeVersion[];
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

function prepare(record: StoredKnowledgeVersion): { readonly payloadJson: string; readonly payloadHash: string } {
  if (record.historyState !== "COMMITTED") {
    throw new KnowledgeProjectionConflictError("only COMMITTED Markdown versions can be projected");
  }
  const parsed = parseKnowledgeAsset(record.asset);
  if (!parsed.ok) throw new KnowledgeProjectionConflictError(parsed.error.message);
  if (calculateKnowledgeContentHash(record.asset) !== record.asset.contentHash) {
    throw new KnowledgeProjectionConflictError("KnowledgeAsset contentHash failed canonical verification");
  }
  const baseName = path.basename(record.documentPath);
  const assetDirectory = baseName === "current.md"
    ? path.basename(path.dirname(record.documentPath))
    : path.basename(path.dirname(path.dirname(record.documentPath)));
  const versionMatches = baseName === "current.md" || baseName === `${String(record.asset.version).padStart(8, "0")}.md`;
  if (assetDirectory !== record.asset.id || !versionMatches) {
    throw new KnowledgeProjectionConflictError("Markdown document path does not match its asset/version identity");
  }
  if (record.tombstone !== (record.tombstoneReason !== undefined)) {
    throw new KnowledgeProjectionConflictError("tombstone and tombstoneReason must be present together");
  }
  const payloadJson = JSON.stringify(record.asset);
  return { payloadJson, payloadHash: sha256(payloadJson) };
}

function parseRow(row: AssetRow): KnowledgeAsset {
  if (sha256(row.payload_json) !== row.payload_hash) {
    throw new Error(`projected knowledge ${row.asset_id}@${row.current_version} failed payload integrity verification`);
  }
  const parsed = parseKnowledgeAsset(JSON.parse(row.payload_json) as unknown);
  if (!parsed.ok) throw new Error(`projected knowledge ${row.asset_id}@${row.current_version} is corrupt or unsupported`);
  const asset = parsed.value;
  if (
    asset.id !== row.asset_id || asset.version !== row.current_version || asset.contentHash !== row.content_hash ||
    asset.status !== row.status || asset.subjectKey !== row.subject_key || asset.kind !== row.kind ||
    calculateKnowledgeContentHash(asset) !== asset.contentHash
  ) {
    throw new Error(`projected knowledge ${row.asset_id}@${row.current_version} index columns failed integrity verification`);
  }
  return deepFreeze(structuredClone(asset));
}

function projected(row: AssetRow): ProjectedKnowledgeAsset {
  return deepFreeze({
    asset: parseRow(row),
    tombstone: row.tombstone === 1,
    ...(row.tombstone_reason === null ? {} : { tombstoneReason: row.tombstone_reason }),
    indexVersion: row.index_version,
  });
}

function assertSearchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
  }
}

function ftsQuery(input: string): string {
  if (input.trim().length === 0 || input.length > MAX_QUERY_CHARS) {
    throw new Error(`query must contain 1 to ${MAX_QUERY_CHARS} characters`);
  }
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_.$:-]+/gu)?.slice(0, 30) ?? [];
  if (tokens.length === 0) throw new Error("query must contain searchable letters or numbers");
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function sameStoredVersion(row: AssetRow, record: StoredKnowledgeVersion, payloadHash: string): boolean {
  return row.asset_id === record.asset.id && row.current_version === record.asset.version &&
    row.payload_hash === payloadHash && row.tombstone === (record.tombstone ? 1 : 0) &&
    row.tombstone_reason === (record.tombstoneReason ?? null) && row.content_hash === record.asset.contentHash &&
    row.status === record.asset.status && row.subject_key === record.asset.subjectKey && row.kind === record.asset.kind;
}

export class SqliteKnowledgeRegistryProjection {
  readonly #database: DatabaseSync;
  readonly #faultInjector: KnowledgeProjectionOptions["faultInjector"];
  #closed = false;

  constructor(filename: string, options: KnowledgeProjectionOptions = {}) {
    this.#database = new DatabaseSync(filename);
    this.#faultInjector = options.faultInjector;
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
    if (this.#closed) throw new Error("knowledge projection is closed");
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_projection_meta (
        component TEXT PRIMARY KEY,
        migration_version INTEGER NOT NULL CHECK (migration_version >= 0),
        active_index_version INTEGER NOT NULL CHECK (active_index_version >= 0)
      );
    `);
    const existing = this.#database.prepare(
      "SELECT migration_version, active_index_version FROM knowledge_projection_meta WHERE component = 'knowledge-registry'",
    ).get() as { migration_version: number; active_index_version: number } | undefined;
    if (existing !== undefined && existing.migration_version > CURRENT_MIGRATION_VERSION) {
      throw new Error(`knowledge projection migration ${existing.migration_version} is newer than supported version ${CURRENT_MIGRATION_VERSION}`);
    }
    if (existing?.migration_version === CURRENT_MIGRATION_VERSION) return;
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_assets (
          asset_id TEXT PRIMARY KEY,
          current_version INTEGER NOT NULL CHECK (current_version >= 1),
          tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
          tombstone_reason TEXT,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          scope_level TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          index_version INTEGER NOT NULL CHECK (index_version >= 1)
        );
        CREATE INDEX IF NOT EXISTS knowledge_assets_eligibility_idx
          ON knowledge_assets(tombstone, status, scope_level, subject_key, asset_id);
        CREATE TABLE IF NOT EXISTS knowledge_versions (
          asset_id TEXT NOT NULL,
          current_version INTEGER NOT NULL CHECK (current_version >= 1),
          tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
          tombstone_reason TEXT,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          scope_level TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          document_path TEXT NOT NULL,
          index_version INTEGER NOT NULL CHECK (index_version >= 1),
          PRIMARY KEY(asset_id, current_version)
        );
        CREATE TABLE IF NOT EXISTS knowledge_relations (
          asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL,
          ordinal INTEGER NOT NULL,
          relation_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_version INTEGER,
          reason TEXT,
          index_version INTEGER NOT NULL,
          PRIMARY KEY(asset_id, asset_version, ordinal),
          FOREIGN KEY(asset_id, asset_version) REFERENCES knowledge_versions(asset_id, current_version) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS knowledge_relations_target_idx ON knowledge_relations(target_id, relation_type);
        CREATE TABLE IF NOT EXISTS knowledge_evidence (
          asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL,
          ordinal INTEGER NOT NULL,
          evidence_id TEXT NOT NULL,
          verdict TEXT NOT NULL,
          index_version INTEGER NOT NULL,
          PRIMARY KEY(asset_id, asset_version, ordinal),
          FOREIGN KEY(asset_id, asset_version) REFERENCES knowledge_versions(asset_id, current_version) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS knowledge_evidence_id_idx ON knowledge_evidence(evidence_id, verdict);
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          asset_id UNINDEXED, title, aliases, keywords, body, symbols, tokenize='unicode61'
        );
        INSERT INTO knowledge_projection_meta(component, migration_version, active_index_version)
          VALUES ('knowledge-registry', 1, 0)
          ON CONFLICT(component) DO UPDATE SET migration_version = excluded.migration_version;
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

  get activeIndexVersion(): number {
    this.#assertOpen();
    const row = this.#database.prepare(
      "SELECT active_index_version FROM knowledge_projection_meta WHERE component = 'knowledge-registry'",
    ).get() as { active_index_version: number };
    return row.active_index_version;
  }

  #nextIndexVersion(): number {
    const next = this.activeIndexVersion + 1;
    if (!Number.isSafeInteger(next)) throw new Error("activeIndexVersion exhausted the safe integer range");
    return next;
  }

  #assetRow(assetId: string): AssetRow | undefined {
    return this.#database.prepare(`
      SELECT asset_id, current_version, tombstone, tombstone_reason, payload_json, payload_hash,
             content_hash, status, subject_key, kind, index_version
      FROM knowledge_assets WHERE asset_id = ?
    `).get(assetId) as AssetRow | undefined;
  }

  #insertVersion(record: StoredKnowledgeVersion, indexVersion: number): void {
    const { payloadJson, payloadHash } = prepare(record);
    const existing = this.#database.prepare(`
      SELECT asset_id, current_version, tombstone, tombstone_reason, payload_json, payload_hash,
             content_hash, status, subject_key, kind, index_version, document_path
      FROM knowledge_versions WHERE asset_id = ? AND current_version = ?
    `).get(record.asset.id, record.asset.version) as VersionRow | undefined;
    if (existing !== undefined) {
      if (!sameStoredVersion(existing, record, payloadHash)) {
        throw new KnowledgeProjectionConflictError(`immutable projection ${record.asset.id}@${record.asset.version} conflicts`);
      }
      parseRow(existing);
      this.#assertVersionEdges(record);
      return;
    }
    const asset = record.asset;
    this.#database.prepare(`
      INSERT INTO knowledge_versions (
        asset_id, current_version, tombstone, tombstone_reason, payload_json, payload_hash, content_hash,
        status, scope_level, subject_key, kind, title, summary, updated_at, document_path, index_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id, asset.version, record.tombstone ? 1 : 0, record.tombstoneReason ?? null,
      payloadJson, payloadHash, asset.contentHash, asset.status, asset.scope.level, asset.subjectKey,
      asset.kind, asset.title, asset.summary, asset.updatedAt, record.documentPath, indexVersion,
    );
    const relationInsert = this.#database.prepare(`
      INSERT INTO knowledge_relations (
        asset_id, asset_version, ordinal, relation_type, target_id, target_version, reason, index_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    asset.relations.forEach((relation, ordinal) => relationInsert.run(
      asset.id, asset.version, ordinal, relation.type, relation.targetId, relation.targetVersion ?? null,
      relation.reason ?? null, indexVersion,
    ));
    const evidenceInsert = this.#database.prepare(`
      INSERT INTO knowledge_evidence (
        asset_id, asset_version, ordinal, evidence_id, verdict, index_version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    asset.evidence.forEach((evidence, ordinal) => evidenceInsert.run(
      asset.id, asset.version, ordinal, evidence.evidenceId, evidence.verdict, indexVersion,
    ));
  }

  #assertVersionEdges(record: StoredKnowledgeVersion): void {
    const relationRows = this.#database.prepare(`
      SELECT relation_type, target_id, target_version, reason FROM knowledge_relations
      WHERE asset_id = ? AND asset_version = ? ORDER BY ordinal ASC
    `).all(record.asset.id, record.asset.version) as unknown as Array<{
      relation_type: KnowledgeRelation["type"];
      target_id: string;
      target_version: number | null;
      reason: string | null;
    }>;
    const relations = relationRows.map((row) => ({
      type: row.relation_type,
      targetId: row.target_id,
      ...(row.target_version === null ? {} : { targetVersion: row.target_version }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    }));
    const evidenceRows = this.#database.prepare(`
      SELECT evidence_id, verdict FROM knowledge_evidence
      WHERE asset_id = ? AND asset_version = ? ORDER BY ordinal ASC
    `).all(record.asset.id, record.asset.version) as unknown as Array<{ evidence_id: string; verdict: string }>;
    const evidence = evidenceRows.map((row) => ({ evidenceId: row.evidence_id, verdict: row.verdict }));
    if (JSON.stringify(relations) !== JSON.stringify(record.asset.relations) ||
      JSON.stringify(evidence) !== JSON.stringify(record.asset.evidence)) {
      throw new KnowledgeProjectionConflictError(`derived edges for ${record.asset.id}@${record.asset.version} are inconsistent`);
    }
  }

  #assertActiveIntegrity(record: StoredKnowledgeVersion, row: AssetRow): void {
    parseRow(row);
    this.#assertVersionEdges(record);
    const ftsRows = this.#database.prepare(`
      SELECT title, aliases, keywords, body, symbols FROM knowledge_fts WHERE asset_id = ?
    `).all(record.asset.id) as unknown as Array<{
      title: string;
      aliases: string;
      keywords: string;
      body: string;
      symbols: string;
    }>;
    if (record.tombstone) {
      if (ftsRows.length !== 0) throw new KnowledgeProjectionConflictError("tombstone must not have an FTS row");
      return;
    }
    const expected = {
      title: record.asset.title,
      aliases: record.asset.aliases.join("\n"),
      keywords: record.asset.keywords.join("\n"),
      body: record.asset.body,
      symbols: record.asset.symbols.join("\n"),
    };
    if (ftsRows.length !== 1 || JSON.stringify(ftsRows[0]) !== JSON.stringify(expected)) {
      throw new KnowledgeProjectionConflictError(`FTS row for ${record.asset.id} is inconsistent`);
    }
  }

  #activate(record: StoredKnowledgeVersion, indexVersion: number): void {
    const { payloadJson, payloadHash } = prepare(record);
    const asset = record.asset;
    this.#database.prepare(`
      INSERT INTO knowledge_assets (
        asset_id, current_version, tombstone, tombstone_reason, payload_json, payload_hash, content_hash,
        status, scope_level, subject_key, kind, title, summary, updated_at, index_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        current_version=excluded.current_version, tombstone=excluded.tombstone,
        tombstone_reason=excluded.tombstone_reason, payload_json=excluded.payload_json,
        payload_hash=excluded.payload_hash, content_hash=excluded.content_hash, status=excluded.status,
        scope_level=excluded.scope_level, subject_key=excluded.subject_key, kind=excluded.kind,
        title=excluded.title, summary=excluded.summary, updated_at=excluded.updated_at,
        index_version=excluded.index_version
    `).run(
      asset.id, asset.version, record.tombstone ? 1 : 0, record.tombstoneReason ?? null,
      payloadJson, payloadHash, asset.contentHash, asset.status, asset.scope.level, asset.subjectKey,
      asset.kind, asset.title, asset.summary, asset.updatedAt, indexVersion,
    );
    this.#faultInjector?.("AFTER_ASSET_UPSERT");
    this.#database.prepare("DELETE FROM knowledge_fts WHERE asset_id = ?").run(asset.id);
    if (!record.tombstone) {
      this.#database.prepare(`
        INSERT INTO knowledge_fts(asset_id, title, aliases, keywords, body, symbols)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        asset.id, asset.title, asset.aliases.join("\n"), asset.keywords.join("\n"),
        asset.body, asset.symbols.join("\n"),
      );
    }
  }

  #setActiveIndexVersion(indexVersion: number): void {
    this.#database.prepare(`
      UPDATE knowledge_projection_meta SET active_index_version = ? WHERE component = 'knowledge-registry'
    `).run(indexVersion);
  }

  projectCurrent(record: StoredKnowledgeVersion): ProjectionWriteResult {
    this.#assertOpen();
    const prepared = prepare(record);
    return this.#transaction(() => {
      const existing = this.#assetRow(record.asset.id);
      if (existing !== undefined && sameStoredVersion(existing, record, prepared.payloadHash)) {
        this.#assertActiveIntegrity(record, existing);
        return deepFreeze({
          status: "IDEMPOTENT" as const, indexVersion: existing.index_version,
          assetId: record.asset.id, assetVersion: record.asset.version,
        });
      }
      if (existing === undefined && record.asset.version !== 1) {
        throw new KnowledgeProjectionConflictError("an empty projection must start at asset version 1; use rebuild for existing history");
      }
      if (existing !== undefined && record.asset.version !== existing.current_version + 1) {
        throw new KnowledgeProjectionConflictError("projected version must immediately follow the active version");
      }
      const indexVersion = this.#nextIndexVersion();
      this.#insertVersion(record, indexVersion);
      this.#activate(record, indexVersion);
      this.#setActiveIndexVersion(indexVersion);
      return deepFreeze({
        status: "PROJECTED", indexVersion, assetId: record.asset.id, assetVersion: record.asset.version,
      });
    });
  }

  replaceAssetHistory(
    versions: readonly StoredKnowledgeVersion[],
    active: StoredKnowledgeVersion,
  ): ProjectionWriteResult {
    this.#assertOpen();
    if (versions.length === 0) throw new KnowledgeProjectionConflictError("asset history must not be empty");
    versions.forEach((record, index) => {
      prepare(record);
      if (record.asset.id !== active.asset.id || record.asset.version !== index + 1) {
        throw new KnowledgeProjectionConflictError("asset history must be contiguous and belong to one asset");
      }
    });
    prepare(active);
    const last = versions.at(-1) as StoredKnowledgeVersion;
    if (
      last.asset.version !== active.asset.version || last.asset.contentHash !== active.asset.contentHash ||
      last.tombstone !== active.tombstone || last.tombstoneReason !== active.tombstoneReason
    ) {
      throw new KnowledgeProjectionConflictError("active Markdown record must match the latest immutable version");
    }
    return this.#transaction(() => {
      const indexVersion = this.#nextIndexVersion();
      this.#database.prepare("DELETE FROM knowledge_fts WHERE asset_id = ?").run(active.asset.id);
      this.#database.prepare("DELETE FROM knowledge_assets WHERE asset_id = ?").run(active.asset.id);
      this.#database.prepare("DELETE FROM knowledge_versions WHERE asset_id = ?").run(active.asset.id);
      for (const version of versions) this.#insertVersion(version, indexVersion);
      this.#activate(active, indexVersion);
      this.#setActiveIndexVersion(indexVersion);
      return deepFreeze({
        status: "PROJECTED" as const,
        indexVersion,
        assetId: active.asset.id,
        assetVersion: active.asset.version,
      });
    });
  }

  async rebuildFromMarkdown(repository: MarkdownKnowledgeRepository): Promise<ProjectionRebuildResult> {
    this.#assertOpen();
    const snapshots: ProjectionSnapshot[] = [];
    const diagnostics: ProjectionRebuildDiagnostic[] = [];
    for (const assetId of await repository.listAssetIds()) {
      const current = await repository.readCurrent(assetId);
      let active: StoredKnowledgeVersion | undefined;
      if (current.ok && current.value.historyState === "COMMITTED") active = current.value;
      else if (current.ok) {
        const immutable = await repository.readVersion(assetId, current.value.asset.version);
        if (immutable.ok) active = immutable.value;
        diagnostics.push({ assetId, code: "CURRENT_FALLBACK", message: "manual current was replaced by its immutable version" });
      } else if (current.lastValid !== undefined) {
        active = current.lastValid;
        diagnostics.push({ assetId, code: "CURRENT_FALLBACK", message: current.error.message });
      }
      if (active === undefined) {
        diagnostics.push({ assetId, code: "NO_VALID_VERSION", message: "asset has no committed Markdown version" });
        continue;
      }
      const versions: StoredKnowledgeVersion[] = [];
      for (let version = 1; version <= active.asset.version; version += 1) {
        const result = await repository.readVersion(assetId, version);
        if (!result.ok || result.value.historyState !== "COMMITTED") {
          throw new KnowledgeProjectionRebuildError(`cannot rebuild ${assetId}: immutable version ${version} is missing or invalid`);
        }
        versions.push(result.value);
      }
      snapshots.push({ active, versions });
    }

    return this.#transaction(() => {
      const indexVersion = this.#nextIndexVersion();
      this.#database.exec(`
        DELETE FROM knowledge_fts;
        DELETE FROM knowledge_evidence;
        DELETE FROM knowledge_relations;
        DELETE FROM knowledge_versions;
        DELETE FROM knowledge_assets;
      `);
      let versionCount = 0;
      for (const snapshot of snapshots) {
        for (const version of snapshot.versions) {
          this.#insertVersion(version, indexVersion);
          versionCount += 1;
        }
        this.#activate(snapshot.active, indexVersion);
      }
      this.#setActiveIndexVersion(indexVersion);
      return deepFreeze({
        indexVersion, assets: snapshots.length, versions: versionCount, diagnostics: [...diagnostics],
      });
    });
  }

  getAsset(assetId: string, includeTombstone = false): ProjectedKnowledgeAsset | undefined {
    this.#assertOpen();
    if (assetId.trim().length === 0) throw new Error("assetId must not be empty");
    const row = this.#assetRow(assetId);
    if (row === undefined || (!includeTombstone && row.tombstone === 1)) return undefined;
    return projected(row);
  }

  listAssets(options: KnowledgeListOptions = {}): readonly ProjectedKnowledgeAsset[] {
    this.#assertOpen();
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
    }
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
    const tombstoneClause = options.includeTombstones === true ? "" : "WHERE tombstone = 0";
    const rows = this.#database.prepare(`
      SELECT asset_id, current_version, tombstone, tombstone_reason, payload_json, payload_hash,
             content_hash, status, subject_key, kind, index_version
      FROM knowledge_assets ${tombstoneClause}
      ORDER BY subject_key ASC, asset_id ASC LIMIT ? OFFSET ?
    `).all(limit, offset) as unknown as AssetRow[];
    return deepFreeze(rows.map(projected));
  }

  getVersion(assetId: string, version: number): ProjectedKnowledgeVersion | undefined {
    this.#assertOpen();
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("version must be a positive safe integer");
    const row = this.#database.prepare(`
      SELECT asset_id, current_version, tombstone, tombstone_reason, payload_json, payload_hash,
             content_hash, status, subject_key, kind, index_version, document_path
      FROM knowledge_versions WHERE asset_id = ? AND current_version = ?
    `).get(assetId, version) as VersionRow | undefined;
    if (row === undefined) return undefined;
    return deepFreeze({ ...projected(row), documentPath: row.document_path });
  }

  listVersions(assetId: string): readonly ProjectedKnowledgeVersion[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT asset_id, current_version, tombstone, tombstone_reason, payload_json, payload_hash,
             content_hash, status, subject_key, kind, index_version, document_path
      FROM knowledge_versions WHERE asset_id = ? ORDER BY current_version ASC
    `).all(assetId) as unknown as VersionRow[];
    return deepFreeze(rows.map((row) => ({ ...projected(row), documentPath: row.document_path })));
  }

  getRelations(assetId: string, version: number): ProjectedRelations {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT relation_type, target_id, target_version, reason
      FROM knowledge_relations WHERE asset_id = ? AND asset_version = ? ORDER BY ordinal ASC
    `).all(assetId, version) as unknown as Array<{
      relation_type: KnowledgeRelation["type"];
      target_id: string;
      target_version: number | null;
      reason: string | null;
    }>;
    const relations = rows.map((row): KnowledgeRelation => ({
      type: row.relation_type,
      targetId: row.target_id,
      ...(row.target_version === null ? {} : { targetVersion: row.target_version }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    }));
    return deepFreeze({ assetId, assetVersion: version, relations });
  }

  getEvidence(assetId: string, version: number): ProjectedEvidence {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT evidence_id, verdict FROM knowledge_evidence
      WHERE asset_id = ? AND asset_version = ? ORDER BY ordinal ASC
    `).all(assetId, version) as unknown as Array<{ evidence_id: string; verdict: EvidenceRef["verdict"] }>;
    return deepFreeze({
      assetId,
      assetVersion: version,
      evidence: rows.map((row) => ({ evidenceId: row.evidence_id, verdict: row.verdict })),
    });
  }

  search(query: string, options: KnowledgeSearchOptions = {}): readonly KnowledgeSearchResult[] {
    this.#assertOpen();
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    assertSearchLimit(limit);
    const match = ftsQuery(query);
    const statusClause = options.includeInactive === true ? "" : "AND a.status IN (?, ?, ?)";
    const parameters: Array<string | number> = [match];
    if (options.includeInactive !== true) parameters.push(...DEFAULT_ELIGIBLE_STATUSES);
    parameters.push(limit);
    const rows = this.#database.prepare(`
      SELECT a.asset_id, a.current_version, a.tombstone, a.tombstone_reason, a.payload_json,
             a.payload_hash, a.content_hash, a.status, a.subject_key, a.kind, a.index_version,
             bm25(knowledge_fts, 10.0, 5.0, 4.0, 1.0, 6.0) AS fts_rank
      FROM knowledge_fts JOIN knowledge_assets a ON a.asset_id = knowledge_fts.asset_id
      WHERE knowledge_fts MATCH ? AND a.tombstone = 0 ${statusClause}
      ORDER BY fts_rank ASC, a.asset_id ASC LIMIT ?
    `).all(...parameters) as unknown as SearchRow[];
    return deepFreeze(rows.map((row, index) => ({
      asset: parseRow(row), rank: index + 1, score: -row.fts_rank, indexVersion: row.index_version,
    })));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
