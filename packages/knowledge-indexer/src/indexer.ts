import type { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import {
  MarkdownRepositoryConflictError,
  type MarkdownKnowledgeRepository,
  type StoredKnowledgeVersion,
} from "@zhiloop/markdown-repository";

import { chunkKnowledgeAsset } from "./chunker.js";
import type {
  IncrementalIndexDiagnostic,
  IncrementalIndexResult,
  KnowledgeChunk,
  KnowledgeIndexerOptions,
} from "./types.js";

function frozenResult(result: IncrementalIndexResult): IncrementalIndexResult {
  return Object.freeze({ ...result, chunks: Object.freeze([...result.chunks]), diagnostics: Object.freeze([...result.diagnostics]) });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IncrementalKnowledgeIndexer {
  readonly #repository: MarkdownKnowledgeRepository;
  readonly #projection: SqliteKnowledgeRegistryProjection;
  readonly #clock: () => Date;
  readonly #correlationIdFactory: (assetId: string, sourceVersion: number) => string;
  readonly #chunkMaxChars: number;
  readonly #chunkSink: KnowledgeIndexerOptions["chunkSink"];
  readonly #chunkStates = new Map<string, string>();

  constructor(
    repository: MarkdownKnowledgeRepository,
    projection: SqliteKnowledgeRegistryProjection,
    options: KnowledgeIndexerOptions = {},
  ) {
    this.#repository = repository;
    this.#projection = projection;
    this.#clock = options.clock ?? (() => new Date());
    this.#correlationIdFactory = options.correlationIdFactory ?? (
      (assetId, sourceVersion) => `indexer-manual-${assetId}-${sourceVersion}`
    );
    this.#chunkMaxChars = options.chunkMaxChars ?? 1_500;
    this.#chunkSink = options.chunkSink;
    if (!Number.isSafeInteger(this.#chunkMaxChars) || this.#chunkMaxChars < 200 || this.#chunkMaxChars > 20_000) {
      throw new Error("chunkMaxChars must be between 200 and 20000");
    }
  }

  get indexVersion(): number {
    return this.#projection.activeIndexVersion;
  }

  async #loadHistory(active: StoredKnowledgeVersion): Promise<readonly StoredKnowledgeVersion[]> {
    const versions: StoredKnowledgeVersion[] = [];
    for (let version = 1; version <= active.asset.version; version += 1) {
      const result = await this.#repository.readVersion(active.asset.id, version);
      if (!result.ok || result.value.historyState !== "COMMITTED") {
        throw new Error(`immutable version ${version} is missing or invalid`);
      }
      versions.push(result.value);
    }
    return versions;
  }

  async #syncChunks(active: StoredKnowledgeVersion, chunks: readonly KnowledgeChunk[]): Promise<void> {
    if (this.#chunkSink === undefined) return;
    if (active.tombstone) await this.#chunkSink.removeAsset(active.asset.id, active.asset.version);
    else await this.#chunkSink.replaceAssetChunks(active.asset, chunks);
    this.#chunkStates.set(active.asset.id, active.asset.contentHash);
  }

  async syncAsset(assetId: string): Promise<IncrementalIndexResult> {
    const diagnostics: IncrementalIndexDiagnostic[] = [];
    const current = await this.#repository.readCurrent(assetId);
    if (!current.ok) {
      return frozenResult({
        assetId,
        action: "SKIPPED_INVALID",
        indexVersion: this.indexVersion,
        chunks: [],
        diagnostics: [{ code: "INVALID_CURRENT", message: current.error.message }],
      });
    }
    let active = current.value;
    if (active.historyState === "MANUAL_EDIT") {
      const now = this.#clock();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("indexer clock returned an invalid Date");
      const correlationId = this.#correlationIdFactory(assetId, active.asset.version);
      if (correlationId.trim().length === 0) throw new Error("indexer correlationIdFactory returned an empty value");
      try {
        active = (await this.#repository.adoptManualEdit(assetId, {
          expectedCurrentVersion: active.asset.version,
          updatedAt: now.toISOString(),
          correlationId,
        })).value;
      } catch (error) {
        if (!(error instanceof MarkdownRepositoryConflictError)) throw error;
        return frozenResult({
          assetId,
          action: "SKIPPED_UNSAFE",
          indexVersion: this.indexVersion,
          chunks: [],
          diagnostics: [{ code: "UNSAFE_MANUAL_EDIT", message: error.message }],
        });
      }
    }

    const chunks = active.tombstone ? [] : chunkKnowledgeAsset(active.asset, this.#chunkMaxChars);
    const existing = this.#projection.getAsset(assetId, true);
    const projectionUnchanged = existing !== undefined &&
      existing.asset.version === active.asset.version &&
      existing.asset.contentHash === active.asset.contentHash &&
      existing.tombstone === active.tombstone;
    const chunksUnchanged = this.#chunkSink === undefined || this.#chunkStates.get(assetId) === active.asset.contentHash;
    if (projectionUnchanged && chunksUnchanged) {
      return frozenResult({
        assetId,
        action: "UNCHANGED",
        assetVersion: active.asset.version,
        contentHash: active.asset.contentHash,
        indexVersion: this.indexVersion,
        chunks: [],
        diagnostics,
      });
    }

    if (!projectionUnchanged) {
      try {
        if (existing !== undefined && active.asset.version === existing.asset.version + 1) {
          this.#projection.projectCurrent(active);
        } else {
          this.#projection.replaceAssetHistory(await this.#loadHistory(active), active);
        }
      } catch (error) {
        return frozenResult({
          assetId,
          action: "SKIPPED_INVALID",
          assetVersion: active.asset.version,
          contentHash: active.asset.contentHash,
          indexVersion: this.indexVersion,
          chunks: [],
          diagnostics: [{ code: "PROJECTION_FAILED", message: safeMessage(error) }],
        });
      }
    }

    try {
      await this.#syncChunks(active, chunks);
    } catch (error) {
      diagnostics.push({ code: "CHUNK_SINK_FAILED", message: safeMessage(error) });
      return frozenResult({
        assetId,
        action: "INDEXED_WITH_CHUNK_ERROR",
        assetVersion: active.asset.version,
        contentHash: active.asset.contentHash,
        indexVersion: this.indexVersion,
        chunks,
        diagnostics,
      });
    }
    return frozenResult({
      assetId,
      action: projectionUnchanged ? "CHUNKS_REFRESHED" : "INDEXED",
      assetVersion: active.asset.version,
      contentHash: active.asset.contentHash,
      indexVersion: this.indexVersion,
      chunks,
      diagnostics,
    });
  }

  async syncMany(assetIds: Iterable<string>): Promise<readonly IncrementalIndexResult[]> {
    const unique = [...new Set(assetIds)].sort();
    const results: IncrementalIndexResult[] = [];
    for (const assetId of unique) {
      try {
        results.push(await this.syncAsset(assetId));
      } catch (error) {
        results.push(frozenResult({
          assetId,
          action: "SKIPPED_INVALID",
          indexVersion: this.indexVersion,
          chunks: [],
          diagnostics: [{ code: "PROJECTION_FAILED", message: safeMessage(error) }],
        }));
      }
    }
    return Object.freeze(results);
  }
}
