import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

import { buildFreshnessRecord } from "./freshness.js";
import type {
  AffectedKnowledgeResult,
  AffectedKnowledgeVersion,
  FrozenAffectedKnowledgePage,
  FrozenAffectedKnowledgeSnapshot,
  FreshnessProjectionInput,
  FreshnessProjectionWriteResult,
  KnowledgeFreshnessRecord,
  KnowledgeFreshnessState,
  FreshnessStateEvent,
  FreshnessStateTransitionInput,
  FreshnessStateTransitionResult,
} from "./types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const ALL_CURRENT_RECIPES_HASH = hash("all-current-recipes-v1");

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

interface AffectedSnapshotRow {
  readonly snapshot_id: string;
  readonly project_id: string;
  readonly source_ref: string;
  readonly change_set_hash: string;
  readonly recipe_selection_hash: string;
  readonly target_hash: string;
  readonly target_count: number;
  readonly created_at: string;
}

export class SqliteKnowledgeFreshnessStore {
  readonly #database: DatabaseSync;
  readonly #verifiedSnapshots = new Set<string>();
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
        CREATE TABLE IF NOT EXISTS knowledge_freshness_state (
          asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          status TEXT NOT NULL,
          revision INTEGER NOT NULL,
          code_revision TEXT NOT NULL,
          graph_revision TEXT,
          reason_codes_json TEXT NOT NULL,
          affected_assertion_ids_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(asset_id, asset_version),
          FOREIGN KEY(asset_id, asset_version)
            REFERENCES knowledge_freshness(asset_id, asset_version) ON DELETE CASCADE
        ) STRICT;
        CREATE TABLE IF NOT EXISTS knowledge_freshness_state_events (
          event_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL,
          previous_status TEXT NOT NULL,
          status TEXT NOT NULL,
          revision INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          code_revision TEXT NOT NULL,
          graph_revision TEXT,
          reason_codes_json TEXT NOT NULL,
          affected_assertion_ids_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(asset_id, asset_version)
            REFERENCES knowledge_freshness(asset_id, asset_version) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS freshness_state_events_asset
          ON knowledge_freshness_state_events(asset_id, asset_version, revision);
        CREATE TABLE IF NOT EXISTS knowledge_freshness_transition_effects(
          effect_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
          result_hash TEXT NOT NULL, asset_id TEXT NOT NULL, asset_version INTEGER NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS freshness_transition_effect_asset
          ON knowledge_freshness_transition_effects(asset_id, asset_version);
        CREATE TABLE IF NOT EXISTS knowledge_freshness_affected_snapshots(
          snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_ref TEXT NOT NULL,
          change_set_hash TEXT NOT NULL, recipe_selection_hash TEXT NOT NULL,
          target_hash TEXT NOT NULL, target_count INTEGER NOT NULL CHECK(target_count >= 0), created_at TEXT NOT NULL,
          UNIQUE(project_id, source_ref, change_set_hash, recipe_selection_hash)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS knowledge_freshness_affected_snapshot_items(
          snapshot_id TEXT NOT NULL REFERENCES knowledge_freshness_affected_snapshots(snapshot_id) ON DELETE RESTRICT,
          asset_id TEXT NOT NULL, asset_version INTEGER NOT NULL CHECK(asset_version > 0),
          PRIMARY KEY(snapshot_id, asset_id, asset_version),
          FOREIGN KEY(asset_id, asset_version) REFERENCES knowledge_freshness(asset_id, asset_version) ON DELETE RESTRICT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS freshness_affected_snapshot_page
          ON knowledge_freshness_affected_snapshot_items(snapshot_id, asset_id, asset_version);
        INSERT OR IGNORE INTO knowledge_freshness_state
          (asset_id,asset_version,project_id,status,revision,code_revision,graph_revision,reason_codes_json,
           affected_assertion_ids_json,updated_at)
          SELECT asset_id,asset_version,project_id,'FRESH',0,
            'publication:' || json_extract(payload_json,'$.assetContentHash'),NULL,'[]','[]',
            json_extract(payload_json,'$.updatedAt')
          FROM knowledge_freshness;
      `);
    } catch (error) { this.#database.close(); this.#closed = true; throw error; }
  }

  #open(): void { if (this.#closed) throw new Error("FRESHNESS_STORE_CLOSED"); }

  #initializeState(record: KnowledgeFreshnessRecord): void {
    this.#database.prepare(`INSERT OR IGNORE INTO knowledge_freshness_state
      (asset_id,asset_version,project_id,status,revision,code_revision,graph_revision,reason_codes_json,affected_assertion_ids_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      record.assetId, record.assetVersion, record.projectId, "FRESH", 0,
      `publication:${record.assetContentHash}`, null, "[]", "[]", record.updatedAt,
    );
  }

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
          this.#initializeState(record);
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
      this.#initializeState(record);
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
    if (row === undefined) return undefined;
    const projection = parse(row.payload_json, row.payload_hash);
    const state = this.getState(assetId, assetVersion);
    return state === undefined ? projection : deepFreeze({ ...projection, freshnessStatus: state.status,
      freshnessRevision: state.revision, codeRevision: state.codeRevision,
      ...(state.graphRevision === undefined ? {} : { graphRevision: state.graphRevision }), updatedAt: state.updatedAt });
  }

  getState(assetId: string, assetVersion?: number): KnowledgeFreshnessState | undefined {
    this.#open();
    if (!safeText(assetId) || (assetVersion !== undefined && (!Number.isSafeInteger(assetVersion) || assetVersion < 1))) {
      throw new Error("FRESHNESS_STATE_LOOKUP_INVALID");
    }
    const row = (assetVersion === undefined
      ? this.#database.prepare(`SELECT state.* FROM knowledge_freshness_active active JOIN knowledge_freshness_state state
          ON state.asset_id=active.asset_id AND state.asset_version=active.asset_version WHERE active.asset_id=?`).get(assetId)
      : this.#database.prepare("SELECT * FROM knowledge_freshness_state WHERE asset_id=? AND asset_version=?").get(assetId, assetVersion)) as
      Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#state(row);
  }

  #state(row: Record<string, unknown>): KnowledgeFreshnessState {
    const status = row["status"];
    const reasonCodes = JSON.parse(String(row["reason_codes_json"])) as unknown;
    const affectedAssertionIds = JSON.parse(String(row["affected_assertion_ids_json"])) as unknown;
    if (!new Set(["FRESH", "REVALIDATE", "CONFLICT", "UNKNOWN"]).has(status as string)
      || !safeText(String(row["asset_id"])) || !Number.isSafeInteger(Number(row["asset_version"]))
      || Number(row["asset_version"]) < 1 || !safeText(String(row["project_id"]))
      || !Number.isSafeInteger(Number(row["revision"])) || Number(row["revision"]) < 0
      || !safeText(String(row["code_revision"]), 4_096) || !Number.isFinite(Date.parse(String(row["updated_at"])))
      || (row["graph_revision"] !== null && row["graph_revision"] !== undefined
        && !safeText(String(row["graph_revision"]), 4_096))
      || !Array.isArray(reasonCodes) || !reasonCodes.every((item) => typeof item === "string")
      || !Array.isArray(affectedAssertionIds) || !affectedAssertionIds.every((item) => typeof item === "string")) {
      throw new Error("FRESHNESS_STATE_CORRUPT");
    }
    return deepFreeze({
      schemaVersion: 1,
      assetId: String(row["asset_id"]), assetVersion: Number(row["asset_version"]), projectId: String(row["project_id"]),
      status: status as KnowledgeFreshnessState["status"], revision: Number(row["revision"]),
      codeRevision: String(row["code_revision"]),
      ...(row["graph_revision"] === null || row["graph_revision"] === undefined ? {} : { graphRevision: String(row["graph_revision"]) }),
      reasonCodes, affectedAssertionIds, updatedAt: String(row["updated_at"]),
    });
  }

  transition(input: FreshnessStateTransitionInput): FreshnessStateTransitionResult {
    this.#open();
    const statuses = new Set(["FRESH", "REVALIDATE", "CONFLICT", "UNKNOWN"]);
    if (!safeText(input.assetId) || !safeText(input.projectId) || !safeText(input.codeRevision, 4_096)
      || (input.graphRevision !== undefined && !safeText(input.graphRevision, 4_096))
      || !Number.isSafeInteger(input.assetVersion) || input.assetVersion < 1
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !statuses.has(input.status)
      || !Number.isFinite(Date.parse(input.updatedAt)) || input.reasonCodes.length > 1_000 || input.affectedAssertionIds.length > 10_000
      || ![...input.reasonCodes, ...input.affectedAssertionIds].every((item) => safeText(item))) {
      throw new Error("FRESHNESS_STATE_TRANSITION_INVALID");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare("SELECT * FROM knowledge_freshness_state WHERE asset_id=? AND asset_version=?")
        .get(input.assetId, input.assetVersion) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error("FRESHNESS_STATE_NOT_FOUND");
      const current = this.#state(row);
      if (current.projectId !== input.projectId) throw new Error("FRESHNESS_STATE_PROJECT_CONFLICT");
      const same = current.status === input.status && current.codeRevision === input.codeRevision
        && current.graphRevision === input.graphRevision
        && canonical(current.reasonCodes) === canonical(input.reasonCodes)
        && canonical(current.affectedAssertionIds) === canonical(input.affectedAssertionIds);
      if (same) { this.#database.exec("COMMIT"); return { status: "IDEMPOTENT", state: current }; }
      if (current.revision !== input.expectedRevision) throw new Error("FRESHNESS_STATE_REVISION_CONFLICT");
      const next: KnowledgeFreshnessState = deepFreeze({
        schemaVersion: 1, assetId: input.assetId, assetVersion: input.assetVersion, projectId: input.projectId,
        status: input.status, revision: current.revision + 1, codeRevision: input.codeRevision,
        ...(input.graphRevision === undefined ? {} : { graphRevision: input.graphRevision }),
        reasonCodes: Object.freeze([...input.reasonCodes]), affectedAssertionIds: Object.freeze([...input.affectedAssertionIds]),
        updatedAt: input.updatedAt,
      });
      const update = this.#database.prepare(`UPDATE knowledge_freshness_state SET status=?,revision=?,code_revision=?,graph_revision=?,
        reason_codes_json=?,affected_assertion_ids_json=?,updated_at=? WHERE asset_id=? AND asset_version=? AND revision=?`).run(
        next.status, next.revision, next.codeRevision, next.graphRevision ?? null, canonical(next.reasonCodes),
        canonical(next.affectedAssertionIds), next.updatedAt, next.assetId, next.assetVersion, input.expectedRevision,
      );
      if (Number(update.changes) !== 1) throw new Error("FRESHNESS_STATE_REVISION_CONFLICT");
      const eventId = `freshness-${hash(canonical(next))}`;
      this.#database.prepare(`INSERT INTO knowledge_freshness_state_events
        (event_id,asset_id,asset_version,previous_status,status,revision,project_id,code_revision,graph_revision,
        reason_codes_json,affected_assertion_ids_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        eventId, next.assetId, next.assetVersion, current.status, next.status, next.revision, next.projectId,
        next.codeRevision, next.graphRevision ?? null, canonical(next.reasonCodes), canonical(next.affectedAssertionIds), next.updatedAt,
      );
      this.#database.exec("COMMIT");
      return { status: "TRANSITIONED", state: next };
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  transitionWithEffect(effectKey: string, input: FreshnessStateTransitionInput): FreshnessStateTransitionResult {
    this.#open();
    if (!/^[a-f0-9]{64}$/u.test(effectKey)) throw new Error("FRESHNESS_EFFECT_KEY_INVALID");
    const semanticInput = { ...input, expectedRevision: undefined };
    const inputHash = hash(canonical(semanticInput));
    const replay = (): FreshnessStateTransitionResult | undefined => {
      const row = this.#database.prepare("SELECT * FROM knowledge_freshness_transition_effects WHERE effect_key=?")
        .get(effectKey) as { readonly input_hash: string; readonly result_json: string; readonly result_hash: string } | undefined;
      if (row === undefined) return undefined;
      if (row.input_hash !== inputHash || hash(row.result_json) !== row.result_hash) throw new Error("FRESHNESS_EFFECT_CONFLICT");
      let result: FreshnessStateTransitionResult;
      try { result = JSON.parse(row.result_json) as FreshnessStateTransitionResult; }
      catch { throw new Error("FRESHNESS_EFFECT_CORRUPT"); }
      if (!new Set(["TRANSITIONED", "IDEMPOTENT"]).has(result.status)
        || result.state.assetId !== input.assetId || result.state.assetVersion !== input.assetVersion
        || result.state.projectId !== input.projectId || result.state.status !== input.status
        || result.state.codeRevision !== input.codeRevision || result.state.graphRevision !== input.graphRevision
        || canonical(result.state.reasonCodes) !== canonical(input.reasonCodes)
        || canonical(result.state.affectedAssertionIds) !== canonical(input.affectedAssertionIds)) {
        throw new Error("FRESHNESS_EFFECT_CORRUPT");
      }
      return deepFreeze(result);
    };
    const existing = replay();
    if (existing !== undefined) return existing;
    let result: FreshnessStateTransitionResult;
    try { result = this.transition(input); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "FRESHNESS_STATE_REVISION_CONFLICT") throw error;
      const rows = this.#database.prepare(`SELECT * FROM knowledge_freshness_state_events
        WHERE asset_id=? AND asset_version=? AND project_id=? AND status=? AND code_revision=?
          AND COALESCE(graph_revision,'')=COALESCE(?,'') AND reason_codes_json=? AND affected_assertion_ids_json=?
        ORDER BY revision LIMIT 2`).all(input.assetId, input.assetVersion, input.projectId, input.status,
          input.codeRevision, input.graphRevision ?? null, canonical(input.reasonCodes), canonical(input.affectedAssertionIds)) as unknown as Record<string, unknown>[];
      if (rows.length !== 1) throw error;
      result = Object.freeze({ status: "IDEMPOTENT", state: this.#state(rows[0]!) });
    }
    const resultJson = canonical(result);
    this.#database.prepare(`INSERT OR IGNORE INTO knowledge_freshness_transition_effects
      (effect_key,input_hash,result_json,result_hash,asset_id,asset_version,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(effectKey, inputHash, resultJson, hash(resultJson), input.assetId, input.assetVersion, input.updatedAt);
    const stored = replay();
    if (stored === undefined) throw new Error("FRESHNESS_EFFECT_WRITE_FAILED");
    return stored;
  }

  listStateEvents(assetId: string, assetVersion: number, limit = 100): readonly FreshnessStateEvent[] {
    this.#open();
    if (!safeText(assetId) || !Number.isSafeInteger(assetVersion) || assetVersion < 1
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("FRESHNESS_STATE_EVENT_QUERY_INVALID");
    const rows = this.#database.prepare(`SELECT * FROM knowledge_freshness_state_events
      WHERE asset_id=? AND asset_version=? ORDER BY revision DESC LIMIT ?`).all(assetId, assetVersion, limit) as unknown as Record<string, unknown>[];
    return Object.freeze(rows.map((row) => {
      const previousStatus = String(row["previous_status"]);
      if (!new Set(["FRESH", "REVALIDATE", "CONFLICT", "UNKNOWN"]).has(previousStatus)) {
        throw new Error("FRESHNESS_STATE_EVENT_CORRUPT");
      }
      return Object.freeze({
        ...this.#state(row), eventId: String(row["event_id"]), previousStatus: previousStatus as FreshnessStateEvent["previousStatus"],
      });
    }));
  }

  #affectedVersions(changes: KnowledgeChangeSet, maximum: number): AffectedKnowledgeResult {
    if (!safeText(changes.projectId) || !safeText(changes.sourceRef, 4_096) || !Number.isFinite(Date.parse(changes.observedAt))
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
    if (keys.length > 1_000_000) throw new Error("FRESHNESS_CHANGESET_LIMIT_EXCEEDED");
    const found = new Map<string, AffectedKnowledgeVersion>();
    for (const item of keys) {
      const rows = item.path !== undefined
        ? this.#database.prepare(`SELECT anchor.asset_id,anchor.asset_version FROM knowledge_freshness_anchors anchor
            JOIN knowledge_freshness_active active ON active.asset_id=anchor.asset_id AND active.asset_version=anchor.asset_version
            LEFT JOIN knowledge_freshness_state state
              ON state.asset_id=anchor.asset_id AND state.asset_version=anchor.asset_version
            WHERE anchor.project_id=? AND (anchor.anchor_path=? OR (anchor.kind='PATH' AND anchor.anchor_key=?))
              AND (state.code_revision IS NULL OR state.code_revision<>?)
            ORDER BY anchor.asset_id,anchor.asset_version LIMIT ?`)
          .all(changes.projectId, item.path, item.path, changes.sourceRef, maximum + 1)
        : this.#database.prepare(`SELECT anchor.asset_id,anchor.asset_version FROM knowledge_freshness_anchors anchor
            JOIN knowledge_freshness_active active ON active.asset_id=anchor.asset_id AND active.asset_version=anchor.asset_version
            LEFT JOIN knowledge_freshness_state state
              ON state.asset_id=anchor.asset_id AND state.asset_version=anchor.asset_version
            WHERE anchor.project_id=? AND anchor.kind=? AND anchor.anchor_key=?
              AND (state.code_revision IS NULL OR state.code_revision<>?)
            ORDER BY anchor.asset_id,anchor.asset_version LIMIT ?`)
          .all(changes.projectId, item.kind ?? "", item.key ?? "", changes.sourceRef, maximum + 1);
      for (const row of rows as unknown as Array<{ asset_id: string; asset_version: number }>) {
        found.set(`${row.asset_id}\0${row.asset_version}`, { assetId: row.asset_id, assetVersion: row.asset_version });
      }
      if (found.size > maximum) break;
    }
    const sorted = [...found.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)
      || left.assetVersion - right.assetVersion);
    return Object.freeze({ items: Object.freeze(sorted.slice(0, maximum)), bounded: sorted.length > maximum });
  }

  freezeAffectedSnapshot(input: {
    readonly changes: KnowledgeChangeSet;
    readonly changeSetHash: string;
    readonly recipeSelectionHash: string;
    readonly maxTargets?: number;
  }): FrozenAffectedKnowledgeSnapshot {
    this.#open();
    const maximum = input.maxTargets ?? 100_000;
    if (!/^[a-f0-9]{64}$/u.test(input.changeSetHash) || !/^[a-f0-9]{64}$/u.test(input.recipeSelectionHash)
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) {
      throw new Error("FRESHNESS_AFFECTED_SNAPSHOT_INPUT_INVALID");
    }
    const identity = canonical(["freshness-affected-v1", input.changes.projectId, input.changes.sourceRef,
      input.changeSetHash, input.recipeSelectionHash]);
    const snapshotId = `affected_${hash(identity)}`;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT * FROM knowledge_freshness_affected_snapshots WHERE snapshot_id=?")
        .get(snapshotId) as unknown as AffectedSnapshotRow | undefined;
      if (existing !== undefined) {
        const replay = this.getAffectedSnapshot(snapshotId)!;
        this.#database.exec("COMMIT");
        return replay;
      }
      const affected = input.recipeSelectionHash === ALL_CURRENT_RECIPES_HASH
        ? this.#allCurrentCodeVersions(input.changes.projectId, input.changes.sourceRef, maximum)
        : this.#affectedVersions(input.changes, maximum);
      if (affected.bounded) throw new Error("FRESHNESS_AFFECTED_SNAPSHOT_LIMIT_EXCEEDED");
      const targetHash = hash(canonical(affected.items));
      this.#database.prepare(`INSERT INTO knowledge_freshness_affected_snapshots
        (snapshot_id,project_id,source_ref,change_set_hash,recipe_selection_hash,target_hash,target_count,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(snapshotId, input.changes.projectId, input.changes.sourceRef, input.changeSetHash,
          input.recipeSelectionHash, targetHash, affected.items.length, input.changes.observedAt);
      const insert = this.#database.prepare("INSERT INTO knowledge_freshness_affected_snapshot_items VALUES (?,?,?)");
      for (const item of affected.items) insert.run(snapshotId, item.assetId, item.assetVersion);
      this.#database.exec("COMMIT");
      this.#verifiedSnapshots.add(snapshotId);
      return Object.freeze({ schemaVersion: 1, snapshotId, projectId: input.changes.projectId,
        sourceRef: input.changes.sourceRef, changeSetHash: input.changeSetHash,
        recipeSelectionHash: input.recipeSelectionHash, targetHash, targetCount: affected.items.length,
        createdAt: input.changes.observedAt });
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  #allCurrentCodeVersions(projectId: string, sourceRef: string, maximum: number): AffectedKnowledgeResult {
    const rows = this.#database.prepare(`SELECT active.asset_id,active.asset_version
      FROM knowledge_freshness_active active
      JOIN knowledge_freshness projection
        ON projection.asset_id=active.asset_id AND projection.asset_version=active.asset_version
      LEFT JOIN knowledge_freshness_state state
        ON state.asset_id=active.asset_id AND state.asset_version=active.asset_version
      WHERE active.project_id=? AND (state.code_revision IS NULL OR state.code_revision<>?)
        AND (json_extract(projection.payload_json,'$.candidate.kind')='IMPLEMENTATION'
          OR EXISTS (SELECT 1 FROM knowledge_freshness_anchors anchor
            WHERE anchor.asset_id=active.asset_id AND anchor.asset_version=active.asset_version AND anchor.kind='SYMBOL'))
      ORDER BY active.asset_id,active.asset_version LIMIT ?`).all(projectId, sourceRef, maximum + 1) as unknown as
      Array<{ readonly asset_id: string; readonly asset_version: number }>;
    return Object.freeze({ items: Object.freeze(rows.slice(0, maximum)
      .map((row) => Object.freeze({ assetId: row.asset_id, assetVersion: row.asset_version }))), bounded: rows.length > maximum });
  }

  getAffectedSnapshot(snapshotId: string): FrozenAffectedKnowledgeSnapshot | undefined {
    this.#open();
    if (!/^affected_[a-f0-9]{64}$/u.test(snapshotId)) throw new Error("FRESHNESS_AFFECTED_SNAPSHOT_ID_INVALID");
    const row = this.#database.prepare("SELECT * FROM knowledge_freshness_affected_snapshots WHERE snapshot_id=?")
      .get(snapshotId) as unknown as AffectedSnapshotRow | undefined;
    if (row === undefined) return undefined;
    if (!safeText(row.project_id) || !safeText(row.source_ref, 4_096) || !/^[a-f0-9]{64}$/u.test(row.change_set_hash)
      || !/^[a-f0-9]{64}$/u.test(row.recipe_selection_hash) || !/^[a-f0-9]{64}$/u.test(row.target_hash)
      || !Number.isSafeInteger(row.target_count) || row.target_count < 0 || row.target_count > 100_000
      || !Number.isFinite(Date.parse(row.created_at))) {
      throw new Error("FRESHNESS_AFFECTED_SNAPSHOT_CORRUPT");
    }
    if (!this.#verifiedSnapshots.has(snapshotId)) {
      const items = this.#database.prepare(`SELECT asset_id,asset_version FROM knowledge_freshness_affected_snapshot_items
        WHERE snapshot_id=? ORDER BY asset_id,asset_version`).all(snapshotId) as unknown as Array<{ asset_id: string; asset_version: number }>;
      const targets = items.map((item) => ({ assetId: item.asset_id, assetVersion: item.asset_version }));
      if (targets.length !== row.target_count || hash(canonical(targets)) !== row.target_hash) {
        throw new Error("FRESHNESS_AFFECTED_SNAPSHOT_CORRUPT");
      }
      this.#verifiedSnapshots.add(snapshotId);
    }
    return Object.freeze({ schemaVersion: 1, snapshotId: row.snapshot_id, projectId: row.project_id,
      sourceRef: row.source_ref, changeSetHash: row.change_set_hash, recipeSelectionHash: row.recipe_selection_hash,
      targetHash: row.target_hash, targetCount: row.target_count, createdAt: row.created_at });
  }

  readAffectedSnapshotPage(request: {
    readonly snapshotId: string;
    readonly limit: number;
    readonly after?: AffectedKnowledgeVersion;
  }): FrozenAffectedKnowledgePage {
    this.#open();
    const snapshot = this.getAffectedSnapshot(request.snapshotId);
    if (snapshot === undefined) throw new Error("FRESHNESS_AFFECTED_SNAPSHOT_NOT_FOUND");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000
      || (request.after !== undefined && (!safeText(request.after.assetId)
        || !Number.isSafeInteger(request.after.assetVersion) || request.after.assetVersion < 1))) {
      throw new Error("FRESHNESS_AFFECTED_PAGE_INPUT_INVALID");
    }
    const afterId = request.after?.assetId ?? "";
    const afterVersion = request.after?.assetVersion ?? 0;
    const rows = this.#database.prepare(`SELECT asset_id,asset_version FROM knowledge_freshness_affected_snapshot_items
      WHERE snapshot_id=? AND (asset_id>? OR (asset_id=? AND asset_version>?))
      ORDER BY asset_id,asset_version LIMIT ?`).all(request.snapshotId, afterId, afterId, afterVersion, request.limit + 1) as unknown as
      Array<{ asset_id: string; asset_version: number }>;
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map((item) => Object.freeze({ assetId: item.asset_id, assetVersion: item.asset_version }));
    const last = items.at(-1);
    return Object.freeze({ snapshot, items: Object.freeze(items),
      ...(hasMore && last !== undefined ? { nextCursor: last } : {}) });
  }

  affected(changes: KnowledgeChangeSet, limit = 500): AffectedKnowledgeResult {
    this.#open();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("FRESHNESS_AFFECTED_LIMIT_INVALID");
    const totalKeys = changes.changedPaths.length + changes.changedSymbols.length + changes.changedConfigs.length + changes.changedDependencies.length;
    if (totalKeys > 10_000) throw new Error("FRESHNESS_CHANGESET_LIMIT_EXCEEDED");
    return this.#affectedVersions(changes, limit);
  }

  close(): void { if (!this.#closed) { this.#database.close(); this.#closed = true; } }
  [Symbol.dispose](): void { this.close(); }
}
