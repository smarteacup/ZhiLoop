import type { KnowledgeCandidate } from "@zhiloop/domain";
import type { KnowledgeFreshnessRecord, SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import type { ProjectedKnowledgeAsset, SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import { KnowledgeVerificationConflictError, type SqliteKnowledgeVerificationStore,
  type StoredVerificationRecipe } from "@zhiloop/knowledge-verification";

import { resolveLegacyMigrationCandidate } from "./classification.js";
import { migrationHash } from "./identity.js";
import type { SqliteLegacyKnowledgeMigrationStore } from "./store.js";
import { LEGACY_MIGRATION_VERSION, LEGACY_RECIPE_VERSION, type LegacyMigrationItemSnapshot,
  type LegacyMigrationPreview } from "./types.js";

export type LegacyMigrationRegistryReadPort = Pick<SqliteKnowledgeRegistryProjection,
"activeIndexVersion" | "listAssets" | "getAsset">;
export type LegacyMigrationRecipeReadPort = Pick<SqliteKnowledgeVerificationStore, "getRecipe">;
export type LegacyMigrationFreshnessReadPort = Pick<SqliteKnowledgeFreshnessStore, "get">
  & Partial<Pick<SqliteKnowledgeFreshnessStore, "getMigrationProjectionOwner">>;

export interface LegacyMigrationResolution {
  readonly candidate: KnowledgeCandidate;
  readonly assertionsHash: string;
}

export class LegacyKnowledgeMigrationService {
  constructor(readonly ports: {
    readonly registry: LegacyMigrationRegistryReadPort;
    readonly recipes: LegacyMigrationRecipeReadPort;
    readonly freshness: LegacyMigrationFreshnessReadPort;
    readonly store: SqliteLegacyKnowledgeMigrationStore;
  }) {}

  dryRun(request: { readonly projectId: string; readonly createdAt: string; readonly pageSize?: number;
    readonly maxItems?: number }): LegacyMigrationPreview {
    const pageSize = request.pageSize ?? 500; const maxItems = request.maxItems ?? 100_000;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000
      || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100_000
      || request.projectId.trim().length === 0 || !Number.isFinite(Date.parse(request.createdAt))) {
      throw new Error("LEGACY_MIGRATION_DRY_RUN_INVALID");
    }
    const sourceRegistryRevision = this.ports.registry.activeIndexVersion;
    const items: LegacyMigrationItemSnapshot[] = [];
    for (let offset = 0; items.length < maxItems; offset += pageSize) {
      const page = this.ports.registry.listAssets({ limit: Math.min(pageSize, maxItems - items.length), offset });
      for (const projected of page) items.push(this.#snapshot(projected, request.projectId, items.length));
      if (page.length < pageSize) break;
      if (items.length >= maxItems) {
        const overflow = this.ports.registry.listAssets({ limit: 1, offset: items.length });
        if (overflow.length > 0) throw new Error("LEGACY_MIGRATION_SCAN_LIMIT_EXCEEDED");
      }
    }
    if (this.ports.registry.activeIndexVersion !== sourceRegistryRevision) throw new Error("LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT");
    return this.ports.store.createPreview({ migrationVersion: LEGACY_MIGRATION_VERSION, projectId: request.projectId,
      sourceRegistryRevision, items, createdAt: request.createdAt });
  }

  resolve(migrationId: string, ordinal: number): LegacyMigrationResolution | undefined {
    const record = this.ports.store.items({ migrationId, limit: 1, ...(ordinal === 0 ? {} : { afterOrdinal: ordinal - 1 }) }).items[0];
    if (record === undefined || record.ordinal !== ordinal || record.classification !== "MIGRATABLE") return undefined;
    const projected = this.ports.registry.getAsset(record.assetId);
    if (projected === undefined || projected.tombstone || projected.asset.version !== record.assetVersion
      || projected.asset.contentHash !== record.assetContentHash || projected.indexVersion !== record.assetIndexVersion) {
      throw new Error("LEGACY_MIGRATION_TARGET_DRIFT");
    }
    // A projection created after a Recipe/Symbol preview is a concurrent target
    // write. Accepting it as migration-owned would make rollback authority lie.
    if (record.source !== "FRESHNESS") {
      const target = this.ports.freshness.get(projected.asset.id, projected.asset.version);
      if (target !== undefined) {
        const owner = this.ports.freshness.getMigrationProjectionOwner?.(projected.asset.id, projected.asset.version);
        if (owner?.migrationId !== migrationId || owner.status !== "OWNED") {
          throw new Error("LEGACY_MIGRATION_TARGET_DRIFT");
        }
      }
    }
    const projectId = this.ports.store.get(migrationId)?.projectId ?? "";
    const recipe = record.source === "RECIPE" ? this.ports.recipes.getRecipe(
      projected.asset.id, projected.asset.version, LEGACY_RECIPE_VERSION,
    ) : undefined;
    const freshness = record.source === "FRESHNESS" ? this.ports.freshness.get(projected.asset.id, projected.asset.version) : undefined;
    const resolved = resolveLegacyMigrationCandidate({ asset: projected.asset, projectId,
      ...(recipe === undefined ? {} : { recipe }), ...(freshness === undefined ? {} : { freshness }) });
    if (resolved.candidate === undefined || resolved.assertions === undefined) throw new Error("LEGACY_MIGRATION_SOURCE_MISSING");
    if (resolved.candidate.candidateId !== record.candidateId) throw new Error("LEGACY_MIGRATION_SOURCE_CANDIDATE_DRIFT");
    if (migrationHash(resolved.assertions) !== record.assertionsHash) throw new Error("LEGACY_MIGRATION_SOURCE_ASSERTIONS_DRIFT");
    return Object.freeze({ candidate: resolved.candidate, assertionsHash: record.assertionsHash });
  }

  #resolution(projected: ProjectedKnowledgeAsset, projectId: string) {
    const recipe: StoredVerificationRecipe | undefined = this.ports.recipes.getRecipe(
      projected.asset.id, projected.asset.version, LEGACY_RECIPE_VERSION,
    );
    const freshness: KnowledgeFreshnessRecord | undefined = this.ports.freshness.get(projected.asset.id, projected.asset.version);
    return resolveLegacyMigrationCandidate({ asset: projected.asset, projectId, ...(recipe === undefined ? {} : { recipe }),
      ...(freshness === undefined ? {} : { freshness }) });
  }

  #snapshot(projected: ProjectedKnowledgeAsset, projectId: string, ordinal: number): LegacyMigrationItemSnapshot {
    const resolution = this.#resolution(projected, projectId);
    const assertions = resolution.assertions;
    return Object.freeze({ schemaVersion: 1, ordinal, assetId: projected.asset.id, assetVersion: projected.asset.version,
      assetContentHash: projected.asset.contentHash, assetIndexVersion: projected.indexVersion,
      classification: resolution.classification, source: resolution.source,
      ...(resolution.candidate === undefined ? {} : { candidateId: resolution.candidate.candidateId }),
      ...(assertions === undefined ? {} : { assertionsHash: migrationHash(assertions) }),
      assertionKinds: Object.freeze(assertions?.map((assertion) => assertion.kind) ?? []),
      reasonCodes: Object.freeze([...resolution.reasonCodes]),
    });
  }
}

