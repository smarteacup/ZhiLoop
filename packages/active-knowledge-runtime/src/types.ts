import type { ClosureVerificationInput, SemanticClosurePort } from "@zhiloop/closure-verifier";
import type { InjectionRolloutController, UserPromptSubmitInput } from "@zhiloop/codex-context-injection";
import type { ClosurePolicy, InjectionPolicy, VerificationPolicy } from "@zhiloop/config";
import type {
  ConfirmationReply,
  ConfirmationTargetSnapshot,
  ConfirmationWritebackRepository,
  ConfirmationWritebackResult,
} from "@zhiloop/confirmation-writeback";
import type { ContextOrchestratorPort } from "@zhiloop/context-orchestrator";
import type { ConfirmationRequest, ContextEnvelope, KnowledgeScope } from "@zhiloop/domain";
import type { FeedbackProfile, KnowledgeFeedbackEvent, SqliteFeedbackStore } from "@zhiloop/feedback-engine";
import type { ConfirmationHistoryEntry, InteractionTrigger } from "@zhiloop/interaction-policy";
import type { KnowledgeMcpService, KnowledgeMcpToolName } from "@zhiloop/knowledge-mcp";
import type { KnowledgeRerankResult, RerankedKnowledge } from "@zhiloop/knowledge-reranker";
import type { QueryContext } from "@zhiloop/query-context";
import type { RetrievalResult } from "@zhiloop/retrieval-engine";
import type { RetrievalTrace, RetrievalTraceSignals } from "@zhiloop/retrieval-evaluation";
import type {
  ClosureRunRecord,
  InjectionAttemptRecord,
  McpExpansionAuditRecord,
  RuntimeAuditPage,
} from "@zhiloop/runtime-audit-store";
import type { StopContinuationRequest, StopContinuationResult, StopContextDeltaPort } from "@zhiloop/stop-continuation";

export interface RuntimeAuditStorePort {
  beginInjection(record: InjectionAttemptRecord): InjectionAttemptRecord;
  completeInjection(
    attemptId: string,
    expectedRevision: number,
    status: Exclude<InjectionAttemptRecord["status"], "PENDING">,
    reasonCode: string,
    completedAt: string,
  ): InjectionAttemptRecord;
  acknowledgeInjectionDelivery(
    attemptId: string,
    expectedRevision: number,
    deliveryEvidenceRef: string,
    deliveredAt: string,
  ): InjectionAttemptRecord;
  getInjection(attemptId: string): InjectionAttemptRecord | undefined;
  listInjections(sessionId: string, limit?: number): RuntimeAuditPage<InjectionAttemptRecord>;
  recordMcpExpansion(record: McpExpansionAuditRecord): McpExpansionAuditRecord;
  getMcpExpansion(expansionId: string): McpExpansionAuditRecord | undefined;
  listMcpExpansions(attemptId: string, limit?: number): RuntimeAuditPage<McpExpansionAuditRecord>;
  recordClosure(record: ClosureRunRecord): ClosureRunRecord;
  getClosure(closureRunId: string): ClosureRunRecord | undefined;
  listClosures(sessionId: string, limit?: number): RuntimeAuditPage<ClosureRunRecord>;
}

export interface KnowledgeEligibilityInspection {
  readonly exists: boolean;
  readonly currentVersion?: number;
  readonly current: boolean;
  readonly scopeMatched: boolean;
  readonly statusEligible: boolean;
  readonly suppressed: boolean;
}

export interface KnowledgeEligibilityPort {
  inspect(request: {
    readonly assetId: string;
    readonly version?: number;
    readonly scopeKey: string;
    readonly signal: AbortSignal;
  }): KnowledgeEligibilityInspection | Promise<KnowledgeEligibilityInspection>;
}

export interface ActiveKnowledgeRetrievalResult {
  readonly runId: string;
  readonly traceId: string;
  readonly queryContext: QueryContext;
  readonly retrieval: RetrievalResult;
  readonly rerank: KnowledgeRerankResult;
  readonly candidates: readonly RerankedKnowledge[];
  readonly signals?: RetrievalTraceSignals;
  readonly requestedLevel?: ContextEnvelope["complexity"]["level"];
  readonly taskContract?: ContextEnvelope["taskContract"];
}

export interface ActiveKnowledgeRetrievalPort {
  retrieve(
    request: { readonly sessionId: string; readonly turnId: string; readonly cwd: string; readonly prompt: string },
    signal: AbortSignal,
  ): Promise<ActiveKnowledgeRetrievalResult>;
}

export interface ActiveInjectionRuntimeDependencies {
  readonly retrieval: ActiveKnowledgeRetrievalPort;
  readonly orchestrator: ContextOrchestratorPort;
  readonly injectionPolicy: () => InjectionPolicy;
  readonly rollout: InjectionRolloutController;
  readonly audits: RuntimeAuditStorePort;
  readonly eligibility: KnowledgeEligibilityPort;
  readonly feedback: SqliteFeedbackStore;
  readonly now?: () => Date;
  readonly deadlineMs?: number;
}

export interface ActiveInjectionRuntimeResult {
  readonly attempt?: InjectionAttemptRecord;
  readonly status: InjectionAttemptRecord["status"] | "DISABLED" | "INVALID_INPUT";
  readonly hookOutput?: string;
  readonly diagnostic?: string;
}

