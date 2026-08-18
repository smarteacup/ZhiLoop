import type { SessionCatalogEntry, SessionCatalogQueryPort } from "@zhiloop/session-catalog";

export const KNOWLEDGE_COMPILATION_SCHEMA_VERSION = 1 as const;

export type KnowledgeCompilationStatus =
  | "OBSERVING"
  | "WAITING_IDLE"
  | "QUEUED"
  | "RETRY_WAIT"
  | "CURRENT"
  | "FAILED";

export type KnowledgeCompilationTrigger =
  | "TURN_THRESHOLD"
  | "SESSION_IDLE"
  | "SESSION_ENDED"
  | "MAXIMUM_WAIT";

export type KnowledgeCompilationReasonCode =
  | KnowledgeCompilationTrigger
  | "CAPTURE_NOT_CURRENT"
  | "SOURCE_UNAVAILABLE"
  | "NO_NEW_EVENTS"
  | "MINIMUM_EVENTS_PENDING"
  | "WAITING_FOR_TRIGGER"
  | "CAPTURE_CHANGED"
  | "SOURCE_CHANGED"
  | "LEDGER_CHANGED"
  | "NO_EXTRACTABLE_EVENTS"
  | "UNSUPPORTED_SOURCE"
  | "DISPATCH_RETRYABLE"
  | "DISPATCH_FAILED"
  | "CHECKPOINT_CONFLICT"
  | "CHECKPOINT_INVALID"
  | "CATALOG_ENTRY_INVALID"
  | "CATALOG_CURSOR_LOOP"
  | "SESSION_SCAN_BOUNDED";

export interface KnowledgeCompilationCheckpoint {
  readonly schemaVersion: typeof KNOWLEDGE_COMPILATION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly version: number;
  readonly lastObservedLedgerSequence: number;
  readonly lastObservedEventCount: number;
  readonly lastObservedTurnCount: number;
  readonly lastCompiledLedgerSequence: number;
  readonly lastCompiledEventCount: number;
  readonly lastCompiledTurnCount: number;
  readonly firstPendingObservedAt?: string;
  readonly lastActivityAt: string;
  readonly sourceVersion?: string;
  readonly lastCompiledPipelineHash?: string;
  readonly pendingSnapshotId?: string;
  readonly pendingJobId?: string;
  readonly nextEligibleAt?: string;
  readonly status: KnowledgeCompilationStatus;
  readonly lastReasonCode: KnowledgeCompilationReasonCode;
  readonly updatedAt: string;
}

export interface KnowledgeCompilationCheckpointPort {
  load(sessionId: string): Promise<KnowledgeCompilationCheckpoint | undefined>;
  compareAndSwap(
    sessionId: string,
    expectedVersion: number | undefined,
    next: KnowledgeCompilationCheckpoint,
  ): Promise<"COMMITTED" | "CONFLICT">;
  listDue(request: {
    readonly atOrBefore: string;
    readonly limit: number;
  }): Promise<readonly KnowledgeCompilationCheckpoint[]>;
}

export interface KnowledgeCompilationConfiguration {
  readonly enabled?: boolean;
  readonly scanIntervalMs?: number;
  readonly minimumNewTurns?: number;
  readonly minimumNewEvents?: number;
  readonly idleAfterMs?: number;
  readonly maximumWaitMs?: number;
  readonly retryDelayMs?: number;
  readonly pageSize?: number;
  readonly maxScanPages?: number;
  readonly maxSessionsPerRun?: number;
  readonly maxDispatchesPerRun?: number;
  readonly checkpointConflictRetries?: number;
}

export interface NormalizedKnowledgeCompilationConfiguration {
  readonly enabled: boolean;
  readonly scanIntervalMs: number;
  readonly minimumNewTurns: number;
  readonly minimumNewEvents: number;
  readonly idleAfterMs: number;
  readonly maximumWaitMs: number;
  readonly retryDelayMs: number;
  readonly pageSize: number;
  readonly maxScanPages: number;
  readonly maxSessionsPerRun: number;
  readonly maxDispatchesPerRun: number;
  readonly checkpointConflictRetries: number;
}

