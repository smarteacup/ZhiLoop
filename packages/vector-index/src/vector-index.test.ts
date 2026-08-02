import type { KnowledgeAsset } from "@zhiloop/domain";
import { chunkKnowledgeAsset } from "@zhiloop/knowledge-indexer";
import { calculateKnowledgeContentHash } from "@zhiloop/markdown-repository";
import { describe, expect, it, vi } from "vitest";

import { DisabledVectorIndex, InMemoryVectorIndex, VectorKnowledgeChunkSink } from "./index.js";

function asset(version = 1, body = "# One\n\nalpha\n\n# Two\n\nbeta"): KnowledgeAsset {
  const draft: KnowledgeAsset = {
    schemaVersion: 1, id: "knowledge.vector.fixture", subjectKey: "knowledge.vector.fixture",
    kind: "IMPLEMENTATION", scope: { level: "PROJECT", projectId: "p" }, version,
    status: "IMPLEMENTED", title: "Vector", summary: "vector fixture", body,
    aliases: [], keywords: [], applicability: [], nonApplicability: [], symbols: [], relations: [],
    evidence: [{ evidenceId: "e", verdict: "SUPPORTS" }], confidence: 1,
    sourceEpisodes: ["episode"], contentHash: "", correlationId: `c-${version}`,
    createdAt: "2026-08-02T00:00:00.000Z", updatedAt: `2026-08-02T0${version}:00:00.000Z`,
  };
  return { ...draft, contentHash: calculateKnowledgeContentHash(draft) };
}

