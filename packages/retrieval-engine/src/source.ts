import type { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";

import type { KnowledgeRetrievalSource, RetrievalSourceHit } from "./types.js";

export class SqliteKnowledgeRetrievalSource implements KnowledgeRetrievalSource {
  readonly #registry: SqliteKnowledgeRegistryProjection;

  constructor(registry: SqliteKnowledgeRegistryProjection) {
    this.#registry = registry;
  }

  listCurrent(): readonly ReturnType<SqliteKnowledgeRegistryProjection["listAssets"]>[number][] {
    const values: ReturnType<SqliteKnowledgeRegistryProjection["listAssets"]>[number][] = [];
    for (let offset = 0; ; offset += 1_000) {
      const page = this.#registry.listAssets({ includeTombstones: true, limit: 1_000, offset });
      values.push(...page);
      if (page.length < 1_000) break;
    }
    return Object.freeze(values);
  }

  getCurrent(assetId: string): ReturnType<SqliteKnowledgeRegistryProjection["getAsset"]> {
    return this.#registry.getAsset(assetId, true);
  }

  searchFts(query: string, limit: number): readonly RetrievalSourceHit[] {
    return Object.freeze(this.#registry.search(query, { limit, includeInactive: true }).map((item) => ({
      asset: this.#registry.getAsset(item.asset.id, true) as NonNullable<ReturnType<SqliteKnowledgeRegistryProjection["getAsset"]>>,
      rank: item.rank,
      rawScore: item.score,
      reason: `FTS rank ${item.rank}`,
    })));
  }

  related(seedAssetIds: readonly string[], limit: number): readonly RetrievalSourceHit[] {
    const seeds = new Set(seedAssetIds);
    const current = this.listCurrent();
    const byId = new Map(current.map((item) => [item.asset.id, item]));
    const ranked = new Map<string, { asset: typeof current[number]; order: number; reason: string }>();
    let order = 0;
    for (const seedId of seedAssetIds) {
      const seed = byId.get(seedId);
      if (seed === undefined) continue;
      for (const relation of seed.asset.relations) {
        const target = byId.get(relation.targetId);
        if (target !== undefined && !seeds.has(target.asset.id) && !ranked.has(target.asset.id)) {
          ranked.set(target.asset.id, { asset: target, order: ++order, reason: `${seedId} ${relation.type} ${target.asset.id}` });
        }
      }
      for (const candidate of current) {
        if (seeds.has(candidate.asset.id) || ranked.has(candidate.asset.id)) continue;
        const relation = candidate.asset.relations.find((item) => item.targetId === seedId);
        if (relation !== undefined) {
          ranked.set(candidate.asset.id, { asset: candidate, order: ++order, reason: `${candidate.asset.id} ${relation.type} ${seedId}` });
        }
      }
    }
    return Object.freeze([...ranked.values()]
      .sort((left, right) => left.order - right.order || left.asset.asset.id.localeCompare(right.asset.asset.id))
      .slice(0, limit)
      .map((item, index) => ({ asset: item.asset, rank: index + 1, rawScore: 1 / item.order, reason: item.reason })));
  }
}
