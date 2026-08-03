import type { BackfillReport, BackfillRequest } from "@zhiloop/codex-backfill";
import type { CaptureSessionReport } from "@zhiloop/codex-session-capture";
import type { SessionCatalogEntry, SessionCatalogQueryPort } from "@zhiloop/session-catalog";

export const AUTOMATIC_INGESTION_SCHEMA_VERSION = 1 as const;

export type IngestionProgressStatus =
  | "FOLLOW_PENDING"
  | "CAPTURED_PARTIAL"
  | "CAPTURED_CURRENT"
  | "SOURCE_UNAVAILABLE"
  | "RETRY_PENDING"
  | "RECOVERY_PENDING";

export type SourceMutationDiagnostic =
  | "TRANSCRIPT_REPLACED"
  | "TRANSCRIPT_TRUNCATED"
  | "TRANSCRIPT_ANCHOR_MISMATCH";

export type AutomaticIngestionDiagnosticCode =
  | SourceMutationDiagnostic
  | "CATALOG_CURSOR_LOOP"
  | "SESSION_SCAN_BOUNDED"
  | "CATALOG_ENTRY_INVALID"
  | "CAPTURE_FAILED"
  | "RECOVERY_FAILED"
  | "RECOVERY_INCOMPLETE"
  | "RELATION_SCAN_FAILED"
  | "RELATION_SCAN_BOUNDED"
  | "CHECKPOINT_CONFLICT";

export interface AutomaticIngestionCheckpoint {
  readonly schemaVersion: typeof AUTOMATIC_INGESTION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly version: number;
  readonly source: SessionCatalogEntry["source"];
  readonly safeSourceAlias: string;
  readonly sourceRevision: string;
  readonly lastObservedActivityAt: string;
  readonly status: IngestionProgressStatus;
  readonly nextEligibleAt?: string | undefined;
  readonly lastAttemptAt?: string;
  readonly capturedByteOffset?: number;
  readonly capturedLineNumber?: number;
  readonly lastDiagnostic?: AutomaticIngestionDiagnosticCode | undefined;
  readonly recoveryAttemptKey?: string | undefined;
  readonly recoveryCompletedAt?: string | undefined;
  readonly updatedAt: string;
}

export interface EligibleCheckpointRequest {
  readonly atOrBefore: string;
  readonly limit: number;
  readonly statuses: readonly IngestionProgressStatus[];
}

/**
 * Persistence boundary for scheduler state. Production implementations must make
 * compareAndSwap and listEligible durable across process restarts.
 */
export interface AutomaticIngestionCheckpointPort {
  load(sessionId: string): Promise<AutomaticIngestionCheckpoint | undefined>;
  compareAndSwap(
    sessionId: string,
    expectedVersion: number | undefined,
    next: AutomaticIngestionCheckpoint,
  ): Promise<"COMMITTED" | "CONFLICT">;
  listEligible(request: EligibleCheckpointRequest): Promise<readonly AutomaticIngestionCheckpoint[]>;
}

export interface SessionCapturePort {
  capture(request: { readonly sessionId: string; readonly dryRun?: boolean }): Promise<CaptureSessionReport>;
}

export interface BackfillRecoveryRequest {
  readonly session: SessionCatalogEntry;
  readonly diagnostic: SourceMutationDiagnostic;
  readonly attemptKey: string;
}

export interface BackfillRecoveryPort {
  recover(request: BackfillRecoveryRequest): Promise<BackfillRecoveryResult>;
}

export interface BackfillRecoveryResult {
  readonly report: Pick<BackfillReport, "status">;
  /** A completed backfill alone is insufficient: the invalid source cursor must be repaired explicitly. */
  readonly sourceCheckpoint: "REBASED" | "NOT_REBASED";
}

export interface BackfillRequestFactory {
  create(request: BackfillRecoveryRequest): BackfillRequest;
}

export interface SourceCheckpointRecoveryPort {
  rebase(request: BackfillRecoveryRequest): Promise<"REBASED" | "NOT_REBASED">;
}

export interface SessionRelationObservation {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly kind: "SUB_AGENT";
  readonly observedAt: string;
  readonly source: "CODEX_APP_SERVER" | "CODEX_TRANSCRIPT" | "HOOK";
}

export interface SessionRelationPage {
  readonly items: readonly SessionRelationObservation[];
  readonly nextCursor?: string;
}

export interface SessionRelationSourcePort {
  list(request: { readonly limit: number; readonly cursor?: string }): Promise<SessionRelationPage>;
}

export interface SessionRelationStorePort {
  upsertMany(relations: readonly SessionRelationObservation[]): Promise<void>;
}

export interface SessionRelationQueryPort {
  getForSession(sessionId: string, limit: number): Promise<readonly SessionRelationObservation[]>;
}

export interface AutomaticIngestionConfiguration {
  readonly scanIntervalMs?: number;
  readonly followDebounceMs?: number;
  readonly retryDelayMs?: number;
  readonly pageSize?: number;
  readonly maxScanPages?: number;
  readonly maxSessionsPerScan?: number;
  readonly maxCapturesPerRun?: number;
  readonly maxRecoveriesPerRun?: number;
  readonly maxRelationsPerRun?: number;
  readonly maxRelationPages?: number;
  readonly checkpointConflictRetries?: number;
}

export interface NormalizedAutomaticIngestionConfiguration {
  readonly scanIntervalMs: number;
  readonly followDebounceMs: number;
  readonly retryDelayMs: number;
  readonly pageSize: number;
  readonly maxScanPages: number;
  readonly maxSessionsPerScan: number;
  readonly maxCapturesPerRun: number;
  readonly maxRecoveriesPerRun: number;
  readonly maxRelationsPerRun: number;
  readonly maxRelationPages: number;
  readonly checkpointConflictRetries: number;
}

export interface AutomaticIngestionDiagnostic {
  readonly code: AutomaticIngestionDiagnosticCode;
  readonly retryable: boolean;
  readonly sessionId?: string;
}

export interface AutomaticIngestionRunReport {
  readonly schemaVersion: typeof AUTOMATIC_INGESTION_SCHEMA_VERSION;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly catalogCoverage: "COMPLETE" | "BOUNDED";
  readonly relationCoverage: "NOT_CONFIGURED" | "COMPLETE" | "BOUNDED" | "FAILED";
  readonly scannedSessions: number;
  readonly discoveredSessions: number;
  readonly changedSessions: number;
  readonly capturedSessions: number;
  readonly recoveredSessions: number;
  readonly observedRelations: number;
  readonly pendingSessions: number;
  readonly diagnostics: readonly AutomaticIngestionDiagnostic[];
}

export interface AutomaticIngestionDependencies {
  readonly catalog: SessionCatalogQueryPort;
  readonly capture: SessionCapturePort;
  readonly checkpoints: AutomaticIngestionCheckpointPort;
  readonly recovery?: BackfillRecoveryPort;
  readonly relationSource?: SessionRelationSourcePort;
  readonly relationStore?: SessionRelationStorePort;
  readonly now?: () => Date;
}

export interface ScheduledTaskHandle {
  cancel(): void;
}

export interface SchedulerTimerPort {
  schedule(delayMs: number, task: () => void): ScheduledTaskHandle;
}
