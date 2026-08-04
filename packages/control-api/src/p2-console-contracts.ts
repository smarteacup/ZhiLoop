import { z } from "zod";

const safeId = z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const safeCode = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
const boundedText = (maximum: number) => z.string().max(maximum);
const positiveVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(20).max(40).refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "expected a canonical ISO timestamp");

export const p2KnowledgeScopeLevelSchema = z.enum(["TASK", "SYMBOL", "MODULE", "PROJECT", "GLOBAL"]);
export const p2KnowledgeStatusSchema = z.enum(["PROPOSED", "ACCEPTED", "IMPLEMENTED", "VERIFIED", "STALE", "SUPERSEDED", "REJECTED"]);
export const p2EvidenceVerdictSchema = z.enum(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]);
export const p2KnowledgeKindSchema = z.enum(["FACT", "REQUIREMENT", "DESIGN", "DECISION", "IMPLEMENTATION", "EXPERIENCE", "RULE", "PREFERENCE", "OPEN_QUESTION"]);

export const p2ActionGateSchema = z.strictObject({
  enabled: z.boolean(),
  expectedRevision: revision,
  idempotencyKey: z.string().min(1).max(500),
  reasonCode: safeCode,
});

export const p2ExtractionStageViewSchema = z.strictObject({
  stage: safeCode,
  status: safeCode,
  reasonCode: safeCode,
  retryable: z.boolean(),
  completedUnits: revision.optional(),
  totalUnits: revision.optional(),
  jobId: safeId.optional(),
  attempt: revision.optional(),
  maxAttempts: positiveVersion.optional(),
  nextAttemptAt: timestamp.optional(),
  failure: z.strictObject({
    code: safeCode,
    retryable: z.boolean(),
    occurredAt: timestamp,
  }).optional(),
});

export const p2ExtractionSnapshotViewSchema = z.strictObject({
  snapshotId: safeId,
  revision: positiveVersion,
  completeness: z.enum(["COMPLETE_SNAPSHOT", "PARTIAL_SNAPSHOT"]),
  sourceSequenceFrom: positiveVersion,
  sourceSequenceThrough: positiveVersion,
  cursor: z.string().min(1).max(100).optional(),
  compilerVersion: safeCode,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: timestamp,
  unsupportedEventTypes: z.array(safeCode).max(100),
}).superRefine((value, context) => {
  if (value.sourceSequenceFrom > value.sourceSequenceThrough) {
    context.addIssue({ code: "custom", path: ["sourceSequenceFrom"], message: "source sequence range is reversed" });
  }
});

export const p2ProvenanceViewSchema = z.strictObject({
  sessionIds: z.array(safeId).max(1_000),
  turnIds: z.array(safeId).max(5_000),
  eventIds: z.array(safeId).max(5_000),
  snapshotIds: z.array(safeId).max(1_000),
  episodeIds: z.array(safeId).max(5_000),
  knowledgeVersions: z.array(z.strictObject({ knowledgeId: safeId, version: positiveVersion })).max(5_000),
});

export const p2ExtractionCandidateViewSchema = z.strictObject({
  candidateId: safeId,
  subjectKey: boundedText(500).min(1),
  kind: p2KnowledgeKindSchema,
  title: boundedText(300).min(1),
  summary: boundedText(2_000).min(1),
  scope: p2KnowledgeScopeLevelSchema,
  confidence: z.number().min(0).max(1),
  status: p2KnowledgeStatusSchema,
  evidenceVerdict: p2EvidenceVerdictSchema,
  policy: z.strictObject({
    action: z.enum(["PUBLISH", "KEEP_PROPOSED", "REQUIRE_CONFIRMATION", "REJECT"]),
    targetStatus: p2KnowledgeStatusSchema,
    shouldPublish: z.boolean(),
    reasonCodes: z.array(safeCode).max(100),
  }),
  provenance: p2ProvenanceViewSchema,
});

export const p2SessionExtractionViewSchema = z.strictObject({
  sessionId: safeId,
  revision,
  snapshot: p2ExtractionSnapshotViewSchema.optional(),
  stages: z.array(p2ExtractionStageViewSchema).max(100),
  candidates: z.array(p2ExtractionCandidateViewSchema).max(100),
  previewId: safeId.optional(),
  reverseProvenance: z.array(p2ProvenanceViewSchema).max(100),
  extractAction: p2ActionGateSchema,
  commitAction: p2ActionGateSchema,
});

export const p2KnowledgeFilterSchema = z.strictObject({
  scope: p2KnowledgeScopeLevelSchema.optional(),
  projectId: safeId.optional(),
  kind: p2KnowledgeKindSchema.optional(),
  status: p2KnowledgeStatusSchema.optional(),
  subject: boundedText(500).min(1).optional(),
  symbol: boundedText(1_000).min(1).optional(),
  keyword: boundedText(500).min(1).optional(),
  evidenceVerdict: p2EvidenceVerdictSchema.optional(),
  version: positiveVersion.optional(),
  eligible: z.boolean().optional(),
});

const p2KnowledgeSummaryViewSchema = z.strictObject({
  knowledgeId: safeId,
  version: positiveVersion,
  subjectKey: boundedText(500).min(1),
  title: boundedText(300).min(1),
  summary: boundedText(2_000).min(1),
  scope: p2KnowledgeScopeLevelSchema,
  projectId: safeId.optional(),
  kind: p2KnowledgeKindSchema,
  status: p2KnowledgeStatusSchema,
  confidence: z.number().min(0).max(1),
  evidenceVerdict: p2EvidenceVerdictSchema,
  eligible: z.boolean(),
  eligibilityReasonCodes: z.array(safeCode).max(100),
  updatedAt: timestamp,
});

