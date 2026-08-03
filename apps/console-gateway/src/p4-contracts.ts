import {
  closureRunSchema,
  feedbackResponseSchema,
  highRiskCommitResponseSchema,
  highRiskCommandSchema,
  highRiskPreviewResponseSchema,
  injectionAttemptSchema,
  mcpExpansionSchema,
  rolloutStateSchema,
} from "@zhiloop/p4-console-runtime";
import { z } from "zod";

const safeId = z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const reasonCode = z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u);
const page = <T extends z.ZodType>(item: T) => z.strictObject({
  items: z.array(item).max(100),
  nextCursor: z.string().min(16).max(4_096).optional(),
});

export const p4RuntimeInjectionViewSchema = z.strictObject({
  ...injectionAttemptSchema.shape,
  tokenBudget: injectionAttemptSchema.shape.envelope.shape.budget,
  omittedReasonCodes: z.array(reasonCode).max(100),
}).transform(({ tokenBudget, omittedReasonCodes, ...attempt }) => {
  void tokenBudget;
  void omittedReasonCodes;
  return injectionAttemptSchema.parse(attempt);
});

export const p4InjectionPageSchema = page(p4RuntimeInjectionViewSchema);
export const p4McpExpansionPageSchema = page(mcpExpansionSchema);
export const p4ClosurePageSchema = page(closureRunSchema);
export const p4RolloutResponseSchema = z.strictObject({
  state: rolloutStateSchema,
  activeCanary: rolloutStateSchema.shape.effective.shape.canary.optional(),
  downgradeHistory: z.array(rolloutStateSchema.shape.audit.element).max(10_000),
  rollbackTarget: rolloutStateSchema.shape.effective,
});
export const p4FeedbackResponseSchema = feedbackResponseSchema;
export const p4HighRiskPreviewResponseSchema = highRiskPreviewResponseSchema;
export const p4HighRiskCommitResponseSchema = highRiskCommitResponseSchema;

export const p4FeedbackBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["RELEVANT", "IRRELEVANT", "PIN", "SUPPRESS"]),
    knowledgeId: safeId,
    version: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    idempotencyKey: safeId,
    scopeKey: z.string().min(1).max(1_000),
    traceId: safeId,
  }),
  z.strictObject({
    kind: z.literal("MCP_USED"),
    knowledgeId: safeId,
    version: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    idempotencyKey: safeId,
    scopeKey: z.string().min(1).max(1_000),
    traceId: safeId,
    expansionId: safeId,
  }),
]).superRefine((value, context) => {
  if (value.version !== value.expectedRevision) {
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "feedback revision must bind the displayed knowledge version" });
  }
});
export const p4HighRiskPreviewBodySchema = z.strictObject({
  expectedPolicyRevision: z.number().int().positive(),
  idempotencyKey: safeId,
  command: highRiskCommandSchema,
});
export const p4HighRiskCommitBodySchema = z.strictObject({
  expectedPolicyRevision: z.number().int().positive(),
  idempotencyKey: safeId,
  previewId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  confirmationPhrase: z.string().min(1).max(1_000).refine((value) => !value.includes("\0")),
});

export const p4CapabilitySchema = z.strictObject({
  capability: z.enum(["INJECTION_AUDIT", "MCP_AUDIT", "CLOSURE_AUDIT", "FEEDBACK", "ROLLOUT", "HIGH_RISK_GOVERNANCE"]),
  state: z.enum(["READY", "DISABLED", "NOT_CONFIGURED", "DEGRADED"]),
  reasonCode,
  evidenceRefs: z.array(safeId).max(100),
});
export const p4CapabilityArraySchema = z.array(p4CapabilitySchema).length(6).readonly();
export const p4CapabilityListSchema = z.strictObject({ items: p4CapabilityArraySchema });

const actionGateSchema = z.strictObject({
  enabled: z.boolean(),
  capabilityStatus: z.enum(["READY", "DEGRADED", "NOT_VERIFIED", "NOT_CONFIGURED", "DISABLED", "FAILED"]),
  reasonCode,
  expectedRevision: z.number().int().positive().optional(),
  idempotencyKey: safeId.optional(),
}).superRefine((gate, context) => {
  if (gate.enabled && (gate.capabilityStatus !== "READY" || gate.expectedRevision === undefined || gate.idempotencyKey === undefined)) {
    context.addIssue({ code: "custom", message: "enabled P4 action requires READY capability, revision and idempotency" });
  }
});
const feedbackKindSchema = z.enum(["RELEVANT", "IRRELEVANT", "PIN", "SUPPRESS", "MCP_USED"]);
export const p4FeedbackTargetSchema = z.strictObject({
  knowledgeId: safeId,
  version: z.number().int().positive(),
  title: z.string().min(1).max(500),
  eligible: z.boolean(),
  eligibilityReasonCodes: z.array(reasonCode).max(100),
  mcpUsed: z.boolean(),
  scopeKey: z.string().min(1).max(1_000),
  traceId: safeId,
  expansionId: safeId.optional(),
  actions: z.record(feedbackKindSchema, actionGateSchema),
});
export const p4FeedbackTargetsSchema = z.strictObject({ items: z.array(p4FeedbackTargetSchema).max(500) });

const highRiskKindSchema = z.enum(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"]);
export const p4HighRiskGovernanceSchema = z.strictObject({
  policyRevision: z.number().int().positive(),
  activeStageEnabled: z.boolean(),
  actor: safeId,
  actions: z.record(highRiskKindSchema, actionGateSchema),
}).superRefine((value, context) => {
  if (!value.activeStageEnabled && Object.values(value.actions).some((gate) => gate.enabled)) {
    context.addIssue({ code: "custom", path: ["actions"], message: "high-risk actions require ACTIVE stage" });
  }
});

export type P4InjectionPage = z.infer<typeof p4InjectionPageSchema>;
export type P4McpExpansionPage = z.infer<typeof p4McpExpansionPageSchema>;
export type P4ClosurePage = z.infer<typeof p4ClosurePageSchema>;
export type P4RolloutResponse = z.infer<typeof p4RolloutResponseSchema>;
export type P4CapabilityList = z.infer<typeof p4CapabilityListSchema>;
export type P4CapabilityArray = z.infer<typeof p4CapabilityArraySchema>;
export type P4FeedbackTargets = z.infer<typeof p4FeedbackTargetsSchema>;
export type P4HighRiskGovernance = z.infer<typeof p4HighRiskGovernanceSchema>;
