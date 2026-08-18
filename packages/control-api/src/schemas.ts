import { z } from "zod";

import {
  CAPABILITY_STATUSES,
  CONTROL_API_SCHEMA_VERSION,
  CONTROL_ERROR_CODES,
  INJECTION_STATUSES,
  JOB_ATTEMPT_STATUSES,
  JOB_CANCELLATION_STATUSES,
  JOB_IDEMPOTENCY_STATUSES,
  JOB_LEASE_STATUSES,
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
export const jobAttemptStatusSchema = z.enum(JOB_ATTEMPT_STATUSES);
export const jobLeaseStatusSchema = z.enum(JOB_LEASE_STATUSES);
export const jobCancellationStatusSchema = z.enum(JOB_CANCELLATION_STATUSES);
export const jobIdempotencyStatusSchema = z.enum(JOB_IDEMPOTENCY_STATUSES);
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

export const jobFailureSchema = z.strictObject({
  code: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u),
  retryable: z.boolean(),
  occurredAt: isoTimestampSchema,
});

export const jobLeaseSchema = z.strictObject({
  attemptId: safeId(),
  workerId: safeId(200),
  fencingToken: z.number().int().positive(),
  status: jobLeaseStatusSchema,
  acquiredAt: isoTimestampSchema,
  heartbeatAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});

export const jobCheckpointSchema = z.strictObject({
  revision: z.number().int().positive(),
  payloadHash: sha256Schema,
  progress: z.number().min(0).max(1),
  updatedAt: isoTimestampSchema,
});

export const jobCancellationSchema = z.strictObject({
  status: jobCancellationStatusSchema,
  requestedAt: isoTimestampSchema.optional(),
  resolvedAt: isoTimestampSchema.optional(),
}).superRefine((value, context) => {
  if (value.status === "NOT_REQUESTED" && (value.requestedAt !== undefined || value.resolvedAt !== undefined)) {
    context.addIssue({ code: "custom", path: ["status"], message: "cancellation was not requested" });
  }
  if (value.status !== "NOT_REQUESTED" && value.requestedAt === undefined) {
    context.addIssue({ code: "custom", path: ["requestedAt"], message: "requested cancellation requires a timestamp" });
  }
  if ((value.status === "ACKNOWLEDGED" || value.status === "REJECTED") && value.resolvedAt === undefined) {
    context.addIssue({ code: "custom", path: ["resolvedAt"], message: "resolved cancellation requires a timestamp" });
  }
  if (value.status === "REQUESTED" && value.resolvedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["resolvedAt"], message: "pending cancellation cannot be resolved" });
  }
});

export const jobIdempotencySchema = z.strictObject({
  key: idempotencyKeySchema,
  inputHash: sha256Schema,
  status: jobIdempotencyStatusSchema,
});

export const jobAttemptSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  jobId: jobIdSchema,
  attemptId: safeId(),
  attempt: z.number().int().positive().max(1_000),
  status: jobAttemptStatusSchema,
  workerId: safeId(200),
  fencingToken: z.number().int().positive(),
  startedAt: isoTimestampSchema,
  heartbeatAt: isoTimestampSchema,
  leaseExpiresAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.optional(),
  checkpointRevision: z.number().int().nonnegative(),
  failure: jobFailureSchema.optional(),
}).superRefine((value, context) => {
  if (value.status === "RUNNING" && value.finishedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "running attempt cannot be finished" });
  }
  if (value.status !== "RUNNING" && value.finishedAt === undefined) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "terminal attempt requires finishedAt" });
  }
  const failed = value.status === "RETRYABLE_FAILED" || value.status === "TERMINAL_FAILED" || value.status === "LEASE_LOST";
  if (failed !== (value.failure !== undefined)) {
    context.addIssue({ code: "custom", path: ["failure"], message: "attempt failure metadata does not match status" });
  }
});

