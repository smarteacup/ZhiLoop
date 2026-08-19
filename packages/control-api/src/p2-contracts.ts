import { z } from "zod";

import { CONTROL_API_SCHEMA_VERSION, MAX_CONTROL_MESSAGE_BYTES } from "./constants.js";
import {
  idempotencyKeySchema,
  jobSnapshotSchema,
  knowledgeVersionRefSchema,
  requestIdSchema,
  sessionIdSchema,
  snapshotIdSchema,
  turnIdSchema,
} from "./schemas.js";

const safeArtifactIdSchema = z.string()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoTimestampSchema = z.string().min(20).max(40).refine(
  (value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  },
  { message: "expected a canonical ISO timestamp" },
);
const versionLabelSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
const sourceSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const operatorCursorSchema = z.string().min(1).max(2_048);
const boundedTextSchema = (maximum: number) => z.string().min(1).max(maximum).refine((value) => !value.includes("\0"), {
  message: "text contains a NUL character",
});

export const SNAPSHOT_COMPLETENESS = ["PARTIAL_SNAPSHOT", "COMPLETE_SNAPSHOT"] as const;
export const CANDIDATE_POLICY_DECISIONS = [
  "PUBLISH",
  "KEEP_PROPOSED",
  "REQUIRE_CONFIRMATION",
  "REJECT",
] as const;
export const PROVENANCE_NODE_TYPES = [
  "SESSION",
  "TURN",
  "EVENT",
  "SNAPSHOT",
  "EPISODE",
  "CANDIDATE",
  "KNOWLEDGE_VERSION",
] as const;
export const PROVENANCE_RELATION_TYPES = [
  "SESSION_CONTAINS_TURN",
  "TURN_CONTAINS_EVENT",
  "SNAPSHOT_INCLUDES_EVENT",
  "SNAPSHOT_DERIVED_EPISODE",
  "EPISODE_COMPILED_CANDIDATE",
  "CANDIDATE_PUBLISHED_AS",
  // Kept identical to the domain KnowledgeRelation registry so provenance and
  // knowledge relations can share an edge without lossy translation.
  "CONTRADICTS",
  "SUPERSEDES",
  "IMPLEMENTS",
  "DERIVED_FROM",
  "RELATED_TO",
  "DUPLICATE_OF",
] as const;

export const snapshotCursorSchema = z.strictObject({
  byteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lineNumber: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const sourceSequenceRangeSchema = z.strictObject({
  from: sourceSequenceSchema,
  to: sourceSequenceSchema,
}).superRefine((value, context) => {
  if (value.from > value.to) {
    context.addIssue({ code: "custom", path: ["from"], message: "source sequence range is reversed" });
  }
});

export const snapshotCompletenessSchema = z.strictObject({
  status: z.enum(SNAPSHOT_COMPLETENESS),
  sourceClosed: z.boolean(),
  unsupportedEventTypes: z.array(versionLabelSchema).max(100).refine(
    (items) => new Set(items).size === items.length,
    { message: "unsupported event types must be unique" },
  ),
}).superRefine((value, context) => {
  if (value.status === "COMPLETE_SNAPSHOT" && !value.sourceClosed) {
    context.addIssue({ code: "custom", path: ["sourceClosed"], message: "an active source cannot be complete" });
  }
  if (value.status === "COMPLETE_SNAPSHOT" && value.unsupportedEventTypes.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["unsupportedEventTypes"],
      message: "a complete snapshot cannot contain unsupported event types",
    });
  }
});

/**
 * Immutable extraction identity. A new source range, compiler, or policy must
 * create another snapshot rather than mutate this record.
 */
export const extractionSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  snapshotId: snapshotIdSchema,
  revision: z.literal(1),
  identityHash: sha256Schema,
  sessionId: sessionIdSchema,
  transcriptIdentityHash: sha256Schema,
  sourceSequence: sourceSequenceRangeSchema,
  cursor: snapshotCursorSchema,
  completeness: snapshotCompletenessSchema,
  previousSnapshotId: snapshotIdSchema.optional(),
  compilerVersion: versionLabelSchema,
  policyHash: sha256Schema,
  configurationHash: sha256Schema,
  createdAt: isoTimestampSchema,
}).superRefine((value, context) => {
  if (value.previousSnapshotId === value.snapshotId) {
    context.addIssue({ code: "custom", path: ["previousSnapshotId"], message: "a snapshot cannot follow itself" });
  }
});

