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
  P2KnowledgeDetailView,
  P2KnowledgeEditImpact,
  P2KnowledgeFilter,
  P2KnowledgeListView,
  P2SessionExtractionView,
  P2IndexRecoveryResult,
  RetrievalTraceContract,
  EvolutionOperationsSnapshot,
  CodeGraphProjectPage,
  CodeGraphInitializationPreview,
  CodeGraphInitializationCommit,
  OperationalAlertConsolePage,
  AlertOperatorCommandResult,
  LegacyMigrationPreviewView,
  LegacyMigrationPageView,
  KnowledgeEvolutionView,
  KnowledgeRevalidationCommandResult,
  KnowledgeRepairSubmissionResult,
} from "@zhiloop/control-api";
import type {
  P3AskResponse,
  P3ConsoleQueryBody,
  P3SearchResponse,
  P3SimulationResponse,
} from "@zhiloop/p3-console-runtime";
import type {
  P4FeedbackResponse,
  P4HighRiskCommitResponse,
  P4HighRiskPreviewResponse,
  P4ContextRefreshResponse,
} from "@zhiloop/p4-console-runtime";
import type {
  P4CapabilityArray,
  P4ClosurePage,
  P4FeedbackTargets,
  P4HighRiskGovernance,
  P4InjectionPage,
  P4McpExpansionPage,
  P4RolloutResponse,
} from "./p4-contracts.js";

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
  getSessionExtraction?(sessionId: string, options: QueryOptions): Promise<P2SessionExtractionView>;
  listKnowledge?(filter: P2KnowledgeFilter, options: QueryOptions): Promise<P2KnowledgeListView>;
  getKnowledge?(knowledgeId: string, options: QueryOptions): Promise<P2KnowledgeDetailView>;
  searchKnowledge?(command: P3ConsoleQueryBody, options: QueryOptions): Promise<P3SearchResponse>;
  askKnowledge?(command: P3ConsoleQueryBody, options: QueryOptions): Promise<P3AskResponse>;
  simulateRetrieval?(command: P3ConsoleQueryBody, options: QueryOptions): Promise<P3SimulationResponse>;
  getRetrievalTrace?(command: {
    readonly requestId: string;
    readonly traceId: string;
    readonly projectId?: string;
    readonly taskId?: string;
  }, options: QueryOptions): Promise<RetrievalTraceContract>;
  listP4Capabilities?(options: QueryOptions): Promise<P4CapabilityArray>;
  listP4Injections?(sessionId: string, page: PageQuery, options: QueryOptions): Promise<P4InjectionPage>;
  getP4Injection?(sessionId: string, attemptId: string, options: QueryOptions): Promise<P4InjectionPage["items"][number]>;
  listP4McpExpansions?(sessionId: string, attemptId: string, page: PageQuery, options: QueryOptions): Promise<P4McpExpansionPage>;
  listP4Closures?(sessionId: string, page: PageQuery, options: QueryOptions): Promise<P4ClosurePage>;
  getP4Closure?(sessionId: string, closureRunId: string, options: QueryOptions): Promise<P4ClosurePage["items"][number]>;
  getP4Rollout?(options: QueryOptions): Promise<P4RolloutResponse>;
  listP4FeedbackTargets?(sessionId: string, options: QueryOptions): Promise<P4FeedbackTargets>;
  getP4HighRiskGovernance?(options: QueryOptions): Promise<P4HighRiskGovernance>;
  getEvolutionOperations?(options: QueryOptions): Promise<EvolutionOperationsSnapshot>;
  getKnowledgeEvolution?(knowledgeId: string, options: QueryOptions): Promise<KnowledgeEvolutionView>;
  listCodeGraphProjects?(limit: number, options: QueryOptions): Promise<CodeGraphProjectPage>;
  listOperationalAlerts?(projectId: string | undefined, limit: number, cursor: string | undefined, options: QueryOptions): Promise<OperationalAlertConsolePage>;
  listLegacyMigrations?(projectId: string, limit: number, options: QueryOptions): Promise<{ readonly items: readonly LegacyMigrationPreviewView[] }>;
  getLegacyMigration?(migrationId: string, options: QueryOptions): Promise<LegacyMigrationPreviewView>;
  listLegacyMigrationItems?(migrationId: string, limit: number, afterOrdinal: number | undefined, options: QueryOptions): Promise<LegacyMigrationPageView>;
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

