import type {
  CapabilitySnapshot,
  Diagnostics,
  EventMetadata,
  JobSnapshot,
  Overview,
  SessionDetail,
  SessionSummary,
  StageSnapshot,
} from "@zhiloop/control-api";

export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface SessionProjectionInput {
  readonly summary: SessionSummary;
  readonly latestCursor?: SessionDetail["latestCursor"];
}

export interface StageRunProjection {
  readonly runId: string;
  readonly snapshot: StageSnapshot;
}

export type DiagnosticSeverity = "INFO" | "WARNING" | "ERROR";

/** Operator diagnostics deliberately contain no free-form message or payload field. */
export interface OperatorDiagnostic {
  readonly diagnosticId: string;
  readonly component: string;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly observedAt: string;
  readonly retryable: boolean;
  readonly evidenceRefs: readonly string[];
}

export interface OperationalProjectionSnapshot {
  readonly capabilities: readonly CapabilitySnapshot[];
  readonly sessions: readonly SessionProjectionInput[];
  readonly stages: readonly StageRunProjection[];
  readonly jobs: readonly JobSnapshot[];
  readonly events: readonly EventMetadata[];
  readonly diagnostics: readonly OperatorDiagnostic[];
  readonly health?: Diagnostics;
}

export interface OperationalProjectionSource {
  snapshot(): OperationalProjectionSnapshot;
}

export interface OverviewRuntime {
  readonly observedAt: string;
  readonly rolloutMode: Overview["rolloutMode"];
  readonly sidecarVersion: string;
  readonly alertCount: number;
}

export interface OperationalQueryPort {
  listCapabilities(page?: PageRequest): Page<CapabilitySnapshot>;
  listSessions(page?: PageRequest): Page<SessionSummary>;
  getSession(sessionId: string): SessionDetail | undefined;
  listSessionEvents(sessionId: string, page?: PageRequest): Page<EventMetadata>;
  listStages(entityId: string, page?: PageRequest): Page<StageRunProjection>;
  listJobs(page?: PageRequest): Page<JobSnapshot>;
  listOperatorDiagnostics(page?: PageRequest): Page<OperatorDiagnostic>;
  getDiagnostics(): Diagnostics | undefined;
  getOverview(runtime: OverviewRuntime): Overview;
}

export interface OperationalReadModelOptions {
  readonly cursorSecret: string | Uint8Array;
  readonly clock?: () => Date;
  readonly faultInjector?: (point: "migration.after-schema" | "rebuild.after-clear") => void;
}

export interface RebuildResult {
  readonly capabilities: number;
  readonly sessions: number;
  readonly stages: number;
  readonly jobs: number;
  readonly events: number;
  readonly diagnostics: number;
  readonly rebuiltAt: string;
}

export class InvalidOperationalCursorError extends Error {
  constructor() {
    super("invalid operational read-model cursor");
    this.name = "InvalidOperationalCursorError";
  }
}