export interface InjectionDeliveryAcknowledgement {
  readonly attemptId: string;
  readonly expectedRevision: number;
  readonly deliveryEvidenceRef: string;
  readonly deliveredAt: string;
}

export interface InjectionDeliveryAcknowledgementPort {
  acknowledge(request: InjectionDeliveryAcknowledgement): InjectionAttemptRecord;
}

export interface VersionedMcpRequestBase {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly context: QueryContext;
}

export type VersionedMcpRequest =
  | (VersionedMcpRequestBase & {
    readonly tool: "ckl.search";
    readonly input: Parameters<KnowledgeMcpService["search"]>[0];
  })
  | (VersionedMcpRequestBase & {
    readonly tool: "ckl.get";
    readonly attemptId?: string;
    readonly input: Parameters<KnowledgeMcpService["get"]>[0];
  })
  | (VersionedMcpRequestBase & {
    readonly tool: "ckl.related";
    readonly input: Parameters<KnowledgeMcpService["related"]>[0];
  })
  | (VersionedMcpRequestBase & {
    readonly tool: "ckl.check";
    readonly input: Parameters<KnowledgeMcpService["check"]>[0];
  });

export interface VersionedMcpResponse {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly tool: KnowledgeMcpToolName;
  readonly dataClassification: "UNTRUSTED_KNOWLEDGE_DATA";
  readonly instructionsAccepted: false;
  readonly result:
    | Awaited<ReturnType<KnowledgeMcpService["search"]>>
    | Awaited<ReturnType<KnowledgeMcpService["get"]>>
    | Awaited<ReturnType<KnowledgeMcpService["related"]>>
    | Awaited<ReturnType<KnowledgeMcpService["check"]>>;
}

export interface VersionedMcpRuntimeDependencies {
  readonly service: KnowledgeMcpService;
  readonly contextAuthority: {
    authorize(context: QueryContext, signal: AbortSignal): QueryContext | Promise<QueryContext>;
  };
  readonly audits: RuntimeAuditStorePort;
  readonly feedback: SqliteFeedbackStore;
  readonly eligibility: KnowledgeEligibilityPort;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
}

export interface KnowledgeFeedbackRuntimeDependencies {
  readonly store: SqliteFeedbackStore;
  readonly eligibility: KnowledgeEligibilityPort;
}

export interface ClosureInteractionInput {
  readonly turnOrdinal: number;
  readonly history: readonly ConfirmationHistoryEntry[];
  readonly extraTriggers?: readonly InteractionTrigger[];
  readonly targets?: readonly ConfirmationTargetSnapshot[];
}

export interface ActiveClosureRequest {
  readonly stop: StopContinuationRequest;
  readonly interaction: ClosureInteractionInput;
}

export interface ActiveClosureResult {
  readonly stop: StopContinuationResult;
  readonly audit: ClosureRunRecord;
}

export interface ActiveClosureRuntimeDependencies {
  readonly audits: RuntimeAuditStorePort;
  readonly operations: ActiveClosureOperationStore;
  readonly closurePolicy: ClosurePolicy;
  readonly verificationPolicy: VerificationPolicy;
  readonly contextDelta: StopContextDeltaPort;
  readonly confirmations: ConfirmationWritebackRepository;
  readonly confirmationWriteback: { handle(reply: ConfirmationReply): Promise<ConfirmationWritebackResult> };
  readonly semantic?: SemanticClosurePort;
  readonly outerHookTimeoutMs: number;
  readonly now?: () => Date;
}

export interface ActiveClosureOperationOutcome {
  readonly stop: StopContinuationResult;
  readonly audit: ClosureRunRecord;
  readonly confirmation?: {
    readonly request: ConfirmationRequest;
    readonly targets: readonly ConfirmationTargetSnapshot[];
  };
}

export interface ActiveClosureOperationState {
  readonly identityKey: string;
  readonly requestHash: string;
  readonly status: "PENDING" | "OUTCOME" | "COMPLETED";
  readonly outcome?: ActiveClosureOperationOutcome;
}

export interface ActiveClosureOperationStore {
  begin(identityKey: string, requestHash: string): ActiveClosureOperationState;
  saveOutcome(identityKey: string, requestHash: string, outcome: ActiveClosureOperationOutcome): ActiveClosureOperationState;
  complete(identityKey: string, requestHash: string): ActiveClosureOperationState;
}

export interface ActiveClosureRuntimePort {
  handle(request: ActiveClosureRequest): Promise<ActiveClosureResult>;
  writeback(reply: ConfirmationReply): Promise<ConfirmationWritebackResult>;
}

export interface McpUsageInput {
  readonly usageEventId: string;
  readonly expansionId: string;
  readonly traceId: string;
  readonly assetId: string;
  readonly version: number;
  readonly scopeKey: string;
  readonly occurredAt: string;
}

export interface FeedbackRecordResult {
  readonly result: "RECORDED" | "EXISTING";
  readonly eligibleAfterWrite: boolean;
}

export interface FeedbackRuntimePort {
  record(event: KnowledgeFeedbackEvent, version: number, signal?: AbortSignal): Promise<FeedbackRecordResult>;
  profile(scopeKey: string): FeedbackProfile;
}

export interface McpExpansionResult {
  readonly response: VersionedMcpResponse;
  readonly expansionAudits: readonly McpExpansionAuditRecord[];
}

export type { UserPromptSubmitInput, ClosureVerificationInput, RetrievalTrace, KnowledgeScope };