export interface P4FeedbackCommand {
  readonly action: "RELEVANT" | "IRRELEVANT" | "PIN" | "SUPPRESS" | "MCP_USE";
  readonly assetId: string;
  readonly expectedKnowledgeVersion: number;
  readonly scopeKey: string;
  readonly traceId: string;
  readonly expansionId?: string;
  readonly idempotencyKey: string;
}

export interface P4HighRiskPreviewCommand {
  readonly expectedPolicyRevision: number;
  readonly idempotencyKey: string;
  readonly command: {
    readonly kind: "GLOBAL_PROMOTION" | "RULE_CHANGE" | "BINDING_CHANGE" | "PRIVACY_PURGE";
    readonly assetIds: readonly string[];
    readonly projectIds: readonly string[];
    readonly reason: string;
    readonly payloadFingerprint: string;
  };
}

export interface P4HighRiskCommitCommand {
  readonly expectedPolicyRevision: number;
  readonly idempotencyKey: string;
  readonly previewId: string;
  readonly confirmationPhrase: string;
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
  startSessionExtraction?(command: { readonly sessionId: string; readonly expectedRevision: number; readonly idempotencyKey: string }, options: QueryOptions): Promise<P2SessionExtractionView>;
  commitSessionExtraction?(command: { readonly sessionId: string; readonly previewId: string; readonly expectedPreviewRevision: number; readonly idempotencyKey: string }, options: QueryOptions): Promise<P2SessionExtractionView>;
  previewKnowledgeEdit?(command: Readonly<Record<string, unknown>>, options: QueryOptions): Promise<P2KnowledgeEditImpact>;
  commitKnowledgeEdit?(command: Readonly<Record<string, unknown>>, options: QueryOptions): Promise<P2KnowledgeDetailView>;
  suppressKnowledge?(command: Readonly<Record<string, unknown>>, options: QueryOptions): Promise<P2KnowledgeDetailView>;
  restoreKnowledge?(command: Readonly<Record<string, unknown>>, options: QueryOptions): Promise<P2KnowledgeDetailView>;
  recoverKnowledgeIndex?(knowledgeId: string, options: QueryOptions): Promise<P2IndexRecoveryResult>;
  recordP4Feedback?(command: P4FeedbackCommand, options: QueryOptions): Promise<P4FeedbackResponse>;
  previewP4HighRisk?(command: P4HighRiskPreviewCommand, options: QueryOptions): Promise<P4HighRiskPreviewResponse>;
  commitP4HighRisk?(command: P4HighRiskCommitCommand, options: QueryOptions): Promise<P4HighRiskCommitResponse>;
  refreshP4Context?(sessionId: string, idempotencyKey: string, options: QueryOptions): Promise<P4ContextRefreshResponse>;
  previewCodeGraphInitialization?(projectId: string, options: QueryOptions): Promise<CodeGraphInitializationPreview>;
  commitCodeGraphInitialization?(command: { readonly projectId: string; readonly previewId: string; readonly repositoryIdentity: string;
    readonly expectedRevision: number; readonly idempotencyKey: string }, options: QueryOptions): Promise<CodeGraphInitializationCommit>;
  acknowledgeOperationalAlert?(command: { readonly alertId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string }, options: QueryOptions): Promise<AlertOperatorCommandResult>;
  suppressOperationalAlert?(command: { readonly alertId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string; readonly suppressedUntil: string }, options: QueryOptions): Promise<AlertOperatorCommandResult>;
  previewLegacyMigration?(projectId: string, options: QueryOptions): Promise<LegacyMigrationPreviewView>;
  commitLegacyMigration?(command: { readonly migrationId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string }, options: QueryOptions): Promise<{ readonly preview: LegacyMigrationPreviewView; readonly job: JobSnapshot }>;
  rollbackLegacyMigration?(command: { readonly migrationId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string }, options: QueryOptions): Promise<LegacyMigrationPreviewView>;
  revalidateKnowledge?(command: { readonly knowledgeId: string; readonly expectedKnowledgeVersion: number;
    readonly expectedFreshnessRevision: number; readonly idempotencyKey: string }, options: QueryOptions): Promise<KnowledgeRevalidationCommandResult>;
  submitRepairCandidate?(command: { readonly draftId: string; readonly expectedRevision: number; readonly idempotencyKey: string;
    readonly title: string; readonly summary: string; readonly body: string }, options: QueryOptions): Promise<KnowledgeRepairSubmissionResult>;
}
