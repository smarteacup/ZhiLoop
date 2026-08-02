import type { KnowledgeAsset } from "@zhiloop/domain";
import type { KnowledgeChunk, KnowledgeChunkSink } from "@zhiloop/knowledge-indexer";

import type {
  EmbeddingPort,
  VectorChunkRecord,
  VectorChunkSinkOptions,
  VectorIndexPort,
  VectorSearchResult,
} from "./types.js";

const DEFAULT_CACHE_SIZE = 10_000;
const MAX_CACHE_SIZE = 1_000_000;
const MAX_SEARCH_LIMIT = 100;

function validateVector(vector: readonly number[], dimension?: number): void {
  if (vector.length === 0 || (dimension !== undefined && vector.length !== dimension) ||
    vector.some((value) => !Number.isFinite(value))) throw new Error("vector must have one consistent finite dimension");
}

function cosine(left: readonly number[], right: readonly number[]): number {
  validateVector(left, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export class DisabledVectorIndex implements VectorIndexPort {
  readonly enabled = false;
  readonly embeddingVersion = undefined;
  replaceAssetChunks(asset: KnowledgeAsset, records: readonly VectorChunkRecord[]): void { void asset; void records; }
  removeAsset(assetId: string, assetVersion: number): void { void assetId; void assetVersion; }
  search(vector: readonly number[], limit?: number): readonly VectorSearchResult[] { void vector; void limit; return []; }
}

export class InMemoryVectorIndex implements VectorIndexPort {
  readonly enabled = true;
  readonly #records = new Map<string, VectorChunkRecord>();
  #dimension: number | undefined;
  #embeddingVersion: string | undefined;

  get embeddingVersion(): string | undefined { return this.#embeddingVersion; }

  replaceAssetChunks(asset: KnowledgeAsset, records: readonly VectorChunkRecord[]): void {
    const seen = new Set<string>();
    let dimension = this.#dimension;
    let embeddingVersion = this.#embeddingVersion;
    for (const record of records) {
      if (record.chunk.assetId !== asset.id || record.chunk.assetVersion !== asset.version) {
        throw new Error("vector chunk does not match its asset identity");
      }
      if (seen.has(record.chunk.chunkId)) throw new Error("duplicate chunkId in vector batch");
      seen.add(record.chunk.chunkId);
      if (record.embeddingVersion.trim().length === 0 || (embeddingVersion !== undefined && record.embeddingVersion !== embeddingVersion)) {
        throw new Error("vector index cannot mix embedding versions");
      }
      embeddingVersion ??= record.embeddingVersion;
      dimension ??= record.vector.length;
      validateVector(record.vector, dimension);
    }
    const next = new Map(this.#records);
    for (const [chunkId, record] of next) if (record.chunk.assetId === asset.id) next.delete(chunkId);
    for (const record of records) next.set(record.chunk.chunkId, Object.freeze({
      chunk: record.chunk,
      vector: Object.freeze([...record.vector]),
      embeddingVersion: record.embeddingVersion,
    }));
    this.#records.clear();
    for (const [chunkId, record] of next) this.#records.set(chunkId, record);
    if (records.length > 0) this.#dimension = dimension;
    if (records.length > 0) this.#embeddingVersion = embeddingVersion;
    else if (this.#records.size === 0) { this.#dimension = undefined; this.#embeddingVersion = undefined; }
  }

  removeAsset(assetId: string, assetVersion: number): void {
    void assetVersion;
    for (const [chunkId, record] of this.#records) if (record.chunk.assetId === assetId) this.#records.delete(chunkId);
    if (this.#records.size === 0) { this.#dimension = undefined; this.#embeddingVersion = undefined; }
  }

  search(vector: readonly number[], limit = 20): readonly VectorSearchResult[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw new Error(`limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
    if (this.#dimension === undefined) return [];
    validateVector(vector, this.#dimension);
    return Object.freeze([...this.#records.values()]
      .map((record) => ({ chunk: record.chunk, score: cosine(vector, record.vector) }))
      .sort((left, right) => right.score - left.score || left.chunk.chunkId.localeCompare(right.chunk.chunkId))
      .slice(0, limit)
      .map((item, index) => Object.freeze({ ...item, rank: index + 1 })));
  }
}

export class VectorKnowledgeChunkSink implements KnowledgeChunkSink {
  readonly #embedding: EmbeddingPort;
  readonly #index: VectorIndexPort;
  readonly #maxCache: number;
  readonly #cache = new Map<string, readonly number[]>();

  constructor(embedding: EmbeddingPort, index: VectorIndexPort, options: VectorChunkSinkOptions = {}) {
    this.#embedding = embedding;
    this.#index = index;
    this.#maxCache = options.maxCachedEmbeddings ?? DEFAULT_CACHE_SIZE;
    if (embedding.version.trim().length === 0) throw new Error("embedding version must not be empty");
    if (!Number.isSafeInteger(this.#maxCache) || this.#maxCache < 1 || this.#maxCache > MAX_CACHE_SIZE) throw new Error("maxCachedEmbeddings is invalid");
  }

  async replaceAssetChunks(asset: KnowledgeAsset, chunks: readonly KnowledgeChunk[]): Promise<void> {
    if (!this.#index.enabled) return;
    const resolved = new Map<string, readonly number[]>();
    for (const chunk of chunks) {
      const key = `${this.#embedding.version}\0${chunk.contentHash}`;
      const cached = this.#cache.get(key);
      if (cached !== undefined) resolved.set(chunk.contentHash, cached);
    }
    const missing = [...new Map(chunks.filter((chunk) => !this.#cache.has(`${this.#embedding.version}\0${chunk.contentHash}`)).map((chunk) => [chunk.contentHash, chunk.content])).entries()];
    if (missing.length > 0) {
      const vectors = await this.#embedding.embed(missing.map(([, content]) => content));
      if (vectors.length !== missing.length) throw new Error("embedding output count does not match input count");
      vectors.forEach((vector, index) => {
        validateVector(vector);
        const contentHash = missing[index]?.[0];
        if (contentHash === undefined) throw new Error("embedding cache identity is missing");
        const key = `${this.#embedding.version}\0${contentHash}`;
        const frozen = Object.freeze([...vector]);
        resolved.set(contentHash, frozen);
        this.#cache.delete(key);
        this.#cache.set(key, frozen);
        while (this.#cache.size > this.#maxCache) this.#cache.delete(this.#cache.keys().next().value as string);
      });
    }
    const records = chunks.map((chunk): VectorChunkRecord => {
      const vector = resolved.get(chunk.contentHash);
      if (vector === undefined) throw new Error("embedding cache did not contain a chunk");
      const cacheKey = `${this.#embedding.version}\0${chunk.contentHash}`;
      if (this.#cache.has(cacheKey)) {
        this.#cache.delete(cacheKey);
        this.#cache.set(cacheKey, vector);
      }
      return { chunk, vector, embeddingVersion: this.#embedding.version };
    });
    await this.#index.replaceAssetChunks(asset, records);
  }

  async removeAsset(assetId: string, assetVersion: number): Promise<void> {
    if (!this.#index.enabled) return;
    await this.#index.removeAsset(assetId, assetVersion);
  }
}
