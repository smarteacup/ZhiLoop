import type { ClosureGateResult, ContextComplexityLevel, ContextEnvelope } from "@zhiloop/domain";

export type ClosureGate =
  | { readonly gateId: string; readonly description: string; readonly type: "TEST_PASSED"; readonly testId: string }
  | { readonly gateId: string; readonly description: string; readonly type: "ARTIFACT_PRESENT"; readonly artifactId: string }
  | { readonly gateId: string; readonly description: string; readonly type: "PATH_CHANGED"; readonly path: string }
  | { readonly gateId: string; readonly description: string; readonly type: "TOOL_SUCCEEDED"; readonly toolName: string }
  | { readonly gateId: string; readonly description: string; readonly type: "NO_OPEN_ISSUES" }
  | { readonly gateId: string; readonly description: string; readonly type: "SEMANTIC" };

export interface ClosureBoundary {
  readonly boundaryId: string;
  readonly type: "FORBID_PATH_PREFIX";
  readonly pathPrefix: string;
}

export interface ClosureKnowledgeRequirement {
  readonly knowledgeId: string;
  readonly minimumDetailLevel: Exclude<ContextComplexityLevel, "L0_NONE" | "L4_EPISODE">;
}

export interface ClosureVerificationInput {
  readonly verificationId: string;
  readonly task: {
    readonly taskId: string;
    readonly objective: string;
    readonly gates: readonly ClosureGate[];
    readonly boundaries: readonly ClosureBoundary[];
    readonly requiredKnowledge: readonly ClosureKnowledgeRequirement[];
  };
  readonly contextEnvelope: ContextEnvelope;
  readonly diff: { readonly changedPaths: readonly string[]; readonly summary: string };
  readonly toolResults: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly status: "SUCCEEDED" | "FAILED";
    readonly artifactIds: readonly string[];
    readonly summary: string;
  }[];
  readonly tests: readonly { readonly testId: string; readonly status: "PASSED" | "FAILED" | "NOT_RUN"; readonly summary: string }[];
  readonly finalConclusion: { readonly claimedComplete: boolean; readonly summary: string; readonly openIssues: readonly string[] };
}

export interface SemanticClosureRequest {
  readonly objective: string;
  readonly gates: readonly { readonly gateId: string; readonly description: string }[];
  readonly contextEnvelope: ContextEnvelope;
  readonly diff: ClosureVerificationInput["diff"];
  readonly toolResults: ClosureVerificationInput["toolResults"];
  readonly tests: ClosureVerificationInput["tests"];
  readonly finalConclusion: ClosureVerificationInput["finalConclusion"];
  readonly signal: AbortSignal;
}

export interface SemanticClosureResult { readonly gateResults: readonly ClosureGateResult[] }
export interface SemanticClosurePort {
  readonly available: boolean;
  verify(request: SemanticClosureRequest): Promise<SemanticClosureResult>;
}
