import { z } from "zod";

import {
  CAPABILITY_STATUSES,
  CONTROL_API_SCHEMA_VERSION,
  CONTROL_ERROR_CODES,
  INJECTION_STATUSES,
  JOB_STATUSES,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_PAGE_SIZE,
  REASON_CODES,
  SSE_EVENT_TYPES,
  STAGE_STATUSES,
} from "./constants.js";

const noControlCharacters = /^[^\0\r\n]+$/u;
const safeId = (maximum = 500) => z.string().min(1).max(maximum).regex(noControlCharacters);
const isoTimestampSchema = z.string().min(20).max(40).refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "expected an ISO timestamp",
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const requestIdSchema = safeId(200);
export const sessionIdSchema = safeId();
export const turnIdSchema = safeId();
export const snapshotIdSchema = safeId();
export const runIdSchema = safeId();
export const traceIdSchema = safeId();
export const knowledgeIdSchema = safeId();
export const jobIdSchema = safeId();
export const capabilityIdSchema = z.string().min(1).max(120).regex(/^[a-z][a-z0-9.-]*$/u);
export const idempotencyKeySchema = z.string().min(16).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
export const configurationHashSchema = sha256Schema;

export const reasonCodeSchema = z.enum(REASON_CODES);
export const capabilityStatusSchema = z.enum(CAPABILITY_STATUSES);
export const stageStatusSchema = z.enum(STAGE_STATUSES);
export const jobStatusSchema = z.enum(JOB_STATUSES);
export const injectionStatusSchema = z.enum(INJECTION_STATUSES);

const statusBaseShape = {
  reasonCode: reasonCodeSchema,
  observedAt: isoTimestampSchema,
  lastTransitionAt: isoTimestampSchema,
  retryable: z.boolean(),
  evidenceRefs: z.array(safeId(1_000)).max(64),
  nextAction: z.string().min(1).max(500).optional(),
};

export const capabilitySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  capabilityId: capabilityIdSchema,
  status: capabilityStatusSchema,
  ...statusBaseShape,
});

export const stageSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  entityId: safeId(),
  stage: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u),
  status: stageStatusSchema,
  ...statusBaseShape,
});

export const jobSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  jobId: jobIdSchema,
  jobType: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u),
  status: jobStatusSchema,
  attempt: z.number().int().min(0).max(1_000),
  maxAttempts: z.number().int().min(1).max(1_000),
  progress: z.number().min(0).max(1),
  ...statusBaseShape,
});

export const knowledgeVersionRefSchema = z.strictObject({
  id: knowledgeIdSchema,
  version: z.number().int().positive(),
});

export const injectionAttemptSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  attemptId: safeId(),
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  status: injectionStatusSchema,
  runId: runIdSchema.optional(),
  traceId: traceIdSchema.optional(),
  knowledge: z.array(knowledgeVersionRefSchema).max(100),
  estimatedTokens: z.number().int().min(0).max(1_000_000),
  maxTokens: z.number().int().min(1).max(1_000_000),
  ...statusBaseShape,
});

export const provenanceLinkSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  turnId: turnIdSchema.optional(),
  sourceSequenceFrom: z.number().int().nonnegative(),
  sourceSequenceTo: z.number().int().nonnegative(),
  snapshotId: snapshotIdSchema.optional(),
  runId: runIdSchema.optional(),
  traceId: traceIdSchema.optional(),
  knowledge: z.array(knowledgeVersionRefSchema).max(100),
}).superRefine((value, context) => {
  if (value.sourceSequenceFrom > value.sourceSequenceTo) {
    context.addIssue({ code: "custom", path: ["sourceSequenceFrom"], message: "source sequence range is reversed" });
  }
});

export const pageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  cursor: z.string().min(1).max(2_048).optional(),
});

export function createPageSchema<T extends z.ZodType>(item: T): z.ZodObject<{
  items: z.ZodArray<T>;
  nextCursor: z.ZodOptional<z.ZodString>;
}> {
  return z.strictObject({ items: z.array(item).max(MAX_PAGE_SIZE), nextCursor: z.string().min(1).max(2_048).optional() });
}

const baseRequestShape = {
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  requestId: requestIdSchema,
};

const noInputRequest = <T extends string>(type: T) => z.strictObject({ ...baseRequestShape, type: z.literal(type) });
const pagedRequest = <T extends string>(type: T) => z.strictObject({
  ...baseRequestShape,
  type: z.literal(type),
  page: pageRequestSchema.optional(),
});

