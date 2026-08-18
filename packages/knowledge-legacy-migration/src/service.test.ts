import { describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset } from "@zhiloop/knowledge-registry";
import { KnowledgeVerificationConflictError } from "@zhiloop/knowledge-verification";

import { LegacyKnowledgeMigrationRollbackService, LegacyKnowledgeMigrationService } from "./service.js";
import { SqliteLegacyKnowledgeMigrationStore } from "./store.js";

const at = "2026-08-19T00:00:00.000Z";
function projected(id: string, symbols: readonly string[] = ["LegacyWorker"]): ProjectedKnowledgeAsset {
  const asset: KnowledgeAsset = { schemaVersion: 1, id, subjectKey: `legacy.${id}`, kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "VERIFIED", title: id, summary: "summary",
    body: "body", aliases: [], keywords: [], applicability: [], nonApplicability: [], symbols, relations: [], evidence: [],
    confidence: 1, sourceEpisodes: ["episode-1"], contentHash: id === "asset-1" ? "a".repeat(64) : "b".repeat(64),
    correlationId: `correlation-${id}`, createdAt: at, updatedAt: at };
  return { asset, tombstone: false, indexVersion: id === "asset-1" ? 1 : 2 };
}

describe("LegacyKnowledgeMigrationService", () => {
  it("creates a bounded side-effect-free preview and resolves its exact source", () => {
    const assets = [projected("asset-1"), projected("asset-2", [])];
    let recipeReads = 0; let freshnessReads = 0; let revision = 2;
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    const service = new LegacyKnowledgeMigrationService({ store,
      registry: { get activeIndexVersion() { return revision; },
        listAssets: (options = {}) => { const { limit = 100, offset = 0 } = options; return assets.slice(offset, offset + limit); },
        getAsset: (id) => assets.find((item) => item.asset.id === id) },
      recipes: { getRecipe: () => { recipeReads += 1; return undefined; } },
      freshness: { get: () => { freshnessReads += 1; return undefined; } } });
    const preview = service.dryRun({ projectId: "project-1", createdAt: at, pageSize: 1 });
    expect(preview).toMatchObject({ status: "READY", scannedCount: 2, migratableCount: 1, skippedCount: 1 });
    expect(recipeReads).toBe(2); expect(freshnessReads).toBe(2);
    expect(service.resolve(preview.migrationId, 0)?.candidate.body).toBe("body");
    expect(store.items({ migrationId: preview.migrationId, limit: 10 }).items.map((item) => item.reasonCodes))
      .toEqual([["EXPLICIT_SYMBOL_ANCHOR_TRANSLATED"], ["RECIPE_MISSING"]]);
    revision = 3;
  });

  it("fails dry-run on revision drift and target resolution on concurrent version drift", () => {
    const value = projected("asset-1"); let reads = 0;
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    const registry = { get activeIndexVersion() { reads += 1; return reads === 1 ? 1 : 2; },
      listAssets: () => [value], getAsset: () => value };
    const service = new LegacyKnowledgeMigrationService({ store, registry, recipes: { getRecipe: () => undefined },
      freshness: { get: () => undefined } });
    expect(() => service.dryRun({ projectId: "project-1", createdAt: at })).toThrow("LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT");
    const stableRegistry = { activeIndexVersion: 1, listAssets: () => [value], getAsset: () => ({ ...value, indexVersion: 2 }) };
    const stable = new LegacyKnowledgeMigrationService({ store, registry: stableRegistry, recipes: { getRecipe: () => undefined },
      freshness: { get: () => undefined } });
    const preview = stable.dryRun({ projectId: "project-1", createdAt: at });
    expect(() => stable.resolve(preview.migrationId, 0)).toThrow("LEGACY_MIGRATION_TARGET_DRIFT");
  });

  it("rejects a concurrent Freshness projection but accepts its own crash-replay owner", () => {
    const value = projected("asset-1"); const current: { freshness?: unknown } = {};
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    const registry = { activeIndexVersion: 1, listAssets: () => [value], getAsset: () => value };
    const foreign = new LegacyKnowledgeMigrationService({ store, registry, recipes: { getRecipe: () => undefined },
      freshness: { get: () => current.freshness as never, getMigrationProjectionOwner: () => undefined } });
    const preview = foreign.dryRun({ projectId: "project-1", createdAt: at });
    current.freshness = {};
    expect(() => foreign.resolve(preview.migrationId, 0)).toThrow("LEGACY_MIGRATION_TARGET_DRIFT");

    const owned = new LegacyKnowledgeMigrationService({ store, registry, recipes: { getRecipe: () => undefined },
      freshness: { get: () => current.freshness as never,
        getMigrationProjectionOwner: () => ({ migrationId: preview.migrationId, payloadHash: "c".repeat(64), status: "OWNED" }) } });
    expect(owned.resolve(preview.migrationId, 0)?.candidate.candidateId).toBeDefined();
  });

  it("validates dry-run bounds, scan limits and skipped resolution", () => {
    const assets = [projected("asset-1"), projected("asset-2")];
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    const service = new LegacyKnowledgeMigrationService({ store,
      registry: { activeIndexVersion: 2, listAssets: ({ limit = 100, offset = 0 } = {}) => assets.slice(offset, offset + limit),
        getAsset: (id) => assets.find((item) => item.asset.id === id) },
      recipes: { getRecipe: () => undefined }, freshness: { get: () => undefined } });
    for (const request of [
      { projectId: "", createdAt: at }, { projectId: "project-1", createdAt: "invalid" },
      { projectId: "project-1", createdAt: at, pageSize: 0 }, { projectId: "project-1", createdAt: at, maxItems: 0 },
    ]) expect(() => service.dryRun(request)).toThrow("LEGACY_MIGRATION_DRY_RUN_INVALID");
    expect(() => service.dryRun({ projectId: "project-1", createdAt: at, pageSize: 1, maxItems: 1 }))
      .toThrow("LEGACY_MIGRATION_SCAN_LIMIT_EXCEEDED");
  });

  it("rolls back owned targets in reverse pages and replays the exact command", async () => {
    const assets = [projected("asset-1"), projected("asset-2"), projected("asset-3")];
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    const service = new LegacyKnowledgeMigrationService({ store,
      registry: { activeIndexVersion: 3, listAssets: ({ limit = 100, offset = 0 } = {}) => assets.slice(offset, offset + limit),
        getAsset: (id) => assets.find((item) => item.asset.id === id) },
      recipes: { getRecipe: () => undefined }, freshness: { get: () => undefined } });
    const preview = service.dryRun({ projectId: "project-1", createdAt: at });
    store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "commit-rollback-fixture",
      status: "COMMITTING", updatedAt: at });
    for (const item of store.items({ migrationId: preview.migrationId, limit: 10 }).items) {
      store.recordItem({ migrationId: preview.migrationId, ordinal: item.ordinal, effectKey: `migrated-${item.ordinal}`,
        status: "MIGRATED", updatedAt: at, createdRecipe: true, createdFreshness: true,
        reasonCodes: ["MIGRATION_VERIFIED"] });
    }
    store.transition({ migrationId: preview.migrationId, expectedRevision: 1, effectKey: "complete-rollback-fixture",
      status: "COMPLETED", updatedAt: at });
    const order: string[] = []; let rebuilt = 0;
    const rollback = new LegacyKnowledgeMigrationRollbackService({ store,
      freshness: { rollbackMigrationProjection: (request) => { order.push(`freshness:${request.assetId}`);
        return { status: "ROLLED_BACK" as const }; } },
      recipes: { rollbackRecipeForMigration: (request) => { order.push(`recipe:${request.assetId}`);
        return { status: "ROLLED_BACK" as const }; } }, rebuildIndex: () => { rebuilt += 1; } });
    const command = { migrationId: preview.migrationId, expectedRevision: 2, idempotencyKey: "rollback-paged",
      updatedAt: "2026-08-19T00:10:00.000Z", pageSize: 1 } as const;
    const result = await rollback.rollback(command);
    expect(result).toMatchObject({ status: "ROLLED_BACK", rollbackConflictCount: 0 });
    expect(order).toEqual(["freshness:asset-3", "recipe:asset-3", "freshness:asset-2", "recipe:asset-2",
      "freshness:asset-1", "recipe:asset-1"]);
    expect(rebuilt).toBe(1);
    expect(await rollback.rollback(command)).toEqual(result);
    await expect(rollback.rollback({ ...command, expectedRevision: result.revision,
      idempotencyKey: "rollback-new-command" })).rejects.toThrow("LEGACY_MIGRATION_STATUS_CONFLICT");
  });

  it("reports target conflicts and propagates non-conflict rollback failures", async () => {
    const create = () => {
      const store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
      const value = projected("asset-1");
      const service = new LegacyKnowledgeMigrationService({ store,
        registry: { activeIndexVersion: 1, listAssets: () => [value], getAsset: () => value },
        recipes: { getRecipe: () => undefined }, freshness: { get: () => undefined } });
      const preview = service.dryRun({ projectId: "project-1", createdAt: at });
      store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "commit-conflict",
        status: "COMMITTING", updatedAt: at });
      store.recordItem({ migrationId: preview.migrationId, ordinal: 0, effectKey: "migrated-conflict", status: "MIGRATED",
        updatedAt: at, createdRecipe: true, createdFreshness: true, reasonCodes: ["MIGRATION_VERIFIED"] });
      store.transition({ migrationId: preview.migrationId, expectedRevision: 1, effectKey: "complete-conflict",
        status: "COMPLETED", updatedAt: at });
      return { store, preview };
    };
    const freshnessConflict = create();
    const conflicted = await new LegacyKnowledgeMigrationRollbackService({ store: freshnessConflict.store,
      freshness: { rollbackMigrationProjection: () => ({ status: "CONFLICT", reasonCode: "FRESHNESS_CHANGED" }) },
      recipes: { rollbackRecipeForMigration: () => { throw new Error("recipe must not run"); } } }).rollback({
        migrationId: freshnessConflict.preview.migrationId, expectedRevision: 2, idempotencyKey: "rollback-conflict",
        updatedAt: "2026-08-19T00:10:00.000Z" });
    expect(conflicted).toMatchObject({ status: "ROLLBACK_CONFLICT", rollbackConflictCount: 1 });
    freshnessConflict.store.close();

    const recipeConflict = create();
    expect(await new LegacyKnowledgeMigrationRollbackService({ store: recipeConflict.store,
      freshness: { rollbackMigrationProjection: () => ({ status: "NOT_OWNED" }) },
      recipes: { rollbackRecipeForMigration: () => { throw new KnowledgeVerificationConflictError("changed"); } } }).rollback({
        migrationId: recipeConflict.preview.migrationId, expectedRevision: 2, idempotencyKey: "rollback-recipe-conflict",
        updatedAt: "2026-08-19T00:10:00.000Z" })).toMatchObject({ status: "ROLLBACK_CONFLICT" });
    recipeConflict.store.close();

    const transient = create();
    await expect(new LegacyKnowledgeMigrationRollbackService({ store: transient.store,
      freshness: { rollbackMigrationProjection: () => ({ status: "NOT_OWNED" }) },
      recipes: { rollbackRecipeForMigration: () => { throw new Error("SQLITE_BUSY"); } } }).rollback({
        migrationId: transient.preview.migrationId, expectedRevision: 2, idempotencyKey: "rollback-transient",
        updatedAt: "2026-08-19T00:10:00.000Z" })).rejects.toThrow("SQLITE_BUSY");
    transient.store.close();
  });

  it("rejects invalid and unknown rollback commands before effects", async () => {
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    const rollback = new LegacyKnowledgeMigrationRollbackService({ store,
      freshness: { rollbackMigrationProjection: () => ({ status: "NOT_OWNED" }) },
      recipes: { rollbackRecipeForMigration: () => ({ status: "NOT_OWNED" }) } });
    await expect(rollback.rollback({ migrationId: "missing", expectedRevision: 0, idempotencyKey: "rollback-valid-key",
      updatedAt: at })).rejects.toThrow("LEGACY_MIGRATION_NOT_FOUND");
    await expect(rollback.rollback({ migrationId: "missing", expectedRevision: 0, idempotencyKey: "",
      updatedAt: at })).rejects.toThrow("LEGACY_MIGRATION_ROLLBACK_INVALID");
    await expect(rollback.rollback({ migrationId: "missing", expectedRevision: 0, idempotencyKey: "rollback-valid-key",
      updatedAt: at, pageSize: 0 })).rejects.toThrow("LEGACY_MIGRATION_ROLLBACK_INVALID");
  });
});
