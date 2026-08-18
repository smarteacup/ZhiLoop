import type {
  BlastRadius,
  HighRiskOperationResult,
  HighRiskPreview,
  PersistedRolloutState,
} from "@zhiloop/active-rollout-service";
import type { FeedbackRecordResult } from "@zhiloop/active-knowledge-runtime";
import type {
  InjectionAttemptRecord,
} from "@zhiloop/runtime-audit-store";
import { z } from "zod";

const safeId = z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const reasonCode = z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/u);
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const iso = z.iso.datetime({ offset: true });
const text = (maximum: number): z.ZodString => z.string().min(1).max(maximum).refine(
  (value) => !value.includes("\0"), { message: "text cannot contain NUL" },
);
const safeStrings = (maximumItems = 100, maximumLength = 1_000) => z.array(text(maximumLength)).max(maximumItems);

const scopeSchema = z.discriminatedUnion("level", [
  z.strictObject({ level: z.literal("TASK"), taskId: safeId, projectId: safeId.optional(), repositoryRemote: text(4_096).optional() }),
  z.strictObject({ level: z.literal("SYMBOL"), projectId: safeId, repositoryRemote: text(4_096).optional(), symbols: safeStrings().min(1) }),
  z.strictObject({ level: z.literal("MODULE"), projectId: safeId, repositoryRemote: text(4_096).optional(), modulePaths: safeStrings().min(1) }),
  z.strictObject({ level: z.literal("PROJECT"), projectId: safeId, repositoryRemote: text(4_096).optional() }),
  z.strictObject({ level: z.literal("USER"), userId: safeId }),
  z.strictObject({ level: z.literal("TEAM"), teamId: safeId }),
  z.strictObject({ level: z.literal("GLOBAL") }),
]);

const taskContractSchema = z.strictObject({
  contractId: safeId,
  objective: text(100_000),
  gates: safeStrings(100, 10_000),
  boundaries: safeStrings(100, 10_000),
});

const contextItemSchema = z.strictObject({
  id: safeId,
  version: z.number().int().positive(),
  subjectKey: text(1_000),
  kind: z.enum(["FACT", "REQUIREMENT", "DESIGN", "DECISION", "IMPLEMENTATION", "EXPERIENCE", "RULE", "PREFERENCE", "OPEN_QUESTION"]),
  status: z.enum(["PROPOSED", "ACCEPTED", "IMPLEMENTED", "VERIFIED", "REJECTED", "STALE", "SUPERSEDED"]),
  scope: scopeSchema,
  authority: z.enum(["BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE"]),
  detailLevel: z.enum(["L1_POINTER", "L2_COMPACT", "L3_EVIDENCED", "L4_EPISODE"]),
  title: text(10_000),
  summary: text(100_000),
  retrievalRank: z.number().int().nonnegative(),
  applicability: safeStrings(100, 10_000).optional(),
  failurePaths: safeStrings(100, 10_000).optional(),
  symbols: safeStrings(100, 10_000).optional(),
  content: text(1_000_000).optional(),
  evidencePointers: safeStrings(1_000, 10_000).optional(),
  evidenceSummary: z.array(z.strictObject({
    evidenceId: safeId,
    verdict: z.enum(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]),
  })).max(1_000).optional(),
  sourceEpisodes: safeStrings(1_000, 10_000).optional(),
});

export const contextEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: safeId,
  projectId: safeId.optional(),
  taskId: safeId.optional(),
  complexity: z.strictObject({
    level: z.enum(["L0_NONE", "L1_POINTER", "L2_COMPACT", "L3_EVIDENCED", "L4_EPISODE"]),
    breadth: z.number().int().nonnegative(),
    depth: z.enum(["NONE", "POINTER", "COMPACT", "EVIDENCED", "EPISODE"]),
    authority: z.enum(["BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE", "MIXED", "NONE"]),
    evidence: z.enum(["NONE", "POINTER", "SUMMARY", "EPISODE"]),
    reasonCodes: z.array(reasonCode).max(100),
  }),
  budget: z.strictObject({
    maxTokens: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    truncated: z.boolean(),
    disclosedItems: z.number().int().nonnegative(),
    omittedItems: z.number().int().nonnegative(),
  }),
  items: z.array(contextItemSchema).max(1_000),
  taskContract: taskContractSchema.optional(),
});