export const jobSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  jobId: jobIdSchema,
  jobType: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u),
  revision: z.number().int().nonnegative().optional(),
  status: jobStatusSchema,
  attempt: z.number().int().min(0).max(1_000),
  maxAttempts: z.number().int().min(1).max(1_000),
  progress: z.number().min(0).max(1),
  createdAt: isoTimestampSchema.optional(),
  updatedAt: isoTimestampSchema.optional(),
  startedAt: isoTimestampSchema.optional(),
  completedAt: isoTimestampSchema.optional(),
  nextAttemptAt: isoTimestampSchema.optional(),
  lease: jobLeaseSchema.optional(),
  checkpoint: jobCheckpointSchema.optional(),
  cancellation: jobCancellationSchema.optional(),
  lastFailure: jobFailureSchema.optional(),
  idempotency: jobIdempotencySchema.optional(),
  ...statusBaseShape,
}).superRefine((value, context) => {
  if (value.attempt > value.maxAttempts) {
    context.addIssue({ code: "custom", path: ["attempt"], message: "attempt exceeds maxAttempts" });
  }
  if (value.lease !== undefined && value.status !== "RUNNING") {
    context.addIssue({ code: "custom", path: ["lease"], message: "only a running job can expose a lease" });
  }
  if (value.nextAttemptAt !== undefined && value.status !== "RETRY_WAIT") {
    context.addIssue({ code: "custom", path: ["nextAttemptAt"], message: "only retry-wait can expose nextAttemptAt" });
  }
  if (value.completedAt !== undefined && value.status !== "SUCCEEDED" && value.status !== "FAILED" && value.status !== "CANCELLED") {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "only terminal jobs can expose completedAt" });
  }
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
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("job.cancel"),
    jobId: jobIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: idempotencyKeySchema,
  }),
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("job.retry"),
    jobId: jobIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: idempotencyKeySchema,
  }),
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
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("config.get"),
    projectId: safeId(200).optional(),
  }),
  z.strictObject({
    ...baseRequestShape,
    type: z.literal("config.validate"),
    baseRevision: z.number().int().nonnegative(),
    scope: z.enum(["GLOBAL", "PROJECT"]),
    projectId: safeId(200).optional(),
    draft: z.record(z.string().min(1).max(200), z.unknown()),
  }).superRefine((value, context) => {
    if ((value.scope === "PROJECT") !== (value.projectId !== undefined)) {
      context.addIssue({ code: "custom", path: ["projectId"], message: "projectId must match configuration scope" });
    }
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

export const jobCommandResultSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  action: z.enum(["CANCEL", "RETRY"]),
  disposition: z.enum(["APPLIED", "NOOP", "REPLAYED"]),
  job: jobSnapshotSchema,
}).superRefine((value, context) => {
  if (value.job.revision === undefined) {
    context.addIssue({ code: "custom", path: ["job", "revision"], message: "job command result requires a durable revision" });
  }
});

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

export const configurationFieldSourceSchema = z.enum(["DEFAULT", "FILE", "ENV", "GLOBAL", "PROJECT_OVERRIDE", "RUNTIME_OVERRIDE"]);
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

const configurationInteger = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);
const configurationThresholdPairSchema = z.strictObject({
  warning: z.number().int().positive(),
  error: z.number().int().positive(),
}).refine((value) => value.warning <= value.error, { path: ["warning"], message: "warning must not exceed error" });
const captureRetryConfigurationSchema = z.strictObject({
  maxAttempts: configurationInteger(1, 20),
  baseDelayMs: configurationInteger(100, 300_000),
  maximumDelayMs: configurationInteger(100, 3_600_000),
  jitterRatio: z.number().min(0).max(1),
}).refine((value) => value.baseDelayMs <= value.maximumDelayMs, {
  path: ["baseDelayMs"], message: "baseDelayMs must not exceed maximumDelayMs",
});

const publicationKindCsvSchema = z.string().max(1_000).refine((value) => value.length === 0 || value.split(",").every((item) =>
  ["FACT", "REQUIREMENT", "DESIGN", "DECISION", "IMPLEMENTATION", "EXPERIENCE", "RULE", "PREFERENCE", "PROCEDURE", "CONSTRAINT"].includes(item.trim())),
{ message: "allowedKindsCsv contains an unsupported knowledge kind" });
const safeCsvSchema = z.string().max(10_000).refine((value) => value.length === 0 || value.split(",").every((item) => /^[A-Za-z0-9._:-]{1,200}$/u.test(item.trim())),
  { message: "CSV contains an unsafe identifier" });

