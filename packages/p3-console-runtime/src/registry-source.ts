import type { KnowledgeScope } from "@zhiloop/domain";
import type {
  KnowledgeSearchResult,
  ProjectedKnowledgeAsset,
  SqliteKnowledgeRegistryProjection,
} from "@zhiloop/knowledge-registry";
import type { KnowledgeRetrievalSource, RetrievalSourceHit } from "@zhiloop/retrieval-engine";

const ELIGIBLE = new Set(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);
const MAX_LIMIT = 100;

export interface RegistryRetrievalBoundary {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly allowGlobalKnowledge: boolean;
}

export type RegistryProjectionReadPort = Pick<
  SqliteKnowledgeRegistryProjection,
  "listAssets" | "getAsset" | "search" | "getRelations"
>;

export class RegistryRetrievalSourceError extends Error {
  override readonly name = "RegistryRetrievalSourceError";
}

function scopeVisible(scope: KnowledgeScope, boundary: RegistryRetrievalBoundary): boolean {
  switch (scope.level) {
    case "GLOBAL": return boundary.allowGlobalKnowledge && boundary.projectId !== undefined;
    case "PROJECT":
    case "MODULE":
    case "SYMBOL": return boundary.projectId !== undefined && scope.projectId === boundary.projectId;
    case "TASK": return boundary.taskId !== undefined && scope.taskId === boundary.taskId
      && (scope.projectId === undefined || scope.projectId === boundary.projectId);
    case "USER":
    case "TEAM": return false;
  }
}

function eligible(value: ProjectedKnowledgeAsset, boundary: RegistryRetrievalBoundary): boolean {
  return !value.tombstone && ELIGIBLE.has(value.asset.status) && scopeVisible(value.asset.scope, boundary);
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("retrieval source limit is invalid");
  return limit;
}

export class SqliteRegistryKnowledgeRetrievalSource implements KnowledgeRetrievalSource {
  constructor(
    private readonly projection: RegistryProjectionReadPort,
    readonly boundary: RegistryRetrievalBoundary,
  ) {
    if (boundary.projectId === undefined && boundary.taskId !== undefined) {
      throw new Error("task-scoped retrieval requires a project boundary");
    }
    if (boundary.allowGlobalKnowledge && boundary.projectId === undefined) {
      throw new Error("global retrieval requires an anchored project boundary");
    }
  }

  #safe<T>(action: () => T, message: string): T {
    try {
      return action();
    } catch {
      throw new RegistryRetrievalSourceError(message);
    }
  }

  listCurrent(): readonly ProjectedKnowledgeAsset[] {
    return this.#safe(() => {
      const output: ProjectedKnowledgeAsset[] = [];
      for (let offset = 0; offset < 100_000; offset += 1_000) {
        const page = this.projection.listAssets({ limit: 1_000, offset });
        output.push(...page.filter((item) => eligible(item, this.boundary)));
        if (page.length < 1_000) break;
      }
      return Object.freeze(output);
    }, "registry current listing failed");
  }

  getCurrent(assetId: string): ProjectedKnowledgeAsset | undefined {
    if (typeof assetId !== "string" || assetId.length < 1 || assetId.length > 500 || assetId.includes("\0")) return undefined;
    return this.#safe(() => {
      const value = this.projection.getAsset(assetId);
      return value !== undefined && eligible(value, this.boundary) ? value : undefined;
    }, "registry current lookup failed");
  }

  searchFts(query: string, limit: number): readonly RetrievalSourceHit[] {
    const requested = boundedLimit(limit);
    return this.#safe(() => this.projection.search(query, { limit: Math.min(100, requested * 4) })
      .filter((item) => eligible({ asset: item.asset, tombstone: false, indexVersion: item.indexVersion }, this.boundary))
      .slice(0, requested)
      .map((item, index) => this.#searchHit(item, index)), "registry FTS query failed");
  }

  #searchHit(item: KnowledgeSearchResult, index: number): RetrievalSourceHit {
    return {
      asset: { asset: item.asset, tombstone: false, indexVersion: item.indexVersion },
      rank: index + 1,
      rawScore: item.score,
      reason: `registry FTS rank ${index + 1}`,
    };
  }

  related(seedAssetIds: readonly string[], limit: number): readonly RetrievalSourceHit[] {
    const requested = boundedLimit(limit);
    if (seedAssetIds.length > 100) throw new Error("relation seed limit exceeded");
    return this.#safe(() => {
      const targets = new Map<string, ProjectedKnowledgeAsset>();
      for (const seedId of seedAssetIds) {
        const seed = this.getCurrent(seedId);
        if (seed === undefined) continue;
        for (const relation of this.projection.getRelations(seed.asset.id, seed.asset.version).relations) {
          const target = this.getCurrent(relation.targetId);
          if (target === undefined || (relation.targetVersion !== undefined && relation.targetVersion !== target.asset.version)) continue;
          targets.set(target.asset.id, target);
          if (targets.size >= requested) break;
        }
        if (targets.size >= requested) break;
      }
      return Object.freeze([...targets.values()].sort((left, right) => left.asset.id.localeCompare(right.asset.id))
        .map((asset, index) => ({
          asset,
          rank: index + 1,
          rawScore: 1 / (index + 1),
          reason: `registry relation rank ${index + 1}`,
        })));
    }, "registry relation query failed");
  }
}
