import type { VerificationPolicy } from "@zhiloop/config";
import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type { Episode, KnowledgeAsset, KnowledgeCandidate, KnowledgeStatus, ProjectContext } from "@zhiloop/domain";
import type { EpisodeBuildResult } from "@zhiloop/episode-builder";
import type { VerificationResult } from "@zhiloop/evidence-engine";
import type { EvidencePolicyDecision } from "@zhiloop/evidence-policy";
import type { KnowledgeExtractionPort, KnowledgeExtractionRunOptions } from "@zhiloop/knowledge-compiler";
import type { IncrementalIndexResult } from "@zhiloop/knowledge-indexer";
import type { ProjectionWriteResult } from "@zhiloop/knowledge-registry";
import type {
  MarkdownPublishOptions,
  MarkdownPublishResult,
  MarkdownReadResult,
  StoredKnowledgeVersion,
} from "@zhiloop/markdown-repository";
import type { ScopeResolution } from "@zhiloop/scope-resolver";
import type { ConversationNormalizationResult } from "@zhiloop/conversation-normalizer";

export const WORKER_STAGES = [
  "LEDGER_READ",
  "NORMALIZE",
  "EPISODE_BUILD",
  "COMPILE",
  "CANDIDATE_POLICY",
  "MARKDOWN_PUBLISH",
  "REGISTRY_PROJECT",
  "INCREMENTAL_INDEX",
] as const;

export type KnowledgeWorkerStage = (typeof WORKER_STAGES)[number];
export type StageStatus = "PENDING" | "RUNNING" | "RETRYABLE" | "SUCCEEDED" | "FAILED";

export interface StageError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly occurredAt: string;
}

export interface StageCheckpoint {
  readonly status: StageStatus;
  readonly attempts: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: StageError;
}

export interface LedgerSnapshotRequest {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly sourceVersion: string;
}

export interface LoadedLedgerSnapshot {
  readonly snapshotId: string;
  readonly sourceVersion: string;
  readonly contentHash: string;
  readonly records: readonly LedgerEventRecord[];
}

export interface LedgerSnapshotPort {
  loadSnapshot(request: LedgerSnapshotRequest, limit: number): Promise<LoadedLedgerSnapshot>;
  inspectSnapshot?(request: LedgerSnapshotRequest): Promise<Omit<LoadedLedgerSnapshot, "records">>;
}

export interface EvidenceVerificationPort {
  verify(candidate: KnowledgeCandidate, project: ProjectContext, requestedAt: string): Promise<readonly VerificationResult[]>;
}

export interface MarkdownKnowledgePort {
  readCurrent(assetId: string): MarkdownReadResult | Promise<MarkdownReadResult>;
  listAssetIds(): readonly string[] | Promise<readonly string[]>;
  publish(asset: KnowledgeAsset, options?: MarkdownPublishOptions): MarkdownPublishResult | Promise<MarkdownPublishResult>;
}

export interface RegistryProjectionPort {
  projectCurrent(record: StoredKnowledgeVersion): ProjectionWriteResult | Promise<ProjectionWriteResult>;
}

export interface IncrementalIndexPort {
  syncAsset(assetId: string): IncrementalIndexResult | Promise<IncrementalIndexResult>;
}

export interface KnowledgeWorkerPorts {
  readonly ledger: LedgerSnapshotPort;
  readonly compiler: KnowledgeExtractionPort;
  readonly evidence: EvidenceVerificationPort;
  readonly markdown: MarkdownKnowledgePort;
  readonly registry: RegistryProjectionPort;
  readonly index: IncrementalIndexPort;
}

export interface KnowledgeWorkerLimits {
  readonly maxLedgerRecords: number;
  readonly maxEpisodes: number;
  readonly maxCandidates: number;
  readonly maxPublishItems: number;
  readonly maxStageAttempts: number;
}

