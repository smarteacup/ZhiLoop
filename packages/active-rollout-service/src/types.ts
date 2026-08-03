import type {
  ActiveContextProvider,
  UserPromptInjectionResult,
  UserPromptSubmitInput,
} from "@zhiloop/codex-context-injection";
import type { GoldenDatasetReport } from "@zhiloop/retrieval-evaluation";

export type RolloutMode = "SHADOW" | "ACTIVE";

export interface ShadowTraceObservation {
  readonly traceId: string;
  readonly runId: string;
  readonly observedAt: string;
  readonly source: "PERSISTED_SHADOW_TRACE";
  readonly delivery: "SHADOWED" | "NO_CONTEXT" | "TIMEOUT" | "ERROR";
  readonly projectId?: string;
  readonly taskId?: string;
  readonly eligibleKnowledgeVersions: readonly string[];
}

export interface ShadowEligibilityCheck {
  readonly code:
    | "REAL_SHADOW_TRACES"
    | "DATASET_BOUND"
    | "CONFIG_BOUND"
    | "VERSION_BOUND"
    | "GOLDEN_GATE"
    | "TRACEABILITY"
    | "SCOPE_ISOLATION"
    | "FORBIDDEN_EXCLUSION"
    | "NO_AUTOMATIC_L4";
  readonly passed: boolean;
  readonly detail: string;
}

export interface ShadowEligibilityEvidence {
  readonly evidenceId: string;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly datasetFingerprint: string;
  readonly configFingerprint: string;
  readonly versionFingerprint: string;
  readonly traceIds: readonly string[];
  readonly observedFrom: string;
  readonly observedTo: string;
  readonly checks: readonly ShadowEligibilityCheck[];
  readonly eligible: boolean;
  readonly createdAt: string;
}

export interface ShadowQualityEvaluationInput {
  readonly report: GoldenDatasetReport;
  readonly traces: readonly ShadowTraceObservation[];
  readonly retrievalConfiguration: unknown;
  readonly componentVersions: Readonly<Record<string, string>>;
  readonly now: string;
}

export interface CanaryScope {
  readonly projectIds?: readonly string[];
  readonly sessionIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly percentageBasisPoints?: number;
  readonly allocationSalt: string;
}

export interface EffectiveRolloutRevision {
  readonly policyRevision: number;
  readonly mode: RolloutMode;
  readonly configFingerprint: string;
  readonly versionFingerprint: string;
  readonly canary?: CanaryScope;
  readonly evidenceId?: string;
}

export interface RolloutAuditRecord {
  readonly eventId: string;
  readonly kind: "BOOTSTRAP" | "ACTIVATED" | "DOWNGRADED";
  readonly stateRevision: number;
  readonly effectivePolicyRevision: number;
  readonly reasonCodes: readonly string[];
  readonly occurredAt: string;
}

export interface PersistedRolloutState {
  readonly schemaVersion: 1;
  readonly stateRevision: number;
  readonly effective: EffectiveRolloutRevision;
  readonly lastKnownGood: EffectiveRolloutRevision;
  readonly evidence: readonly ShadowEligibilityEvidence[];
  readonly audit: readonly RolloutAuditRecord[];
}

export interface RolloutStateStore {
  load(): PersistedRolloutState | undefined;
  save(next: PersistedRolloutState, expectedStateRevision: number): void;
}

export interface RolloutBootstrap {
  readonly policyRevision: number;
  readonly configFingerprint: string;
  readonly versionFingerprint: string;
  readonly now: string;
}

export interface ActivateCanaryRequest {
  readonly expectedStateRevision: number;
  readonly targetPolicyRevision: number;
  readonly configFingerprint: string;
  readonly versionFingerprint: string;
  readonly eligibilityEvidenceId: string;
  readonly canary: CanaryScope;
  readonly now: string;
}

export interface RolloutRequestScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectId?: string;
  readonly taskId?: string;
}