export const snapshotReferenceSchema = z.strictObject({
  snapshotId: snapshotIdSchema,
  revision: z.literal(1),
  identityHash: sha256Schema,
});

export const candidatePreviewItemSchema = z.strictObject({
  candidateId: safeArtifactIdSchema,
  episodeIds: z.array(safeArtifactIdSchema).min(1).max(100).refine(
    (items) => new Set(items).size === items.length,
    { message: "episode IDs must be unique" },
  ),
  compilerVersion: versionLabelSchema,
  subjectKey: z.string().min(5).max(500).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/u),
  kind: z.enum([
    "FACT",
    "REQUIREMENT",
    "DESIGN",
    "DECISION",
    "IMPLEMENTATION",
    "EXPERIENCE",
    "RULE",
    "PREFERENCE",
    "OPEN_QUESTION",
  ]),
  title: z.string().min(1).max(300),
  summary: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
  scope: z.enum(["TASK", "SYMBOL", "MODULE", "PROJECT", "USER", "TEAM", "GLOBAL"]),
  evidenceVerdict: z.enum(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]),
  policyDecision: z.enum(CANDIDATE_POLICY_DECISIONS),
  policyReasonCodes: z.array(versionLabelSchema).max(20).refine(
    (items) => new Set(items).size === items.length,
    { message: "policy reason codes must be unique" },
  ),
});

export const candidatePreviewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  previewId: safeArtifactIdSchema,
  revision: positiveRevisionSchema,
  snapshot: snapshotReferenceSchema,
  extractionKey: sha256Schema,
  compilerVersion: versionLabelSchema,
  policyHash: sha256Schema,
  status: z.enum(["READY", "PARTIAL", "POLICY_BLOCKED", "FAILED"]),
  candidates: z.array(candidatePreviewItemSchema).max(100),
  diagnostics: z.array(z.strictObject({
    code: versionLabelSchema,
    candidateId: safeArtifactIdSchema.optional(),
    retryable: z.boolean(),
  })).max(100),
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
}).superRefine((value, context) => {
  if (value.status === "READY" && value.diagnostics.some((item) => item.retryable)) {
    context.addIssue({ code: "custom", path: ["diagnostics"], message: "a ready preview cannot have retryable diagnostics" });
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "preview expiry must follow creation" });
  }
  if (value.candidates.some((candidate) => candidate.compilerVersion !== value.compilerVersion)) {
    context.addIssue({ code: "custom", path: ["candidates"], message: "candidate compilerVersion must match preview" });
  }
  const candidateIds = value.candidates.map((candidate) => candidate.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    context.addIssue({ code: "custom", path: ["candidates"], message: "candidate IDs must be unique" });
  }
});

const sessionNodeSchema = z.strictObject({ type: z.literal("SESSION"), sessionId: sessionIdSchema });
const turnNodeSchema = z.strictObject({
  type: z.literal("TURN"),
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
});
const eventNodeSchema = z.strictObject({
  type: z.literal("EVENT"),
  sessionId: sessionIdSchema,
  eventId: safeArtifactIdSchema,
  turnId: turnIdSchema.optional(),
  sourceSequence: sourceSequenceSchema,
});
const snapshotNodeSchema = z.strictObject({
  type: z.literal("SNAPSHOT"),
  snapshotId: snapshotIdSchema,
  revision: z.literal(1),
});
const episodeNodeSchema = z.strictObject({ type: z.literal("EPISODE"), episodeId: safeArtifactIdSchema });
const candidateNodeSchema = z.strictObject({ type: z.literal("CANDIDATE"), candidateId: safeArtifactIdSchema });
const knowledgeVersionNodeSchema = z.strictObject({
  type: z.literal("KNOWLEDGE_VERSION"),
  knowledge: knowledgeVersionRefSchema,
});

export const provenanceNodeSchema = z.discriminatedUnion("type", [
  sessionNodeSchema,
  turnNodeSchema,
  eventNodeSchema,
  snapshotNodeSchema,
  episodeNodeSchema,
  candidateNodeSchema,
  knowledgeVersionNodeSchema,
]);

