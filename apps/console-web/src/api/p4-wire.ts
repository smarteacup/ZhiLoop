import { z } from "zod";

const safeText = (maximum: number) => z.string().min(1).max(maximum).refine((value) => !value.includes("\0"));
const safeId = safeText(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.string().min(20).max(40).refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});
const reasonCode = z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u);

const scopeSchema = z.discriminatedUnion("level", [
  z.strictObject({ level: z.literal("TASK"), taskId: safeId, projectId: safeId.optional(), repositoryRemote: safeText(4_096).optional() }),
  z.strictObject({ level: z.literal("SYMBOL"), projectId: safeId, repositoryRemote: safeText(4_096).optional(), symbols: z.array(safeText(1_000)).min(1).max(100) }),
  z.strictObject({ level: z.literal("MODULE"), projectId: safeId, repositoryRemote: safeText(4_096).optional(), modulePaths: z.array(safeText(1_000)).min(1).max(100) }),
  z.strictObject({ level: z.literal("PROJECT"), projectId: safeId, repositoryRemote: safeText(4_096).optional() }),
  z.strictObject({ level: z.literal("USER"), userId: safeId }),
  z.strictObject({ level: z.literal("TEAM"), teamId: safeId }),
  z.strictObject({ level: z.literal("GLOBAL") }),
]);
const taskContractSchema = z.strictObject({
  contractId: safeId,
  objective: safeText(100_000),
  gates: z.array(safeText(10_000)).max(100),
  boundaries: z.array(safeText(10_000)).max(100),
});
const contextItemSchema = z.strictObject({
  id: safeId, version: revision, subjectKey: safeText(1_000),
  kind: z.enum(["FACT", "REQUIREMENT", "DESIGN", "DECISION", "IMPLEMENTATION", "EXPERIENCE", "RULE", "PREFERENCE", "OPEN_QUESTION"]),
  status: z.enum(["PROPOSED", "ACCEPTED", "IMPLEMENTED", "VERIFIED", "REJECTED", "STALE", "SUPERSEDED"]),
  scope: scopeSchema,
  authority: z.enum(["BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE"]),
  detailLevel: z.enum(["L1_POINTER", "L2_COMPACT", "L3_EVIDENCED", "L4_EPISODE"]),
  title: safeText(10_000), summary: safeText(100_000), retrievalRank: count,
  applicability: z.array(safeText(10_000)).max(100).optional(),
  failurePaths: z.array(safeText(10_000)).max(100).optional(),
  symbols: z.array(safeText(10_000)).max(100).optional(),
  content: safeText(1_000_000).optional(),
  evidencePointers: z.array(safeText(10_000)).max(1_000).optional(),
  evidenceSummary: z.array(z.strictObject({ evidenceId: safeId, verdict: z.enum(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]) })).max(1_000).optional(),
  sourceEpisodes: z.array(safeText(10_000)).max(1_000).optional(),
});
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: safeId, projectId: safeId.optional(), taskId: safeId.optional(),
  complexity: z.strictObject({
    level: z.enum(["L0_NONE", "L1_POINTER", "L2_COMPACT", "L3_EVIDENCED", "L4_EPISODE"]),
    breadth: count, depth: z.enum(["NONE", "POINTER", "COMPACT", "EVIDENCED", "EPISODE"]),
    authority: z.enum(["BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE", "MIXED", "NONE"]),
    evidence: z.enum(["NONE", "POINTER", "SUMMARY", "EPISODE"]), reasonCodes: z.array(reasonCode).max(100),
  }),
  budget: z.strictObject({ maxTokens: count, estimatedTokens: count, truncated: z.boolean(), disclosedItems: count, omittedItems: count }),
  items: z.array(contextItemSchema).max(1_000),
  taskContract: taskContractSchema.optional(),
});
export const p4WireInjectionSchema = z.strictObject({
  schemaVersion: z.literal(1), attemptId: safeId, sessionId: safeId, turnId: safeId, traceId: safeId, runId: safeId,
  rolloutRevision: count, status: z.enum(["PENDING", "SHADOWED", "INJECTED", "NO_CONTEXT", "ROLLED_BACK", "TIMEOUT", "ERROR"]),
  revision: count, envelope: envelopeSchema, reasonCode, createdAt: timestamp, completedAt: timestamp.optional(),
  deliveryEvidenceRef: safeId.optional(), deliveredAt: timestamp.optional(),
}).superRefine((value, context) => {
  if ((value.status === "PENDING") !== (value.completedAt === undefined)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "terminal status/completion mismatch" });
  }
  const acknowledged = value.deliveryEvidenceRef !== undefined || value.deliveredAt !== undefined;
  if (acknowledged !== (value.deliveryEvidenceRef !== undefined && value.deliveredAt !== undefined)) {
    context.addIssue({ code: "custom", path: ["deliveryEvidenceRef"], message: "delivery proof must be complete" });
  }
  if (acknowledged && (value.status !== "INJECTED" || value.revision !== 2)) {
    context.addIssue({ code: "custom", path: ["status"], message: "acknowledged delivery must be revision two INJECTED" });
  }
  if (!acknowledged && value.status !== "PENDING" && value.revision !== 1) {
    context.addIssue({ code: "custom", path: ["revision"], message: "unacknowledged terminal delivery must be revision one" });
  }
  if (value.status === "PENDING" && value.revision !== 0) {
    context.addIssue({ code: "custom", path: ["revision"], message: "pending delivery must be revision zero" });
  }
});
export const p4WireInjectionPageSchema = z.strictObject({
  items: z.array(p4WireInjectionSchema).max(100), nextCursor: z.string().min(16).max(4_096).optional(),
});
export const p4WireMcpExpansionSchema = z.strictObject({
  schemaVersion: z.literal(1), expansionId: safeId, attemptId: safeId.optional(), traceId: safeId,
  tool: z.enum(["ckl.search", "ckl.get", "ckl.related", "ckl.check"]), knowledgeId: safeId, knowledgeVersion: revision,
  fromDetailLevel: z.enum(["L1_POINTER", "L2_COMPACT"]), toDetailLevel: z.enum(["L2_COMPACT", "L3_EVIDENCED"]),
  latencyMs: count, used: z.boolean(), occurredAt: timestamp,
});
export const p4WireMcpPageSchema = z.strictObject({ items: z.array(p4WireMcpExpansionSchema).max(100), nextCursor: z.string().min(16).max(4_096).optional() });

