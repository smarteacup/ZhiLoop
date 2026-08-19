import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  candidatePolicyCommitRequestSchema,
  candidatePreviewRequestSchema,
  type CandidatePreviewItem,
  type ExtractionSnapshot,
  type JobSnapshot,
  type JobCommandResult,
  type P2ControlRequest,
} from "@zhiloop/control-api";
import {
  DurableJobWorker,
  NonRetryableJobError,
  RetryableJobError,
  SqliteDurableJobStore,
  type JobExecutionContext,
  type JobOperatorCommandRequest,
  type JobPriority,
  type WorkerCycleResult,
} from "@zhiloop/job-runtime";
import type {
  KnowledgeCompilationRunReport,
} from "@zhiloop/knowledge-compilation-scheduler";
import type {
  KnowledgeWorkerRuntime,
  CandidatePolicyRecord,
  KnowledgeWorkerCheckpoint,
  KnowledgeWorkerRunRequest,
} from "@zhiloop/knowledge-worker-runtime";
import {
  SessionExtractionService,
  SessionExtractionStore,
  ExtractionNotFoundError,
  candidatePolicyCommitIdempotencyKey,
  candidatePreviewIdempotencyKey,
  type CreateSnapshotObservation,
  type SnapshotCreateResult,
} from "@zhiloop/session-extraction";

const PREVIEW_JOB_TYPE = "CANDIDATE_PREVIEW";
const COMMIT_JOB_TYPE = "CANDIDATE_POLICY_COMMIT";
const PREVIEW_TTL_MS = 5 * 60_000;

type SnapshotCreateRequest = Extract<P2ControlRequest, { readonly type: "extraction.snapshot.create" }>;
type CandidatePreviewRequest = Extract<P2ControlRequest, { readonly type: "extraction.candidates.preview" }>;
type CandidateCommitRequest = Extract<P2ControlRequest, { readonly type: "extraction.candidates.commit" }>;

export interface P2SnapshotSourcePort {
  /** Observe the exact immutable source revision immediately before persistence. */
  observe(request: SnapshotCreateRequest): Promise<CreateSnapshotObservation>;
}

export interface P2KnowledgeWorkerComposition {
  readonly runtime: Pick<KnowledgeWorkerRuntime, "run">;
  requestFor(snapshot: ExtractionSnapshot): KnowledgeWorkerRunRequest | Promise<KnowledgeWorkerRunRequest>;
}

export interface P2RuntimeState {
  readonly extraction: "READY" | "STOPPED" | "FAILED";
  readonly knowledgeCompile: "READY" | "NOT_CONFIGURED";
  readonly automaticCompile: "READY" | "STOPPED" | "DEGRADED" | "DISABLED";
  readonly lastAutomaticCompileReport?: KnowledgeCompilationRunReport;
  readonly provenance: "READY" | "FAILED";
}

export interface P2SidecarRuntimeDependencies {
  readonly stateDirectory: string;
  readonly snapshotSource: P2SnapshotSourcePort;
  readonly projectJob: (snapshot: JobSnapshot) => void | Promise<void>;
  readonly knowledgeWorker?: P2KnowledgeWorkerComposition;
  readonly clock?: () => Date;
  readonly workerId?: string;
  /** Idle durable-job polling cadence. Runtime configuration requires restart. */
  readonly pollIntervalMs?: number;
}

export class P2CapabilityUnavailableError extends Error {
  constructor() {
    super("knowledge worker is not configured");
    this.name = "P2CapabilityUnavailableError";
  }
}

function previewDisposition(record: CandidatePolicyRecord): CandidatePreviewItem["policyDecision"] {
  if (record.decision.shouldPublish) return "PUBLISH";
  if (record.decision.interaction === "ASK_USER") return "REQUIRE_CONFIRMATION";
  if (record.decision.targetStatus === "REJECTED") return "REJECT";
  return "KEEP_PROPOSED";
}

function evidenceVerdict(record: CandidatePolicyRecord): CandidatePreviewItem["evidenceVerdict"] {
  if (record.verificationResults.some(({ status }) => status === "REFUTED")) return "CONTRADICTS";
  if (record.verificationResults.length > 0
    && record.verificationResults.every(({ status }) => status === "SUPPORTED")) return "SUPPORTS";
  return "INCONCLUSIVE";
}

