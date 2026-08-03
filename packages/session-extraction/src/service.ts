import {
  candidatePolicyCommitRequestSchema,
  candidatePreviewRequestSchema,
  extractionSnapshotCreateRequestSchema,
  extractionSnapshotSchema,
  snapshotReferenceSchema,
  type CandidatePreview,
  type ExtractionSnapshot,
} from "@zhiloop/control-api";
import { jobEffectKey, serializeJobJson } from "@zhiloop/job-runtime";

import type { SessionExtractionStore } from "./store.js";
import { ExtractionConflictError, ExtractionNotFoundError, ExtractionStaleRevisionError } from "./types.js";
import type {
  CandidatePolicyCommitRequest,
  CandidatePreviewCompletion,
  CandidatePreviewRequest,
  CandidatePreviewResult,
  CreateSnapshotObservation,
  EpisodeReference,
  ExtractionJobQueue,
  KnowledgePublicationReference,
  PolicyCommitCompletion,
  PolicyCommit,
  PolicyCommitResult,
  ProvenancePage,
  ProvenanceQuery,
  SnapshotCreateRequest,
  SnapshotCreateResult,
  SnapshotListRequest,
  SnapshotPage,
} from "./types.js";

const PREVIEW_JOB_TYPE = "CANDIDATE_PREVIEW";
const COMMIT_JOB_TYPE = "CANDIDATE_POLICY_COMMIT";

export interface SessionExtractionServiceOptions {
  readonly maxAttempts?: number;
  readonly clock?: () => Date;
}

function identityHash(value: unknown): string {
  return serializeJobJson(value).hash;
}

function sameJson(left: unknown, right: unknown): boolean {
  return serializeJobJson(left).json === serializeJobJson(right).json;
}

function assertCanonicalTimestamp(value: string, field: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
}

function jobInputRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ExtractionConflictError("durable extraction job input is invalid");
  }
  return input as Readonly<Record<string, unknown>>;
}

function snapshotIdentityInput(request: SnapshotCreateRequest): Readonly<Record<string, unknown>> {
  return Object.freeze({
    transcriptIdentityHash: request.transcriptIdentityHash,
    sourceSequence: request.sourceSequence,
    cursor: request.cursor,
    compilerVersion: request.compilerVersion,
    policyHash: request.policyHash,
    configurationHash: request.configurationHash,
  });
}

export function snapshotIdempotencyKey(request: Omit<SnapshotCreateRequest, "idempotencyKey">): string {
  return `snapshot:create:${identityHash(snapshotIdentityInput(request as SnapshotCreateRequest))}`;
}

export function candidatePreviewIdempotencyKey(
  request: Omit<CandidatePreviewRequest, "idempotencyKey" | "requestId" | "schemaVersion" | "type">,
): string {
  return `candidate:preview:${identityHash(request)}`;
}

export function candidatePolicyCommitIdempotencyKey(
  request: Omit<CandidatePolicyCommitRequest, "idempotencyKey" | "requestId" | "schemaVersion" | "type">,
): string {
  return `candidate:commit:${identityHash(request)}`;
}

export class SessionExtractionService {
  readonly #store: SessionExtractionStore;
  readonly #jobs: ExtractionJobQueue;
  readonly #maxAttempts: number;
  readonly #clock: () => Date;

