import { createHash } from "node:crypto";

import type { SessionCatalogEntry } from "@zhiloop/session-catalog";

import type {
  CompilationSessionObservation,
  KnowledgeCompilationCheckpoint,
  KnowledgeCompilationConfiguration,
  KnowledgeCompilationPipelineIdentity,
  NormalizedKnowledgeCompilationConfiguration,
  TriggerEvaluation,
} from "./types.js";

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return selected;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return parsed;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function normalizeKnowledgeCompilationConfiguration(
  input: KnowledgeCompilationConfiguration = {},
): NormalizedKnowledgeCompilationConfiguration {
  return Object.freeze({
    enabled: input.enabled ?? true,
    scanIntervalMs: boundedInteger(input.scanIntervalMs, 30_000, 1_000, 86_400_000, "scanIntervalMs"),
    minimumNewTurns: boundedInteger(input.minimumNewTurns, 3, 1, 1_000, "minimumNewTurns"),
    minimumNewEvents: boundedInteger(input.minimumNewEvents, 2, 1, 100_000, "minimumNewEvents"),
    idleAfterMs: boundedInteger(input.idleAfterMs, 120_000, 1_000, 86_400_000, "idleAfterMs"),
    maximumWaitMs: boundedInteger(input.maximumWaitMs, 1_800_000, 1_000, 604_800_000, "maximumWaitMs"),
    retryDelayMs: boundedInteger(input.retryDelayMs, 30_000, 1_000, 3_600_000, "retryDelayMs"),
    pageSize: boundedInteger(input.pageSize, 100, 1, 100, "pageSize"),
    maxScanPages: boundedInteger(input.maxScanPages, 50, 1, 1_000, "maxScanPages"),
    maxSessionsPerRun: boundedInteger(input.maxSessionsPerRun, 1_000, 1, 50_000, "maxSessionsPerRun"),
    maxDispatchesPerRun: boundedInteger(input.maxDispatchesPerRun, 25, 1, 1_000, "maxDispatchesPerRun"),
    checkpointConflictRetries: boundedInteger(input.checkpointConflictRetries, 3, 1, 10, "checkpointConflictRetries"),
  });
}

export function knowledgeCompilationPipelineHash(identity: KnowledgeCompilationPipelineIdentity): string {
  return createHash("sha256").update(JSON.stringify({
    compilerVersion: identity.compilerVersion,
    promptVersion: identity.promptVersion,
    policyHash: identity.policyHash,
    configurationHash: identity.configurationHash,
    executionMode: "PREVIEW_ONLY",
  })).digest("hex");
}

export function automaticPreviewIdempotencyKey(input: {
  readonly sessionId: string;
  readonly expectedLedgerSequence: number;
  readonly sourceVersion?: string;
  readonly pipeline: KnowledgeCompilationPipelineIdentity;
}): string {
  const digest = createHash("sha256").update(JSON.stringify({
    sessionId: input.sessionId,
    expectedLedgerSequence: input.expectedLedgerSequence,
    sourceVersion: input.sourceVersion ?? null,
    compilerVersion: input.pipeline.compilerVersion,
    promptVersion: input.pipeline.promptVersion,
    policyHash: input.pipeline.policyHash,
    configurationHash: input.pipeline.configurationHash,
    executionMode: "PREVIEW_ONLY",
  })).digest("hex");
  return `knowledge-compile:v1:${digest}`;
}

export function evaluateKnowledgeCompilationTrigger(input: {
  readonly session: SessionCatalogEntry;
  readonly observation: CompilationSessionObservation;
  readonly checkpoint?: KnowledgeCompilationCheckpoint;
  readonly configuration: NormalizedKnowledgeCompilationConfiguration;
  readonly pipelineHash: string;
  readonly observedAt: string;
}): TriggerEvaluation {
  const { session, observation, checkpoint, configuration, pipelineHash, observedAt } = input;
  const nowMs = timestamp(observedAt, "observedAt");
  const activityMs = timestamp(observation.lastActivityAt, "observation.lastActivityAt");

  if (session.sourceStatus !== "AVAILABLE") {
    return Object.freeze({ eligible: false, reasonCode: "SOURCE_UNAVAILABLE" });
  }
  if (session.captureStatus !== "CAPTURED_CURRENT") {
    return Object.freeze({ eligible: false, reasonCode: "CAPTURE_NOT_CURRENT" });
  }

  const samePipeline = checkpoint?.lastCompiledPipelineHash === pipelineHash;
  const compiledSequence = samePipeline ? checkpoint?.lastCompiledLedgerSequence ?? 0 : 0;
  const compiledEvents = samePipeline ? checkpoint?.lastCompiledEventCount ?? 0 : 0;
  const compiledTurns = samePipeline ? checkpoint?.lastCompiledTurnCount ?? 0 : 0;
  const newEvents = observation.effectiveEventCount - compiledEvents;
  const newTurns = observation.effectiveTurnCount - compiledTurns;

  if (observation.ledgerSequence <= compiledSequence && newEvents <= 0) {
    return Object.freeze({ eligible: false, reasonCode: "NO_NEW_EVENTS" });
  }

  const firstPendingObservedAt = checkpoint?.firstPendingObservedAt ?? observedAt;
  const firstPendingMs = timestamp(firstPendingObservedAt, "firstPendingObservedAt");
  if (newEvents < configuration.minimumNewEvents) {
    return Object.freeze({
      eligible: false,
      reasonCode: "MINIMUM_EVENTS_PENDING",
      firstPendingObservedAt,
      nextEligibleAt: iso(Math.min(activityMs + configuration.idleAfterMs, firstPendingMs + configuration.maximumWaitMs)),
    });
  }

  if (observation.latestEventType === "session.ended") {
    return Object.freeze({ eligible: true, reasonCode: "SESSION_ENDED", trigger: "SESSION_ENDED", firstPendingObservedAt });
  }
  if (newTurns >= configuration.minimumNewTurns) {
    return Object.freeze({ eligible: true, reasonCode: "TURN_THRESHOLD", trigger: "TURN_THRESHOLD", firstPendingObservedAt });
  }
  if (nowMs >= activityMs + configuration.idleAfterMs) {
    return Object.freeze({ eligible: true, reasonCode: "SESSION_IDLE", trigger: "SESSION_IDLE", firstPendingObservedAt });
  }
  if (nowMs >= firstPendingMs + configuration.maximumWaitMs) {
    return Object.freeze({ eligible: true, reasonCode: "MAXIMUM_WAIT", trigger: "MAXIMUM_WAIT", firstPendingObservedAt });
  }
  return Object.freeze({
    eligible: false,
    reasonCode: "WAITING_FOR_TRIGGER",
    firstPendingObservedAt,
    nextEligibleAt: iso(Math.min(activityMs + configuration.idleAfterMs, firstPendingMs + configuration.maximumWaitMs)),
  });
}
