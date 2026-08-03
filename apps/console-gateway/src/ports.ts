import type {
  CaptureCommitResult,
  CapturePreview,
  Diagnostics,
  EventMetadata,
  JobSnapshot,
  JobCommandResult,
  Overview,
  SessionDetail,
  SessionSummary,
  CapabilitySnapshot,
  ConfigurationMutationResult,
  ConfigurationState,
  ConfigurationValidationResult,
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
  getConfiguration(projectId: string | undefined, options: QueryOptions): Promise<ConfigurationState>;
}

export interface CaptureCommitCommand {
  readonly sessionId: string;
  readonly previewRevision: number;
  readonly transcriptIdentityHash: string;
  readonly idempotencyKey: string;
}

export interface ConfigurationDraftCommand {
  readonly baseRevision: number;
  readonly scope: "GLOBAL" | "PROJECT";
  readonly projectId?: string;
  readonly draft: Readonly<Record<string, unknown>>;
}

export interface ConfigurationActivateCommand {
  readonly expectedRevision: number;
  readonly draftRevision: number;
  readonly idempotencyKey: string;
}

export interface ConfigurationRollbackCommand {
  readonly expectedRevision: number;
  readonly targetRevision: number;
  readonly idempotencyKey: string;
}

export interface JobOperatorCommand {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

/** Commands remain behind the Sidecar boundary and are not exposed by P0 read-only routes. */
export interface ControlCommandPort {
  previewCapture(sessionId: string, options: QueryOptions): Promise<CapturePreview>;
  commitCapture(command: CaptureCommitCommand, options: QueryOptions): Promise<CaptureCommitResult>;
  validateConfiguration(command: ConfigurationDraftCommand, options: QueryOptions): Promise<ConfigurationValidationResult>;
  activateConfiguration(command: ConfigurationActivateCommand, options: QueryOptions): Promise<ConfigurationMutationResult>;
  rollbackConfiguration(command: ConfigurationRollbackCommand, options: QueryOptions): Promise<ConfigurationMutationResult>;
  cancelJob?(command: JobOperatorCommand, options: QueryOptions): Promise<JobCommandResult>;
  retryJob?(command: JobOperatorCommand, options: QueryOptions): Promise<JobCommandResult>;
}
