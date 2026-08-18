import { z } from "zod";

const safeText = (maximum: number) => z.string().min(1).max(maximum).refine((value) => !value.includes("\0"));
const safeId = safeText(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u);
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(20).max(40).refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, { message: "timestamp must be canonical ISO-8601" });

export const p4CapabilityStatusSchema = z.enum(["READY", "DEGRADED", "NOT_VERIFIED", "NOT_CONFIGURED", "DISABLED", "FAILED"]);
export const p4ActionGateSchema = z.strictObject({
  enabled: z.boolean(),
  capabilityStatus: p4CapabilityStatusSchema,
  reasonCode: safeText(120),
  expectedRevision: revision.optional(),
  idempotencyKey: safeId.optional(),
}).superRefine((gate, context) => {
  if (gate.enabled && (gate.capabilityStatus !== "READY" || gate.expectedRevision === undefined || gate.idempotencyKey === undefined)) {
    context.addIssue({ code: "custom", message: "enabled action requires READY capability and revision-bound identity" });
  }
});

export const injectionDeliveryStatusSchema = z.enum([
  "PENDING", "SHADOWED", "INJECTED", "NO_CONTEXT", "ROLLED_BACK", "TIMEOUT", "ERROR",
]);
const envelopeItemSchema = z.strictObject({
  knowledgeId: safeId,
  version: revision,
  detailLevel: z.enum(["L1_POINTER", "L2_COMPACT", "L3_EVIDENCED"]),
  estimatedTokens: count.optional(),
});
const contextEnvelopeViewSchema = z.strictObject({
  mode: z.enum(["SHADOW", "ACTUAL"]),
  detailLevel: z.enum(["L0_NONE", "L1_POINTER", "L2_COMPACT", "L3_EVIDENCED"]),
  maxTokens: count,
  estimatedTokens: count,
  items: z.array(envelopeItemSchema).max(100).readonly(),
  omitted: z.array(z.strictObject({ knowledgeId: safeId, version: revision, reasonCode: safeText(120) })).max(1_000).readonly(),
  omittedCount: count.optional(),
  reasonCodes: z.array(safeText(120)).max(100).readonly(),
}).superRefine((envelope, context) => {
  if (envelope.estimatedTokens > envelope.maxTokens) context.addIssue({ code: "custom", path: ["estimatedTokens"], message: "envelope exceeds token budget" });
  const selected = envelope.items.map((item) => `${item.knowledgeId}@${item.version}`);
  const omitted = envelope.omitted.map((item) => `${item.knowledgeId}@${item.version}`);
  if (new Set(selected).size !== selected.length || new Set(omitted).size !== omitted.length || selected.some((key) => omitted.includes(key))) {
    context.addIssue({ code: "custom", path: ["items"], message: "envelope knowledge versions must be unique and disjoint" });
  }
});
const mcpExpansionViewSchema = z.strictObject({
  expansionId: safeId,
  tool: z.enum(["ckl.search", "ckl.get", "ckl.related", "ckl.check"]),
  knowledgeId: safeId,
  knowledgeVersion: revision,
  fromDetailLevel: z.enum(["L1_POINTER", "L2_COMPACT"]),
  toDetailLevel: z.enum(["L2_COMPACT", "L3_EVIDENCED"]),
  latencyMs: count,
  used: z.boolean(),
  occurredAt: timestamp,
});
export const injectionAttemptViewSchema = z.strictObject({
  attemptId: safeId,
  sessionId: safeId,
  turnId: safeId,
  runId: safeId,
  retrievalTraceId: safeId,
  rolloutRevision: count,
  status: injectionDeliveryStatusSchema,
  reasonCode: safeText(120),
  envelope: contextEnvelopeViewSchema,
  deliveryEvidenceRef: safeId.optional(),
  createdAt: timestamp,
  completedAt: timestamp.optional(),
  mcpExpansions: z.array(mcpExpansionViewSchema).max(500).readonly(),
}).superRefine((attempt, context) => {
  if (attempt.status === "INJECTED" && (attempt.envelope.mode !== "ACTUAL" || attempt.deliveryEvidenceRef === undefined)) {
    context.addIssue({ code: "custom", path: ["status"], message: "INJECTED requires actual envelope and delivery evidence" });
  }
  if (attempt.status === "SHADOWED" && attempt.envelope.mode !== "SHADOW") {
    context.addIssue({ code: "custom", path: ["status"], message: "SHADOWED requires shadow envelope" });
  }
});
export const sessionInjectionViewSchema = z.strictObject({
  observedAt: timestamp,
  truncated: z.boolean(),
  capabilityStatus: p4CapabilityStatusSchema,
  capabilityReasonCode: safeText(120),
  attempts: z.array(injectionAttemptViewSchema).max(200).readonly(),
});

