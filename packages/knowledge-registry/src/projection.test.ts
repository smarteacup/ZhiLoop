import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeAsset } from "@zhiloop/domain";
import {
  calculateKnowledgeContentHash,
  MarkdownKnowledgeRepository,
  type StoredKnowledgeVersion,
} from "@zhiloop/markdown-repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KnowledgeProjectionConflictError,
  KnowledgeProjectionRebuildError,
  SqliteKnowledgeRegistryProjection,
} from "./index.js";

const at1 = "2026-08-02T01:00:00.000Z";
const at2 = "2026-08-02T02:00:00.000Z";

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  const draft: KnowledgeAsset = {
    schemaVersion: 1,
    id,
    subjectKey: id,
    kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-a" },
    version: 1,
    status: "IMPLEMENTED",
    title: "TitleBeacon registry projection",
    summary: "Searchable SQLite projection",
    body: "BodyBeacon describes the implementation.",
    aliases: ["AliasBeacon"],
    keywords: ["KeywordBeacon"],
    applicability: ["local knowledge"],
    nonApplicability: [],
    symbols: ["SymbolBeacon"],
    relations: [{ type: "IMPLEMENTS", targetId: "design.registry.target", targetVersion: 1, reason: "fixture" }],
    evidence: [{ evidenceId: "evidence-registry", verdict: "SUPPORTS" }],
    confidence: 0.9,
    sourceEpisodes: ["episode-registry"],
    contentHash: "",
    correlationId: "correlation-registry",
    createdAt: at1,
    updatedAt: at1,
    ...overrides,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

async function publish(
  repository: MarkdownKnowledgeRepository,
  value: KnowledgeAsset,
  expectedCurrentVersion = value.version - 1,
): Promise<StoredKnowledgeVersion> {
  return (await repository.publish(value, { expectedCurrentVersion })).value;
}

describe("SqliteKnowledgeRegistryProjection", () => {
  let temporaryRoot: string;
  let markdownRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-registry-projection-"));
    markdownRoot = path.join(temporaryRoot, "markdown");
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("projects title, aliases, keywords, body, and symbols into FTS5", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const record = await publish(markdown, asset("knowledge.registry.search"));
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    const result = projection.projectCurrent(record);

    expect(result).toMatchObject({ status: "PROJECTED", indexVersion: 1, assetVersion: 1 });
    for (const query of ["TitleBeacon", "AliasBeacon", "KeywordBeacon", "BodyBeacon", "SymbolBeacon"]) {
      expect(projection.search(query)).toMatchObject([{ rank: 1, asset: { id: record.asset.id }, indexVersion: 1 }]);
    }
    expect(projection.getAsset(record.asset.id)).toMatchObject({ asset: record.asset, tombstone: false, indexVersion: 1 });
    expect(projection.getRelations(record.asset.id, 1).relations).toEqual(record.asset.relations);
    expect(projection.getEvidence(record.asset.id, 1).evidence).toEqual(record.asset.evidence);
    expect(projection.listVersions(record.asset.id)).toHaveLength(1);
    projection.close();
  });

  it("is idempotent, requires sequential versions, and retains versioned relations and Evidence", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const first = await publish(markdown, asset("knowledge.registry.versions"));
    const secondAsset = asset(first.asset.id, {
      version: 2,
      title: "Second projected version",
      relations: [{ type: "SUPERSEDES", targetId: first.asset.id, targetVersion: 1 }],
      evidence: [{ evidenceId: "evidence-v2", verdict: "SUPPORTS" }],
      updatedAt: at2,
      correlationId: "correlation-v2",
    });
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    expect(projection.projectCurrent(first).indexVersion).toBe(1);
    expect(projection.projectCurrent(first)).toMatchObject({ status: "IDEMPOTENT", indexVersion: 1 });
    await expect(Promise.resolve().then(() => projection.projectCurrent({ ...first, asset: asset(first.asset.id, { version: 3, updatedAt: at2 }) })))
      .rejects.toThrow("immediately follow");
    const second = await publish(markdown, secondAsset, 1);
    expect(projection.projectCurrent(second)).toMatchObject({ status: "PROJECTED", indexVersion: 2 });
    expect(projection.listVersions(first.asset.id).map((item) => item.asset.version)).toEqual([1, 2]);
    expect(projection.getRelations(first.asset.id, 2).relations).toEqual(secondAsset.relations);
    expect(projection.getEvidence(first.asset.id, 2).evidence).toEqual(secondAsset.evidence);
  });

  it("filters inactive status by default while allowing explicit governance search", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const stale = await publish(markdown, asset("knowledge.registry.stale", { status: "STALE", title: "InactiveBeacon" }));
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    projection.projectCurrent(stale);
    expect(projection.search("InactiveBeacon")).toEqual([]);
    expect(projection.search("InactiveBeacon", { includeInactive: true })).toHaveLength(1);
  });

  it("removes tombstones from default get and FTS without losing history", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const first = await publish(markdown, asset("knowledge.registry.tombstone"));
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    projection.projectCurrent(first);
    const tombstone = (await markdown.tombstone(first.asset.id, {
      expectedCurrentVersion: 1,
      reason: "retired",
      updatedAt: at2,
      correlationId: "correlation-delete",
    })).value;
    projection.projectCurrent(tombstone);

    expect(projection.search("TitleBeacon")).toEqual([]);
    expect(projection.getAsset(first.asset.id)).toBeUndefined();
    expect(projection.getAsset(first.asset.id, true)).toMatchObject({ tombstone: true, tombstoneReason: "retired" });
    expect(projection.listVersions(first.asset.id).map((item) => item.tombstone)).toEqual([false, true]);
  });

  it("rebuilds a deleted projection completely from Markdown", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const first = await publish(markdown, asset("knowledge.registry.rebuild-a"));
    const second = await publish(markdown, asset("knowledge.registry.rebuild-b", {
      title: "RebuildBeacon",
      evidence: [{ evidenceId: "evidence-rebuild", verdict: "SUPPORTS" }],
    }));
    const databasePath = path.join(temporaryRoot, "projection.sqlite");
    let projection = new SqliteKnowledgeRegistryProjection(databasePath);
    projection.projectCurrent(first);
    projection.projectCurrent(second);
    const before = [projection.search("TitleBeacon")[0]?.asset.id, projection.search("RebuildBeacon")[0]?.asset.id];
    projection.close();
    await rm(databasePath, { force: true });

    projection = new SqliteKnowledgeRegistryProjection(databasePath);
    const sentinel = new DatabaseSync(databasePath);
    sentinel.exec("CREATE TABLE non_projection_sentinel(value TEXT); INSERT INTO non_projection_sentinel VALUES ('keep');");
    sentinel.close();
    const rebuilt = await projection.rebuildFromMarkdown(markdown);
    expect(rebuilt).toMatchObject({ indexVersion: 1, assets: 2, versions: 2, diagnostics: [] });
    expect([projection.search("TitleBeacon")[0]?.asset.id, projection.search("RebuildBeacon")[0]?.asset.id]).toEqual(before);
    expect(projection.getEvidence(second.asset.id, 1).evidence).toEqual(second.asset.evidence);
    projection.close();
    const checked = new DatabaseSync(databasePath);
    expect(checked.prepare("SELECT value FROM non_projection_sentinel").get()).toEqual({ value: "keep" });
    checked.close();
  });

  it("reports a new invalid Markdown directory without blocking valid assets", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const valid = await publish(markdown, asset("knowledge.registry.valid"));
    const invalidId = "knowledge.registry.never-valid";
    const invalidDirectory = path.join(markdownRoot, "assets", invalidId);
    await mkdir(invalidDirectory, { recursive: true });
    await writeFile(path.join(invalidDirectory, "current.md"), "---\nschema_version: 99\n---\ninvalid", "utf8");
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    const result = await projection.rebuildFromMarkdown(markdown);
    expect(result).toMatchObject({ assets: 1, versions: 1 });
    expect(result.diagnostics).toContainEqual({
      assetId: invalidId,
      code: "NO_VALID_VERSION",
      message: "asset has no committed Markdown version",
    });
    expect(projection.getAsset(valid.asset.id)?.asset.id).toBe(valid.asset.id);
  });

  it("falls back to immutable history for invalid or trust-modified current documents", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const invalid = await publish(markdown, asset("knowledge.registry.invalid-current"));
    const manual = await publish(markdown, asset("knowledge.registry.manual-current"));
    const invalidPath = invalid.documentPath;
    await writeFile(invalidPath, (await readFile(invalidPath, "utf8")).replace("schema_version: 1", "schema_version: 99"), "utf8");
    await writeFile(manual.documentPath, (await readFile(manual.documentPath, "utf8")).replace("status: IMPLEMENTED", "status: VERIFIED"), "utf8");
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    const result = await projection.rebuildFromMarkdown(markdown);

    expect(result.diagnostics).toHaveLength(2);
    expect(projection.getAsset(invalid.asset.id)?.asset.status).toBe("IMPLEMENTED");
    expect(projection.getAsset(manual.asset.id)?.asset.status).toBe("IMPLEMENTED");
  });

  it("preserves the active projection when Markdown history is broken before rebuild", async () => {
    const stableMarkdown = new MarkdownKnowledgeRepository(markdownRoot);
    const stable = await publish(stableMarkdown, asset("knowledge.registry.stable"));
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    projection.projectCurrent(stable);

    const broken = await publish(stableMarkdown, asset("knowledge.registry.broken"));
    const brokenV2 = await publish(stableMarkdown, asset(broken.asset.id, { version: 2, updatedAt: at2 }), 1);
    await rm(path.join(markdownRoot, "assets", broken.asset.id, "versions", "00000001.md"));
    expect(brokenV2.asset.version).toBe(2);
    await expect(projection.rebuildFromMarkdown(stableMarkdown)).rejects.toBeInstanceOf(KnowledgeProjectionRebuildError);
    expect(projection.activeIndexVersion).toBe(1);
    expect(projection.getAsset(stable.asset.id)?.asset.id).toBe(stable.asset.id);
  });

  it("rolls back all tables and indexVersion when activation fails", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const record = await publish(markdown, asset("knowledge.registry.rollback"));
    const projection = new SqliteKnowledgeRegistryProjection(":memory:", {
      faultInjector: () => { throw new Error("injected activation failure"); },
    });
    expect(() => projection.projectCurrent(record)).toThrow("injected activation failure");
    expect(projection.activeIndexVersion).toBe(0);
    expect(projection.getAsset(record.asset.id)).toBeUndefined();
    expect(projection.listVersions(record.asset.id)).toEqual([]);
  });

  it("rejects uncommitted records, non-v1 empty projection, and conflicting immutable content", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const first = await publish(markdown, asset("knowledge.registry.conflict"));
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    expect(() => projection.projectCurrent({ ...first, historyState: "MANUAL_EDIT" })).toThrow("only COMMITTED");
    expect(() => projection.projectCurrent({ ...first, documentPath: path.join(temporaryRoot, "wrong", "current.md") }))
      .toThrow("path does not match");
    expect(() => projection.projectCurrent({ ...first, tombstoneReason: "forged" })).toThrow("present together");
    expect(() => projection.projectCurrent({ ...first, asset: asset(first.asset.id, { version: 2, updatedAt: at2 }) }))
      .toThrow("empty projection must start");
    projection.projectCurrent(first);
    const raw = new DatabaseSync(path.join(temporaryRoot, "other.sqlite"));
    raw.close();
    const conflicting = { ...first, asset: asset(first.asset.id, { title: "Different same version" }) };
    expect(() => projection.projectCurrent(conflicting)).toThrow(KnowledgeProjectionConflictError);
  });

  it("validates search bounds, version bounds, close state, migration, and file permissions", async () => {
    const databasePath = path.join(temporaryRoot, "projection.sqlite");
    const projection = new SqliteKnowledgeRegistryProjection(databasePath);
    expect(() => projection.search(" ")).toThrow("query must contain");
    expect(() => projection.search("!!!")).toThrow("searchable");
    expect(() => projection.search("x", { limit: 0 })).toThrow("limit");
    expect(() => projection.getVersion("missing", 0)).toThrow("positive safe integer");
    expect(projection.getVersion("missing", 1)).toBeUndefined();
    if (process.platform !== "win32") expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    projection.close();
    projection.close();
    expect(() => projection.search("closed")).toThrow("closed");

    const futurePath = path.join(temporaryRoot, "future.sqlite");
    const raw = new DatabaseSync(futurePath);
    raw.exec("CREATE TABLE knowledge_projection_meta(component TEXT PRIMARY KEY, migration_version INTEGER NOT NULL, active_index_version INTEGER NOT NULL); INSERT INTO knowledge_projection_meta VALUES ('knowledge-registry', 99, 0);");
    raw.close();
    expect(() => new SqliteKnowledgeRegistryProjection(futurePath)).toThrow("newer than supported");
    await chmod(futurePath, 0o600);
  });

  it("keeps indexVersion monotonic across connections and detects payload tampering", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const first = await publish(markdown, asset("knowledge.registry.connection-a"));
    const second = await publish(markdown, asset("knowledge.registry.connection-b"));
    const databasePath = path.join(temporaryRoot, "shared.sqlite");
    const left = new SqliteKnowledgeRegistryProjection(databasePath);
    const right = new SqliteKnowledgeRegistryProjection(databasePath);
    expect(left.projectCurrent(first).indexVersion).toBe(1);
    expect(right.projectCurrent(second).indexVersion).toBe(2);
    expect(left.activeIndexVersion).toBe(2);
    left.close();
    right.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE knowledge_assets SET payload_json = ? WHERE asset_id = ?").run("{}", first.asset.id);
    raw.close();
    const reopened = new SqliteKnowledgeRegistryProjection(databasePath);
    expect(() => reopened.getAsset(first.asset.id)).toThrow("payload integrity");
    reopened.close();
  });

  it("does not let idempotency hide damaged FTS or relation rows", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const record = await publish(markdown, asset("knowledge.registry.derived-integrity"));
    const databasePath = path.join(temporaryRoot, "derived.sqlite");
    let projection = new SqliteKnowledgeRegistryProjection(databasePath);
    projection.projectCurrent(record);
    projection.close();

    let raw = new DatabaseSync(databasePath);
    raw.prepare("DELETE FROM knowledge_fts WHERE asset_id = ?").run(record.asset.id);
    raw.close();
    projection = new SqliteKnowledgeRegistryProjection(databasePath);
    expect(() => projection.projectCurrent(record)).toThrow("FTS row");
    projection.close();

    raw = new DatabaseSync(databasePath);
    raw.prepare("INSERT INTO knowledge_fts(asset_id, title, aliases, keywords, body, symbols) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.asset.id, record.asset.title, record.asset.aliases.join("\n"), record.asset.keywords.join("\n"), record.asset.body, record.asset.symbols.join("\n"));
    raw.prepare("DELETE FROM knowledge_relations WHERE asset_id = ?").run(record.asset.id);
    raw.close();
    projection = new SqliteKnowledgeRegistryProjection(databasePath);
    expect(() => projection.projectCurrent(record)).toThrow("derived edges");
    projection.close();
  });

  it("atomically replaces one contiguous asset history for the incremental indexer", async () => {
    const markdown = new MarkdownKnowledgeRepository(markdownRoot);
    const first = await publish(markdown, asset("knowledge.registry.replace-history"));
    const second = await publish(markdown, asset(first.asset.id, {
      version: 2, title: "Replacement history v2", updatedAt: at2, correlationId: "replace-v2",
    }), 1);
    const firstVersion = await markdown.readVersion(first.asset.id, 1);
    const secondVersion = await markdown.readVersion(first.asset.id, 2);
    if (!firstVersion.ok || !secondVersion.ok) throw new Error("fixture history missing");
    const projection = new SqliteKnowledgeRegistryProjection(":memory:");
    projection.projectCurrent(first);
    expect(() => projection.replaceAssetHistory([], second)).toThrow("must not be empty");
    expect(() => projection.replaceAssetHistory([secondVersion.value], second)).toThrow("contiguous");
    expect(() => projection.replaceAssetHistory([firstVersion.value, secondVersion.value], first)).toThrow("latest immutable");
    expect(projection.replaceAssetHistory([firstVersion.value, secondVersion.value], second))
      .toMatchObject({ status: "PROJECTED", indexVersion: 2, assetVersion: 2 });
    expect(projection.listVersions(first.asset.id).map((item) => item.asset.version)).toEqual([1, 2]);
    expect(projection.search("Replacement")[0]?.asset.version).toBe(2);
  });
});