const KNOWLEDGE_RELATION_TYPES = new Set<string>([
  "CONTRADICTS",
  "SUPERSEDES",
  "IMPLEMENTS",
  "DERIVED_FROM",
  "RELATED_TO",
  "DUPLICATE_OF",
]);

const PROVENANCE_ENDPOINTS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  SESSION_CONTAINS_TURN: ["SESSION", "TURN"],
  TURN_CONTAINS_EVENT: ["TURN", "EVENT"],
  SNAPSHOT_INCLUDES_EVENT: ["EVENT", "SNAPSHOT"],
  SNAPSHOT_DERIVED_EPISODE: ["SNAPSHOT", "EPISODE"],
  EPISODE_COMPILED_CANDIDATE: ["EPISODE", "CANDIDATE"],
  CANDIDATE_PUBLISHED_AS: ["CANDIDATE", "KNOWLEDGE_VERSION"],
});

export const provenanceEdgeSchema = z.strictObject({
  edgeId: safeArtifactIdSchema,
  relationType: z.enum(PROVENANCE_RELATION_TYPES),
  from: provenanceNodeSchema,
  to: provenanceNodeSchema,
  reason: z.string().min(1).max(500).optional(),
  observedAt: isoTimestampSchema,
}).superRefine((value, context) => {
  const expected = PROVENANCE_ENDPOINTS[value.relationType];
  const valid = expected === undefined
    ? KNOWLEDGE_RELATION_TYPES.has(value.relationType)
      && value.from.type === "KNOWLEDGE_VERSION"
      && value.to.type === "KNOWLEDGE_VERSION"
    : value.from.type === expected[0] && value.to.type === expected[1];
  if (!valid) {
    context.addIssue({
      code: "custom",
      path: ["relationType"],
      message: "provenance relation does not match its endpoint node types",
    });
  }
});

export const bidirectionalProvenanceSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  root: provenanceNodeSchema,
  upstream: z.array(provenanceEdgeSchema).max(1_000),
  downstream: z.array(provenanceEdgeSchema).max(1_000),
  completeness: z.enum(["COMPLETE", "PARTIAL_UNSUPPORTED_EVENT_TYPES", "TRUNCATED"]),
  unsupportedEventTypes: z.array(versionLabelSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).optional(),
}).superRefine((value, context) => {
  const serializedRoot = JSON.stringify(value.root);
  if (value.upstream.some((edge) => JSON.stringify(edge.to) !== serializedRoot)) {
    context.addIssue({ code: "custom", path: ["upstream"], message: "upstream edges must terminate at root" });
  }
  if (value.downstream.some((edge) => JSON.stringify(edge.from) !== serializedRoot)) {
    context.addIssue({ code: "custom", path: ["downstream"], message: "downstream edges must originate at root" });
  }
  if (value.completeness === "COMPLETE" && value.unsupportedEventTypes.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["unsupportedEventTypes"],
      message: "complete provenance cannot contain unsupported event types",
    });
  }
  if (value.completeness === "PARTIAL_UNSUPPORTED_EVENT_TYPES" && value.unsupportedEventTypes.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["unsupportedEventTypes"],
      message: "partial unsupported provenance requires an unsupported event type",
    });
  }
  if (value.completeness === "TRUNCATED" && value.nextCursor === undefined) {
    context.addIssue({ code: "custom", path: ["nextCursor"], message: "truncated provenance requires a cursor" });
  }
  const edgeIds = [...value.upstream, ...value.downstream].map((edge) => edge.edgeId);
  if (new Set(edgeIds).size !== edgeIds.length) {
    context.addIssue({ code: "custom", path: ["upstream"], message: "provenance edge IDs must be unique" });
  }
});

const p2RequestBase = {
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  requestId: requestIdSchema,
};

export const extractionSnapshotCreateRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.snapshot.create"),
  sessionId: sessionIdSchema,
  expectedCaptureRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  transcriptIdentityHash: sha256Schema,
  sourceSequence: sourceSequenceRangeSchema,
  cursor: snapshotCursorSchema,
  completeness: snapshotCompletenessSchema,
  compilerVersion: versionLabelSchema,
  policyHash: sha256Schema,
  configurationHash: sha256Schema,
  idempotencyKey: idempotencyKeySchema,
});