const taskContractSchema = z.strictObject({
  objective: safeText(10_000),
  boundaries: z.array(safeText(2_000)).max(100).readonly(),
  completionGates: z.array(safeText(2_000)).max(100).readonly(),
});
const closureGateSchema = z.strictObject({
  gateId: safeId,
  label: safeText(500),
  status: z.enum(["SATISFIED", "UNSATISFIED", "UNKNOWN"]),
  evidenceRefs: z.array(safeId).max(100).readonly(),
  reasonCode: safeText(120),
});
export const closureRunViewSchema = z.strictObject({
  closureRunId: safeId,
  sessionId: safeId,
  turnId: safeId,
  createdAt: timestamp,
  taskContract: taskContractSchema,
  gates: z.array(closureGateSchema).max(100).readonly(),
  decision: z.enum(["PASS", "RETRY_WITH_CONTEXT", "RETRY_WITH_CORRECTION", "ASK_USER"]),
  correctionDelta: z.string().max(20_000).optional(),
  continuationCount: count,
  continuationLimit: count.optional(),
  recursiveStopRejected: z.boolean(),
  interaction: z.strictObject({
    required: z.boolean(),
    question: safeText(2_000).optional(),
    answer: safeText(5_000).optional(),
    safeDefault: safeText(2_000).optional(),
    confirmationStatus: z.enum(["NOT_REQUIRED", "PENDING", "CONFIRMED", "DEFAULTED", "REJECTED"]),
  }).optional(),
}).superRefine((run, context) => {
  if (run.continuationLimit !== undefined && run.continuationCount > run.continuationLimit) context.addIssue({ code: "custom", path: ["continuationCount"], message: "continuation count exceeds limit" });
});
export const closureRunListViewSchema = z.strictObject({
  capabilityStatus: p4CapabilityStatusSchema,
  capabilityReasonCode: safeText(120),
  truncated: z.boolean(),
  items: z.array(closureRunViewSchema).max(200).readonly(),
});

export const feedbackKindSchema = z.enum(["RELEVANT", "IRRELEVANT", "PIN", "SUPPRESS", "MCP_USED"]);
export const feedbackTargetViewSchema = z.strictObject({
  knowledgeId: safeId,
  version: revision,
  title: safeText(500),
  eligible: z.boolean(),
  eligibilityReasonCodes: z.array(safeText(120)).max(100).readonly(),
  mcpUsed: z.boolean(),
  scopeKey: safeText(1_000),
  traceId: safeId,
  expansionId: safeId.optional(),
  actions: z.record(feedbackKindSchema, p4ActionGateSchema),
});
export const feedbackReceiptSchema = z.strictObject({
  result: z.enum(["RECORDED", "EXISTING"]),
  eligibleAfterWrite: z.boolean(),
  revision,
  reasonCode: safeText(120),
});

const canaryScopeSchema = z.strictObject({
  projectIds: z.array(safeId).max(1_000).readonly().optional(),
  sessionIds: z.array(safeId).max(1_000).readonly().optional(),
  taskIds: z.array(safeId).max(1_000).readonly().optional(),
  percentageBasisPoints: z.number().int().min(1).max(10_000).optional(),
  allocationSalt: safeId,
}).superRefine((canary, context) => {
  const selectors = [canary.projectIds, canary.sessionIds, canary.taskIds].filter((value) => value !== undefined);
  if (selectors.some((value) => value.length === 0)) {
    context.addIssue({ code: "custom", message: "canary selectors cannot be empty" });
  }
  if (selectors.length === 0 && (canary.percentageBasisPoints ?? 10_000) === 10_000) {
    context.addIssue({ code: "custom", message: "ACTIVE requires a scoped canary" });
  }
});
const rolloutRevisionSchema = z.strictObject({
  policyRevision: revision,
  mode: z.enum(["SHADOW", "ACTIVE"]),
  configFingerprint: fingerprint,
  versionFingerprint: fingerprint,
  canary: canaryScopeSchema.optional(),
  evidenceId: safeId.optional(),
});
export const rolloutViewSchema = z.strictObject({
  capabilityStatus: p4CapabilityStatusSchema,
  capabilityReasonCode: safeText(120),
  stateRevision: revision,
  effective: rolloutRevisionSchema,
  lastKnownGood: rolloutRevisionSchema,
  eligibility: z.array(z.strictObject({
    evidenceId: safeId,
    datasetFingerprint: fingerprint,
    configFingerprint: fingerprint,
    versionFingerprint: fingerprint,
    traceCount: count,
    eligible: z.boolean(),
    checks: z.array(z.strictObject({ code: safeText(120), passed: z.boolean(), detail: safeText(1_000) })).max(100).readonly(),
    createdAt: timestamp,
  })).max(100).readonly(),
  lastTransition: z.strictObject({ kind: z.enum(["BOOTSTRAP", "ACTIVATED", "DOWNGRADED"]), reasonCodes: z.array(safeText(120)).max(100).readonly(), occurredAt: timestamp }).optional(),
}).superRefine((rollout, context) => {
  if (rollout.effective.mode === "ACTIVE" && (rollout.effective.canary === undefined || rollout.effective.evidenceId === undefined)) {
    context.addIssue({ code: "custom", path: ["effective"], message: "ACTIVE requires scoped canary and eligibility evidence" });
  }
});