function previewItem(record: CandidatePolicyRecord): CandidatePreviewItem {
  return {
    candidateId: record.candidate.candidateId,
    episodeIds: [...record.candidate.sourceEpisodes],
    compilerVersion: record.candidate.compilerVersion,
    subjectKey: record.candidate.subjectKey,
    kind: record.candidate.kind,
    title: record.candidate.title,
    summary: record.candidate.summary,
    confidence: record.candidate.confidence,
    scope: record.decision.effectiveScope.level,
    evidenceVerdict: evidenceVerdict(record),
    policyDecision: previewDisposition(record),
    policyReasonCodes: [...new Set(record.decision.reasonCodes)].sort(),
  };
}

function throwCheckpointFailure(checkpoint: KnowledgeWorkerCheckpoint, fallback: string): never {
  const failures = Object.entries(checkpoint.stages)
    .filter((entry): entry is [string, typeof entry[1] & { error: NonNullable<typeof entry[1]["error"]> }] => entry[1].error !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const failure = failures[0]?.[1].error;
  if (failure?.retryable === true) throw new RetryableJobError(failure.code);
  throw new NonRetryableJobError(failure?.code ?? fallback);
}

function assertPreviewCheckpoint(checkpoint: KnowledgeWorkerCheckpoint): readonly CandidatePolicyRecord[] {
  if (checkpoint.status === "FAILED" || checkpoint.status === "RETRYABLE") {
    throwCheckpointFailure(checkpoint, "KNOWLEDGE_PREVIEW_FAILED");
  }
  if (checkpoint.status !== "AWAITING_COMMIT" || checkpoint.payload.policies === undefined) {
    throw new RetryableJobError("KNOWLEDGE_PREVIEW_INCOMPLETE");
  }
  return checkpoint.payload.policies;
}

function assertCommitCheckpoint(checkpoint: KnowledgeWorkerCheckpoint): void {
  if (checkpoint.status === "FAILED" || checkpoint.status === "RETRYABLE") {
    throwCheckpointFailure(checkpoint, "KNOWLEDGE_COMMIT_FAILED");
  }
  if (checkpoint.status !== "COMPLETED") throw new RetryableJobError("KNOWLEDGE_COMMIT_INCOMPLETE");
}

/**
 * P2 manual extraction composition. No method on this class is reachable from
 * the Hook handler; jobs run only when explicitly polled by the Sidecar worker.
 */
export class P2SidecarRuntime {
  readonly #dependencies: P2SidecarRuntimeDependencies;
  readonly #clock: () => Date;
  readonly #extractionStore: SessionExtractionStore;
  readonly #jobStore: SqliteDurableJobStore;
  readonly #service: SessionExtractionService;
  readonly #worker: DurableJobWorker;
  readonly #pollIntervalMs: number;
  readonly #activePollIntervalMs: number;
  #closed = false;
  #started = false;
  #pollTimer: NodeJS.Timeout | undefined;
  #pollTail: Promise<void> | undefined;
  #automaticCompilationState: (() => Pick<P2RuntimeState, "automaticCompile" | "lastAutomaticCompileReport">) | undefined;

  private constructor(dependencies: P2SidecarRuntimeDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#extractionStore = new SessionExtractionStore(join(dependencies.stateDirectory, "p2-extraction.sqlite"));
    this.#jobStore = new SqliteDurableJobStore(join(dependencies.stateDirectory, "p2-jobs.sqlite"), {
      clock: this.#clock,
      retryPolicy: { baseDelayMs: 100, maxDelayMs: 60_000, jitterRatio: 0.2 },
    });
    this.#service = new SessionExtractionService(this.#extractionStore, this.#jobStore, { clock: this.#clock });
    const pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
      throw new Error("pollIntervalMs must be between 100 and 60000");
    }
    this.#pollIntervalMs = pollIntervalMs;
    this.#activePollIntervalMs = Math.min(250, pollIntervalMs);
    this.#worker = new DurableJobWorker(this.#jobStore, {
      [PREVIEW_JOB_TYPE]: async (context) => await this.#preview(context),
      [COMMIT_JOB_TYPE]: async (context) => await this.#commit(context),
    }, { workerId: dependencies.workerId ?? `sidecar-p2-${process.pid}`, leaseMs: 60_000, heartbeatMs: 20_000 });
  }

  public static async create(dependencies: P2SidecarRuntimeDependencies): Promise<P2SidecarRuntime> {
    await mkdir(dependencies.stateDirectory, { recursive: true, mode: 0o700 });
    return new P2SidecarRuntime(dependencies);
  }

  public state(): P2RuntimeState {
    this.#assertOpen();
    const automatic = this.#automaticCompilationState?.() ?? { automaticCompile: "DISABLED" as const };
    return Object.freeze({
      extraction: this.#started ? "READY" : "STOPPED",
      knowledgeCompile: this.#dependencies.knowledgeWorker === undefined ? "NOT_CONFIGURED" : "READY",
      ...automatic,
      provenance: "READY",
    });
  }

  public setAutomaticCompilationStateProvider(
    provider: () => Pick<P2RuntimeState, "automaticCompile" | "lastAutomaticCompileReport">,
  ): void {
    this.#assertOpen();
    this.#automaticCompilationState = provider;
  }

  public async start(): Promise<void> {
    this.#assertOpen();
    if (this.#started) return;
    this.#started = true;
    await this.#recoverJobProjection();
    // Give the composition root time to bind the health/control socket before
    // claiming a potentially long model-backed job. Deployment readiness must
    // not be gated by work already persisted in the durable queue.
    this.#schedulePoll(this.#pollIntervalMs);
  }

  public outstandingJobCount(): number {
    this.#assertOpen();
    return this.#jobStore.list({
      limit: 1_000,
      statuses: ["QUEUED", "RUNNING", "RETRY_WAIT"],
    }).items.length;
  }

  public async createSnapshot(request: SnapshotCreateRequest): Promise<SnapshotCreateResult> {
    this.#assertStarted();
    const observation = await this.#dependencies.snapshotSource.observe(request);
    return this.#service.createSnapshot(request, observation);
  }

  public async enqueueCandidatePreview(request: CandidatePreviewRequest, priority: JobPriority = "INTERACTIVE"): Promise<JobSnapshot> {
    this.#assertStarted();
    if (this.#dependencies.knowledgeWorker === undefined) throw new P2CapabilityUnavailableError();
    const result = this.#service.enqueueCandidatePreview(request, priority);
    await this.#project(result.job.snapshot);
    return result.job.snapshot;
  }

  public async enqueuePolicyCommit(request: CandidateCommitRequest): Promise<JobSnapshot> {
    this.#assertStarted();
    if (this.#dependencies.knowledgeWorker === undefined) throw new P2CapabilityUnavailableError();
    const result = this.#service.enqueuePolicyCommit(request);
    await this.#project(result.job.snapshot);
    return result.job.snapshot;
  }

  public async handle(request: P2ControlRequest): Promise<unknown> {
    switch (request.type) {
      case "extraction.snapshot.create": return await this.createSnapshot(request);
      case "extraction.candidates.preview": return await this.enqueueCandidatePreview(request);
      case "extraction.candidates.commit": return await this.enqueuePolicyCommit(request);
      case "extraction.snapshot.get": {
        const snapshot = this.#service.getSnapshot(request.snapshotId);
        if (snapshot === undefined) throw new ExtractionNotFoundError("snapshot was not found");
        return snapshot;
      }
      case "extraction.snapshots.list":
        return this.#service.listSnapshots({
          limit: request.limit,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        });
      case "extraction.candidates.get": {
        const preview = request.previewId === undefined
          ? this.#service.getCandidatePreviewForSnapshot(request.snapshotId!)
          : this.#service.getCandidatePreview(request.previewId);
        if (preview === undefined) throw new ExtractionNotFoundError("candidate preview was not found");
        return preview;
      }
      case "extraction.policy-commit.get": {
        const commit = this.#service.getPolicyCommitForPreview(request.previewId);
        if (commit === undefined) throw new ExtractionNotFoundError("policy commit was not found");
        return commit;
      }
      case "extraction.provenance.get":
        return this.#service.getProvenance({
          root: request.root,
          limit: request.limit,
          ...(request.afterEdgeId === undefined ? {} : { afterEdgeId: request.afterEdgeId }),
        });
    }
  }

  public async runJobWorkerOnce(signal?: AbortSignal): Promise<WorkerCycleResult> {
    this.#assertStarted();
    const running = this.#jobStore.list({ limit: 100, statuses: ["RUNNING"] });
    for (const snapshot of running.items) await this.#project(snapshot);
    const result = signal === undefined ? await this.#worker.runOnce() : await this.#worker.runOnce(signal);
    if ("job" in result) await this.#project(result.job.snapshot);
    return result;
  }

  public service(): SessionExtractionService {
    this.#assertOpen();
    return this.#service;
  }

  public hasJob(jobId: string): boolean {
    this.#assertOpen();
    return this.#jobStore.get(jobId) !== undefined;
  }

  public async cancelJob(request: JobOperatorCommandRequest): Promise<JobCommandResult> {
    this.#assertOpen();
    const result = this.#jobStore.cancel(request);
    await this.#project(result.job);
    return result;
  }

  public async retryJob(request: JobOperatorCommandRequest): Promise<JobCommandResult> {
    this.#assertOpen();
    const result = this.#jobStore.manualRetry(request);
    await this.#project(result.job);
    return result;
  }

  /** Durable publication job state used by the Console read model. */
  public publicationJobForPreview(previewId: string): JobSnapshot | undefined {
    this.#assertOpen();
    const preview = this.#service.getCandidatePreview(previewId);
    if (preview === undefined) return undefined;
    const snapshot = this.#service.getSnapshot(preview.snapshot.snapshotId);
    if (snapshot === undefined) return undefined;
    const key = p2CommitRequest(snapshot, preview.previewId, preview.revision, "console-publication-state").idempotencyKey;
    return this.#jobForIdempotencyKey(COMMIT_JOB_TYPE, key);
  }

  /** Durable candidate-generation job state used by the Console read model. */
  public candidatePreviewJobForSnapshot(snapshotId: string): JobSnapshot | undefined {
    this.#assertOpen();
    const snapshot = this.#service.getSnapshot(snapshotId);
    if (snapshot === undefined) return undefined;
    const key = p2PreviewRequest(snapshot, "console-preview-state").idempotencyKey;
    return this.#jobForIdempotencyKey(PREVIEW_JOB_TYPE, key);
  }

  #jobForIdempotencyKey(jobType: string, key: string): JobSnapshot | undefined {
    const record = this.#jobStore.getByIdempotencyKey(key);
    return record?.snapshot.jobType === jobType ? record.snapshot : undefined;
  }

  async #preview(context: JobExecutionContext): Promise<void> {
    const worker = this.#dependencies.knowledgeWorker;
    if (worker === undefined) throw new NonRetryableJobError("KNOWLEDGE_WORKER_NOT_CONFIGURED");
    const request = candidatePreviewRequestSchema.parse({
      schemaVersion: 1,
      requestId: "p2-preview-worker",
      type: "extraction.candidates.preview",
      ...(context.input as object),
      idempotencyKey: context.idempotencyKey,
    });
    const snapshot = this.#service.getSnapshot(request.snapshot.snapshotId);
    if (snapshot === undefined) throw new NonRetryableJobError("EXTRACTION_SNAPSHOT_NOT_FOUND");
    const existing = this.#service.getCandidatePreviewForSnapshot(snapshot.snapshotId);
    if (existing !== undefined) return;
    const workerRequest = await worker.requestFor(snapshot);
    const checkpoint = await worker.runtime.run({
      ...workerRequest,
      extraction: { ...workerRequest.extraction, signal: context.signal },
    }, {
      executionMode: "PREVIEW_ONLY",
      retryFailed: true,
    });
    const policies = assertPreviewCheckpoint(checkpoint);
    const createdAt = this.#clock().toISOString();
    this.#service.recordEpisodes(snapshot.snapshotId, (checkpoint.payload.episodes ?? []).map(({ episodeId }) => ({ episodeId })), createdAt);
    this.#service.completeCandidatePreview({
      jobId: context.jobId,
      effectKey: context.effectKey("candidate-preview"),
      status: "READY",
      candidates: policies.map(previewItem),
      diagnostics: [],
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + PREVIEW_TTL_MS).toISOString(),
    });
  }

  async #commit(context: JobExecutionContext): Promise<void> {
    const worker = this.#dependencies.knowledgeWorker;
    if (worker === undefined) throw new NonRetryableJobError("KNOWLEDGE_WORKER_NOT_CONFIGURED");
    const request = candidatePolicyCommitRequestSchema.parse({
      schemaVersion: 1,
      requestId: "p2-commit-worker",
      type: "extraction.candidates.commit",
      ...(context.input as object),
      idempotencyKey: context.idempotencyKey,
    });
    const snapshot = this.#service.getSnapshot(request.snapshot.snapshotId);
    const preview = this.#service.getCandidatePreview(request.previewId);
    if (snapshot === undefined || preview === undefined) throw new NonRetryableJobError("EXTRACTION_PREVIEW_NOT_FOUND");
    if (this.#service.getPolicyCommitForPreview(preview.previewId) === undefined) {
      this.#service.completePolicyCommit({
        jobId: context.jobId,
        effectKey: context.effectKey("candidate-policy-commit"),
        decisions: preview.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          disposition: candidate.policyDecision,
          reasonCodes: candidate.policyReasonCodes,
        })),
        createdAt: this.#clock().toISOString(),
      });
    }
    const workerRequest = await worker.requestFor(snapshot);
    const checkpoint = await worker.runtime.run({
      ...workerRequest,
      extraction: { ...workerRequest.extraction, signal: context.signal },
    }, {
      executionMode: "SAFE_AUTO_PUBLICATION",
      publicationAuthorization: {
        kind: "EXPLICIT_COMMIT",
        authorizationId: context.idempotencyKey,
      },
      retryFailed: true,
    });
    assertCommitCheckpoint(checkpoint);
    for (const item of checkpoint.payload.outbox ?? []) {
      if (item.markdown === undefined) continue;
      this.#service.recordKnowledgeVersion({
        snapshotId: snapshot.snapshotId,
        candidateId: item.candidateId,
        knowledgeId: item.asset.id,
        version: item.asset.version,
        observedAt: checkpoint.updatedAt,
      });
    }
  }

  async #recoverJobProjection(): Promise<void> {
    let after: { readonly createdAt: string; readonly jobId: string } | undefined;
    for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
      const page = this.#jobStore.list({ limit: 100, ...(after === undefined ? {} : { after }) });
      for (const snapshot of page.items) await this.#project(snapshot);
      if (page.next === undefined) return;
      after = page.next;
    }
    throw new Error("P2 job projection recovery exceeded its bounded page limit");
  }

  #schedulePoll(delayMs: number): void {
    if (!this.#started || this.#closed || this.#pollTimer !== undefined) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      if (!this.#started || this.#closed) return;
      let nextDelayMs = this.#pollIntervalMs;
      const operation = this.runJobWorkerOnce().then((result) => {
        nextDelayMs = result.status === "IDLE" ? this.#pollIntervalMs : this.#activePollIntervalMs;
      });
      this.#pollTail = operation;
      void operation.catch(() => undefined).finally(() => {
        if (this.#pollTail === operation) this.#pollTail = undefined;
        this.#schedulePoll(nextDelayMs);
      });
    }, delayMs);
    this.#pollTimer.unref?.();
  }

  async #project(snapshot: JobSnapshot): Promise<void> {
    await this.#dependencies.projectJob(snapshot);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("P2 runtime is closed");
  }

  #assertStarted(): void {
    this.#assertOpen();
    if (!this.#started) throw new Error("P2 runtime is not started");
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#started = false;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    await this.#pollTail;
    this.#jobStore.close();
    this.#extractionStore.close();
    this.#closed = true;
  }
}