export const candidatePreviewRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.candidates.preview"),
  snapshot: snapshotReferenceSchema,
  compilerVersion: versionLabelSchema,
  policyHash: sha256Schema,
  idempotencyKey: idempotencyKeySchema,
});

export const candidatePolicyCommitRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.candidates.commit"),
  snapshot: snapshotReferenceSchema,
  previewId: safeArtifactIdSchema,
  expectedPreviewRevision: positiveRevisionSchema,
  compilerVersion: versionLabelSchema,
  policyHash: sha256Schema,
  idempotencyKey: idempotencyKeySchema,
});

export const extractionSnapshotGetRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.snapshot.get"),
  snapshotId: snapshotIdSchema,
});

export const extractionSnapshotsListRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.snapshots.list"),
  sessionId: sessionIdSchema.optional(),
  limit: z.number().int().positive().max(100),
});

export const extractionCandidatesGetRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.candidates.get"),
  previewId: safeArtifactIdSchema.optional(),
  snapshotId: snapshotIdSchema.optional(),
}).superRefine((value, context) => {
  if ((value.previewId === undefined) === (value.snapshotId === undefined)) {
    context.addIssue({ code: "custom", message: "exactly one previewId or snapshotId is required" });
  }
});

export const extractionPolicyCommitGetRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.policy-commit.get"),
  previewId: safeArtifactIdSchema,
});

export const extractionProvenanceGetRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("extraction.provenance.get"),
  root: provenanceNodeSchema,
  limit: z.number().int().positive().max(100),
  afterEdgeId: safeArtifactIdSchema.optional(),
});

export const LEGACY_MIGRATION_STATUSES = [
  "READY", "COMMITTING", "COMPLETED", "FAILED", "ROLLING_BACK", "ROLLED_BACK", "ROLLBACK_CONFLICT",
] as const;
export const LEGACY_MIGRATION_CLASSIFICATIONS = ["MIGRATABLE", "ALREADY_CURRENT", "SKIPPED"] as const;
export const LEGACY_MIGRATION_SOURCES = ["FRESHNESS", "RECIPE", "SYMBOL_ANCHOR", "NONE"] as const;
export const LEGACY_MIGRATION_ITEM_STATUSES = [
  "PENDING", "MIGRATED", "SKIPPED", "FAILED", "ROLLED_BACK", "ROLLBACK_CONFLICT",
] as const;

/** Bounded operator view. Knowledge bodies and raw verification output are intentionally absent. */
export const legacyMigrationPreviewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  migrationId: safeArtifactIdSchema,
  migrationVersion: versionLabelSchema,
  projectId: safeArtifactIdSchema,
  sourceRegistryRevision: nonnegativeRevisionSchema,
  status: z.enum(LEGACY_MIGRATION_STATUSES),
  revision: nonnegativeRevisionSchema,
  scannedCount: nonnegativeRevisionSchema,
  migratableCount: nonnegativeRevisionSchema,
  alreadyCurrentCount: nonnegativeRevisionSchema,
  skippedCount: nonnegativeRevisionSchema,
  failedCount: nonnegativeRevisionSchema,
  rollbackConflictCount: nonnegativeRevisionSchema,
  summaryHash: sha256Schema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  jobId: safeArtifactIdSchema.optional(),
  failureCode: versionLabelSchema.optional(),
}).superRefine((value, context) => {
  if (value.migratableCount + value.alreadyCurrentCount + value.skippedCount !== value.scannedCount) {
    context.addIssue({ code: "custom", path: ["scannedCount"], message: "migration counters do not sum to scannedCount" });
  }
});