export const p4WireClosureSchema = z.strictObject({
  schemaVersion: z.literal(1), closureRunId: safeId, sessionId: safeId, turnId: safeId, taskContract: taskContractSchema,
  gates: z.array(z.strictObject({ gateId: safeId, status: z.enum(["SATISFIED", "UNSATISFIED", "UNKNOWN"]), reasonCodes: z.array(reasonCode).max(100), evidenceRefs: z.array(safeText(10_000)).max(100) })).max(100),
  decision: z.enum(["PASS", "RETRY_WITH_CONTEXT", "RETRY_WITH_CORRECTION", "ASK_USER"]), correctionDelta: safeText(100_000).optional(),
  continuationCount: z.number().int().min(0).max(100), recursiveStopRejected: z.boolean(),
  interaction: z.strictObject({ required: z.boolean(), question: safeText(100_000).optional(), safeDefault: safeText(10_000).optional() }).optional(),
  createdAt: timestamp,
});
export const p4WireClosurePageSchema = z.strictObject({ items: z.array(p4WireClosureSchema).max(100), nextCursor: z.string().min(16).max(4_096).optional() });

const canarySchema = z.strictObject({
  projectIds: z.array(safeId).min(1).max(1_000).optional(), sessionIds: z.array(safeId).min(1).max(1_000).optional(), taskIds: z.array(safeId).min(1).max(1_000).optional(),
  percentageBasisPoints: z.number().int().min(1).max(10_000).optional(), allocationSalt: safeId,
});
const rolloutRevisionSchema = z.strictObject({ policyRevision: revision, mode: z.enum(["SHADOW", "ACTIVE"]), configFingerprint: fingerprint, versionFingerprint: fingerprint, canary: canarySchema.optional(), evidenceId: fingerprint.optional() });
const rolloutAuditSchema = z.strictObject({ eventId: fingerprint, kind: z.enum(["BOOTSTRAP", "ACTIVATED", "DOWNGRADED"]), stateRevision: revision, effectivePolicyRevision: revision, reasonCodes: z.array(reasonCode).min(1).max(100), occurredAt: timestamp });
const eligibilitySchema = z.strictObject({
  evidenceId: fingerprint, datasetId: safeId, datasetVersion: revision, datasetFingerprint: fingerprint, configFingerprint: fingerprint, versionFingerprint: fingerprint,
  traceIds: z.array(safeId).min(1).max(10_000), observedFrom: timestamp, observedTo: timestamp,
  checks: z.array(z.strictObject({ code: z.enum(["REAL_SHADOW_TRACES", "DATASET_BOUND", "CONFIG_BOUND", "VERSION_BOUND", "GOLDEN_GATE", "TRACEABILITY", "SCOPE_ISOLATION", "FORBIDDEN_EXCLUSION", "NO_AUTOMATIC_L4"]), passed: z.boolean(), detail: safeText(10_000) })).length(9),
  eligible: z.boolean(), createdAt: timestamp,
});
const rolloutStateSchema = z.strictObject({ schemaVersion: z.literal(1), stateRevision: revision, effective: rolloutRevisionSchema, lastKnownGood: rolloutRevisionSchema, evidence: z.array(eligibilitySchema).max(1_000), audit: z.array(rolloutAuditSchema).min(1).max(10_000) });
export const p4WireRolloutSchema = z.strictObject({ state: rolloutStateSchema, activeCanary: canarySchema.optional(), downgradeHistory: z.array(rolloutAuditSchema).max(10_000), rollbackTarget: rolloutRevisionSchema });

