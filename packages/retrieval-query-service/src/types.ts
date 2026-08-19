import type { InjectionPolicy, RetrievalPolicy } from "@zhiloop/config";
import type { EvidenceRef, KnowledgeScope, KnowledgeStatus, ProjectContext } from "@zhiloop/domain";
import type { RerankDiagnostic, RerankPort } from "@zhiloop/knowledge-reranker";
import type { QueryContext, QueryContextHints } from "@zhiloop/query-context";
import type {
  KnowledgeRetrievalSource,
  RetrievalChannel,
  RetrievalChannelContribution,
  RetrievalDiagnostic,
  RetrievalResult,
  ScenarioDirectoryItem,
  VectorRetrievalDependencies,
} from "@zhiloop/retrieval-engine";
import type { RetrievalTrace as EvaluationRetrievalTrace } from "@zhiloop/retrieval-evaluation";

export type RetrievalPolicySource = "CURRENT" | "DRAFT" | "REPLAY";

export interface RetrievalPolicyReference {
  readonly policyId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly source: RetrievalPolicySource;
}

export interface ResolvedRetrievalPolicy {
  readonly reference: RetrievalPolicyReference;
  readonly retrieval: RetrievalPolicy;
  readonly injection: InjectionPolicy;
}

export interface RetrievalPolicyResolver {
  resolve(reference: RetrievalPolicyReference): ResolvedRetrievalPolicy | Promise<ResolvedRetrievalPolicy>;
}

interface QueryRequestBase {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly query: string;
  readonly project?: ProjectContext;
  readonly cwd?: string;
  readonly taskId?: string;
  readonly hints?: QueryContextHints;
  readonly maxResults: number;
  readonly maxContextTokens: number;
  readonly timeoutMs: number;
}

export interface ConsoleKnowledgeSearchRequest extends QueryRequestBase {
  readonly policy: RetrievalPolicyReference;
}

export interface ConsoleRetrievalSimulationRequest extends QueryRequestBase {
  readonly currentPolicy: RetrievalPolicyReference;
  readonly draftPolicy?: RetrievalPolicyReference;
  readonly fixedInputTraceId?: string;
}

export type RetrievalRunOutcome = "SUCCEEDED" | "PARTIAL" | "NO_CONTEXT" | "TIMEOUT" | "ERROR";
export type ShadowDeliveryResult = "SHADOWED" | "NO_CONTEXT" | "TIMEOUT" | "ERROR";
export type RetrievalOmissionReason =
  | "SCOPE_FILTERED"
  | "STATUS_FILTERED"
  | "SUPPRESSED"
  | "STALE_VERSION"
  | "DUPLICATE_SUBJECT"
  | "LOW_AUTHORITY"
  | "TOKEN_BUDGET"
  | "CHANNEL_TIMEOUT"
  | "POLICY_FILTERED";

export interface TraceFilterDecision {
  readonly assetId?: string;
  readonly channel?: RetrievalChannel;
  readonly decision: "INCLUDED" | "EXCLUDED" | "DEGRADED";
  readonly reasonCode: string;
  readonly safeMessage: string;
}

export interface TraceResultItem {
  readonly knowledgeId: string;
  readonly version: number;
  readonly subjectKey: string;
  readonly title: string;
  readonly summary: string;
  readonly scope: KnowledgeScope;
  readonly status: Extract<KnowledgeStatus, "ACCEPTED" | "IMPLEMENTED" | "VERIFIED">;
  readonly retrievalRank: number;
  readonly finalRank: number;
  readonly rrfScore: number;
  readonly contributions: readonly RetrievalChannelContribution[];
  readonly rerankReasonCodes: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly sourceEpisodeIds: readonly string[];
}

export interface TraceEnvelopeItem {
  readonly knowledgeId: string;
  readonly version: number;
  readonly estimatedTokens: number;
}