export const consoleConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(2),
  runtime: z.strictObject({
    sessionScanIntervalMs: configurationInteger(5_000, 86_400_000),
    followDebounceMs: configurationInteger(100, 60_000),
    workerPollIntervalMs: configurationInteger(100, 60_000),
    extractionDelayMs: configurationInteger(1_000, 86_400_000),
    workerConcurrency: configurationInteger(1, 32),
    scanBatchSize: configurationInteger(1, 1_000),
    captureBatchSize: configurationInteger(1, 1_000),
    captureRetry: captureRetryConfigurationSchema,
    alerts: z.strictObject({
      enabled: z.boolean(),
      notify: z.boolean(),
      minimumSeverity: z.enum(["WARNING", "ERROR"]),
      spoolDepth: configurationThresholdPairSchema,
      spoolOldestAgeMs: configurationThresholdPairSchema,
      cursorLagEvents: configurationThresholdPairSchema,
      failedJobs: configurationThresholdPairSchema,
      hookSilenceMs: configurationThresholdPairSchema,
      quietHours: z.strictObject({
        enabled: z.boolean(),
        startMinute: configurationInteger(0, 1_439),
        endMinute: configurationInteger(0, 1_439),
        daysOfWeek: z.array(configurationInteger(0, 6)).min(1).max(7).refine((days) => new Set(days).size === days.length).readonly(),
        utcOffsetMinutes: configurationInteger(-840, 840),
      }),
    }),
  }),
  future: z.strictObject({
    injectionMaxTokens: configurationInteger(1, 1_000_000),
    compilerBatchSize: configurationInteger(1, 1_000),
    codexQueryTimeoutMs: configurationInteger(1_000, 300_000),
    codexQueryConcurrency: configurationInteger(1, 32),
  }),
  compilation: z.strictObject({
    enabled: z.boolean(),
    mode: z.enum(["PREVIEW_ONLY", "POLICY_EVALUATION", "SAFE_AUTO_PUBLICATION"]),
    minNewTurns: configurationInteger(1, 100),
    minNewEvents: configurationInteger(1, 1_000),
    idleMs: configurationInteger(1_000, 86_400_000),
    maximumWaitMs: configurationInteger(1_000, 86_400_000),
    onSessionEnd: z.boolean(),
    scanIntervalMs: configurationInteger(1_000, 86_400_000),
    maxSessionsPerRun: configurationInteger(1, 10_000),
    maxDispatchesPerRun: configurationInteger(1, 1_000),
    publication: z.strictObject({
      enabled: z.boolean(),
      allowedKindsCsv: publicationKindCsvSchema,
      allowedProjectIdsCsv: safeCsvSchema,
      requireFreshCodeEvidence: z.literal(true),
      goldenDatasetId: z.string().max(200),
      goldenDatasetVersion: configurationInteger(0, 1_000_000),
      goldenConfigFingerprint: z.string().max(64).refine((value) => value.length === 0 || /^[a-f0-9]{64}$/u.test(value)),
    }),
  }),
  evolution: z.strictObject({ maxMatchCandidates: configurationInteger(1, 20), semanticJudgeEnabled: z.boolean(), failClosed: z.literal(true) }),
  codeIntelligence: z.strictObject({
    provider: z.literal("codegraph"), initializeAutomatically: z.literal(false), queryTimeoutMs: configurationInteger(10, 10_000),
    circuitBreakerFailures: configurationInteger(1, 100), circuitBreakerResetMs: configurationInteger(1_000, 3_600_000),
  }),
  freshness: z.strictObject({
    enabled: z.boolean(), changeDebounceMs: configurationInteger(100, 60_000), fallbackScanIntervalMs: configurationInteger(10_000, 86_400_000),
    preInjectionGate: z.literal(true), gateTimeoutMs: configurationInteger(10, 1_000), maxAffectedPerJob: configurationInteger(1, 10_000),
  }),
  prewarm: z.strictObject({
    enabled: z.boolean(), onSessionStart: z.boolean(), ttlMs: configurationInteger(1_000, 86_400_000),
    maxItems: configurationInteger(1, 50), maxTokens: configurationInteger(1, 4_000),
  }),
  evolutionAlerts: z.strictObject({
    enabled: z.boolean(), onPermanentJobFailure: z.boolean(), onCodeGraphUnavailable: z.boolean(), onStaleKnowledgeDetected: z.boolean(),
  }),
}).superRefine((configuration, context) => {
  if (configuration.compilation.idleMs > configuration.compilation.maximumWaitMs) {
    context.addIssue({ code: "custom", path: ["compilation", "idleMs"], message: "idleMs must not exceed maximumWaitMs" });
  }
  const publication = configuration.compilation.publication;
  const completeEvidence = publication.goldenDatasetId.length > 0 && publication.goldenDatasetVersion > 0 && publication.goldenConfigFingerprint.length === 64;
  if (publication.enabled && (configuration.compilation.mode !== "SAFE_AUTO_PUBLICATION" || publication.allowedKindsCsv.length === 0
    || publication.allowedProjectIdsCsv.length === 0 || !completeEvidence)) {
    context.addIssue({ code: "custom", path: ["compilation", "publication", "enabled"], message: "automatic publication requires safe mode, allowlists and golden evidence" });
  }
  if (!publication.enabled && configuration.compilation.mode === "SAFE_AUTO_PUBLICATION") {
    context.addIssue({ code: "custom", path: ["compilation", "mode"], message: "SAFE_AUTO_PUBLICATION requires publication.enabled" });
  }
  if (configuration.prewarm.maxTokens > configuration.future.injectionMaxTokens) {
    context.addIssue({ code: "custom", path: ["prewarm", "maxTokens"], message: "prewarm maxTokens must not exceed injectionMaxTokens" });
  }
});