export const p4WireFeedbackResponseSchema = z.strictObject({ outcome: z.enum(["RECORDED", "EXISTING"]), eligibleAfterWrite: z.boolean() });
const blastRadiusSchema = z.strictObject({ affectedAssets: count, affectedProjects: count, affectedRules: count, affectedBindings: count, affectedTraces: count, affectedInjections: count, irreversible: z.boolean(), reasonCodes: z.array(reasonCode).min(1).max(100) });
const highRiskCommandSchema = z.strictObject({ kind: z.enum(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"]), assetIds: z.array(safeId).min(1).max(10_000), projectIds: z.array(safeId).max(1_000), reason: safeText(1_000), payloadFingerprint: fingerprint });
const highRiskPreviewSchema = z.strictObject({ previewId: fingerprint, policyRevision: revision, commandFingerprint: fingerprint, command: highRiskCommandSchema, blastRadius: blastRadiusSchema, createdAt: timestamp, expiresAt: timestamp });
export const p4WireHighRiskPreviewSchema = z.strictObject({ preview: highRiskPreviewSchema, blastRadius: blastRadiusSchema, confirmationPhrase: safeText(1_000) });
export const p4WireHighRiskCommitSchema = z.strictObject({ result: z.strictObject({ operationId: fingerprint, previewId: fingerprint, kind: highRiskCommandSchema.shape.kind, actor: safeId, policyRevision: revision, blastRadius: blastRadiusSchema, committedAt: timestamp }) });

export const p4WireCapabilityListSchema = z.strictObject({ items: z.array(z.strictObject({
  capability: z.enum(["INJECTION_AUDIT", "MCP_AUDIT", "CLOSURE_AUDIT", "FEEDBACK", "ROLLOUT", "HIGH_RISK_GOVERNANCE"]),
  state: z.enum(["READY", "DISABLED", "NOT_CONFIGURED", "DEGRADED"]), reasonCode, evidenceRefs: z.array(safeId).max(100),
})).length(6) });

export type P4WireInjection = z.infer<typeof p4WireInjectionSchema>;
export type P4WireClosure = z.infer<typeof p4WireClosureSchema>;