export const injectionAttemptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attemptId: safeId,
  sessionId: safeId,
  turnId: safeId,
  traceId: safeId,
  runId: safeId,
  rolloutRevision: z.number().int().nonnegative(),
  status: z.enum(["PENDING", "SHADOWED", "INJECTED", "NO_CONTEXT", "ROLLED_BACK", "TIMEOUT", "ERROR"]),
  revision: z.number().int().nonnegative(),
  envelope: contextEnvelopeSchema,
  reasonCode,
  createdAt: iso,
  completedAt: iso.optional(),
  deliveryEvidenceRef: safeId.optional(),
  deliveredAt: iso.optional(),
}).superRefine((value, context) => {
  if (value.envelope.runId !== value.runId) context.addIssue({ code: "custom", path: ["envelope", "runId"], message: "runId mismatch" });
  if ((value.status === "PENDING") !== (value.completedAt === undefined)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "terminal status/completion mismatch" });
  }
  const acknowledged = value.deliveryEvidenceRef !== undefined || value.deliveredAt !== undefined;
  if (acknowledged !== (value.deliveryEvidenceRef !== undefined && value.deliveredAt !== undefined)) {
    context.addIssue({ code: "custom", path: ["deliveryEvidenceRef"], message: "delivery evidence and timestamp must be present together" });
  }
  if (acknowledged && (value.status !== "INJECTED" || value.revision !== 2)) {
    context.addIssue({ code: "custom", path: ["status"], message: "acknowledged delivery requires revision two INJECTED" });
  }
  if (!acknowledged && value.status !== "PENDING" && value.revision !== 1) {
    context.addIssue({ code: "custom", path: ["revision"], message: "unacknowledged terminal delivery requires revision one" });
  }
  if (value.status === "PENDING" && value.revision !== 0) {
    context.addIssue({ code: "custom", path: ["revision"], message: "pending delivery requires revision zero" });
  }
  if (value.deliveredAt !== undefined && value.completedAt !== undefined
    && Date.parse(value.deliveredAt) < Date.parse(value.completedAt)) {
    context.addIssue({ code: "custom", path: ["deliveredAt"], message: "delivery cannot precede generation completion" });
  }
});

export const mcpExpansionSchema = z.strictObject({
  schemaVersion: z.literal(1), expansionId: safeId, attemptId: safeId.optional(), traceId: safeId,
  tool: z.enum(["ckl.search", "ckl.get", "ckl.related", "ckl.check"]),
  knowledgeId: safeId, knowledgeVersion: z.number().int().positive(),
  fromDetailLevel: z.enum(["L1_POINTER", "L2_COMPACT"]),
  toDetailLevel: z.enum(["L2_COMPACT", "L3_EVIDENCED"]),
  latencyMs: z.number().int().nonnegative(), used: z.boolean(), occurredAt: iso,
}).superRefine((value, context) => {
  if (value.fromDetailLevel === "L2_COMPACT" && value.toDetailLevel !== "L3_EVIDENCED") {
    context.addIssue({ code: "custom", path: ["toDetailLevel"], message: "invalid detail transition" });
  }
});

export const closureRunSchema = z.strictObject({
  schemaVersion: z.literal(1), closureRunId: safeId, sessionId: safeId, turnId: safeId,
  taskContract: taskContractSchema,
  gates: z.array(z.strictObject({
    gateId: safeId,
    status: z.enum(["SATISFIED", "UNSATISFIED", "UNKNOWN"]),
    reasonCodes: z.array(reasonCode).max(100),
    evidenceRefs: safeStrings(100, 10_000),
  })).max(100),
  decision: z.enum(["PASS", "RETRY_WITH_CONTEXT", "RETRY_WITH_CORRECTION", "ASK_USER"]),
  correctionDelta: text(100_000).optional(),
  continuationCount: z.number().int().min(0).max(100),
  recursiveStopRejected: z.boolean(),
  interaction: z.strictObject({ required: z.boolean(), question: text(100_000).optional(), safeDefault: text(10_000).optional() }).optional(),
  createdAt: iso,
});

const pageRequest = {
  schemaVersion: z.literal(1),
  sessionId: safeId,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(16).max(4_096).optional(),
} as const;