export class LegacyKnowledgeMigrationRollbackService {
  constructor(readonly ports: {
    readonly store: SqliteLegacyKnowledgeMigrationStore;
    readonly recipes: Pick<SqliteKnowledgeVerificationStore, "rollbackRecipeForMigration">;
    readonly freshness: Pick<SqliteKnowledgeFreshnessStore, "rollbackMigrationProjection">;
    readonly rebuildIndex?: () => void | Promise<void>;
  }) {}

  async rollback(request: { readonly migrationId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string; readonly updatedAt: string; readonly pageSize?: number }): Promise<LegacyMigrationPreview> {
    const pageSize = request.pageSize ?? 100;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000 || request.idempotencyKey.trim().length === 0) {
      throw new Error("LEGACY_MIGRATION_ROLLBACK_INVALID");
    }
    const current = this.ports.store.get(request.migrationId);
    if (current === undefined) throw new Error("LEGACY_MIGRATION_NOT_FOUND");
    const rolling = this.ports.store.transition({ migrationId: current.migrationId,
      expectedRevision: request.expectedRevision, effectKey: request.idempotencyKey, status: "ROLLING_BACK",
      updatedAt: request.updatedAt });
    let cursor: number | undefined; let conflicts = 0; let changed = false;
    do {
      const page = this.ports.store.itemsReverse({ migrationId: rolling.migrationId, limit: pageSize,
        ...(cursor === undefined ? {} : { beforeOrdinal: cursor }) });
      for (const item of page.items) {
        if (item.status !== "MIGRATED" && item.status !== "ROLLBACK_CONFLICT") continue;
        let conflictReason: string | undefined;
        if (item.createdFreshness === true) {
          const result = this.ports.freshness.rollbackMigrationProjection({ migrationId: rolling.migrationId,
            assetId: item.assetId, assetVersion: item.assetVersion, updatedAt: request.updatedAt });
          if (result.status === "CONFLICT") conflictReason = result.reasonCode ?? "FRESHNESS_CHANGED";
          else if (result.status === "ROLLED_BACK") changed = true;
        }
        if (conflictReason === undefined && item.createdRecipe === true && item.assertionsHash !== undefined) {
          try {
            const result = this.ports.recipes.rollbackRecipeForMigration({ migrationId: rolling.migrationId,
              assetId: item.assetId, assetVersion: item.assetVersion, recipeVersion: LEGACY_RECIPE_VERSION,
              assertionsHash: item.assertionsHash, updatedAt: request.updatedAt });
            if (result.status === "ROLLED_BACK") changed = true;
          } catch (error) {
            if (error instanceof KnowledgeVerificationConflictError) conflictReason = "RECIPE_CHANGED";
            else throw error;
          }
        }
        if (conflictReason !== undefined) conflicts += 1;
        this.ports.store.recordItem({ migrationId: rolling.migrationId, ordinal: item.ordinal,
          effectKey: `rollback:${rolling.revision}:${item.ordinal}`, status: conflictReason === undefined ? "ROLLED_BACK" : "ROLLBACK_CONFLICT",
          updatedAt: request.updatedAt, reasonCodes: conflictReason === undefined ? ["MIGRATION_DERIVED_DATA_REMOVED"] : [conflictReason] });
      }
      cursor = page.nextOrdinal;
    } while (cursor !== undefined);
    if (changed) await this.ports.rebuildIndex?.();
    if (this.ports.store.get(rolling.migrationId) === undefined) throw new Error("LEGACY_MIGRATION_NOT_FOUND");
    return this.ports.store.transition({ migrationId: rolling.migrationId, expectedRevision: rolling.revision,
      effectKey: `rollback-complete:${rolling.revision}`, status: conflicts === 0 ? "ROLLED_BACK" : "ROLLBACK_CONFLICT",
      updatedAt: request.updatedAt, rollbackConflictCount: conflicts });
  }
}
