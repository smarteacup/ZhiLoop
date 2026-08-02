export const CLOSURE_DECISIONS = ["PASS", "RETRY_WITH_CONTEXT", "RETRY_WITH_CORRECTION", "ASK_USER"] as const;
export type ClosureDecision = (typeof CLOSURE_DECISIONS)[number];
export type ClosureGateStatus = "SATISFIED" | "UNSATISFIED" | "UNKNOWN";

export interface ClosureGateResult {
  readonly gateId: string;
  readonly status: ClosureGateStatus;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ClosureVerificationResult {
  readonly schemaVersion: 1;
  readonly verificationId: string;
  readonly taskId: string;
  readonly decision: ClosureDecision;
  readonly reasonCodes: readonly string[];
  readonly missingKnowledgeIds: readonly string[];
  readonly unmetGateIds: readonly string[];
  readonly violatedBoundaryIds: readonly string[];
  readonly gateResults: readonly ClosureGateResult[];
}