export const highRiskKindSchema = z.enum(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"]);
export const highRiskGovernanceViewSchema = z.strictObject({
  policyRevision: revision,
  activeStageEnabled: z.boolean(),
  actor: safeId.optional(),
  actions: z.record(highRiskKindSchema, p4ActionGateSchema),
}).superRefine((view, context) => {
  if (!view.activeStageEnabled && Object.values(view.actions).some((gate) => gate.enabled)) {
    context.addIssue({ code: "custom", path: ["actions"], message: "high-risk actions cannot be enabled outside ACTIVE stage" });
  }
});
export const highRiskPreviewViewSchema = z.strictObject({
  previewId: safeId,
  policyRevision: revision,
  kind: highRiskKindSchema,
  expiresAt: timestamp,
  actor: safeId.optional(),
  confirmationPhrase: safeText(500),
  blastRadius: z.strictObject({
    affectedAssets: count,
    affectedProjects: count,
    affectedRules: count,
    affectedBindings: count,
    affectedTraces: count,
    affectedInjections: count,
    irreversible: z.boolean(),
    reasonCodes: z.array(safeText(120)).min(1).max(100).readonly(),
  }),
}).superRefine((preview, context) => {
  if (preview.kind === "PRIVACY_PURGE" && !preview.blastRadius.irreversible) {
    context.addIssue({ code: "custom", path: ["blastRadius", "irreversible"], message: "privacy purge must be marked irreversible" });
  }
});
export const highRiskReceiptSchema = z.strictObject({ operationId: safeId, previewId: safeId, kind: highRiskKindSchema, actor: safeId, policyRevision: revision, committedAt: timestamp });
export const contextRefreshReceiptSchema = z.strictObject({ sessionId: safeId, removedEntries: count, refreshedAt: timestamp, reasonCode: safeText(120) });

export type P4ActionGate = z.infer<typeof p4ActionGateSchema>;
export type InjectionAttemptView = z.infer<typeof injectionAttemptViewSchema>;
export type SessionInjectionView = z.infer<typeof sessionInjectionViewSchema>;
export type ClosureRunView = z.infer<typeof closureRunViewSchema>;
export type ClosureRunListView = z.infer<typeof closureRunListViewSchema>;
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;
export type FeedbackTargetView = z.infer<typeof feedbackTargetViewSchema>;
export type FeedbackReceipt = z.infer<typeof feedbackReceiptSchema>;
export type RolloutView = z.infer<typeof rolloutViewSchema>;
export type HighRiskKind = z.infer<typeof highRiskKindSchema>;
export type HighRiskGovernanceView = z.infer<typeof highRiskGovernanceViewSchema>;
export type HighRiskPreviewView = z.infer<typeof highRiskPreviewViewSchema>;
export type HighRiskReceipt = z.infer<typeof highRiskReceiptSchema>;
export type ContextRefreshReceipt = z.infer<typeof contextRefreshReceiptSchema>;

export interface FeedbackCommand {
  readonly knowledgeId: string;
  readonly version: number;
  readonly kind: FeedbackKind;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly scopeKey: string;
  readonly traceId: string;
  readonly expansionId?: string;
}

export interface HighRiskPreviewCommand {
  readonly expectedPolicyRevision: number;
  readonly idempotencyKey: string;
  readonly kind: HighRiskKind;
  readonly assetIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly reason: string;
  readonly payloadFingerprint: string;
}

export interface HighRiskCommitCommand {
  readonly previewId: string;
  readonly expectedPolicyRevision: number;
  readonly idempotencyKey: string;
  /** Exact operator-entered phrase. The server derives actor and confirmation fingerprint. */
  readonly confirmationPhrase: string;
}

/** P4 adapter boundary. Implementations must validate responses with the schemas above. */
export interface P4ConsoleApi {
  sessionInjections(sessionId: string, signal?: AbortSignal): Promise<SessionInjectionView>;
  refreshSessionContext(sessionId: string, signal?: AbortSignal): Promise<ContextRefreshReceipt>;
  closureRuns(sessionId?: string, signal?: AbortSignal): Promise<ClosureRunListView>;
  closureRun(sessionId: string, closureRunId: string, signal?: AbortSignal): Promise<ClosureRunView>;
  feedbackTargets(sessionId: string, signal?: AbortSignal): Promise<readonly FeedbackTargetView[]>;
  recordFeedback(command: FeedbackCommand, signal?: AbortSignal): Promise<FeedbackReceipt>;
  rollout(signal?: AbortSignal): Promise<RolloutView>;
  highRiskGovernance(signal?: AbortSignal): Promise<HighRiskGovernanceView>;
  previewHighRisk(command: HighRiskPreviewCommand, signal?: AbortSignal): Promise<HighRiskPreviewView>;
  commitHighRisk(command: HighRiskCommitCommand, signal?: AbortSignal): Promise<HighRiskReceipt>;
}
