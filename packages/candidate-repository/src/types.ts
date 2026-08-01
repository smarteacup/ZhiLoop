import type { KnowledgeCandidate } from "@zhiloop/domain";
import type { KnowledgeExtractionDiagnostic, KnowledgeExtractionFailureReason } from "@zhiloop/knowledge-compiler";

export type CandidateCompilationStatus = "RUNNING" | "RETRYABLE" | "SUCCEEDED" | "FAILED";

export interface CandidateCompilationIdentity {
  readonly extractionKey: string;
  readonly inputHash: string;
  readonly episodeId: string;
  readonly builderVersion: string;
  readonly compilerVersion: string;
  readonly promptVersion: string;
}

export interface CandidateCompilationBatch extends CandidateCompilationIdentity {
  readonly status: CandidateCompilationStatus;
  readonly runCount: number;
  readonly lastAttempts: number;
  readonly failureReason?: KnowledgeExtractionFailureReason;
  readonly diagnostics: readonly KnowledgeExtractionDiagnostic[];
  readonly candidates: readonly KnowledgeCandidate[];
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export type CandidateCompilationClaim =
  | {
      readonly status: "ACQUIRED";
      readonly claimToken: string;
      readonly batch: CandidateCompilationBatch;
    }
  | {
      readonly status: "IN_PROGRESS" | "ALREADY_SUCCEEDED" | "TERMINAL_FAILED";
      readonly batch: CandidateCompilationBatch;
    };

export interface CandidateRepositoryOptions {
  readonly clock?: () => Date;
  readonly tokenFactory?: () => string;
  readonly defaultLeaseMs?: number;
}

export interface CandidateClaimOptions {
  readonly leaseMs?: number;
}

export interface CandidateListOptions {
  readonly includeProposed?: boolean;
  readonly episodeId?: string;
  readonly compilerVersion?: string;
  readonly limit?: number;
}
