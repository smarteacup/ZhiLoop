import type { KnowledgeCandidate } from "@zhiloop/domain";

export interface ExtractionProjectContext {
  readonly projectId: string;
  readonly repositoryRemote?: string;
  readonly branch?: string;
  readonly portable: boolean;
}

export interface ExtractionSubgoalInput {
  readonly statement: string;
  readonly sourceRef: string;
}

export interface ExtractionCorrectionInput {
  readonly originalRef: string;
  readonly originalStatement: string;
  readonly correctedRef: string;
  readonly correctedStatement: string;
}

export interface ExtractionActionInput {
  readonly kind: "TOOL" | "COMMAND" | "FILE_CHANGE" | "DECISION";
  readonly summary: string;
  readonly sourceRefs: readonly [string, ...string[]];
}

export interface ExtractionArtifactInput {
  readonly kind: "FILE" | "DIFF" | "DOCUMENT" | "URL";
  readonly uri: string;
  readonly contentHash?: string;
}

export interface ExtractionOutcomeInput {
  readonly kind: "SUCCESS" | "FAILURE" | "PARTIAL" | "UNKNOWN";
  readonly summary: string;
  readonly evidenceRefs: readonly [string, ...string[]];
}

export interface KnowledgeExtractionInput {
  readonly schemaVersion: 1;
  readonly episodeId: string;
  readonly builderVersion: string;
  readonly projectContext: ExtractionProjectContext;
  readonly goal: string;
  readonly goalRef: string;
  readonly subgoals: readonly ExtractionSubgoalInput[];
  readonly corrections: readonly ExtractionCorrectionInput[];
  readonly actions: readonly ExtractionActionInput[];
  readonly artifacts: readonly ExtractionArtifactInput[];
  readonly outcomes: readonly ExtractionOutcomeInput[];
  readonly evidenceRefs: readonly [string, ...string[]];
}

export interface KnowledgeExtractionRequest {
  readonly input: KnowledgeExtractionInput;
  readonly compilerVersion: string;
  readonly promptVersion: string;
  readonly requestedAt: string;
  readonly correlationId: string;
}

export interface KnowledgeExtractionAttemptContext {
  readonly extractionKey: string;
  readonly inputHash: string;
  readonly compilerVersion: string;
  readonly promptVersion: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface KnowledgeExtractionPort {
  extract(input: KnowledgeExtractionInput, context: KnowledgeExtractionAttemptContext): Promise<unknown>;
}

export type KnowledgeExtractionFailureReason =
  | "TIMEOUT"
  | "ADAPTER_UNAVAILABLE"
  | "INVALID_OUTPUT"
  | "RETRY_SCHEDULER_FAILED"
  | "ADAPTER_REJECTED"
  | "ABORTED";

export interface KnowledgeExtractionDiagnostic {
  readonly code:
    | "SCHEMA_INVALID"
    | "UNREFERENCED_SOURCE"
    | "PROJECT_MISMATCH"
    | "GENERATED_CANDIDATE_INVALID";
  readonly path: string;
}

interface KnowledgeExtractionResultBase {
  readonly extractionKey: string;
  readonly inputHash: string;
  readonly episodeId: string;
  readonly builderVersion: string;
  readonly compilerVersion: string;
  readonly promptVersion: string;
  readonly attempts: number;
}

export type KnowledgeExtractionResult =
  | (KnowledgeExtractionResultBase & {
      readonly status: "SUCCEEDED";
      readonly candidates: readonly KnowledgeCandidate[];
      readonly diagnostics: readonly [];
    })
  | (KnowledgeExtractionResultBase & {
      readonly status: "RETRYABLE" | "FAILED";
      readonly candidates: readonly [];
      readonly reason: KnowledgeExtractionFailureReason;
      readonly diagnostics: readonly KnowledgeExtractionDiagnostic[];
    });

export interface KnowledgeExtractionScheduler {
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface KnowledgeExtractionRunOptions {
  readonly perAttemptTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly signal?: AbortSignal;
  readonly scheduler?: KnowledgeExtractionScheduler;
}

export type KnowledgeExtractionAdapterErrorCode = "UNAVAILABLE" | "RATE_LIMITED" | "REJECTED";
