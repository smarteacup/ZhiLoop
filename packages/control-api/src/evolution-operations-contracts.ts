import { z } from "zod";

import { CONTROL_API_SCHEMA_VERSION } from "./constants.js";
import { jobSnapshotSchema } from "./schemas.js";

const safeId = z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/u);
const safeCode = z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(20).max(40).refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "expected a canonical ISO timestamp");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const operationDiagnosticSchema = z.strictObject({
  reasonCode: safeCode,
  message: z.string().min(1).max(1_000),
  retryable: z.boolean(),
  attempt: revision.optional(),
  maxAttempts: z.number().int().positive().max(1_000).optional(),
  nextAttemptAt: timestamp.optional(),
  suggestedAction: z.string().min(1).max(1_000).optional(),
});

export const codeGraphCapabilityViewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  projectId: safeId,
  repositoryIdentity: sha256,
  repositoryRootLabel: z.string().min(1).max(500),
  status: z.enum(["READY", "NOT_CONFIGURED", "DEGRADED", "FAILED"]),
  reasonCode: safeCode,
  revision,
  providerVersion: z.string().min(1).max(200).optional(),
  indexRevision: z.string().min(1).max(512).optional(),
  indexedFiles: revision.optional(),
  latestJob: jobSnapshotSchema.optional(),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(16),
  observedAt: timestamp,
});

export const codeGraphProjectPageSchema = z.strictObject({
  revision,
  items: z.array(codeGraphCapabilityViewSchema).max(100),
  bounded: z.boolean(),
  observedAt: timestamp,
});

export const codeGraphInitializationPreviewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  previewId: safeId,
  projectId: safeId,
  repositoryIdentity: sha256,
  repositoryRootLabel: z.string().min(1).max(500),
  targetDirectoryLabel: z.string().min(1).max(600),
  expectedRevision: revision,
  providerVersion: z.string().min(1).max(200).optional(),
  currentStatus: z.enum(["READY", "NOT_CONFIGURED", "DEGRADED", "FAILED"]),
  riskCodes: z.array(safeCode).min(1).max(16),
  createdAt: timestamp,
  expiresAt: timestamp,
});

export const codeGraphInitializationCommitSchema = z.strictObject({
  preview: codeGraphInitializationPreviewSchema,
  job: jobSnapshotSchema,
});

export const alertOperatorStateSchema = z.strictObject({
  revision,
  acknowledgedAt: timestamp.optional(),
  acknowledgedBy: safeId.optional(),
  suppressedUntil: timestamp.optional(),
  updatedAt: timestamp,
});

export const operationalAlertConsoleItemSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  alertId: safeId,
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
  type: z.enum(["PERMANENT_JOB_FAILURE", "CODEGRAPH_UNAVAILABLE", "STALE_KNOWLEDGE", "MIGRATION_FAILED"]),
  projectId: safeId.optional(),
  entityRef: z.string().min(1).max(1_000).optional(),
  reasonCodes: z.array(safeCode).min(1).max(32),
  occurrenceCount: z.number().int().positive(),
  firstObservedAt: timestamp,
  lastObservedAt: timestamp,
  /** Immutable source-alert revision; operator commands are bound to `revision` below. */
  alertRevision: revision,
  /** Independent operator-state revision. Zero means no operator action has been recorded. */
  revision: revision,
  deliveryState: z.enum(["LOCAL_ONLY", "PENDING", "DELIVERED", "DELIVERY_FAILED"]),
  operatorState: alertOperatorStateSchema.optional(),
  diagnostic: operationDiagnosticSchema,
});

export const operationalAlertConsolePageSchema = z.strictObject({
  revision,
  items: z.array(operationalAlertConsoleItemSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).optional(),
  bounded: z.boolean(),
  observedAt: timestamp,
});

export const alertOperatorCommandResultSchema = z.strictObject({
  alertId: safeId,
  alertRevision: revision,
  operatorState: alertOperatorStateSchema,
});

export const evolutionOperationsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  consistency: z.enum(["CONSISTENT", "MIXED_REVISION"]),
  observedAt: timestamp,
  sections: z.array(z.strictObject({
    area: z.enum(["COMPILE", "REVALIDATE", "REPAIR", "CODEGRAPH", "FRESHNESS", "MIGRATION", "ALERT", "INJECTION"]),
    revision,
    status: z.enum(["READY", "RUNNING", "DEGRADED", "DISABLED", "FAILED", "EMPTY"]),
    reasonCode: safeCode,
    queued: revision,
    running: revision,
    failed: revision,
    updatedAt: timestamp,
  })).length(8),
});