export interface KnowledgeCompilationPipelineIdentity {
  readonly compilerVersion: string;
  readonly promptVersion: string;
  readonly policyHash: string;
  readonly configurationHash: string;
}

export interface CompilationSessionObservation {
  readonly sessionId: string;
  readonly ledgerSequence: number;
  readonly effectiveEventCount: number;
  readonly effectiveTurnCount: number;
  readonly latestEventType?: string;
  readonly sourceVersion?: string;
  readonly lastActivityAt: string;
}

export interface CompilationObservationPort {
  inspect(session: SessionCatalogEntry): Promise<CompilationSessionObservation>;
}

export interface AutomaticPreviewDispatchRequest extends KnowledgeCompilationPipelineIdentity {
  readonly schemaVersion: typeof KNOWLEDGE_COMPILATION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly expectedLedgerSequence: number;
  readonly sourceVersion?: string;
  readonly executionMode: "PREVIEW_ONLY";
  readonly trigger: KnowledgeCompilationTrigger;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export type AutomaticPreviewDispatchResult =
  | {
      /** Durable outer job accepted the work; the immutable Snapshot is created by that job. */
      readonly status: "QUEUED";
      readonly jobId: string;
      readonly compiledThroughSequence: number;
    }
  | {
      readonly status: "ENQUEUED" | "EXISTING";
      readonly snapshotId: string;
      readonly jobId: string;
      readonly compiledThroughSequence: number;
    }
  | { readonly status: "CURRENT"; readonly compiledThroughSequence: number }
  | {
      readonly status: "STALE";
      readonly reasonCode: "CAPTURE_NOT_CURRENT" | "SOURCE_CHANGED" | "LEDGER_CHANGED";
    }
  | {
      readonly status: "INELIGIBLE";
      readonly reasonCode: "NO_EXTRACTABLE_EVENTS" | "UNSUPPORTED_SOURCE";
    };

export interface CompilationDispatchPort {
  dispatchPreview(request: AutomaticPreviewDispatchRequest): Promise<AutomaticPreviewDispatchResult>;
}

export interface TriggerEvaluation {
  readonly eligible: boolean;
  readonly reasonCode: KnowledgeCompilationReasonCode;
  readonly trigger?: KnowledgeCompilationTrigger;
  readonly firstPendingObservedAt?: string;
  readonly nextEligibleAt?: string;
}

export interface KnowledgeCompilationDiagnostic {
  readonly code: KnowledgeCompilationReasonCode;
  readonly retryable: boolean;
  readonly sessionId?: string;
}

export interface KnowledgeCompilationRunReport {
  readonly schemaVersion: typeof KNOWLEDGE_COMPILATION_SCHEMA_VERSION;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scannedSessions: number;
  readonly eligibleSessions: number;
  readonly queuedSessions: number;
  readonly currentSessions: number;
  readonly deferredSessions: number;
  readonly retrySessions: number;
  readonly failedSessions: number;
  readonly bounded: boolean;
  readonly diagnostics: readonly KnowledgeCompilationDiagnostic[];
}

export interface KnowledgeCompilationDependencies {
  readonly catalog: SessionCatalogQueryPort;
  readonly observations: CompilationObservationPort;
  readonly checkpoints: KnowledgeCompilationCheckpointPort;
  readonly dispatcher: CompilationDispatchPort;
  readonly pipeline: KnowledgeCompilationPipelineIdentity;
  readonly now?: () => Date;
}

export interface ScheduledCompilationTaskHandle {
  cancel(): void;
}

export interface KnowledgeCompilationTimerPort {
  schedule(delayMs: number, task: () => void): ScheduledCompilationTaskHandle;
}