describe("VectorIndexPort", () => {
  it("does not embed or index when disabled", async () => {
    const embed = vi.fn();
    const index = new DisabledVectorIndex();
    const sink = new VectorKnowledgeChunkSink({ version: "test-v1", embed }, index);
    await sink.replaceAssetChunks(asset(), chunkKnowledgeAsset(asset()));
    await sink.removeAsset(asset().id, 1);
    expect(embed).not.toHaveBeenCalled();
    index.replaceAssetChunks(asset(), []);
    index.removeAsset(asset().id, 1);
    expect(index.search([1])).toEqual([]);
  });

  it("embeds each contentHash once and reuses it across versions", async () => {
    const embed = vi.fn(async (inputs: readonly string[]) => inputs.map((input) => [input.includes("alpha") ? 1 : 0, input.includes("beta") ? 1 : 0]));
    const index = new InMemoryVectorIndex();
    const sink = new VectorKnowledgeChunkSink({ version: "test-v1", embed }, index);
    const first = asset();
    await sink.replaceAssetChunks(first, chunkKnowledgeAsset(first));
    const second = asset(2);
    await sink.replaceAssetChunks(second, chunkKnowledgeAsset(second));
    expect(embed).toHaveBeenCalledTimes(1);
    expect(index.search([1, 0])[0]).toMatchObject({ rank: 1, score: 1, chunk: { assetVersion: 2, heading: "One" } });
    expect(index.search([1, 0]).every((result) => result.chunk.assetVersion === 2)).toBe(true);
  });

  it("atomically replaces and removes an asset without old chunks", () => {
    const index = new InMemoryVectorIndex();
    const first = asset();
    const firstChunks = chunkKnowledgeAsset(first);
    index.replaceAssetChunks(first, firstChunks.map((chunk, i) => ({ chunk, vector: i === 0 ? [1, 0] : [0, 1], embeddingVersion: "test-v1" })));
    const second = asset(2, "# Three\n\ngamma");
    const secondChunks = chunkKnowledgeAsset(second);
    index.replaceAssetChunks(second, secondChunks.map((chunk) => ({ chunk, vector: [0.5, 0.5], embeddingVersion: "test-v1" })));
    expect(index.search([1, 0])).toHaveLength(1);
    expect(index.search([1, 0])[0]?.chunk.assetVersion).toBe(2);
    expect(index.search([0, 0])[0]?.score).toBe(0);
    expect(() => index.search([1])).toThrow("finite dimension");
    index.replaceAssetChunks(second, []);
    expect(index.search([1, 0])).toEqual([]);
    index.replaceAssetChunks(second, secondChunks.map((chunk) => ({ chunk, vector: [0.5, 0.5], embeddingVersion: "test-v1" })));
    index.removeAsset(second.id, 2);
    expect(index.search([1, 0])).toEqual([]);
  });

  it("validates the whole batch before replacing", () => {
    const index = new InMemoryVectorIndex();
    const original = asset();
    const chunks = chunkKnowledgeAsset(original);
    index.replaceAssetChunks(original, chunks.map((chunk) => ({ chunk, vector: [1, 0], embeddingVersion: "test-v1" })));
    expect(() => index.replaceAssetChunks(original, [{ chunk: chunks[0]!, vector: [Number.NaN, 0], embeddingVersion: "test-v1" }])).toThrow("finite dimension");
    expect(index.search([1, 0])).toHaveLength(chunks.length);
    expect(() => index.replaceAssetChunks(asset(2), [{ chunk: chunks[0]!, vector: [1, 0], embeddingVersion: "test-v1" }])).toThrow("asset identity");
    expect(() => index.replaceAssetChunks(original, [
      { chunk: chunks[0]!, vector: [1, 0], embeddingVersion: "test-v1" }, { chunk: chunks[0]!, vector: [1, 0], embeddingVersion: "test-v1" },
    ])).toThrow("duplicate chunkId");
    expect(() => index.replaceAssetChunks(original, [{ chunk: chunks[0]!, vector: [1, 0], embeddingVersion: "test-v2" }]))
      .toThrow("mix embedding versions");
  });

  it("rejects embedding count/vector errors and validates search/cache limits", async () => {
    const chunks = chunkKnowledgeAsset(asset());
    await expect(new VectorKnowledgeChunkSink({ version: "test-v1", embed: async () => [] }, new InMemoryVectorIndex())
      .replaceAssetChunks(asset(), chunks)).rejects.toThrow("output count");
    await expect(new VectorKnowledgeChunkSink({ version: "test-v1", embed: async () => [[Infinity]] }, new InMemoryVectorIndex())
      .replaceAssetChunks(asset(), [chunks[0]!])).rejects.toThrow("finite dimension");
    expect(() => new VectorKnowledgeChunkSink({ version: "test-v1", embed: async () => [] }, new InMemoryVectorIndex(), { maxCachedEmbeddings: 0 })).toThrow("invalid");
    expect(() => new VectorKnowledgeChunkSink({ version: " ", embed: async () => [] }, new InMemoryVectorIndex())).toThrow("version");
    const index = new InMemoryVectorIndex();
    expect(() => index.search([1], 0)).toThrow("limit");
    expect(index.search([1])).toEqual([]);
    const removeAsset = vi.spyOn(index, "removeAsset");
    await new VectorKnowledgeChunkSink({ version: "test-v1", embed: async () => [] }, index).removeAsset("asset", 1);
    expect(removeAsset).toHaveBeenCalledWith("asset", 1);
  });

  it("evicts the LRU embedding cache without corrupting replacement", async () => {
    const embed = vi.fn(async (inputs: readonly string[]) => inputs.map((_input, index) => [index + 1]));
    const index = new InMemoryVectorIndex();
    const sink = new VectorKnowledgeChunkSink({ version: "test-v1", embed }, index, { maxCachedEmbeddings: 1 });
    await sink.replaceAssetChunks(asset(), chunkKnowledgeAsset(asset()));
    await sink.replaceAssetChunks(asset(2), chunkKnowledgeAsset(asset(2)));
    expect(embed).toHaveBeenCalledTimes(2);
    expect(index.search([1]).every((result) => result.chunk.assetVersion === 2)).toBe(true);
  });
});
