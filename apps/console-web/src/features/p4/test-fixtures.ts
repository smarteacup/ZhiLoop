import type {
  ClosureRunListView,
  ClosureRunView,
  FeedbackTargetView,
  HighRiskGovernanceView,
  P4ActionGate,
  P4ConsoleApi,
  RolloutView,
  SessionInjectionView,
} from "../../api/p4.js";

export const readyGate: P4ActionGate = { enabled: true, capabilityStatus: "READY", reasonCode: "ACTION_READY", expectedRevision: 2, idempotencyKey: "idem-2" };
const injection: SessionInjectionView = {
  observedAt: "2026-08-04T00:00:00.000Z", truncated: false, capabilityStatus: "READY", capabilityReasonCode: "COMPONENT_READY",
  attempts: [
    { attemptId: "attempt-shadow", sessionId: "session-1", turnId: "turn-shadow", runId: "run-1", retrievalTraceId: "trace-1", rolloutRevision: 1, status: "SHADOWED", reasonCode: "SHADOW_MODE", envelope: { mode: "SHADOW", detailLevel: "L1_POINTER", maxTokens: 1_000, estimatedTokens: 100, items: [{ knowledgeId: "knowledge-1", version: 2, detailLevel: "L1_POINTER", estimatedTokens: 100 }], omitted: [{ knowledgeId: "knowledge-2", version: 1, reasonCode: "TOKEN_BUDGET" }], reasonCodes: ["SHADOW_MODE"] }, createdAt: "2026-08-04T00:00:00.000Z", completedAt: "2026-08-04T00:00:00.010Z", mcpExpansions: [],
    },
    { attemptId: "attempt-actual", sessionId: "session-1", turnId: "turn-actual", runId: "run-2", retrievalTraceId: "trace-2", rolloutRevision: 2, status: "INJECTED", reasonCode: "ACTIVE_CANARY_INCLUDED", envelope: { mode: "ACTUAL", detailLevel: "L2_COMPACT", maxTokens: 1_000, estimatedTokens: 200, items: [{ knowledgeId: "knowledge-1", version: 2, detailLevel: "L2_COMPACT", estimatedTokens: 200 }], omitted: [], reasonCodes: ["ACTIVE_CANARY_INCLUDED"] }, deliveryEvidenceRef: "delivery-evidence-1", createdAt: "2026-08-04T00:00:00.000Z", completedAt: "2026-08-04T00:00:00.010Z", mcpExpansions: [{ expansionId: "expansion-1", tool: "ckl.get", knowledgeId: "knowledge-1", knowledgeVersion: 2, fromDetailLevel: "L1_POINTER", toDetailLevel: "L2_COMPACT", latencyMs: 4, used: true, occurredAt: "2026-08-04T00:00:00.005Z" }],
    },
  ],
};
export const closure: ClosureRunView = { closureRunId: "closure-1", sessionId: "session-1", turnId: "turn-actual", createdAt: "2026-08-04T00:01:00.000Z", taskContract: { objective: "完成实现", boundaries: ["不修改凭证"], completionGates: ["测试通过"] }, gates: [{ gateId: "gate-1", label: "unit tests", status: "SATISFIED", evidenceRefs: ["test-run-1"], reasonCode: "TESTS_PASSED" }], decision: "PASS", continuationCount: 0, continuationLimit: 1, recursiveStopRejected: false, interaction: { required: false, confirmationStatus: "NOT_REQUIRED" } };
const closures: ClosureRunListView = { capabilityStatus: "READY", capabilityReasonCode: "COMPONENT_READY", truncated: false, items: [closure] };
export const feedbackTarget: FeedbackTargetView = { knowledgeId: "knowledge-1", version: 2, title: "安全边界", eligible: true, eligibilityReasonCodes: [], mcpUsed: true, actions: { RELEVANT: readyGate, IRRELEVANT: readyGate, PIN: readyGate, SUPPRESS: readyGate, MCP_USED: readyGate } };
const FP = `sha256:${"a".repeat(64)}`;
const OLD_FP = `sha256:${"b".repeat(64)}`;
const DATASET_FP = `sha256:${"c".repeat(64)}`;
export const rollout: RolloutView = { capabilityStatus: "READY", capabilityReasonCode: "COMPONENT_READY", stateRevision: 3, effective: { policyRevision: 2, mode: "ACTIVE", configFingerprint: FP, versionFingerprint: FP, evidenceId: "evidence-1", canary: { projectIds: ["project-1"], percentageBasisPoints: 500, allocationSalt: "salt-1" } }, lastKnownGood: { policyRevision: 1, mode: "SHADOW", configFingerprint: OLD_FP, versionFingerprint: OLD_FP }, eligibility: [{ evidenceId: "evidence-1", datasetFingerprint: DATASET_FP, configFingerprint: FP, versionFingerprint: FP, traceCount: 10, eligible: true, checks: [{ code: "TRACEABILITY", passed: true, detail: "rate=1" }], createdAt: "2026-08-04T00:00:00.000Z" }], lastTransition: { kind: "ACTIVATED", reasonCodes: ["ACTIVE_CANARY_INCLUDED"], occurredAt: "2026-08-04T00:02:00.000Z" } };
export const disabledHighRisk: HighRiskGovernanceView = { policyRevision: 1, activeStageEnabled: false, actor: "local-operator", actions: { GLOBAL_PROMOTION: { enabled: false, capabilityStatus: "DISABLED", reasonCode: "ACTIVE_STAGE_DISABLED" }, RULE_CHANGE: { enabled: false, capabilityStatus: "DISABLED", reasonCode: "ACTIVE_STAGE_DISABLED" }, BINDING_CHANGE: { enabled: false, capabilityStatus: "DISABLED", reasonCode: "ACTIVE_STAGE_DISABLED" }, PRIVACY_PURGE: { enabled: false, capabilityStatus: "DISABLED", reasonCode: "ACTIVE_STAGE_DISABLED" } } };

export function p4Api(overrides: Partial<P4ConsoleApi> = {}): P4ConsoleApi {
  return {
    sessionInjections: async () => injection,
    closureRuns: async () => closures,
    closureRun: async () => closure,
    feedbackTargets: async () => [feedbackTarget],
    recordFeedback: async () => ({ result: "RECORDED", eligibleAfterWrite: true, revision: 3, reasonCode: "FEEDBACK_RECORDED" }),
    rollout: async () => rollout,
    highRiskGovernance: async () => disabledHighRisk,
    previewHighRisk: async () => { throw new Error("disabled"); },
    commitHighRisk: async () => { throw new Error("disabled"); },
    ...overrides,
  };
}