export const controlRequestSchema = z.discriminatedUnion("type", [
  noInputRequest("overview.get"),
  pagedRequest("capabilities.list"),
  pagedRequest("sessions.list"),
  z.strictObject({ ...baseRequestShape, type: z.literal("session.get"), sessionId: sessionIdSchema }),
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("session.events.list"),
    sessionId: sessionIdSchema,
    page: pageRequestSchema.optional(),
  }),
  pagedRequest("jobs.list"),
  noInputRequest("diagnostics.get"),
  z.strictObject({ ...baseRequestShape, type: z.literal("capture.preview"), sessionId: sessionIdSchema }),
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("capture.commit"),
    sessionId: sessionIdSchema,
    previewRevision: z.number().int().positive(),
    transcriptIdentityHash: sha256Schema,
    idempotencyKey: idempotencyKeySchema,
  }),
  noInputRequest("config.get"),
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("config.validate"),
    baseRevision: z.number().int().nonnegative(),
    draft: z.record(z.string().min(1).max(200), z.unknown()),
  }),
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("config.activate"),
    expectedRevision: z.number().int().nonnegative(),
    draftRevision: z.number().int().positive(),
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("config.rollback"),
    expectedRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative(),
    idempotencyKey: idempotencyKeySchema,
  }),
]);

export const controlErrorSchema = z.strictObject({
  code: z.enum(CONTROL_ERROR_CODES),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  details: z.record(z.string().min(1).max(100), z.string().max(500)).optional(),
});

export const controlResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
    requestId: requestIdSchema,
    observedAt: isoTimestampSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
    requestId: requestIdSchema,
    observedAt: isoTimestampSchema,
    ok: z.literal(false),
    error: controlErrorSchema,
  }),
]);

export const configurationFieldSourceSchema = z.enum(["DEFAULT", "FILE", "ENV", "PROJECT_OVERRIDE", "RUNTIME_OVERRIDE"]);
export const configurationRevisionSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  hash: configurationHashSchema,
  status: z.enum(["DRAFT", "EFFECTIVE", "REJECTED", "ROLLED_BACK"]),
  createdAt: isoTimestampSchema,
  baseRevision: z.number().int().nonnegative(),
  changedPaths: z.array(z.string().min(1).max(300)).max(500),
  requiresRestart: z.boolean(),
});

export const sseInvalidationEventSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  eventId: safeId(200),
  type: z.enum(SSE_EVENT_TYPES),
  entityId: safeId().optional(),
  revision: z.number().int().nonnegative(),
  occurredAt: isoTimestampSchema,
  reasonCode: reasonCodeSchema.optional(),
});

export const sessionSourceSchema = z.enum(["CODEX_APP_SERVER", "CODEX_TRANSCRIPT"]);
export const sessionSourceStatusSchema = z.enum(["AVAILABLE", "UNAVAILABLE", "UNSUPPORTED"]);
export const sessionCaptureStatusSchema = z.enum([
  "DISCOVERED_NOT_CAPTURED",
  "CAPTURED_PARTIAL",
  "CAPTURED_CURRENT",
  "SOURCE_UNAVAILABLE",
]);

export const sessionSummarySchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  title: z.string().min(1).max(300),
  source: sessionSourceSchema,
  sourceStatus: sessionSourceStatusSchema,
  sourceVersion: z.string().min(1).max(100).optional(),
  captureStatus: sessionCaptureStatusSchema,
  projectHint: z.string().min(1).max(500).optional(),
  cwdAlias: z.string().min(1).max(500).optional(),
  firstActivityAt: isoTimestampSchema,
  lastActivityAt: isoTimestampSchema,
  eventCount: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  ignoredRecords: z.number().int().nonnegative(),
  redactionCount: z.number().int().nonnegative(),
});

export const eventMetadataSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  eventId: safeId(),
  eventType: z.string().min(1).max(120),
  source: z.string().min(1).max(120),
  sessionId: sessionIdSchema,
  turnId: turnIdSchema.optional(),
  occurredAt: isoTimestampSchema,
  correlationId: safeId(),
  contentHash: sha256Schema,
  redactionCount: z.number().int().nonnegative(),
  payloadPurged: z.boolean(),
});

export const sessionDetailSchema = z.strictObject({
  summary: sessionSummarySchema,
  stages: z.array(stageSnapshotSchema).max(100),
  injections: z.array(injectionAttemptSchema).max(1_000),
  latestCursor: z.strictObject({
    byteOffset: z.number().int().nonnegative(),
    lineNumber: z.number().int().nonnegative(),
    observedAt: isoTimestampSchema,
  }).optional(),
});

