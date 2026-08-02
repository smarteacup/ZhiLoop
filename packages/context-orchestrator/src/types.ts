import type { InjectionPolicy } from "@zhiloop/config";
import type { ContextComplexityLevel, ContextEnvelope, TaskContractBlock } from "@zhiloop/domain";
import type { RerankedKnowledge } from "@zhiloop/knowledge-reranker";
import type { QueryContext } from "@zhiloop/query-context";

export interface ContextOrchestrationSignals {
  readonly risk?: "LOW" | "MEDIUM" | "HIGH";
  readonly ambiguous?: boolean;
  readonly conflicting?: boolean;
}

export interface ContextFeedbackHint {
  readonly scopeKey: string;
  readonly preferredLevel: "L1_POINTER" | "L2_COMPACT" | "L3_EVIDENCED";
  readonly sampleCount: number;
  readonly reasonCodes: readonly string[];
}

export interface ContextOrchestrationRequest {
  readonly runId: string;
  readonly queryContext: QueryContext;
  readonly candidates: readonly RerankedKnowledge[];
  readonly policy: InjectionPolicy;
  readonly requestedLevel?: ContextComplexityLevel;
  readonly automatic?: boolean;
  readonly explicitEpisodeExpansion?: boolean;
  readonly maxTokens?: number;
  readonly signals?: ContextOrchestrationSignals;
  readonly taskContract?: TaskContractBlock;
  readonly feedback?: ContextFeedbackHint;
}

export interface ContextOrchestratorPort {
  orchestrate(request: ContextOrchestrationRequest): ContextEnvelope;
}
