export interface RetrievalPolicyRefView {
  readonly policyId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly source: "CURRENT" | "DRAFT" | "REPLAY";
}

export interface RetrievalResultView {
  readonly knowledgeId: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly scope: string;
  readonly status: string;
  readonly retrievalRank: number;
  readonly finalRank: number;
  readonly rrfScore: number;
  readonly contributions: readonly {
    readonly channel: "EXACT" | "FTS" | "VECTOR" | "RELATION";
    readonly rank: number;
    readonly reason: string;
  }[];
  readonly evidenceIds: readonly string[];
  readonly injected: false;
}

export interface RetrievalTraceView {
  readonly traceId: string;
  readonly outcome: "SUCCEEDED" | "PARTIAL" | "NO_CONTEXT" | "TIMEOUT" | "ERROR";
  readonly injectionResult: "SHADOWED" | "NO_CONTEXT" | "TIMEOUT" | "ERROR";
  readonly reasonCodes: readonly string[];
  readonly results: readonly RetrievalResultView[];
  readonly filters: readonly { readonly decision: string; readonly reasonCode: string; readonly safeMessage: string }[];
  readonly envelope: {
    readonly detailLevel: "L0_NONE" | "L1_POINTER" | "L2_COMPACT" | "L3_EVIDENCED";
    readonly maxTokens: number;
    readonly estimatedTokens: number;
    readonly truncated: boolean;
    readonly omitted: readonly { readonly knowledgeId: string; readonly version: number; readonly reason: string }[];
  };
}

export interface KnowledgeSearchCommand {
  readonly requestId: string;
  readonly query: string;
  readonly projectId?: string;
  readonly maxResults: number;
  readonly maxContextTokens: number;
}

export interface KnowledgeAskView {
  readonly outcome: "SUCCEEDED" | "FALLBACK_SEARCH" | "CANCELLED" | "FAILED";
  readonly answer: string;
  readonly citations: readonly { readonly knowledgeId: string; readonly version: number; readonly answerSpans: readonly { readonly start: number; readonly end: number }[] }[];
  readonly unknowns: readonly string[];
  readonly conflicts: readonly { readonly summary: string; readonly knowledgeVersions: readonly { readonly knowledgeId: string; readonly version: number }[] }[];
  readonly retrieval: RetrievalTraceView;
  readonly latencyMs: number;
}

export interface RetrievalSimulationView {
  readonly current: RetrievalTraceView;
  readonly draft?: RetrievalTraceView;
  readonly comparison?: {
    readonly selectedOnlyByCurrent: readonly string[];
    readonly selectedOnlyByDraft: readonly string[];
    readonly tokenDelta: number;
  };
}