export const injectionListRequestSchema = z.strictObject({ ...pageRequest, type: z.literal("p4.injections.list") });
export const injectionDetailRequestSchema = z.strictObject({
  schemaVersion: z.literal(1), type: z.literal("p4.injections.get"), sessionId: safeId, attemptId: safeId,
});
export const contextRefreshRequestSchema = z.strictObject({
  schemaVersion: z.literal(1), type: z.literal("p4.context.refresh"), sessionId: safeId, idempotencyKey: safeId,
});
export const contextRefreshResponseSchema = z.strictObject({
  sessionId: safeId,
  removedEntries: z.number().int().nonnegative().max(1_000_000),
  refreshedAt: iso,
  reasonCode: reasonCode,
});
export type P4ContextRefreshResponse = z.infer<typeof contextRefreshResponseSchema>;
export const mcpExpansionListRequestSchema = z.strictObject({
  ...pageRequest, type: z.literal("p4.mcp-expansions.list"), attemptId: safeId,
});
export const closureListRequestSchema = z.strictObject({ ...pageRequest, type: z.literal("p4.closures.list") });
export const closureDetailRequestSchema = z.strictObject({
  schemaVersion: z.literal(1), type: z.literal("p4.closures.get"), sessionId: safeId, closureRunId: safeId,
});

const commandBase = {
  schemaVersion: z.literal(1),
  idempotencyKey: safeId,
  occurredAt: iso,
} as const;

export const feedbackCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...commandBase, type: z.literal("p4.feedback.record"), action: z.enum(["RELEVANT", "IRRELEVANT", "PIN", "SUPPRESS"]), assetId: safeId, expectedKnowledgeVersion: z.number().int().positive(), scopeKey: text(1_000), traceId: safeId, actor: text(1_000) }),
  z.strictObject({ ...commandBase, type: z.literal("p4.feedback.record"), action: z.literal("MCP_USE"), expansionId: safeId, assetId: safeId, expectedKnowledgeVersion: z.number().int().positive(), scopeKey: text(1_000), traceId: safeId }),
]);

