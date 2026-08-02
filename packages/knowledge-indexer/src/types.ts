import type { KnowledgeAsset } from "@zhiloop/domain";

export interface KnowledgeChunk {
  readonly chunkId: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly assetContentHash: string;
  readonly ordinal: number;
  readonly heading: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface KnowledgeChunkSink {
  replaceAssetChunks(asset: KnowledgeAsset, chunks: readonly KnowledgeChunk[]): void | Promise<void>;
  removeAsset(assetId: string, assetVersion: number): void | Promise<void>;
}

export type IncrementalIndexAction =
  | "INDEXED"
  | "UNCHANGED"
  | "CHUNKS_REFRESHED"
  | "SKIPPED_INVALID"
  | "SKIPPED_UNSAFE"
  | "INDEXED_WITH_CHUNK_ERROR";

export interface IncrementalIndexDiagnostic {
  readonly code:
    | "INVALID_CURRENT"
    | "UNSAFE_MANUAL_EDIT"
    | "BROKEN_HISTORY"
    | "PROJECTION_FAILED"
    | "CHUNK_SINK_FAILED";
  readonly message: string;
}

export interface IncrementalIndexResult {
  readonly assetId: string;
  readonly action: IncrementalIndexAction;
  readonly assetVersion?: number;
  readonly contentHash?: string;
  readonly indexVersion: number;
  readonly chunks: readonly KnowledgeChunk[];
  readonly diagnostics: readonly IncrementalIndexDiagnostic[];
}

export interface KnowledgeIndexerOptions {
  readonly clock?: () => Date;
  readonly correlationIdFactory?: (assetId: string, sourceVersion: number) => string;
  readonly chunkMaxChars?: number;
  readonly chunkSink?: KnowledgeChunkSink;
}

export interface DebouncedIndexerOptions {
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly onBatch?: (results: readonly IncrementalIndexResult[]) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface NodeKnowledgeWatcherOptions {
  readonly onError?: (error: Error) => void;
}