export interface KnowledgeWorkerRunRequest {
  readonly workId: string;
  readonly snapshot: LedgerSnapshotRequest;
  readonly asOf: string;
  readonly project: ProjectContext;
  readonly compilerVersion: string;
  readonly promptVersion: string;
  readonly verificationPolicy: VerificationPolicy;
  readonly extraction?: KnowledgeExtractionRunOptions;
  readonly allowGlobal?: boolean;
  readonly projectTerms?: readonly string[];
  readonly limits?: Partial<KnowledgeWorkerLimits>;
}

export interface CandidatePolicyRecord {
  readonly candidate: KnowledgeCandidate;
  readonly currentStatus: KnowledgeStatus;
  readonly scope: ScopeResolution;
  readonly verificationResults: readonly VerificationResult[];
  readonly decision: EvidencePolicyDecision;
}

export interface PublicationOutboxItem {
  readonly candidateId: string;
  readonly asset: KnowledgeAsset;
  readonly expectedCurrentVersion?: number;
  readonly markdown?: StoredKnowledgeVersion;
  readonly projection?: ProjectionWriteResult;
  readonly index?: IncrementalIndexResult;
}

export interface KnowledgeWorkerPayload {
  readonly ledger?: LoadedLedgerSnapshot;
  readonly normalization?: ConversationNormalizationResult;
  readonly episodeBuild?: EpisodeBuildResult;
  readonly episodes?: readonly Episode[];
  readonly candidates?: readonly KnowledgeCandidate[];
  readonly policies?: readonly CandidatePolicyRecord[];
  readonly outbox?: readonly PublicationOutboxItem[];
}

export type KnowledgeWorkerRunStatus = "RUNNING" | "AWAITING_COMMIT" | "RETRYABLE" | "FAILED" | "COMPLETED";

export const KNOWLEDGE_EXECUTION_MODES = [
  "PREVIEW_ONLY",
  "POLICY_EVALUATION",
  "SAFE_AUTO_PUBLICATION",
] as const;

export type KnowledgeExecutionMode = (typeof KNOWLEDGE_EXECUTION_MODES)[number];

export type KnowledgePublicationAuthorization =
  | {
      readonly kind: "EXPLICIT_COMMIT";
      readonly authorizationId: string;
    }
  | {
      readonly kind: "SAFE_POLICY";
      readonly authorizationId: string;
      readonly policyHash: string;
    };

export interface KnowledgeWorkerRunOptions {
  /** Capability ceiling for this invocation. Omitted means fail-closed PREVIEW_ONLY. */
  readonly executionMode?: KnowledgeExecutionMode;
  /** Required whenever SAFE_AUTO_PUBLICATION is requested. */
  readonly publicationAuthorization?: KnowledgePublicationAuthorization;
  /**
   * Permit an explicitly re-queued durable job to make one more attempt at a
   * terminal stage whose underlying failure is still classified retryable.
   */
  readonly retryFailed?: boolean;
}

export interface KnowledgeWorkerCheckpoint {
  readonly schemaVersion: 1;
  readonly workId: string;
  readonly identityHash: string;
  readonly revision: number;
  readonly status: KnowledgeWorkerRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Optional for backward-compatible reads of schemaVersion 1 checkpoints. */
  readonly lastExecutionMode?: KnowledgeExecutionMode;
  /** Stable authority accepted before publication; absent on Preview-only work. */
  readonly publicationAuthorization?: KnowledgePublicationAuthorization;
  readonly stages: Readonly<Record<KnowledgeWorkerStage, StageCheckpoint>>;
  readonly payload: KnowledgeWorkerPayload;
}

export interface KnowledgeWorkerCheckpointStore {
  load(workId: string): KnowledgeWorkerCheckpoint | undefined;
  create(checkpoint: KnowledgeWorkerCheckpoint): void;
  save(checkpoint: KnowledgeWorkerCheckpoint, expectedRevision: number): void;
}

export interface IndexRebuildResult {
  readonly requested: number;
  readonly indexed: number;
  readonly unchanged: number;
  readonly results: readonly IncrementalIndexResult[];
}
