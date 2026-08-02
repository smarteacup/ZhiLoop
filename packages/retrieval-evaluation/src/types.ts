import type { ContextEnvelope, ContextEnvelopeItem, KnowledgeScope } from "@zhiloop/domain";
import type { KnowledgeRerankResult, RerankExplanation } from "@zhiloop/knowledge-reranker";
import type { QueryContext, QueryContextInput } from "@zhiloop/query-context";
import type {
  RetrievalChannelContribution,
  RetrievalDiagnostic,
  RetrievalResult,
} from "@zhiloop/retrieval-engine";

export interface RetrievalTraceSignals {
  readonly risk?: "LOW" | "MEDIUM" | "HIGH";
  readonly ambiguous?: boolean;
  readonly conflicting?: boolean;
}

export interface RetrievalTraceInput {
  readonly traceId: string;
  readonly runId: string;
  readonly queryContext: QueryContext;
  readonly retrieval: RetrievalResult;
  readonly rerank: KnowledgeRerankResult;
  readonly envelope: ContextEnvelope;
  readonly signals?: RetrievalTraceSignals;
  readonly automatic?: boolean;
}

export interface RetrievalTraceResult {
  readonly assetId: string;
  readonly version: number;
  readonly subjectKey: string;
  readonly scope: KnowledgeScope;
  readonly retrievalRank: number;
  readonly finalRank: number;
  readonly rrfScore: number;
  readonly contributions: readonly RetrievalChannelContribution[];
  readonly rerank: RerankExplanation;
  readonly evidenceIds: readonly string[];
  readonly sourceEpisodes: readonly string[];
  readonly injected: boolean;
  readonly detailLevel?: ContextEnvelopeItem["detailLevel"];
}

export interface RetrievalTrace {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly runId: string;
  readonly query: {
    readonly projectId?: string;
    readonly taskId?: string;
    readonly allowProjectKnowledge: boolean;
    readonly allowGlobalKnowledge: boolean;
    readonly promptFingerprint: string;
    readonly reasonCodes: readonly string[];
  };
  readonly filters: readonly RetrievalDiagnostic[];
  readonly rerankDiagnostics: KnowledgeRerankResult["diagnostics"];
  readonly results: readonly RetrievalTraceResult[];
  readonly injection: {
    readonly items: readonly Pick<ContextEnvelopeItem, "id" | "version" | "scope" | "authority" | "detailLevel">[];
  };
  readonly complexity: {
    readonly level: ContextEnvelope["complexity"]["level"];
    readonly automatic: boolean;
    readonly estimatedTokens: number;
    readonly maxTokens: number;
    readonly truncated: boolean;
    readonly reasonCodes: readonly string[];
  };
}

export interface GoldenDatasetCase {
  readonly caseId: string;
  readonly query: QueryContextInput;
  readonly expectedRelevantAssetIds: readonly string[];
  readonly forbiddenAssetIds?: readonly string[];
}

export interface GoldenDataset {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly version: number;
  readonly cases: readonly GoldenDatasetCase[];
}

export interface GoldenDatasetExecutor {
  execute(testCase: GoldenDatasetCase): Promise<RetrievalTrace>;
}

export interface GoldenDatasetRunnerOptions {
  readonly k?: number;
  readonly recallThreshold?: number;
  readonly precisionThreshold?: number;
}

export interface GoldenCaseResult {
  readonly caseId: string;
  readonly status: "PASS" | "FAIL" | "ERROR";
  readonly traceId?: string;
  readonly retrievedAssetIds: readonly string[];
  readonly relevantHits: readonly string[];
  readonly missingRelevantAssetIds: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly error?: string;
}

export interface ComplexityAudit {
  readonly levelCounts: Readonly<Record<ContextEnvelope["complexity"]["level"], number>>;
  readonly averageTokens: number;
  readonly p95Tokens: number;
  readonly maximumTokens: number;
  readonly truncatedCount: number;
  readonly overBudgetCount: number;
  readonly automaticL4Count: number;
  readonly missingReasonAxisCount: number;
}

export interface GoldenDatasetReport {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly configFingerprint: string;
  readonly k: number;
  readonly totals: {
    readonly cases: number;
    readonly errors: number;
    readonly relevant: number;
    readonly returned: number;
    readonly hits: number;
    readonly forbiddenHits: number;
  };
  readonly metrics: {
    readonly recallAtK: number;
    readonly precisionAtK: number;
    readonly traceabilityRate: number;
    readonly scopeLeakCount: number;
  };
  readonly thresholds: { readonly recallAtK: number; readonly precisionAtK: number };
  readonly complexity: ComplexityAudit;
  readonly qualityThresholdsMet: boolean;
  readonly defaultInjectionAllowed: boolean;
  readonly gatePassed: boolean;
  readonly cases: readonly GoldenCaseResult[];
}