export const configurationDiagnosticSchema = z.strictObject({
  code: z.enum([
    "INVALID_CONFIGURATION", "STALE_REVISION", "CONFLICT", "CONSUMER_DISABLED", "COMPONENT_PREPARE_FAILED",
    "COMPONENT_APPLY_FAILED", "COMPONENT_ROLLBACK_FAILED", "NOT_FOUND",
  ]),
  path: z.string().min(1).max(300).optional(),
  retryable: z.boolean(),
});

export const configurationDraftSchema = z.strictObject({
  draftRevision: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative(),
  scope: z.enum(["GLOBAL", "PROJECT"]),
  projectId: safeId(200).optional(),
  configuration: consoleConfigurationSchema,
  changedPaths: z.array(z.string().min(1).max(300)).max(500),
  requiresRestart: z.boolean(),
  activatable: z.boolean(),
  diagnostics: z.array(configurationDiagnosticSchema).max(100),
});

export const configurationViewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  hash: configurationHashSchema,
  projectId: safeId(200).optional(),
  effective: consoleConfigurationSchema,
  sources: z.record(z.string().min(1).max(300), configurationFieldSourceSchema),
});

export const configurationHistoryEntrySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  baseRevision: z.number().int().nonnegative(),
  status: z.enum(["EFFECTIVE", "REJECTED", "ROLLED_BACK"]),
  hash: configurationHashSchema,
  scope: z.enum(["GLOBAL", "PROJECT"]),
  projectId: safeId(200).optional(),
  changedPaths: z.array(z.string().min(1).max(300)).max(500),
  requiresRestart: z.boolean(),
  createdAt: isoTimestampSchema,
  reasonCode: z.string().min(1).max(200).regex(/^[A-Z][A-Z0-9_]*$/u),
});

export const configurationStateSchema = z.strictObject({
  view: configurationViewSchema,
  drafts: z.array(configurationDraftSchema).max(100),
  history: z.array(configurationHistoryEntrySchema).max(100),
});

export const configurationValidationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), draft: configurationDraftSchema }),
  z.strictObject({ ok: z.literal(false), diagnostics: z.array(configurationDiagnosticSchema).max(100) }),
]);

export const configurationMutationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    revision: z.number().int().positive(),
    hash: configurationHashSchema,
    status: z.enum(["EFFECTIVE", "ROLLED_BACK"]),
  }),
  z.strictObject({ ok: z.literal(false), diagnostic: configurationDiagnosticSchema }),
]);

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
  contentPreview: z.string().min(1).max(2_000).optional(),
  contentTruncated: z.boolean().optional(),
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

