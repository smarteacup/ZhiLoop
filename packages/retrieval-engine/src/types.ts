import type { RetrievalPolicy } from "@zhiloop/config";
import type { KnowledgeAsset } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset } from "@zhiloop/knowledge-registry";
import type { QueryContext } from "@zhiloop/query-context";
import type { EmbeddingPort, VectorIndexPort } from "@zhiloop/vector-index";

export type RetrievalChannel = "EXACT" | "FTS" | "VECTOR" | "RELATION";

export interface RetrievalSourceHit {
  readonly asset: ProjectedKnowledgeAsset;
  readonly rank: number;
  readonly rawScore: number;
  readonly reason: string;
}

export interface KnowledgeRetrievalSource {
  listCurrent(): readonly ProjectedKnowledgeAsset[] | Promise<readonly ProjectedKnowledgeAsset[]>;
  getCurrent(assetId: string): ProjectedKnowledgeAsset | undefined | Promise<ProjectedKnowledgeAsset | undefined>;
  searchFts(query: string, limit: number): readonly RetrievalSourceHit[] | Promise<readonly RetrievalSourceHit[]>;
  related(seedAssetIds: readonly string[], limit: number): readonly RetrievalSourceHit[] | Promise<readonly RetrievalSourceHit[]>;
}

export interface RetrievalChannels {
  readonly exact?: boolean;
  readonly fts?: boolean;
  readonly vector?: boolean;
  readonly relation?: boolean;
}

export interface RetrievalEngineOptions {
  readonly channels?: RetrievalChannels;
}

export interface RetrievalRequest {
  readonly context: QueryContext;
  readonly policy: RetrievalPolicy;
}

export interface RetrievalChannelContribution {
  readonly channel: RetrievalChannel;
  readonly rank: number;
  readonly contribution: number;
  readonly reason: string;
}

export interface RetrievedKnowledge {
  readonly asset: KnowledgeAsset;
  readonly rank: number;
  readonly score: number;
  readonly scopeMatched: true;
  readonly contributions: readonly RetrievalChannelContribution[];
}

export type RetrievalDiagnosticCode =
  | "CHANNEL_DISABLED"
  | "CHANNEL_FAILED"
  | "STATUS_FILTERED"
  | "SCOPE_FILTERED"
  | "TOMBSTONE_FILTERED"
  | "STALE_SOURCE_HIT"
  | "STALE_VECTOR_CHUNK"
  | "VECTOR_VERSION_MISMATCH";

export interface RetrievalDiagnostic {
  readonly code: RetrievalDiagnosticCode;
  readonly channel: RetrievalChannel;
  readonly message: string;
  readonly assetId?: string;
}

export interface RetrievalResult {
  readonly items: readonly RetrievedKnowledge[];
  readonly diagnostics: readonly RetrievalDiagnostic[];
}

export interface VectorRetrievalDependencies {
  readonly embedding: EmbeddingPort;
  readonly index: VectorIndexPort;
}