export const highRiskCommandSchema = z.strictObject({
  kind: z.enum(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"]),
  assetIds: z.array(safeId).min(1).max(10_000),
  projectIds: z.array(safeId).max(1_000),
  reason: text(1_000),
  payloadFingerprint: fingerprint,
});
export const blastRadiusSchema = z.strictObject({
  affectedAssets: z.number().int().min(1).max(1_000_000_000),
  affectedProjects: z.number().int().min(0).max(1_000_000_000),
  affectedRules: z.number().int().min(0).max(1_000_000_000),
  affectedBindings: z.number().int().min(0).max(1_000_000_000),
  affectedTraces: z.number().int().min(0).max(1_000_000_000),
  affectedInjections: z.number().int().min(0).max(1_000_000_000),
  irreversible: z.boolean(),
  reasonCodes: z.array(reasonCode).min(1).max(100),
});
export const highRiskPreviewSchema = z.strictObject({
  previewId: fingerprint,
  policyRevision: z.number().int().positive(),
  commandFingerprint: fingerprint,
  command: highRiskCommandSchema,
  blastRadius: blastRadiusSchema,
  createdAt: iso,
  expiresAt: iso,
});
export const highRiskPreviewRequestSchema = z.strictObject({
  ...commandBase,
  type: z.literal("p4.high-risk.preview"),
  expectedPolicyRevision: z.number().int().positive(),
  command: highRiskCommandSchema,
});
export const highRiskCommitRequestSchema = z.strictObject({
  ...commandBase,
  type: z.literal("p4.high-risk.commit"),
  expectedPolicyRevision: z.number().int().positive(),
  previewId: fingerprint,
  confirmationPhrase: text(1_000),
});

export const feedbackResponseSchema = z.strictObject({
  outcome: z.enum(["RECORDED", "EXISTING"]),
  eligibleAfterWrite: z.boolean(),
});
export const highRiskPreviewResponseSchema = z.strictObject({
  preview: highRiskPreviewSchema,
  blastRadius: blastRadiusSchema,
  confirmationPhrase: text(1_000),
});
export const highRiskOperationResultSchema = z.strictObject({
  operationId: fingerprint,
  previewId: fingerprint,
  kind: z.enum(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"]),
  actor: safeId,
  policyRevision: z.number().int().positive(),
  blastRadius: blastRadiusSchema,
  committedAt: iso,
});
export const highRiskCommitResponseSchema = z.strictObject({ result: highRiskOperationResultSchema });

export const canaryScopeSchema = z.strictObject({
  projectIds: z.array(safeId).min(1).max(1_000).optional(),
  sessionIds: z.array(safeId).min(1).max(1_000).optional(),
  taskIds: z.array(safeId).min(1).max(1_000).optional(),
  percentageBasisPoints: z.number().int().min(1).max(10_000).optional(),
  allocationSalt: safeId,
}).superRefine((value, context) => {
  const hasSelector = value.projectIds !== undefined || value.sessionIds !== undefined || value.taskIds !== undefined;
  if (!hasSelector && (value.percentageBasisPoints ?? 10_000) === 10_000) {
    context.addIssue({ code: "custom", path: ["percentageBasisPoints"], message: "global 100% canary is forbidden" });
  }
});
const effectiveRolloutSchema = z.strictObject({
  policyRevision: z.number().int().positive(), mode: z.enum(["SHADOW", "ACTIVE"]),
  configFingerprint: fingerprint, versionFingerprint: fingerprint,
  canary: canaryScopeSchema.optional(), evidenceId: fingerprint.optional(),
});
const eligibilityCheckSchema = z.strictObject({
  code: z.enum(["REAL_SHADOW_TRACES", "DATASET_BOUND", "CONFIG_BOUND", "VERSION_BOUND", "GOLDEN_GATE", "TRACEABILITY", "SCOPE_ISOLATION", "FORBIDDEN_EXCLUSION", "NO_AUTOMATIC_L4"]),
  passed: z.boolean(), detail: text(10_000),
});
const eligibilityEvidenceSchema = z.strictObject({
  evidenceId: fingerprint, datasetId: safeId, datasetVersion: z.number().int().positive(),
  datasetFingerprint: fingerprint, configFingerprint: fingerprint, versionFingerprint: fingerprint,
  traceIds: z.array(safeId).min(1).max(10_000), observedFrom: iso, observedTo: iso,
  checks: z.array(eligibilityCheckSchema).length(9), eligible: z.boolean(), createdAt: iso,
});
const rolloutAuditSchema = z.strictObject({
  eventId: fingerprint, kind: z.enum(["BOOTSTRAP", "ACTIVATED", "DOWNGRADED"]),
  stateRevision: z.number().int().positive(), effectivePolicyRevision: z.number().int().positive(),
  reasonCodes: z.array(reasonCode).min(1).max(100), occurredAt: iso,
});
export const rolloutStateSchema = z.strictObject({
  schemaVersion: z.literal(1), stateRevision: z.number().int().positive(),
  effective: effectiveRolloutSchema, lastKnownGood: effectiveRolloutSchema,
  evidence: z.array(eligibilityEvidenceSchema).max(1_000), audit: z.array(rolloutAuditSchema).min(1).max(10_000),
});

export interface CursorPage<T> { readonly items: readonly T[]; readonly nextCursor?: string }
export interface InjectionAttemptView extends InjectionAttemptRecord {
  readonly tokenBudget: InjectionAttemptRecord["envelope"]["budget"];
  readonly omittedReasonCodes: readonly string[];
}
export interface P4Capability {
  readonly capability: "INJECTION_AUDIT" | "MCP_AUDIT" | "CLOSURE_AUDIT" | "FEEDBACK" | "ROLLOUT" | "HIGH_RISK_GOVERNANCE";
  readonly state: "READY" | "DISABLED" | "NOT_CONFIGURED" | "DEGRADED";
  readonly reasonCode: string;
  readonly evidenceRefs: readonly string[];
}
export type FeedbackCommand = z.infer<typeof feedbackCommandSchema>;
export type HighRiskPreviewRequest = z.infer<typeof highRiskPreviewRequestSchema>;
export type HighRiskCommitRequest = z.infer<typeof highRiskCommitRequestSchema>;
export interface P4FeedbackResponse { readonly outcome: FeedbackRecordResult["result"]; readonly eligibleAfterWrite: boolean }
export interface P4HighRiskPreviewResponse { readonly preview: HighRiskPreview; readonly blastRadius: BlastRadius; readonly confirmationPhrase: string }
export interface P4HighRiskCommitResponse { readonly result: HighRiskOperationResult }
export interface P4RolloutView { readonly state: PersistedRolloutState; readonly activeCanary: PersistedRolloutState["effective"]["canary"]; readonly downgradeHistory: PersistedRolloutState["audit"]; readonly rollbackTarget: PersistedRolloutState["lastKnownGood"] }