export interface TraceOmission {
  readonly knowledgeId: string;
  readonly version: number;
  readonly reason: RetrievalOmissionReason;
}

export interface ConsoleRetrievalTrace {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly replayOfTraceId?: string;
  readonly queryContext: QueryContext;
  readonly scenarioDirectory: readonly ScenarioDirectoryItem[];
  readonly policy: RetrievalPolicyReference;
  readonly outcome: RetrievalRunOutcome;
  readonly filters: readonly TraceFilterDecision[];
  readonly retrievalDiagnostics: readonly RetrievalDiagnostic[];
  readonly rerankDiagnostics: readonly RerankDiagnostic[];
  readonly results: readonly TraceResultItem[];
  readonly envelope: {
    readonly detailLevel: "L0_NONE" | "L1_POINTER" | "L2_COMPACT" | "L3_EVIDENCED";
    readonly maxTokens: number;
    readonly estimatedTokens: number;
    readonly truncated: boolean;
    readonly selected: readonly TraceEnvelopeItem[];
    readonly omitted: readonly TraceOmission[];
    readonly reasonCodes: readonly string[];
  };
  readonly injection: {
    readonly result: ShadowDeliveryResult;
    readonly reasonCodes: readonly string[];
  };
  readonly durationMs: number;
  readonly createdAt: string;
  readonly evaluation?: EvaluationRetrievalTrace;
}

export interface RetrievalPolicyComparison {
  readonly currentTraceId: string;
  readonly draftTraceId: string;
  readonly selectedOnlyByCurrent: readonly string[];
  readonly selectedOnlyByDraft: readonly string[];
  readonly currentEstimatedTokens: number;
  readonly draftEstimatedTokens: number;
  readonly tokenDelta: number;
  readonly currentTruncated: boolean;
  readonly draftTruncated: boolean;
}

export interface ConsoleKnowledgeSearchResponse {
  readonly schemaVersion: 1;
  readonly kind: "SEARCH";
  readonly trace: ConsoleRetrievalTrace;
}

export interface ConsoleRetrievalSimulationResponse {
  readonly schemaVersion: 1;
  readonly kind: "SIMULATION";
  readonly current: ConsoleRetrievalTrace;
  readonly draft?: ConsoleRetrievalTrace;
  readonly comparison?: RetrievalPolicyComparison;
}

export type RetrievalQueryResponse = ConsoleKnowledgeSearchResponse | ConsoleRetrievalSimulationResponse;

export interface RetrievalReplayInput {
  readonly schemaVersion: 1;
  readonly queryContext: QueryContext;
  readonly retrieval: RetrievalResult;
}

export interface StoredRetrievalOperation {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestHash: string;
  readonly response: RetrievalQueryResponse;
  readonly traces: readonly {
    readonly trace: ConsoleRetrievalTrace;
    readonly replayInput?: RetrievalReplayInput;
  }[];
  readonly createdAt: string;
}

export interface RetrievalTraceStore {
  getOperation(requestId: string): StoredRetrievalOperation | undefined;
  getTrace(traceId: string): ConsoleRetrievalTrace | undefined;
  getReplayInput(traceId: string): RetrievalReplayInput | undefined;
  commit(operation: StoredRetrievalOperation): "STORED" | "IDEMPOTENT";
}

export interface RetrievalQueryServiceDependencies {
  readonly source: KnowledgeRetrievalSource;
  readonly vector?: VectorRetrievalDependencies;
  readonly policies: RetrievalPolicyResolver;
  readonly traces: RetrievalTraceStore;
  readonly rerankPort?: RerankPort;
  readonly now?: () => Date;
}

export class RetrievalRequestConflictError extends Error {
  override readonly name = "RetrievalRequestConflictError";
}

export class RetrievalPolicyMismatchError extends Error {
  override readonly name = "RetrievalPolicyMismatchError";
}

export class RetrievalReplayError extends Error {
  override readonly name = "RetrievalReplayError";
}
