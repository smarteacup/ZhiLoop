import type {
  BidirectionalProvenance,
  CandidatePreview,
  CandidatePreviewItem,
  ExtractionSnapshot,
  P2ControlRequest,
  ProvenanceNode,
  SnapshotReference,
} from "@zhiloop/control-api";
import type { DurableJobRecord, EnqueueJobResult, JobPriority } from "@zhiloop/job-runtime";

export type SnapshotCreateRequest = Extract<P2ControlRequest, { readonly type: "extraction.snapshot.create" }>;
export type CandidatePreviewRequest = Extract<P2ControlRequest, { readonly type: "extraction.candidates.preview" }>;
export type CandidatePolicyCommitRequest = Extract<P2ControlRequest, { readonly type: "extraction.candidates.commit" }>;

export interface SnapshotSourceReference {
  readonly eventId: string;
  readonly turnId?: string;
  readonly sourceSequence: number;
}

export interface CreateSnapshotObservation {
  readonly captureRevision: number;
  readonly sourceReferences: readonly SnapshotSourceReference[];
  readonly previousSnapshotId?: string;
  readonly observedAt: string;
}

export type SnapshotCreateResult =
  | { readonly status: "CREATED"; readonly snapshot: ExtractionSnapshot }
  | { readonly status: "EXISTING"; readonly snapshot: ExtractionSnapshot };

export interface SnapshotListCursor {
  readonly createdAt: string;
  readonly snapshotId: string;
}

export interface SnapshotListRequest {
  readonly sessionId?: string;
  readonly limit: number;
  readonly after?: SnapshotListCursor;
}

export interface SnapshotPage {
  readonly items: readonly ExtractionSnapshot[];
  readonly next?: SnapshotListCursor;
}

export interface ExtractionJobQueue {
  enqueue(request: {
    readonly jobType: string;
    readonly idempotencyKey: string;
    readonly input: unknown;
    readonly maxAttempts: number;
    readonly priority?: JobPriority;
  }): EnqueueJobResult;
  get(jobId: string): DurableJobRecord | undefined;
}

export interface CandidatePreviewCompletion {
  readonly jobId: string;
  readonly effectKey: string;
  readonly status: CandidatePreview["status"];
  readonly candidates: readonly CandidatePreviewItem[];
  readonly diagnostics: CandidatePreview["diagnostics"];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type CandidatePreviewResult =
  | { readonly status: "CREATED"; readonly preview: CandidatePreview }
  | { readonly status: "EXISTING"; readonly preview: CandidatePreview };

export interface PolicyDecision {
  readonly candidateId: string;
  readonly disposition: CandidatePreviewItem["policyDecision"];
  readonly reasonCodes: readonly string[];
}

export interface PolicyCommit {
  readonly commitId: string;
  readonly revision: 1;
  readonly snapshot: SnapshotReference;
  readonly previewId: string;
  readonly previewRevision: number;
  readonly compilerVersion: string;
  readonly policyHash: string;
  readonly decisions: readonly PolicyDecision[];
  readonly createdAt: string;
}

export interface PolicyCommitCompletion {
  readonly jobId: string;
  readonly effectKey: string;
  readonly decisions: readonly PolicyDecision[];
  readonly createdAt: string;
}

export type PolicyCommitResult =
  | { readonly status: "CREATED"; readonly commit: PolicyCommit }
  | { readonly status: "EXISTING"; readonly commit: PolicyCommit };

export interface ProvenanceQuery {
  readonly root: ProvenanceNode;
  readonly limit: number;
  readonly afterEdgeId?: string;
}

export type ProvenancePage = BidirectionalProvenance;

export interface EpisodeReference {
  readonly episodeId: string;
}

export interface KnowledgePublicationReference {
  readonly snapshotId: string;
  readonly candidateId: string;
  readonly knowledgeId: string;
  readonly version: number;
  readonly observedAt: string;
}

export class ExtractionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExtractionConflictError";
  }
}

export class ExtractionStaleRevisionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExtractionStaleRevisionError";
  }
}

export class ExtractionNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExtractionNotFoundError";
  }
}