export function p2PreviewRequest(snapshot: ExtractionSnapshot, requestId: string): CandidatePreviewRequest {
  const reference = { snapshotId: snapshot.snapshotId, revision: snapshot.revision, identityHash: snapshot.identityHash };
  return candidatePreviewRequestSchema.parse({
    schemaVersion: 1,
    requestId,
    type: "extraction.candidates.preview",
    snapshot: reference,
    compilerVersion: snapshot.compilerVersion,
    policyHash: snapshot.policyHash,
    idempotencyKey: candidatePreviewIdempotencyKey({
      snapshot: reference,
      compilerVersion: snapshot.compilerVersion,
      policyHash: snapshot.policyHash,
    }),
  });
}

export function p2CommitRequest(snapshot: ExtractionSnapshot, previewId: string, revision: number, requestId: string): CandidateCommitRequest {
  const reference = { snapshotId: snapshot.snapshotId, revision: snapshot.revision, identityHash: snapshot.identityHash };
  return candidatePolicyCommitRequestSchema.parse({
    schemaVersion: 1,
    requestId,
    type: "extraction.candidates.commit",
    snapshot: reference,
    previewId,
    expectedPreviewRevision: revision,
    compilerVersion: snapshot.compilerVersion,
    policyHash: snapshot.policyHash,
    idempotencyKey: candidatePolicyCommitIdempotencyKey({
      snapshot: reference,
      previewId,
      expectedPreviewRevision: revision,
      compilerVersion: snapshot.compilerVersion,
      policyHash: snapshot.policyHash,
    }),
  });
}
