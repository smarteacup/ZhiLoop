import type { ClosureGateResult, ClosureVerificationResult, ContextEnvelope, TaskContractBlock } from "@zhiloop/domain";

export type InjectionDeliveryStatus =
  | "PENDING"
  | "SHADOWED"
  | "INJECTED"
  | "NO_CONTEXT"
  | "ROLLED_BACK"
  | "TIMEOUT"
  | "ERROR";

export interface InjectionAttemptRecord {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly runId: string;
  readonly rolloutRevision: number;
  readonly status: InjectionDeliveryStatus;
  readonly revision: number;
  readonly envelope: ContextEnvelope;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface McpExpansionAuditRecord {
  readonly schemaVersion: 1;
  readonly expansionId: string;
  readonly attemptId: string;
  readonly traceId: string;
  readonly tool: "ckl.search" | "ckl.get" | "ckl.related" | "ckl.check";
  readonly knowledgeId: string;
  readonly knowledgeVersion: number;
  readonly fromDetailLevel: "L1_POINTER" | "L2_COMPACT";
  readonly toDetailLevel: "L2_COMPACT" | "L3_EVIDENCED";
  readonly latencyMs: number;
  readonly used: boolean;
  readonly occurredAt: string;
}

export interface ClosureRunRecord {
  readonly schemaVersion: 1;
  readonly closureRunId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly taskContract: TaskContractBlock;
  readonly gates: readonly ClosureGateResult[];
  readonly decision: ClosureVerificationResult["decision"];
  readonly correctionDelta?: string;
  readonly continuationCount: number;
  readonly recursiveStopRejected: boolean;
  readonly interaction?: {
    readonly required: boolean;
    readonly question?: string;
    readonly safeDefault?: string;
  };
  readonly createdAt: string;
}

export interface RuntimeAuditPage<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
}
