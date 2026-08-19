import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { deriveScenarioId, type KnowledgeAsset, type KnowledgeLocator } from "@zhiloop/domain";

import { migrationCanonical, migrationHash } from "./identity.js";

export interface LegacyLocalizationDraft {
  readonly schemaVersion: 1;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly assetContentHash: string;
  readonly state: "DRAFT";
  readonly locator: KnowledgeLocator;
  readonly reasonCodes: readonly ["LEGACY_REVISION_UNKNOWN", "MANUAL_REVALIDATION_REQUIRED"];
}

export interface LegacyLocalizationRebuildResult {
  readonly rebuildId: string;
  readonly projected: number;
  readonly skipped: number;
}

function scenarioKey(asset: KnowledgeAsset): string {
  const normalized = asset.subjectKey.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9.-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-|-$/gu, "");
  return normalized.includes(".") ? normalized : `legacy.${normalized || "knowledge"}`;
}

export function deriveLegacyLocalizationDraft(asset: KnowledgeAsset): LegacyLocalizationDraft | undefined {
  if (asset.schemaVersion !== 1 || !("projectId" in asset.scope) || asset.scope.projectId === undefined) return undefined;
  const key = scenarioKey(asset);
  const locator: KnowledgeLocator = {
    schemaVersion: 1,
    projectId: asset.scope.projectId,
    ...("repositoryRemote" in asset.scope && asset.scope.repositoryRemote !== undefined
      ? { repositoryRemote: asset.scope.repositoryRemote } : {}),
    observedRevision: { dirty: false },
    branchApplicability: { mode: "ALL_BRANCHES", reason: "LEGACY_REVISION_UNKNOWN" },
    scenarioId: deriveScenarioId(asset.scope.projectId, key),
    scenarioKey: key,
    scenarioTitle: asset.title,
    scenarioSummary: asset.summary,
    modulePaths: asset.scope.level === "MODULE" ? asset.scope.modulePaths : [],
    symbols: [...new Set([...asset.symbols, ...(asset.scope.level === "SYMBOL" ? asset.scope.symbols : [])])].sort(),
    entryPoints: [],
    taskIntents: [...new Set([asset.title, ...asset.keywords])].slice(0, 100),
    applicability: asset.applicability,
    nonApplicability: asset.nonApplicability,
  };
  return Object.freeze({ schemaVersion: 1, assetId: asset.id, assetVersion: asset.version,
    assetContentHash: asset.contentHash, state: "DRAFT", locator: Object.freeze(locator),
    reasonCodes: Object.freeze(["LEGACY_REVISION_UNKNOWN", "MANUAL_REVALIDATION_REQUIRED"] as const) });
}

export class SqliteLegacyLocalizationProjection {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    const target = filename === ":memory:" ? filename : resolve(filename);
    if (filename !== ":memory:") mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(target);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(target, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode=WAL;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS legacy_localization_rebuilds (
          rebuild_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          source_revision INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS legacy_localization_drafts (
          rebuild_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          PRIMARY KEY(rebuild_id, asset_id, asset_version),
          FOREIGN KEY(rebuild_id) REFERENCES legacy_localization_rebuilds(rebuild_id) ON DELETE CASCADE
        );
      `);
    } catch (error) {
      this.#database.close(); this.#closed = true; throw error;
    }
  }

  rebuild(input: { readonly projectId: string; readonly sourceRevision: number;
    readonly assets: readonly KnowledgeAsset[]; readonly createdAt: string }): LegacyLocalizationRebuildResult {
    if (this.#closed) throw new Error("LEGACY_LOCALIZATION_PROJECTION_CLOSED");
    if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0
      || !Number.isFinite(Date.parse(input.createdAt)) || input.assets.length > 100_000) {
      throw new Error("LEGACY_LOCALIZATION_REBUILD_INVALID");
    }
    const drafts = input.assets.map(deriveLegacyLocalizationDraft).filter((item): item is LegacyLocalizationDraft =>
      item !== undefined && item.locator.projectId === input.projectId);
    const rebuildId = `legacy-localization-${migrationHash([input.projectId, input.sourceRevision,
      drafts.map((item) => [item.assetId, item.assetVersion, item.assetContentHash])]).slice(0, 40)}`;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT rebuild_id FROM legacy_localization_rebuilds WHERE rebuild_id=?")
        .get(rebuildId);
      if (existing === undefined) {
        this.#database.prepare("INSERT INTO legacy_localization_rebuilds(rebuild_id, project_id, source_revision, created_at) VALUES (?, ?, ?, ?)")
          .run(rebuildId, input.projectId, input.sourceRevision, input.createdAt);
        const insert = this.#database.prepare(`INSERT INTO legacy_localization_drafts
          (rebuild_id, asset_id, asset_version, payload_json, payload_hash) VALUES (?, ?, ?, ?, ?)`);
        for (const draft of drafts.sort((left, right) => left.assetId.localeCompare(right.assetId) || left.assetVersion - right.assetVersion)) {
          const payload = migrationCanonical(draft);
          insert.run(rebuildId, draft.assetId, draft.assetVersion, payload, migrationHash(payload));
        }
      }
      this.#database.exec("COMMIT");
      return Object.freeze({ rebuildId, projected: drafts.length, skipped: input.assets.length - drafts.length });
    } catch (error) {
      this.#database.exec("ROLLBACK"); throw error;
    }
  }

  list(rebuildId: string): readonly LegacyLocalizationDraft[] {
    if (this.#closed) throw new Error("LEGACY_LOCALIZATION_PROJECTION_CLOSED");
    const rows = this.#database.prepare(`SELECT payload_json, payload_hash FROM legacy_localization_drafts
      WHERE rebuild_id=? ORDER BY asset_id, asset_version LIMIT 100000`).all(rebuildId) as Array<{ payload_json: string; payload_hash: string }>;
    return Object.freeze(rows.map((row) => {
      if (migrationHash(row.payload_json) !== row.payload_hash) throw new Error("LEGACY_LOCALIZATION_PROJECTION_CORRUPT");
      return Object.freeze(JSON.parse(row.payload_json) as LegacyLocalizationDraft);
    }));
  }

  rollback(rebuildId: string): number {
    if (this.#closed) throw new Error("LEGACY_LOCALIZATION_PROJECTION_CLOSED");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare("DELETE FROM legacy_localization_rebuilds WHERE rebuild_id=?").run(rebuildId);
      this.#database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.#database.exec("ROLLBACK"); throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close(); this.#closed = true;
  }

  [Symbol.dispose](): void { this.close(); }
}
