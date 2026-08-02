import type { KnowledgeAsset } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset, SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import { describe, expect, it, vi } from "vitest";

import { SqliteKnowledgeRetrievalSource } from "./source.js";

const at = "2026-08-02T15:00:00.000Z";

function projected(id: string, relations: KnowledgeAsset["relations"] = []): ProjectedKnowledgeAsset {
  return {
    asset: {
      schemaVersion: 1, id, subjectKey: id, kind: "IMPLEMENTATION",
      scope: { level: "PROJECT", projectId: "project-a" }, version: 1, status: "IMPLEMENTED",
      title: id, summary: "retrieval source", body: "FtsSourceBeacon", aliases: [], keywords: [],
      applicability: [], nonApplicability: [], symbols: [], relations, evidence: [], confidence: 0.9,
      sourceEpisodes: ["episode-source"], contentHash: `sha256_${id}`, correlationId: "correlation-source",
      createdAt: at, updatedAt: at,
    },
    tombstone: false,
    indexVersion: 1,
  };
}

describe("SqliteKnowledgeRetrievalSource", () => {
  it("adapts paged current, FTS, outgoing, and incoming relations", () => {
    const target = projected("knowledge.source.target");
    const seed = projected("knowledge.source.seed", [{ type: "RELATED_TO", targetId: target.asset.id, targetVersion: 1 }]);
    const incoming = projected("knowledge.source.incoming", [{ type: "IMPLEMENTS", targetId: seed.asset.id, targetVersion: 1 }]);
    const values = [target, seed, incoming];
    const byId = new Map(values.map((item) => [item.asset.id, item]));
    const registry = {
      listAssets: vi.fn((options: { offset?: number }) => options.offset === 0 ? values : []),
      getAsset: vi.fn((id: string) => byId.get(id)),
      search: vi.fn(() => [{ asset: target.asset, rank: 1, score: 42, indexVersion: 1 }]),
    } as unknown as SqliteKnowledgeRegistryProjection;
    const source = new SqliteKnowledgeRetrievalSource(registry);
    expect(source.listCurrent()).toHaveLength(3);
    expect(source.getCurrent(seed.asset.id)?.asset.id).toBe(seed.asset.id);
    expect(source.searchFts("FtsSourceBeacon", 10)).toMatchObject([{
      asset: { asset: { id: target.asset.id } }, rank: 1, rawScore: 42,
    }]);
    expect(source.related([seed.asset.id], 10).map((item) => item.asset.asset.id)).toEqual([
      target.asset.id, incoming.asset.id,
    ]);
    expect(source.related([], 10)).toEqual([]);
  });

  it("reads all registry pages without a fixed 1,000-asset ceiling", () => {
    const page = Array.from({ length: 1_000 }, (_, index) => projected(`knowledge.source.page-${index}`));
    const tail = projected("knowledge.source.tail");
    const registry = {
      listAssets: vi.fn((options: { offset?: number }) => options.offset === 0 ? page : options.offset === 1_000 ? [tail] : []),
    } as unknown as SqliteKnowledgeRegistryProjection;
    const source = new SqliteKnowledgeRetrievalSource(registry);
    expect(source.listCurrent()).toHaveLength(1_001);
    expect(registry.listAssets).toHaveBeenCalledTimes(2);
  });
});
