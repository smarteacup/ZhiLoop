import type { QueryTerm } from "@zhiloop/query-context";
import type { RetrievalChannelContribution, RetrievedKnowledge } from "@zhiloop/retrieval-engine";

export interface RerankCandidateInput {
  readonly assetId: string;
  readonly subjectKey: string;
  readonly kind: RetrievedKnowledge["asset"]["kind"];
  readonly status: RetrievedKnowledge["asset"]["status"];
  readonly scope: RetrievedKnowledge["asset"]["scope"];
  readonly title: string;
  readonly summary: string;
  readonly applicability: readonly string[];
  readonly nonApplicability: readonly string[];
  readonly symbols: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly originalRank: number;
  readonly rrfScore: number;
  readonly contributions: readonly RetrievalChannelContribution[];
}

export interface RerankPortRequest {
  readonly schemaVersion: 1;
  readonly prompt: string;
  readonly exactTerms: readonly QueryTerm[];
  readonly candidates: readonly RerankCandidateInput[];
  readonly signal: AbortSignal;
}

export interface RerankPortRanking {
  readonly assetId: string;
  readonly score: number;
  readonly reasonCodes: readonly string[];
}

export interface RerankPortResult {
  readonly schemaVersion: 1;
  readonly rankings: readonly RerankPortRanking[];
}

export interface RerankPort {
  readonly available: boolean;
  rerank(request: RerankPortRequest): Promise<RerankPortResult>;
}

export interface KnowledgeRerankerOptions {
  readonly timeoutMs?: number;
}

export type RerankFallbackCode =
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "PORT_ERROR"
  | "INVALID_OUTPUT"
  | "QUERY_TOO_LARGE";

export interface RerankDiagnostic {
  readonly code: RerankFallbackCode | "DUPLICATE_SUBJECT_REMOVED" | "CANDIDATE_LIMIT_APPLIED";
  readonly message: string;
  readonly assetId?: string;
  readonly keptAssetId?: string;
}

export interface RerankExplanation {
  readonly applied: boolean;
  readonly originalRank: number;
  readonly score?: number;
  readonly reasonCodes: readonly string[];
}

export interface RerankedKnowledge extends Omit<RetrievedKnowledge, "rank"> {
  readonly rank: number;
  readonly rerank: RerankExplanation;
}

export interface KnowledgeRerankResult {
  readonly items: readonly RerankedKnowledge[];
  readonly diagnostics: readonly RerankDiagnostic[];
}
