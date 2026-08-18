import type { SessionCatalogEntry, SessionPagePosition } from "@zhiloop/session-catalog";

import {
  automaticPreviewIdempotencyKey,
  evaluateKnowledgeCompilationTrigger,
  knowledgeCompilationPipelineHash,
  normalizeKnowledgeCompilationConfiguration,
} from "./decision.js";
import type {
  CompilationSessionObservation,
  KnowledgeCompilationCheckpoint,
  KnowledgeCompilationConfiguration,
  KnowledgeCompilationDependencies,
  KnowledgeCompilationDiagnostic,
  KnowledgeCompilationReasonCode,
  KnowledgeCompilationRunReport,
  KnowledgeCompilationStatus,
  NormalizedKnowledgeCompilationConfiguration,
} from "./types.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const MAX_DIAGNOSTICS = 100;

type SessionOutcome = "QUEUED" | "CURRENT" | "DEFERRED" | "RETRY" | "FAILED";

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("clock returned an invalid date");
  return date.toISOString();
}

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function cursorKey(position: SessionPagePosition): string {
  return `${position.lastActivityAt}\0${position.sessionId}`;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCatalogEntry(entry: SessionCatalogEntry): boolean {
  return SAFE_SESSION_ID.test(entry.sessionId)
    && validTimestamp(entry.lastActivityAt)
    && validCount(entry.eventCount)
    && validCount(entry.turnCount);
}

function validateObservation(entry: SessionCatalogEntry, observation: CompilationSessionObservation): void {
  if (
    observation.sessionId !== entry.sessionId
    || !validCount(observation.ledgerSequence)
    || !validCount(observation.effectiveEventCount)
    || !validCount(observation.effectiveTurnCount)
    || !validTimestamp(observation.lastActivityAt)
    || (observation.sourceVersion !== undefined && observation.sourceVersion.length > 4_000)
  ) throw Object.assign(new Error("compilation observation is invalid"), { retryable: false });
}

function diagnostic(code: KnowledgeCompilationReasonCode, retryable: boolean, sessionId?: string): KnowledgeCompilationDiagnostic {
  return Object.freeze({ code, retryable, ...(sessionId === undefined ? {} : { sessionId }) });
}

function checkpoint(input: {
  readonly previous?: KnowledgeCompilationCheckpoint;
  readonly observation: CompilationSessionObservation;
  readonly status: KnowledgeCompilationStatus;
  readonly reasonCode: KnowledgeCompilationReasonCode;
  readonly updatedAt: string;
  readonly firstPendingObservedAt?: string;
  readonly nextEligibleAt?: string;
  readonly lastCompiledLedgerSequence?: number;
  readonly lastCompiledEventCount?: number;
  readonly lastCompiledTurnCount?: number;
  readonly lastCompiledPipelineHash?: string;
  readonly pendingSnapshotId?: string;
  readonly pendingJobId?: string;
}): KnowledgeCompilationCheckpoint {
  const previous = input.previous;
  return Object.freeze({
    schemaVersion: 1,
    sessionId: input.observation.sessionId,
    version: (previous?.version ?? 0) + 1,
    lastObservedLedgerSequence: input.observation.ledgerSequence,
    lastObservedEventCount: input.observation.effectiveEventCount,
    lastObservedTurnCount: input.observation.effectiveTurnCount,
    lastCompiledLedgerSequence: input.lastCompiledLedgerSequence ?? previous?.lastCompiledLedgerSequence ?? 0,
    lastCompiledEventCount: input.lastCompiledEventCount ?? previous?.lastCompiledEventCount ?? 0,
    lastCompiledTurnCount: input.lastCompiledTurnCount ?? previous?.lastCompiledTurnCount ?? 0,
    ...(input.firstPendingObservedAt === undefined ? {} : { firstPendingObservedAt: input.firstPendingObservedAt }),
    lastActivityAt: input.observation.lastActivityAt,
    ...(input.observation.sourceVersion === undefined ? {} : { sourceVersion: input.observation.sourceVersion }),
    ...(input.lastCompiledPipelineHash ?? previous?.lastCompiledPipelineHash) === undefined
      ? {}
      : { lastCompiledPipelineHash: input.lastCompiledPipelineHash ?? previous!.lastCompiledPipelineHash! },
    ...(input.pendingSnapshotId ?? previous?.pendingSnapshotId) === undefined
      ? {}
      : { pendingSnapshotId: input.pendingSnapshotId ?? previous!.pendingSnapshotId! },
    ...(input.pendingJobId ?? previous?.pendingJobId) === undefined
      ? {}
      : { pendingJobId: input.pendingJobId ?? previous!.pendingJobId! },
    ...(input.nextEligibleAt === undefined ? {} : { nextEligibleAt: input.nextEligibleAt }),
    status: input.status,
    lastReasonCode: input.reasonCode,
    updatedAt: input.updatedAt,
  });
}

function dispatchFailure(error: unknown): { readonly status: "RETRY_WAIT" | "FAILED"; readonly reasonCode: "DISPATCH_RETRYABLE" | "DISPATCH_FAILED" } {
  const retryable = typeof error === "object" && error !== null && "retryable" in error && error.retryable === true;
  return retryable
    ? Object.freeze({ status: "RETRY_WAIT", reasonCode: "DISPATCH_RETRYABLE" })
    : Object.freeze({ status: "FAILED", reasonCode: "DISPATCH_FAILED" });
}

export class KnowledgeCompilationService {
  readonly configuration: NormalizedKnowledgeCompilationConfiguration;
  readonly #dependencies: KnowledgeCompilationDependencies;
  readonly #pipelineHash: string;

  constructor(
    dependencies: KnowledgeCompilationDependencies,
    configuration: KnowledgeCompilationConfiguration = {},
  ) {
    this.#dependencies = dependencies;
    this.configuration = normalizeKnowledgeCompilationConfiguration(configuration);
    this.#pipelineHash = knowledgeCompilationPipelineHash(dependencies.pipeline);
  }

  async runOnce(): Promise<KnowledgeCompilationRunReport> {
    const startedAt = iso((this.#dependencies.now ?? (() => new Date()))());
    const counters = {
      scannedSessions: 0,
      eligibleSessions: 0,
      queuedSessions: 0,
      currentSessions: 0,
      deferredSessions: 0,
      retrySessions: 0,
      failedSessions: 0,
    };
    const diagnostics: KnowledgeCompilationDiagnostic[] = [];
    let bounded = false;

    if (this.configuration.enabled) {
      let after: SessionPagePosition | undefined;
      const seenCursors = new Set<string>();
      const seenSessions = new Set<string>();
      for (let pageNumber = 0; pageNumber < this.configuration.maxScanPages; pageNumber += 1) {
        const remaining = this.configuration.maxSessionsPerRun - counters.scannedSessions;
        if (remaining <= 0) {
          bounded = true;
          break;
        }
        const page = await this.#dependencies.catalog.list({
          limit: Math.min(this.configuration.pageSize, remaining),
          ...(after === undefined ? {} : { after }),
        });
        for (const entry of page.items) {
          if (counters.queuedSessions >= this.configuration.maxDispatchesPerRun) {
            bounded = true;
            break;
          }
          if (counters.scannedSessions >= this.configuration.maxSessionsPerRun) {
            bounded = true;
            break;
          }
          if (seenSessions.has(entry.sessionId)) continue;
          seenSessions.add(entry.sessionId);
          counters.scannedSessions += 1;
          if (!validCatalogEntry(entry)) {
            counters.failedSessions += 1;
            this.#addDiagnostic(diagnostics, diagnostic("CATALOG_ENTRY_INVALID", false, entry.sessionId));
            continue;
          }
          if (entry.sourceStatus !== "AVAILABLE" || entry.captureStatus !== "CAPTURED_CURRENT") {
            counters.deferredSessions += 1;
            this.#addDiagnostic(diagnostics, diagnostic(
              entry.sourceStatus !== "AVAILABLE" ? "SOURCE_UNAVAILABLE" : "CAPTURE_NOT_CURRENT",
              true,
              entry.sessionId,
            ));
            continue;
          }
          const outcome = await this.#processSession(entry, startedAt, diagnostics);
          if (outcome === "QUEUED") {
            counters.eligibleSessions += 1;
            counters.queuedSessions += 1;
          } else if (outcome === "CURRENT") counters.currentSessions += 1;
          else if (outcome === "DEFERRED") counters.deferredSessions += 1;
          else if (outcome === "RETRY") counters.retrySessions += 1;
          else counters.failedSessions += 1;
        }
        if (bounded || page.nextPosition === undefined) {
          break;
        }
        const key = cursorKey(page.nextPosition);
        if (seenCursors.has(key)) {
          bounded = true;
          this.#addDiagnostic(diagnostics, diagnostic("CATALOG_CURSOR_LOOP", true));
          break;
        }
        seenCursors.add(key);
        after = page.nextPosition;
        if (pageNumber === this.configuration.maxScanPages - 1) bounded = true;
      }
      if (bounded) this.#addDiagnostic(diagnostics, diagnostic("SESSION_SCAN_BOUNDED", true));
    }

    const completedAt = iso((this.#dependencies.now ?? (() => new Date()))());
    return Object.freeze({
      schemaVersion: 1,
      startedAt,
      completedAt,
      ...counters,
      bounded,
      diagnostics: Object.freeze([...diagnostics]),
    });
  }

  async #processSession(
    entry: SessionCatalogEntry,
    observedAt: string,
    diagnostics: KnowledgeCompilationDiagnostic[],
  ): Promise<SessionOutcome> {
    for (let attempt = 0; attempt < this.configuration.checkpointConflictRetries; attempt += 1) {
      let previous: KnowledgeCompilationCheckpoint | undefined;
      let observation: CompilationSessionObservation;
      try {
        previous = await this.#dependencies.checkpoints.load(entry.sessionId);
        observation = await this.#dependencies.observations.inspect(entry);
        validateObservation(entry, observation);
      } catch {
        this.#addDiagnostic(diagnostics, diagnostic(previous === undefined ? "CHECKPOINT_INVALID" : "DISPATCH_FAILED", false, entry.sessionId));
        return "FAILED";
      }

      const evaluation = evaluateKnowledgeCompilationTrigger({
        session: entry,
        observation,
        ...(previous === undefined ? {} : { checkpoint: previous }),
        configuration: this.configuration,
        pipelineHash: this.#pipelineHash,
        observedAt,
      });
      if (!evaluation.eligible) {
        const current = evaluation.reasonCode === "NO_NEW_EVENTS";
        const next = checkpoint({
          ...(previous === undefined ? {} : { previous }),
          observation,
          status: current ? "CURRENT" : "WAITING_IDLE",
          reasonCode: evaluation.reasonCode,
          updatedAt: observedAt,
          ...(evaluation.firstPendingObservedAt === undefined ? {} : { firstPendingObservedAt: evaluation.firstPendingObservedAt }),
          ...(evaluation.nextEligibleAt === undefined ? {} : { nextEligibleAt: evaluation.nextEligibleAt }),
        });
        if (await this.#dependencies.checkpoints.compareAndSwap(entry.sessionId, previous?.version, next) === "COMMITTED") {
          if (!current) this.#addDiagnostic(diagnostics, diagnostic(evaluation.reasonCode, true, entry.sessionId));
          return current ? "CURRENT" : "DEFERRED";
        }
        continue;
      }

      let result;
      try {
        result = await this.#dependencies.dispatcher.dispatchPreview({
          schemaVersion: 1,
          sessionId: entry.sessionId,
          expectedLedgerSequence: observation.ledgerSequence,
          ...(observation.sourceVersion === undefined ? {} : { sourceVersion: observation.sourceVersion }),
          ...this.#dependencies.pipeline,
          executionMode: "PREVIEW_ONLY",
          trigger: evaluation.trigger!,
          idempotencyKey: automaticPreviewIdempotencyKey({
            sessionId: entry.sessionId,
            expectedLedgerSequence: observation.ledgerSequence,
            ...(observation.sourceVersion === undefined ? {} : { sourceVersion: observation.sourceVersion }),
            pipeline: this.#dependencies.pipeline,
          }),
          requestedAt: observedAt,
        });
      } catch (error) {
        const failure = dispatchFailure(error);
        const next = checkpoint({
          ...(previous === undefined ? {} : { previous }),
          observation,
          status: failure.status,
          reasonCode: failure.reasonCode,
          updatedAt: observedAt,
          firstPendingObservedAt: evaluation.firstPendingObservedAt ?? observedAt,
          ...(failure.status === "RETRY_WAIT" ? { nextEligibleAt: plusMilliseconds(observedAt, this.configuration.retryDelayMs) } : {}),
        });
        if (await this.#dependencies.checkpoints.compareAndSwap(entry.sessionId, previous?.version, next) === "COMMITTED") {
          this.#addDiagnostic(diagnostics, diagnostic(failure.reasonCode, failure.status === "RETRY_WAIT", entry.sessionId));
          return failure.status === "RETRY_WAIT" ? "RETRY" : "FAILED";
        }
        continue;
      }

      if (result.status === "ENQUEUED" || result.status === "EXISTING") {
        if (result.compiledThroughSequence !== observation.ledgerSequence) {
          this.#addDiagnostic(diagnostics, diagnostic("LEDGER_CHANGED", true, entry.sessionId));
          return "RETRY";
        }
        const next = checkpoint({
          ...(previous === undefined ? {} : { previous }),
          observation,
          status: "QUEUED",
          reasonCode: evaluation.reasonCode,
          updatedAt: observedAt,
          lastCompiledLedgerSequence: result.compiledThroughSequence,
          lastCompiledEventCount: observation.effectiveEventCount,
          lastCompiledTurnCount: observation.effectiveTurnCount,
          lastCompiledPipelineHash: this.#pipelineHash,
          pendingSnapshotId: result.snapshotId,
          pendingJobId: result.jobId,
        });
        if (await this.#dependencies.checkpoints.compareAndSwap(entry.sessionId, previous?.version, next) === "COMMITTED") return "QUEUED";
        continue;
      }

      if (result.status === "CURRENT") {
        const next = checkpoint({
          ...(previous === undefined ? {} : { previous }),
          observation,
          status: "CURRENT",
          reasonCode: "NO_NEW_EVENTS",
          updatedAt: observedAt,
          lastCompiledLedgerSequence: result.compiledThroughSequence,
          lastCompiledEventCount: observation.effectiveEventCount,
          lastCompiledTurnCount: observation.effectiveTurnCount,
          lastCompiledPipelineHash: this.#pipelineHash,
        });
        if (await this.#dependencies.checkpoints.compareAndSwap(entry.sessionId, previous?.version, next) === "COMMITTED") return "CURRENT";
        continue;
      }

      if (!("reasonCode" in result)) throw new Error("automatic preview dispatcher returned an invalid result");
      const retryable = result.status === "STALE";
      const next = checkpoint({
        ...(previous === undefined ? {} : { previous }),
        observation,
        status: retryable ? "RETRY_WAIT" : "FAILED",
        reasonCode: result.reasonCode,
        updatedAt: observedAt,
        firstPendingObservedAt: evaluation.firstPendingObservedAt ?? observedAt,
        ...(retryable ? { nextEligibleAt: plusMilliseconds(observedAt, this.configuration.retryDelayMs) } : {}),
      });
      if (await this.#dependencies.checkpoints.compareAndSwap(entry.sessionId, previous?.version, next) === "COMMITTED") {
        this.#addDiagnostic(diagnostics, diagnostic(result.reasonCode, retryable, entry.sessionId));
        return retryable ? "RETRY" : "FAILED";
      }
    }
    this.#addDiagnostic(diagnostics, diagnostic("CHECKPOINT_CONFLICT", true, entry.sessionId));
    return "RETRY";
  }

  #addDiagnostic(target: KnowledgeCompilationDiagnostic[], value: KnowledgeCompilationDiagnostic): void {
    if (target.length < MAX_DIAGNOSTICS) target.push(value);
  }
}