export const p2KnowledgeListViewSchema = z.strictObject({
  revision,
  items: z.array(p2KnowledgeSummaryViewSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).optional(),
  indexStatus: safeCode,
  indexReasonCode: safeCode,
  retryable: z.boolean(),
});

export const p2KnowledgeEditDraftSchema = z.strictObject({
  title: boundedText(300).min(1),
  summary: boundedText(2_000).min(1),
  markdown: boundedText(32_000).min(1),
});

const p2KnowledgeVersionViewSchema = z.strictObject({
  version: positiveVersion,
  status: p2KnowledgeStatusSchema,
  createdAt: timestamp,
  reasonCode: safeCode,
  markdown: boundedText(64_000),
  diffFromPrevious: boundedText(2_000).optional(),
});

export const p2KnowledgeDetailViewSchema = z.strictObject({
  revision,
  knowledgeId: safeId,
  version: positiveVersion,
  title: boundedText(300).min(1),
  summary: boundedText(2_000).min(1),
  subjectKey: boundedText(500).min(1),
  kind: p2KnowledgeKindSchema,
  scope: p2KnowledgeScopeLevelSchema,
  projectId: safeId.optional(),
  status: p2KnowledgeStatusSchema,
  confidence: z.number().min(0).max(1),
  eligible: z.boolean(),
  eligibilityReasonCodes: z.array(safeCode).max(100),
  markdown: boundedText(64_000),
  scopeReasonCodes: z.array(safeCode).max(100),
  assertions: z.array(z.strictObject({ assertionId: safeId, text: boundedText(4_000), status: p2EvidenceVerdictSchema })).max(1_000),
  evidence: z.array(z.strictObject({ evidenceId: safeId, verdict: p2EvidenceVerdictSchema, source: boundedText(4_000), reasonCode: safeCode })).max(1_000),
  relations: z.array(z.strictObject({ relation: z.enum(["CONTRADICTS", "SUPERSEDES", "IMPLEMENTS", "DERIVED_FROM", "RELATED_TO", "DUPLICATE_OF"]), knowledgeId: safeId, version: positiveVersion, title: boundedText(300) })).max(1_000),
  provenance: p2ProvenanceViewSchema,
  lifecycle: z.array(z.strictObject({ status: p2KnowledgeStatusSchema, occurredAt: timestamp, reasonCode: safeCode })).max(1_000),
  usage: z.array(z.strictObject({ sessionId: boundedText(500), turnId: boundedText(500), mode: safeCode, occurredAt: timestamp })).max(1_000),
  versions: z.array(p2KnowledgeVersionViewSchema).max(1_000),
  editAction: p2ActionGateSchema,
  suppressAction: p2ActionGateSchema,
  restoreAction: p2ActionGateSchema,
});

export const p2KnowledgeEditImpactSchema = z.strictObject({
  knowledgeId: safeId,
  basedOnVersion: positiveVersion,
  proposedVersion: positiveVersion,
  changedFields: z.array(safeCode).max(100),
  scopeChanged: z.boolean(),
  evidenceDowngraded: z.boolean(),
  eligibleBefore: z.boolean(),
  eligibleAfter: z.boolean(),
  reasonCodes: z.array(safeCode).max(100),
  draft: p2KnowledgeEditDraftSchema,
});

export const p2IndexRecoveryResultSchema = z.strictObject({
  knowledgeId: safeId,
  action: z.enum(["INDEXED", "UNCHANGED", "CHUNKS_REFRESHED", "SKIPPED_INVALID", "SKIPPED_UNSAFE", "INDEXED_WITH_CHUNK_ERROR"]),
  assetVersion: positiveVersion.optional(),
  indexVersion: revision,
  diagnostics: z.array(z.strictObject({ code: safeCode, message: boundedText(2_000) })).max(100),
});

export const p2SessionPreviewCommandSchema = z.strictObject({ expectedRevision: revision, idempotencyKey: z.string().min(1).max(500) });
export const p2SessionCommitCommandSchema = z.strictObject({ previewId: safeId, expectedPreviewRevision: positiveVersion, idempotencyKey: z.string().min(1).max(500) });
export const p2KnowledgeEditCommandBodySchema = z.strictObject({ expectedVersion: positiveVersion, idempotencyKey: z.string().min(1).max(500), draft: p2KnowledgeEditDraftSchema });
export const p2KnowledgeLifecycleCommandBodySchema = z.strictObject({ expectedVersion: positiveVersion, idempotencyKey: z.string().min(1).max(500), reason: boundedText(1_000).min(1) });

export type P2SessionExtractionView = z.infer<typeof p2SessionExtractionViewSchema>;
export type P2KnowledgeFilter = z.infer<typeof p2KnowledgeFilterSchema>;
export type P2KnowledgeListView = z.infer<typeof p2KnowledgeListViewSchema>;
export type P2KnowledgeDetailView = z.infer<typeof p2KnowledgeDetailViewSchema>;
export type P2KnowledgeEditImpact = z.infer<typeof p2KnowledgeEditImpactSchema>;
export type P2IndexRecoveryResult = z.infer<typeof p2IndexRecoveryResultSchema>;
