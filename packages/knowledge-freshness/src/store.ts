import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

import { buildFreshnessRecord } from "./freshness.js";
import type {
  AffectedKnowledgeResult,
  FreshnessProjectionInput,
  FreshnessProjectionWriteResult,
  KnowledgeFreshnessRecord,
} from "./types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function safeText(value: string, maximum = 1_000): boolean {
  return value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function safePath(value: string): boolean {
  return safeText(value, 4_096) && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parse(payload: string, payloadHash: string): KnowledgeFreshnessRecord {
  if (hash(payload) !== payloadHash) throw new Error("FRESHNESS_PROJECTION_INTEGRITY_FAILED");
  const value = JSON.parse(payload) as KnowledgeFreshnessRecord;
  if (value.schemaVersion !== 1 || value.assetId.trim().length === 0 || value.assetVersion < 1
    || value.anchors.length > 10_000 || value.fingerprint.candidateId !== value.candidate.candidateId) {
    throw new Error("FRESHNESS_PROJECTION_CORRUPT");
  }
  return deepFreeze(value);
}

export class SqliteKnowledgeFreshnessStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    const resolved = filename === ":memory:" ? filename : path.resolve(filename);
    if (filename !== ":memory:") mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(resolved, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_freshness (
          asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          PRIMARY KEY(asset_id, asset_version)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS knowledge_freshness_active (
          asset_id TEXT PRIMARY KEY,
          asset_version INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          FOREIGN KEY(asset_id, asset_version)
            REFERENCES knowledge_freshness(asset_id, asset_version)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS knowledge_freshness_anchors (
          asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          anchor_key TEXT NOT NULL,
          anchor_path TEXT,
          assertion_id TEXT NOT NULL,
          PRIMARY KEY(asset_id, asset_version, kind, anchor_key, assertion_id),
          FOREIGN KEY(asset_id, asset_version)
            REFERENCES knowledge_freshness(asset_id, asset_version) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS freshness_anchor_lookup
          ON knowledge_freshness_anchors(project_id, kind, anchor_key, asset_id);
        CREATE INDEX IF NOT EXISTS freshness_anchor_path_lookup
          ON knowledge_freshness_anchors(project_id, anchor_path, asset_id);
      `);
    } catch (error) { this.#database.close(); this.#closed = true; throw error; }
  }

  #open(): void { if (this.#closed) throw new Error("FRESHNESS_STORE_CLOSED"); }

  project(input: FreshnessProjectionInput): FreshnessProjectionWriteResult {
    this.#open();
    const record = buildFreshnessRecord(input);
    const payload = canonical(record);
    const payloadHash = hash(payload);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(`SELECT active.asset_version, projection.payload_hash
        FROM knowledge_freshness_active active JOIN knowledge_freshness projection
          ON projection.asset_id=active.asset_id AND projection.asset_version=active.asset_version
        WHERE active.asset_id=?`).get(record.assetId) as { asset_version: number; payload_hash: string } | undefined;
      if (existing !== undefined) {
        if (existing.asset_version === record.assetVersion && existing.payload_hash === payloadHash) {
          this.#database.exec("COMMIT");
          return { status: "IDEMPOTENT", assetId: record.assetId, assetVersion: record.assetVersion, anchorCount: record.anchors.length };
        }
        if (record.assetVersion !== existing.asset_version + 1) throw new Error("FRESHNESS_PROJECTION_VERSION_CONFLICT");
      } else if (record.assetVersion !== 1) throw new Error("FRESHNESS_PROJECTION_VERSION_CONFLICT");
      this.#database.prepare(`INSERT INTO knowledge_freshness(asset_id,asset_version,project_id,payload_json,payload_hash)
        VALUES(?,?,?,?,?)`)
        .run(record.assetId, record.assetVersion, record.projectId, payload, payloadHash);
      const insert = this.#database.prepare(`INSERT INTO knowledge_freshness_anchors
        (asset_id,asset_version,project_id,kind,anchor_key,anchor_path,assertion_id) VALUES(?,?,?,?,?,?,?)`);
      for (const anchor of record.anchors) insert.run(
        record.assetId, record.assetVersion, record.projectId, anchor.kind, anchor.key, anchor.path ?? null, anchor.assertionId,
      );
      this.#database.prepare(`INSERT INTO knowledge_freshness_active(asset_id,asset_version,project_id) VALUES(?,?,?)
        ON CONFLICT(asset_id) DO UPDATE SET asset_version=excluded.asset_version,project_id=excluded.project_id`)
        .run(record.assetId, record.assetVersion, record.projectId);
      this.#database.exec("COMMIT");
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
    return { status: "PROJECTED", assetId: record.assetId, assetVersion: record.assetVersion, anchorCount: record.anchors.length };
  }

  get(assetId: string, assetVersion?: number): KnowledgeFreshnessRecord | undefined {
    this.#open();
    if (assetVersion !== undefined && (!Number.isSafeInteger(assetVersion) || assetVersion < 1)) {
      throw new Error("FRESHNESS_ASSET_VERSION_INVALID");
    }
    const row = (assetVersion === undefined
      ? this.#database.prepare(`SELECT projection.payload_json,projection.payload_hash
          FROM knowledge_freshness_active active JOIN knowledge_freshness projection
            ON projection.asset_id=active.asset_id AND projection.asset_version=active.asset_version
          WHERE active.asset_id=?`).get(assetId)
      : this.#database.prepare(`SELECT payload_json,payload_hash FROM knowledge_freshness
          WHERE asset_id=? AND asset_version=?`).get(assetId, assetVersion)) as
      { payload_json: string; payload_hash: string } | undefined;
    return row === undefined ? undefined : parse(row.payload_json, row.payload_hash);
  }

  affected(changes: KnowledgeChangeSet, limit = 500): AffectedKnowledgeResult {
    this.#open();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("FRESHNESS_AFFECTED_LIMIT_INVALID");
    if (!safeText(changes.projectId) || !safeText(changes.sourceRef) || !Number.isFinite(Date.parse(changes.observedAt))
      || !changes.changedPaths.every(safePath)
      || ![...changes.changedSymbols, ...changes.changedConfigs, ...changes.changedDependencies].every((item) => safeText(item))) {
      throw new Error("FRESHNESS_CHANGESET_INVALID");
    }
    const keys: Array<{ kind?: string; key?: string; path?: string }> = [
      ...changes.changedPaths.map((item) => ({ path: item })),
      ...changes.changedSymbols.map((key) => ({ kind: "SYMBOL", key })),
      ...changes.changedConfigs.map((key) => ({ kind: "CONFIG", key })),
      ...changes.changedDependencies.map((key) => ({ kind: "DEPENDENCY", key })),
    ];
    if (keys.length > 10_000) throw new Error("FRESHNESS_CHANGESET_LIMIT_EXCEEDED");
    const found = new Map<string, { assetId: string; assetVersion: number }>();
    for (const item of keys) {
      const rows = item.path !== undefined
        ? this.#database.prepare(`SELECT anchor.asset_id,anchor.asset_version FROM knowledge_freshness_anchors anchor
            JOIN knowledge_freshness_active active ON active.asset_id=anchor.asset_id AND active.asset_version=anchor.asset_version
            WHERE anchor.project_id=? AND (anchor.anchor_path=? OR (anchor.kind='PATH' AND anchor.anchor_key=?))
            ORDER BY anchor.asset_id LIMIT ?`)
          .all(changes.projectId, item.path, item.path, limit + 1)
        : this.#database.prepare(`SELECT anchor.asset_id,anchor.asset_version FROM knowledge_freshness_anchors anchor
            JOIN knowledge_freshness_active active ON active.asset_id=anchor.asset_id AND active.asset_version=anchor.asset_version
            WHERE anchor.project_id=? AND anchor.kind=? AND anchor.anchor_key=? ORDER BY anchor.asset_id LIMIT ?`)
          .all(changes.projectId, item.kind ?? "", item.key ?? "", limit + 1);
      for (const row of rows as unknown as Array<{ asset_id: string; asset_version: number }>) {
        found.set(row.asset_id, { assetId: row.asset_id, assetVersion: row.asset_version });
      }
      if (found.size > limit) break;
    }
    const items = [...found.values()].sort((a, b) => a.assetId.localeCompare(b.assetId)).slice(0, limit);
    return Object.freeze({ items, bounded: found.size > limit });
  }

  close(): void { if (!this.#closed) { this.#database.close(); this.#closed = true; } }
  [Symbol.dispose](): void { this.close(); }
}
