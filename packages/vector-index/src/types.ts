import type { KnowledgeAsset } from "@zhiloop/domain";
import type { KnowledgeChunk } from "@zhiloop/knowledge-indexer";

export interface EmbeddingPort {
  readonly version: string;
  embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface VectorChunkRecord {
  readonly chunk: KnowledgeChunk;
  readonly vector: readonly number[];
  readonly embeddingVersion: string;
}

export interface VectorSearchResult {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
  readonly rank: number;
}

export interface VectorIndexPort {
  readonly enabled: boolean;
  readonly embeddingVersion: string | undefined;
  replaceAssetChunks(asset: KnowledgeAsset, records: readonly VectorChunkRecord[]): void | Promise<void>;
  removeAsset(assetId: string, assetVersion: number): void | Promise<void>;
  search(vector: readonly number[], limit?: number): readonly VectorSearchResult[] | Promise<readonly VectorSearchResult[]>;
}

export interface VectorChunkSinkOptions {
  readonly maxCachedEmbeddings?: number;
}