export interface RolloutDecision {
  readonly stateRevision: number;
  readonly policyRevision: number;
  readonly mode: RolloutMode;
  readonly reasonCode: "ACTIVE_CANARY_INCLUDED" | "GRAY_SCOPE_EXCLUDED" | "SHADOW_MODE" | "FAIL_SAFE_SHADOW";
}

export interface ScopedInjectionCoordinatorOptions {
  readonly deadlineMs?: number;
  readonly scopeResolver?: (input: UserPromptSubmitInput) => RolloutRequestScope;
}

export interface ScopedInjectionCoordinatorDependencies {
  readonly provider: ActiveContextProvider;
}

export interface ScopedInjectionResult extends UserPromptInjectionResult {
  readonly rolloutDecision: RolloutDecision;
}

export type HighRiskOperationKind =
  | "GLOBAL_PROMOTION"
  | "RULE_CHANGE"
  | "BINDING_CHANGE"
  | "PRIVACY_PURGE";

export type HighRiskPermission =
  | "PROMOTE_GLOBAL"
  | "CHANGE_RULE"
  | "CHANGE_BINDING"
  | "PURGE_PRIVATE_DATA";

export interface HighRiskGovernancePolicy {
  readonly revision: number;
  readonly activeStageEnabled: boolean;
  readonly enabledOperations: Readonly<Record<HighRiskOperationKind, boolean>>;
  readonly previewTtlMs: number;
}

export interface HighRiskGovernanceCommand {
  readonly kind: HighRiskOperationKind;
  readonly assetIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly reason: string;
  readonly payloadFingerprint: string;
}

export interface BlastRadius {
  readonly affectedAssets: number;
  readonly affectedProjects: number;
  readonly affectedRules: number;
  readonly affectedBindings: number;
  readonly affectedTraces: number;
  readonly affectedInjections: number;
  readonly irreversible: boolean;
  readonly reasonCodes: readonly string[];
}

export interface HighRiskGovernancePort {
  preview(command: HighRiskGovernanceCommand): BlastRadius | Promise<BlastRadius>;
  /** The implementation must durably conflict-check idempotencyKey and replay the same receipt after restart. */
  execute(
    command: HighRiskGovernanceCommand,
    identity: HighRiskExecutionIdentity,
  ): HighRiskExecutionReceipt | Promise<HighRiskExecutionReceipt>;
}

export interface HighRiskExecutionIdentity {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly previewId: string;
  readonly requestFingerprint: string;
}

export interface HighRiskExecutionReceipt {
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly outcome: "COMMITTED" | "REPLAYED";
  readonly committedAt: string;
}

export interface HighRiskPreview {
  readonly previewId: string;
  readonly policyRevision: number;
  readonly commandFingerprint: string;
  readonly command: HighRiskGovernanceCommand;
  readonly blastRadius: BlastRadius;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CommitHighRiskRequest {
  readonly preview: HighRiskPreview;
  readonly expectedPolicyRevision: number;
  readonly actor: string;
  readonly confirmationFingerprint: string;
  readonly now: string;
}

export interface HighRiskAuthorizationPort {
  /** Must resolve permission from the authenticated Sidecar principal, never from client-supplied claims. */
  hasPermission(actor: string, permission: HighRiskPermission): boolean | Promise<boolean>;
}

export interface HighRiskOperationResult {
  readonly operationId: string;
  readonly previewId: string;
  readonly kind: HighRiskOperationKind;
  readonly actor: string;
  readonly policyRevision: number;
  readonly blastRadius: BlastRadius;
  readonly committedAt: string;
}

export interface HighRiskGovernanceCommitRecord {
  readonly previewId: string;
  readonly requestFingerprint: string;
  readonly result: HighRiskOperationResult;
}

export interface HighRiskGovernanceStateStore {
  getPreview(previewId: string): HighRiskPreview | undefined;
  putPreview(preview: HighRiskPreview): void;
  getCommit(previewId: string): HighRiskGovernanceCommitRecord | undefined;
  putCommit(record: HighRiskGovernanceCommitRecord): void;
}