export const jobCountsSchema = z.strictObject({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  retryWait: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const overviewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  observedAt: isoTimestampSchema,
  rolloutMode: z.enum(["OFF", "SHADOW", "ACTIVE"]),
  sidecarVersion: z.string().min(1).max(100),
  capabilities: z.array(capabilitySnapshotSchema).max(200),
  recentSessions: z.array(sessionSummarySchema).max(20),
  jobs: jobCountsSchema,
  alertCount: z.number().int().nonnegative(),
});

export const diagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  observedAt: isoTimestampSchema,
  ledgerSequence: z.number().int().nonnegative(),
  spoolDepth: z.number().int().nonnegative(),
  consumerLags: z.array(z.strictObject({
    consumerId: safeId(200),
    sequence: z.number().int().nonnegative(),
    lag: z.number().int().nonnegative(),
    updatedAt: isoTimestampSchema,
  })).max(500),
  worker: z.strictObject({
    healthy: z.boolean(),
    lastCycleAt: isoTimestampSchema.optional(),
    consumed: z.number().int().nonnegative(),
    produced: z.number().int().nonnegative(),
    retryableFailures: z.number().int().nonnegative(),
  }),
  storage: z.strictObject({
    healthy: z.boolean(),
    databaseBytes: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative().optional(),
  }),
});

export const capturePreviewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  previewRevision: z.number().int().positive(),
  transcriptIdentityHash: sha256Schema,
  projectedEvents: z.number().int().nonnegative(),
  ignoredRecords: z.number().int().nonnegative(),
  eventTypes: z.record(z.string().min(1).max(120), z.number().int().nonnegative()),
  cursor: z.strictObject({
    byteOffset: z.number().int().nonnegative(),
    lineNumber: z.number().int().nonnegative(),
  }),
  hasMore: z.boolean(),
  expiresAt: isoTimestampSchema,
});

export const captureCommitResultSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  previewRevision: z.number().int().positive(),
  appendedEvents: z.number().int().nonnegative(),
  duplicateEvents: z.number().int().nonnegative(),
  cursor: z.strictObject({
    byteOffset: z.number().int().nonnegative(),
    lineNumber: z.number().int().nonnegative(),
  }),
  knowledgeCompileStage: stageSnapshotSchema,
});

export const sessionPageSchema = createPageSchema(sessionSummarySchema);
export const capabilityPageSchema = createPageSchema(capabilitySnapshotSchema);
export const eventMetadataPageSchema = createPageSchema(eventMetadataSchema);
export const jobPageSchema = createPageSchema(jobSnapshotSchema);

export type ControlRequest = z.infer<typeof controlRequestSchema>;
export type ControlResponse = z.infer<typeof controlResponseSchema>;
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;
export type StageSnapshot = z.infer<typeof stageSnapshotSchema>;
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export type InjectionAttempt = z.infer<typeof injectionAttemptSchema>;
export type ProvenanceLink = z.infer<typeof provenanceLinkSchema>;
export type ConfigurationRevision = z.infer<typeof configurationRevisionSchema>;
export type SseInvalidationEvent = z.infer<typeof sseInvalidationEventSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type EventMetadata = z.infer<typeof eventMetadataSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type CapturePreview = z.infer<typeof capturePreviewSchema>;
export type CaptureCommitResult = z.infer<typeof captureCommitResultSchema>;

export type ControlRequestParseResult =
  | { readonly ok: true; readonly value: ControlRequest }
  | {
      readonly ok: false;
      readonly code: "INVALID_JSON" | "MESSAGE_TOO_LARGE" | "UNSUPPORTED_SCHEMA_VERSION" | "INVALID_REQUEST";
      readonly issues: readonly string[];
    };

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

export function parseControlRequestText(serialized: string, maximumBytes = MAX_CONTROL_MESSAGE_BYTES): ControlRequestParseResult {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error(`maximumBytes must be within 1..${MAX_CONTROL_MESSAGE_BYTES}`);
  }
  if (utf8ByteLength(serialized) > maximumBytes) {
    return { ok: false, code: "MESSAGE_TOO_LARGE", issues: ["control request exceeds configured byte limit"] };
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return { ok: false, code: "INVALID_JSON", issues: ["control request is not valid JSON"] };
  }
  if (typeof value === "object" && value !== null && "schemaVersion" in value
    && (value as { schemaVersion?: unknown }).schemaVersion !== CONTROL_API_SCHEMA_VERSION) {
    return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", issues: ["unsupported control API schema version"] };
  }
  const parsed = controlRequestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      issues: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
    };
  }
  return { ok: true, value: parsed.data };
}