export const legacyMigrationItemSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  migrationId: safeArtifactIdSchema,
  ordinal: nonnegativeRevisionSchema,
  assetId: safeArtifactIdSchema,
  assetVersion: positiveRevisionSchema,
  assetContentHash: sha256Schema,
  assetIndexVersion: positiveRevisionSchema,
  classification: z.enum(LEGACY_MIGRATION_CLASSIFICATIONS),
  source: z.enum(LEGACY_MIGRATION_SOURCES),
  candidateId: safeArtifactIdSchema.optional(),
  assertionsHash: sha256Schema.optional(),
  assertionKinds: z.array(versionLabelSchema).max(1_000),
  reasonCodes: z.array(versionLabelSchema).min(1).max(32),
  status: z.enum(LEGACY_MIGRATION_ITEM_STATUSES),
  verificationRunId: safeArtifactIdSchema.optional(),
  freshnessStatus: z.enum(["FRESH", "CONFLICT", "UNKNOWN"]).optional(),
  createdRecipe: z.boolean().optional(),
  createdFreshness: z.boolean().optional(),
  updatedAt: isoTimestampSchema,
}).superRefine((value, context) => {
  const hasEvidenceIdentity = value.candidateId !== undefined && value.assertionsHash !== undefined;
  if ((value.classification === "MIGRATABLE") !== hasEvidenceIdentity) {
    context.addIssue({ code: "custom", path: ["classification"], message: "migratable items require evidence identity" });
  }
});

export const legacyMigrationPageSchema = z.strictObject({
  items: z.array(legacyMigrationItemSchema).max(100),
  nextOrdinal: nonnegativeRevisionSchema.optional(),
});

export const legacyMigrationsListSchema = z.strictObject({
  items: z.array(legacyMigrationPreviewSchema).max(100),
});

export const legacyMigrationCommitResultSchema = z.strictObject({
  preview: legacyMigrationPreviewSchema,
  job: jobSnapshotSchema,
});

export const legacyMigrationPreviewRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("knowledge.migrations.preview"),
  projectId: safeArtifactIdSchema,
  requestedAt: isoTimestampSchema,
});

export const legacyMigrationsListRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("knowledge.migrations.list"),
  projectId: safeArtifactIdSchema,
  limit: z.number().int().positive().max(100),
});

export const legacyMigrationGetRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("knowledge.migrations.get"),
  migrationId: safeArtifactIdSchema,
});

export const legacyMigrationItemsRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("knowledge.migrations.items"),
  migrationId: safeArtifactIdSchema,
  limit: z.number().int().positive().max(100),
  afterOrdinal: nonnegativeRevisionSchema.optional(),
});

const legacyMigrationCommandShape = {
  ...p2RequestBase,
  migrationId: safeArtifactIdSchema,
  expectedRevision: nonnegativeRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  requestedAt: isoTimestampSchema,
};

export const legacyMigrationCommitRequestSchema = z.strictObject({
  ...legacyMigrationCommandShape,
  type: z.literal("knowledge.migrations.commit"),
});

export const legacyMigrationRollbackRequestSchema = z.strictObject({
  ...legacyMigrationCommandShape,
  type: z.literal("knowledge.migrations.rollback"),
});

export const evolutionOperationsGetRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("evolution.operations.get"),
});

export const codeGraphProjectsListRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("codegraph.projects.list"),
  limit: z.number().int().positive().max(100),
});

export const codeGraphInitializationPreviewRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("codegraph.initialization.preview"),
  projectId: safeArtifactIdSchema,
  requestedAt: isoTimestampSchema,
});

export const codeGraphInitializationCommitRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("codegraph.initialization.commit"),
  projectId: safeArtifactIdSchema,
  previewId: safeArtifactIdSchema,
  repositoryIdentity: sha256Schema,
  expectedRevision: nonnegativeRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  requestedAt: isoTimestampSchema,
});

export const operationalAlertsListRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("alerts.list"),
  projectId: safeArtifactIdSchema.optional(),
  limit: z.number().int().positive().max(100),
  cursor: operatorCursorSchema.optional(),
});

const alertOperatorCommandShape = {
  ...p2RequestBase,
  alertId: safeArtifactIdSchema,
  expectedRevision: nonnegativeRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  requestedAt: isoTimestampSchema,
};

export const operationalAlertAcknowledgeRequestSchema = z.strictObject({
  ...alertOperatorCommandShape,
  type: z.literal("alerts.acknowledge"),
});

export const operationalAlertSuppressRequestSchema = z.strictObject({
  ...alertOperatorCommandShape,
  type: z.literal("alerts.suppress"),
  suppressedUntil: isoTimestampSchema,
}).superRefine((value, context) => {
  if (Date.parse(value.suppressedUntil) <= Date.parse(value.requestedAt)) {
    context.addIssue({ code: "custom", path: ["suppressedUntil"], message: "suppression expiry must follow request time" });
  }
});

export const knowledgeEvolutionGetRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("knowledge.evolution.get"),
  knowledgeId: safeArtifactIdSchema,
});

export const knowledgeRevalidationCommitRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("knowledge.revalidation.commit"),
  knowledgeId: safeArtifactIdSchema,
  expectedKnowledgeVersion: positiveRevisionSchema,
  expectedFreshnessRevision: nonnegativeRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  requestedAt: isoTimestampSchema,
});

export const knowledgeRepairSubmitRequestSchema = z.strictObject({
  ...p2RequestBase,
  type: z.literal("knowledge.repair.submit"),
  draftId: safeArtifactIdSchema,
  expectedRevision: nonnegativeRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  title: boundedTextSchema(2_000),
  summary: boundedTextSchema(20_000),
  body: boundedTextSchema(64_000),
  requestedAt: isoTimestampSchema,
});

export const p2ControlRequestSchema = z.discriminatedUnion("type", [
  extractionSnapshotCreateRequestSchema,
  candidatePreviewRequestSchema,
  candidatePolicyCommitRequestSchema,
  extractionSnapshotGetRequestSchema,
  extractionSnapshotsListRequestSchema,
  extractionCandidatesGetRequestSchema,
  extractionPolicyCommitGetRequestSchema,
  extractionProvenanceGetRequestSchema,
  legacyMigrationPreviewRequestSchema,
  legacyMigrationsListRequestSchema,
  legacyMigrationGetRequestSchema,
  legacyMigrationItemsRequestSchema,
  legacyMigrationCommitRequestSchema,
  legacyMigrationRollbackRequestSchema,
  evolutionOperationsGetRequestSchema,
  codeGraphProjectsListRequestSchema,
  codeGraphInitializationPreviewRequestSchema,
  codeGraphInitializationCommitRequestSchema,
  operationalAlertsListRequestSchema,
  operationalAlertAcknowledgeRequestSchema,
  operationalAlertSuppressRequestSchema,
  knowledgeEvolutionGetRequestSchema,
  knowledgeRevalidationCommitRequestSchema,
  knowledgeRepairSubmitRequestSchema,
]);

export type ExtractionSnapshot = z.infer<typeof extractionSnapshotSchema>;
export type SnapshotReference = z.infer<typeof snapshotReferenceSchema>;
export type CandidatePreviewItem = z.infer<typeof candidatePreviewItemSchema>;
export type CandidatePreview = z.infer<typeof candidatePreviewSchema>;
export type ProvenanceNode = z.infer<typeof provenanceNodeSchema>;
export type ProvenanceEdge = z.infer<typeof provenanceEdgeSchema>;
export type BidirectionalProvenance = z.infer<typeof bidirectionalProvenanceSchema>;
export type LegacyMigrationPreviewView = z.infer<typeof legacyMigrationPreviewSchema>;
export type LegacyMigrationItemView = z.infer<typeof legacyMigrationItemSchema>;
export type LegacyMigrationPageView = z.infer<typeof legacyMigrationPageSchema>;
export type P2ControlRequest = z.infer<typeof p2ControlRequestSchema>;

export type P2ContractParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: "INVALID_JSON" | "MESSAGE_TOO_LARGE" | "UNSUPPORTED_SCHEMA_VERSION" | "INVALID_REQUEST";
      readonly issues: readonly string[];
    };

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseP2ContractText<T>(
  serialized: string,
  schema: z.ZodType<T>,
  maximumBytes = MAX_CONTROL_MESSAGE_BYTES,
): P2ContractParseResult<T> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error(`maximumBytes must be within 1..${MAX_CONTROL_MESSAGE_BYTES}`);
  }
  if (utf8ByteLength(serialized) > maximumBytes) {
    return { ok: false, code: "MESSAGE_TOO_LARGE", issues: ["P2 contract exceeds configured byte limit"] };
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return { ok: false, code: "INVALID_JSON", issues: ["P2 contract is not valid JSON"] };
  }
  if (typeof value === "object" && value !== null && "schemaVersion" in value
    && (value as { schemaVersion?: unknown }).schemaVersion !== CONTROL_API_SCHEMA_VERSION) {
    return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", issues: ["unsupported control API schema version"] };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      issues: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
    };
  }
  return { ok: true, value: parsed.data };
}