  public constructor(store: SessionExtractionStore, jobs: ExtractionJobQueue, options: SessionExtractionServiceOptions = {}) {
    this.#store = store;
    this.#jobs = jobs;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#clock = options.clock ?? (() => new Date());
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 20) {
      throw new Error("maxAttempts must be between 1 and 20");
    }
  }

  public createSnapshot(requestInput: SnapshotCreateRequest, observation: CreateSnapshotObservation): SnapshotCreateResult {
    const request = extractionSnapshotCreateRequestSchema.parse(requestInput);
    if (!Number.isSafeInteger(observation.captureRevision) || observation.captureRevision < 0) {
      throw new Error("captureRevision must be a nonnegative safe integer");
    }
    if (request.expectedCaptureRevision !== observation.captureRevision) {
      throw new ExtractionStaleRevisionError("capture revision changed before snapshot creation");
    }
    assertCanonicalTimestamp(observation.observedAt, "observedAt");
    const unsupportedEventTypes = [...request.completeness.unsupportedEventTypes].sort();
    const completeness = {
      status: request.completeness.sourceClosed && unsupportedEventTypes.length === 0
        ? "COMPLETE_SNAPSHOT" as const
        : "PARTIAL_SNAPSHOT" as const,
      sourceClosed: request.completeness.sourceClosed,
      unsupportedEventTypes,
    };
    if (request.completeness.status !== completeness.status) {
      throw new ExtractionConflictError("snapshot completeness does not match observed source state");
    }
    const sequenceIds = observation.sourceReferences.map((reference) => reference.sourceSequence);
    if (new Set(sequenceIds).size !== sequenceIds.length) {
      throw new ExtractionConflictError("source sequences must be unique");
    }
    const snapshotIdentityHash = identityHash(snapshotIdentityInput(request));
    if (request.idempotencyKey !== `snapshot:create:${snapshotIdentityHash}`) {
      throw new ExtractionConflictError("snapshot idempotency key is not bound to immutable identity");
    }
    const snapshotId = `snapshot_${snapshotIdentityHash.slice(0, 48)}`;
    const existingSnapshot = this.#store.getSnapshot(snapshotId);
    if (existingSnapshot !== undefined) {
      return this.#store.putSnapshot(existingSnapshot, observation.sourceReferences);
    }
    if (observation.previousSnapshotId !== undefined) {
      const previous = this.#store.getSnapshot(observation.previousSnapshotId);
      if (previous === undefined) throw new ExtractionNotFoundError("previous snapshot was not found");
      if (previous.sessionId !== request.sessionId
        || previous.transcriptIdentityHash !== request.transcriptIdentityHash
        || previous.compilerVersion !== request.compilerVersion
        || previous.policyHash !== request.policyHash
        || previous.configurationHash !== request.configurationHash
        || previous.sourceSequence.to >= request.sourceSequence.from
        || previous.cursor.byteOffset > request.cursor.byteOffset
        || previous.cursor.lineNumber > request.cursor.lineNumber
        || Date.parse(previous.createdAt) >= Date.parse(observation.observedAt)) {
        throw new ExtractionConflictError("previous snapshot is not a compatible incremental predecessor");
      }
    }
    const snapshot: ExtractionSnapshot = extractionSnapshotSchema.parse({
      schemaVersion: 1,
      snapshotId,
      revision: 1,
      identityHash: snapshotIdentityHash,
      sessionId: request.sessionId,
      transcriptIdentityHash: request.transcriptIdentityHash,
      sourceSequence: request.sourceSequence,
      cursor: request.cursor,
      completeness,
      ...(observation.previousSnapshotId === undefined ? {} : { previousSnapshotId: observation.previousSnapshotId }),
      compilerVersion: request.compilerVersion,
      policyHash: request.policyHash,
      configurationHash: request.configurationHash,
      createdAt: observation.observedAt,
    });
    return this.#store.putSnapshot(snapshot, observation.sourceReferences);
  }

  #resolveSnapshot(reference: CandidatePreviewRequest["snapshot"]): ExtractionSnapshot {
    const snapshot = this.#store.getSnapshot(reference.snapshotId);
    if (snapshot === undefined) throw new ExtractionNotFoundError("snapshot was not found");
    if (snapshot.revision !== reference.revision || snapshot.identityHash !== reference.identityHash) {
      throw new ExtractionStaleRevisionError("snapshot reference is stale");
    }
    return snapshot;
  }

  public enqueueCandidatePreview(requestInput: CandidatePreviewRequest) {
    const request = candidatePreviewRequestSchema.parse(requestInput);
    const snapshot = this.#resolveSnapshot(request.snapshot);
    if (snapshot.compilerVersion !== request.compilerVersion || snapshot.policyHash !== request.policyHash) {
      throw new ExtractionConflictError("preview compiler or policy does not match snapshot identity");
    }
    const expectedKey = candidatePreviewIdempotencyKey({
      snapshot: request.snapshot,
      compilerVersion: request.compilerVersion,
      policyHash: request.policyHash,
    });
    if (request.idempotencyKey !== expectedKey) {
      throw new ExtractionConflictError("preview idempotency key is not bound to snapshot/compiler/policy");
    }
    return this.#jobs.enqueue({
      jobType: PREVIEW_JOB_TYPE,
      idempotencyKey: request.idempotencyKey,
      input: {
        snapshot: request.snapshot,
        compilerVersion: request.compilerVersion,
        policyHash: request.policyHash,
      },
      maxAttempts: this.#maxAttempts,
    });
  }

  public completeCandidatePreview(completion: CandidatePreviewCompletion): CandidatePreviewResult {
    const job = this.#jobs.get(completion.jobId);
    if (job === undefined || job.snapshot.jobType !== PREVIEW_JOB_TYPE) {
      throw new ExtractionNotFoundError("candidate preview job was not found");
    }
    const expectedEffectKey = jobEffectKey(job.snapshot.idempotency?.key ?? "", "candidate-preview");
    if (completion.effectKey !== expectedEffectKey) throw new ExtractionConflictError("preview effect key is invalid");
    if (job.snapshot.status !== "RUNNING" && job.snapshot.status !== "SUCCEEDED") {
      throw new ExtractionConflictError("candidate preview job is not running");
    }
    const storedInput = jobInputRecord(job.input);
    const parsedJobRequest = candidatePreviewRequestSchema.parse({
      schemaVersion: 1,
      requestId: "durable-preview-job",
      type: "extraction.candidates.preview",
      ...storedInput,
      idempotencyKey: job.snapshot.idempotency?.key,
    });
    const input = {
      snapshot: parsedJobRequest.snapshot,
      compilerVersion: parsedJobRequest.compilerVersion,
      policyHash: parsedJobRequest.policyHash,
    };
    const snapshot = this.#resolveSnapshot(input.snapshot);
    if (job.snapshot.status === "SUCCEEDED" && this.#store.getCandidatePreview(`preview_${identityHash({
      snapshotId: snapshot.snapshotId,
      snapshotIdentityHash: snapshot.identityHash,
      compilerVersion: input.compilerVersion,
      policyHash: input.policyHash,
    }).slice(0, 48)}`) === undefined) {
      throw new ExtractionConflictError("succeeded preview job has no durable effect");
    }
    return this.#store.recordCandidatePreview(snapshot, input, completion);
  }

  public enqueuePolicyCommit(requestInput: CandidatePolicyCommitRequest) {
    const request = candidatePolicyCommitRequestSchema.parse(requestInput);
    const snapshot = this.#resolveSnapshot(request.snapshot);
    const preview = this.#store.getCandidatePreview(request.previewId);
    if (preview === undefined) throw new ExtractionNotFoundError("candidate preview was not found");
    if (preview.revision !== request.expectedPreviewRevision) {
      throw new ExtractionStaleRevisionError("candidate preview revision is stale");
    }
    if (!sameJson(preview.snapshot, request.snapshot)
      || preview.compilerVersion !== request.compilerVersion
      || preview.policyHash !== request.policyHash
      || snapshot.compilerVersion !== request.compilerVersion
      || snapshot.policyHash !== request.policyHash) {
      throw new ExtractionConflictError("commit is not bound to the preview snapshot/compiler/policy");
    }
    if (Date.parse(preview.expiresAt) <= this.#clock().getTime()) {
      throw new ExtractionStaleRevisionError("candidate preview has expired");
    }
    const expectedKey = candidatePolicyCommitIdempotencyKey({
      snapshot: request.snapshot,
      previewId: request.previewId,
      expectedPreviewRevision: request.expectedPreviewRevision,
      compilerVersion: request.compilerVersion,
      policyHash: request.policyHash,
    });
    if (request.idempotencyKey !== expectedKey) {
      throw new ExtractionConflictError("commit idempotency key is not bound to snapshot/compiler/policy/preview revision");
    }
    return this.#jobs.enqueue({
      jobType: COMMIT_JOB_TYPE,
      idempotencyKey: request.idempotencyKey,
      input: {
        snapshot: request.snapshot,
        previewId: request.previewId,
        expectedPreviewRevision: request.expectedPreviewRevision,
        compilerVersion: request.compilerVersion,
        policyHash: request.policyHash,
      },
      maxAttempts: this.#maxAttempts,
    });
  }

  public completePolicyCommit(completion: PolicyCommitCompletion): PolicyCommitResult {
    const job = this.#jobs.get(completion.jobId);
    if (job === undefined || job.snapshot.jobType !== COMMIT_JOB_TYPE) {
      throw new ExtractionNotFoundError("candidate policy commit job was not found");
    }
    const expectedEffectKey = jobEffectKey(job.snapshot.idempotency?.key ?? "", "candidate-policy-commit");
    if (completion.effectKey !== expectedEffectKey) throw new ExtractionConflictError("policy commit effect key is invalid");
    if (job.snapshot.status !== "RUNNING" && job.snapshot.status !== "SUCCEEDED") {
      throw new ExtractionConflictError("candidate policy commit job is not running");
    }
    const storedInput = jobInputRecord(job.input);
    const parsedJobRequest = candidatePolicyCommitRequestSchema.parse({
      schemaVersion: 1,
      requestId: "durable-policy-commit-job",
      type: "extraction.candidates.commit",
      ...storedInput,
      idempotencyKey: job.snapshot.idempotency?.key,
    });
    const input = {
      snapshot: snapshotReferenceSchema.parse(parsedJobRequest.snapshot),
      previewId: parsedJobRequest.previewId,
      expectedPreviewRevision: parsedJobRequest.expectedPreviewRevision,
      compilerVersion: parsedJobRequest.compilerVersion,
      policyHash: parsedJobRequest.policyHash,
    };
    this.#resolveSnapshot(input.snapshot);
    const preview = this.#store.getCandidatePreview(input.previewId);
    if (preview === undefined) throw new ExtractionNotFoundError("candidate preview was not found");
    if (preview.revision !== input.expectedPreviewRevision
      || preview.compilerVersion !== input.compilerVersion
      || preview.policyHash !== input.policyHash) {
      throw new ExtractionStaleRevisionError("candidate preview changed before policy commit");
    }
    if (job.snapshot.status === "SUCCEEDED" && this.#store.getPolicyCommitForPreview(preview.previewId) === undefined) {
      throw new ExtractionConflictError("succeeded policy commit job has no durable effect");
    }
    return this.#store.recordPolicyCommit(preview, completion);
  }

  public recordEpisodes(snapshotId: string, episodes: readonly EpisodeReference[], observedAt: string): void {
    this.#store.recordEpisodes(snapshotId, episodes, observedAt);
  }

  /** Explicit downstream publication acknowledgement; policy commit never calls this method. */
  public recordKnowledgeVersion(reference: KnowledgePublicationReference): void {
    this.#store.recordKnowledgeVersion(reference);
  }

  public getSnapshot(snapshotId: string): ExtractionSnapshot | undefined {
    return this.#store.getSnapshot(snapshotId);
  }

  public listSnapshots(request: SnapshotListRequest): SnapshotPage {
    return this.#store.listSnapshots(request);
  }

  public getCandidatePreview(previewId: string): CandidatePreview | undefined {
    return this.#store.getCandidatePreview(previewId);
  }

  public getCandidatePreviewForSnapshot(snapshotId: string): CandidatePreview | undefined {
    return this.#store.getCandidatePreviewForSnapshot(snapshotId);
  }

  public getPolicyCommit(commitId: string): PolicyCommit | undefined {
    return this.#store.getPolicyCommit(commitId);
  }

  public getPolicyCommitForPreview(previewId: string): PolicyCommit | undefined {
    return this.#store.getPolicyCommitForPreview(previewId);
  }

  public getProvenance(request: ProvenanceQuery): ProvenancePage {
    return this.#store.getProvenance(request);
  }
}