export const alertEvaluationSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  evaluationId: sha256Schema,
  observedAt: isoTimestampSchema,
  health: z.enum(["HEALTHY", "DEGRADED", "FAILED"]),
  quietHoursActive: z.boolean(),
  activeAlerts: z.array(z.strictObject({
    alertId: safeId(200),
    dedupeKey: safeId(500),
    entityType: z.enum(["SPOOL", "CURSOR", "JOBS", "HOOK"]),
    entityId: safeId(500),
    severity: z.enum(["WARNING", "ERROR"]),
    reasonCodes: z.array(z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u)).min(1).max(10),
    observedAt: isoTimestampSchema,
    observedValue: z.number().nonnegative(),
    threshold: z.number().nonnegative(),
    notificationPending: z.boolean(),
    notificationDelivered: z.boolean(),
  })).max(1_000),
  transitions: z.array(z.strictObject({
    dedupeKey: safeId(500),
    kind: z.enum(["OPENED", "UNCHANGED", "UPDATED", "ESCALATED", "DEESCALATED", "RESOLVED"]),
    previousSeverity: z.enum(["WARNING", "ERROR"]).optional(),
    currentSeverity: z.enum(["WARNING", "ERROR"]).optional(),
    reasonCodes: z.array(z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u)).max(10),
    notificationDecision: z.enum(["DELIVER", "NOT_REQUIRED", "SUPPRESSED_DISABLED", "SUPPRESSED_QUIET_HOURS", "SUPPRESSED_MINIMUM_SEVERITY"]),
  })).max(2_000),
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
  alerts: alertEvaluationSchema.optional(),
});

export const capturedEventContentSchema = z.strictObject({
  eventId: safeId(),
  eventType: z.string().min(1).max(120),
  occurredAt: isoTimestampSchema,
  turnId: turnIdSchema.optional(),
  contentPreview: z.string().min(1).max(2_000),
  contentTruncated: z.boolean(),
});

export const capturePreviewSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  previewRevision: z.number().int().positive(),
  transcriptIdentityHash: sha256Schema,
  projectedEvents: z.number().int().nonnegative(),
  ignoredRecords: z.number().int().nonnegative(),
  eventTypes: z.record(z.string().min(1).max(120), z.number().int().nonnegative()),
  items: z.array(capturedEventContentSchema).max(100),
  itemsTruncated: z.boolean(),
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
  appendedEventIds: z.array(safeId()).max(100),
  duplicateEventIds: z.array(safeId()).max(100),
  eventIdsTruncated: z.boolean(),
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
export type JobCommandResult = z.infer<typeof jobCommandResultSchema>;
export type JobAttemptSnapshot = z.infer<typeof jobAttemptSnapshotSchema>;
export type JobLease = z.infer<typeof jobLeaseSchema>;
export type JobCheckpoint = z.infer<typeof jobCheckpointSchema>;
export type JobFailure = z.infer<typeof jobFailureSchema>;
export type JobCancellation = z.infer<typeof jobCancellationSchema>;
export type JobIdempotency = z.infer<typeof jobIdempotencySchema>;
export type InjectionAttempt = z.infer<typeof injectionAttemptSchema>;
export type ProvenanceLink = z.infer<typeof provenanceLinkSchema>;
export type ConfigurationRevision = z.infer<typeof configurationRevisionSchema>;
export type ConsoleConfiguration = z.infer<typeof consoleConfigurationSchema>;
export type ConfigurationDraft = z.infer<typeof configurationDraftSchema>;
export type ConfigurationView = z.infer<typeof configurationViewSchema>;
export type ConfigurationState = z.infer<typeof configurationStateSchema>;
export type ConfigurationValidationResult = z.infer<typeof configurationValidationResultSchema>;
export type ConfigurationMutationResult = z.infer<typeof configurationMutationResultSchema>;
export type SseInvalidationEvent = z.infer<typeof sseInvalidationEventSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type EventMetadata = z.infer<typeof eventMetadataSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type AlertEvaluation = z.infer<typeof alertEvaluationSchema>;
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