const verificationResultViewSchema = z.strictObject({
  assertionId: safeId,
  assertionKind: safeCode,
  status: z.enum(["SUPPORTED", "REFUTED", "UNKNOWN", "ERROR"]),
  reasonCodes: z.array(safeCode).max(16),
  evidenceId: safeId.optional(),
});

export const knowledgeRepairDraftViewSchema = z.strictObject({
  draftId: safeId,
  projectId: safeId,
  assetId: safeId,
  assetVersion: z.number().int().positive(),
  conflictRunId: safeId,
  status: z.enum(["PENDING", "READY", "DISMISSED", "PROMOTED", "FAILED"]),
  revision,
  changedAssertions: z.array(z.strictObject({
    assertionId: safeId,
    assertionKind: safeCode,
    reasonCodes: z.array(safeCode).max(16),
  })).max(100),
  reasonCodes: z.array(safeCode).max(100),
  proposedCandidate: z.strictObject({
    candidateId: safeId,
    title: z.string().min(1).max(2_000),
    summary: z.string().min(1).max(20_000),
    body: z.string().min(1).max(64_000),
  }).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const knowledgeEvolutionViewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  revision,
  knowledgeId: safeId,
  knowledgeVersion: z.number().int().positive(),
  projectId: safeId.optional(),
  freshnessRevision: revision,
  recipe: z.strictObject({
    recipeVersion: z.string().min(1).max(200),
    assertionsHash: sha256,
    assertionCount: revision,
    createdAt: timestamp,
  }).optional(),
  verificationRuns: z.array(z.strictObject({
    runId: safeId,
    purpose: z.enum(["CANDIDATE", "FRESHNESS", "PRE_INJECTION"]),
    projectId: safeId,
    codeRevision: z.string().min(1).max(4_096),
    graphRevision: z.string().min(1).max(4_096).optional(),
    qualifyingProof: z.boolean(),
    status: z.literal("COMPLETED"),
    results: z.array(verificationResultViewSchema).max(100),
    completedAt: timestamp,
  })).max(20),
  repairDrafts: z.array(knowledgeRepairDraftViewSchema).max(20),
  jobs: z.array(jobSnapshotSchema).max(20),
  revalidationAction: z.strictObject({
    enabled: z.boolean(),
    expectedKnowledgeVersion: z.number().int().positive(),
    expectedFreshnessRevision: revision,
    reasonCode: safeCode,
  }),
  observedAt: timestamp,
});

export const knowledgeRevalidationCommandResultSchema = z.strictObject({
  knowledgeId: safeId,
  knowledgeVersion: z.number().int().positive(),
  disposition: z.enum(["QUEUED", "NO_CHANGES"]),
  reasonCode: safeCode,
  job: jobSnapshotSchema.optional(),
  observedAt: timestamp,
});

export const knowledgeRepairSubmissionResultSchema = z.strictObject({
  draft: knowledgeRepairDraftViewSchema,
});

export type CodeGraphCapabilityView = z.infer<typeof codeGraphCapabilityViewSchema>;
export type CodeGraphProjectPage = z.infer<typeof codeGraphProjectPageSchema>;
export type CodeGraphInitializationPreview = z.infer<typeof codeGraphInitializationPreviewSchema>;
export type CodeGraphInitializationCommit = z.infer<typeof codeGraphInitializationCommitSchema>;
export type OperationalAlertConsolePage = z.infer<typeof operationalAlertConsolePageSchema>;
export type AlertOperatorCommandResult = z.infer<typeof alertOperatorCommandResultSchema>;
export type EvolutionOperationsSnapshot = z.infer<typeof evolutionOperationsSnapshotSchema>;
export type KnowledgeEvolutionView = z.infer<typeof knowledgeEvolutionViewSchema>;
export type KnowledgeRepairDraftView = z.infer<typeof knowledgeRepairDraftViewSchema>;
export type KnowledgeRevalidationCommandResult = z.infer<typeof knowledgeRevalidationCommandResultSchema>;
export type KnowledgeRepairSubmissionResult = z.infer<typeof knowledgeRepairSubmissionResultSchema>;
