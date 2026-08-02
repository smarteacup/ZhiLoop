import type { EventEnvelope } from "@zhiloop/domain";

export interface BackfillScope {
  readonly level: "PROJECT" | "GLOBAL";
  readonly projectId?: string;
  readonly cwd?: string;
}

export interface HistoricalThreadSummary {
  readonly id: string;
  readonly preview: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cliVersion?: string;
  readonly archived?: boolean;
  readonly [key: string]: unknown;
}

export interface HistoricalThread extends HistoricalThreadSummary {
  readonly turns: readonly unknown[];
}

export interface ThreadListRequest {
  readonly cursor?: string;
  readonly limit: number;
  readonly archived: boolean;
  readonly sourceKinds: readonly string[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface ThreadListPage {
  readonly data: readonly HistoricalThreadSummary[];
  readonly nextCursor?: string;
}

export interface CodexHistoryPort {
  listThreads(request: ThreadListRequest): Promise<ThreadListPage>;
  readThread(threadId: string, signal?: AbortSignal): Promise<HistoricalThread>;
}

export interface BackfillEventSink {
  append(event: EventEnvelope): { readonly status: "appended" | "duplicate" };
}

export interface ProcessedThreadPort {
  isProcessed(threadId: string): Promise<boolean> | boolean;
}

export interface BackfillPolicy {
  readonly minTurns?: number;
  readonly sensitiveThreadIds?: readonly string[];
  readonly sensitivePreviewTerms?: readonly string[];
  readonly sensitiveCwdPrefixes?: readonly string[];
}

export interface BackfillRequest {
  readonly scope: BackfillScope;
  readonly dryRun?: boolean;
  readonly archived?: boolean;
  readonly sourceKinds?: readonly string[];
  readonly pageSize?: number;
  readonly maxThreads?: number;
  readonly maxThreadBytes?: number;
  readonly policy?: BackfillPolicy;
  readonly signal?: AbortSignal;
}

export type BackfillSkipReason =
  | "SHORT_SESSION"
  | "SENSITIVE_SESSION"
  | "ALREADY_PROCESSED"
  | "DUPLICATE_LISTING"
  | "ACTIVE_SESSION"
  | "OUT_OF_SCOPE"
  | "OVERSIZED_SESSION";
export type BackfillThreadDecision = "ELIGIBLE" | BackfillSkipReason;

export interface BackfillThreadPlan {
  readonly threadId: string;
  readonly cwd: string;
  readonly turnCount?: number;
  readonly estimatedBytes: number;
  readonly decision: BackfillThreadDecision;
}

export interface BackfillReport {
  readonly runId?: string;
  readonly dryRun: boolean;
  readonly resumed: boolean;
  readonly status: "DRY_RUN" | "COMPLETED" | "PAUSED";
  readonly pauseReason?: "ABORTED" | "MAX_THREADS";
  readonly scope: BackfillScope;
  readonly threads: readonly BackfillThreadPlan[];
  readonly scannedThreads: number;
  readonly eligibleThreads: number;
  readonly processedThreads: number;
  readonly skippedThreads: number;
  readonly appendedEvents: number;
  readonly duplicateEvents: number;
  readonly estimatedBytes: number;
  readonly nextCursor?: string;
}

export interface BackfillRunCheckpoint {
  readonly runId: string;
  readonly requestHash: string;
  readonly scopeKey: string;
  readonly status: "RUNNING" | "COMPLETED";
  readonly cursor?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export type BackfillCheckpointThreadStatus = "PROCESSING" | "COMPLETED" | "SKIPPED";

export interface BackfillCheckpointStore {
  startOrResume(requestHash: string, scopeKey: string): { readonly checkpoint: BackfillRunCheckpoint; readonly resumed: boolean };
  threadStatus(runId: string, threadId: string): BackfillCheckpointThreadStatus | undefined;
  markThread(runId: string, threadId: string, status: BackfillCheckpointThreadStatus, reason?: BackfillSkipReason): void;
  advance(runId: string, expectedCursor: string | undefined, nextCursor: string | undefined): void;
  complete(runId: string, expectedCursor: string | undefined): void;
}
