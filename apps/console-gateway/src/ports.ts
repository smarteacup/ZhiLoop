import type {
  CaptureCommitResult,
  CapturePreview,
  Diagnostics,
  EventMetadata,
  JobSnapshot,
  Overview,
  SessionDetail,
  SessionSummary,
  CapabilitySnapshot,
} from "@zhiloop/control-api";

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor?: string | undefined;
}

export interface PageQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface QueryOptions {
  readonly signal: AbortSignal;
}

export interface ControlQueryPort {
  getOverview(options: QueryOptions): Promise<Overview>;
  listCapabilities(page: PageQuery, options: QueryOptions): Promise<Page<CapabilitySnapshot>>;
  listSessions(page: PageQuery, options: QueryOptions): Promise<Page<SessionSummary>>;
  getSession(sessionId: string, options: QueryOptions): Promise<SessionDetail>;
  listSessionEvents(sessionId: string, page: PageQuery, options: QueryOptions): Promise<Page<EventMetadata>>;
  listJobs(page: PageQuery, options: QueryOptions): Promise<Page<JobSnapshot>>;
  getDiagnostics(options: QueryOptions): Promise<Diagnostics>;
}

export interface CaptureCommitCommand {
  readonly sessionId: string;
  readonly previewRevision: number;
  readonly transcriptIdentityHash: string;
  readonly idempotencyKey: string;
}

/** Commands remain behind the Sidecar boundary and are not exposed by P0 read-only routes. */
export interface ControlCommandPort {
  previewCapture(sessionId: string, options: QueryOptions): Promise<CapturePreview>;
  commitCapture(command: CaptureCommitCommand, options: QueryOptions): Promise<CaptureCommitResult>;
}
