import type { JobAttemptSnapshot, JobCheckpoint, JobCommandResult, JobSnapshot } from "@zhiloop/control-api";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface EnqueueJobRequest {
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly maxAttempts: number;
}

export interface JobRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface DurableJobStoreOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly random?: () => number;
  readonly defaultLeaseMs?: number;
  readonly retryPolicy?: Partial<JobRetryPolicy>;
}

export interface JobCheckpointRecord extends JobCheckpoint {
  readonly data: JsonValue;
}

export interface DurableJobRecord {
  readonly snapshot: JobSnapshot;
  readonly input: JsonValue;
  readonly checkpoint?: JobCheckpointRecord;
}

export type EnqueueJobResult =
  | { readonly status: "CREATED"; readonly job: DurableJobRecord }
  | { readonly status: "EXISTING"; readonly job: DurableJobRecord };

export interface JobLeaseReference {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly fencingToken: number;
}

export interface JobClaim extends JobLeaseReference {
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly input: JsonValue;
  readonly checkpoint?: JobCheckpointRecord;
  readonly snapshot: JobSnapshot;
}

export type ClaimJobResult =
  | { readonly status: "ACQUIRED"; readonly claim: JobClaim }
  | { readonly status: "EMPTY" };

export interface JobFailureInput {
  readonly code: string;
  readonly retryable: boolean;
}

export interface JobHeartbeat {
  readonly leaseExpiresAt: string;
  readonly cancellationRequested: boolean;
}

export type CancellationRequestResult =
  | { readonly status: "CANCELLED" | "REQUESTED" | "ALREADY_REQUESTED" | "REJECTED"; readonly job: DurableJobRecord }
  | { readonly status: "ALREADY_TERMINAL"; readonly job: DurableJobRecord };

export interface JobOperatorCommandRequest {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export type JobOperatorCommandResult = JobCommandResult;

export interface JobExecutionContext {
  readonly jobId: string;
  readonly jobType: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly fencingToken: number;
  readonly idempotencyKey: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
  getCheckpoint(): JobCheckpointRecord | undefined;
  saveCheckpoint(data: unknown, progress: number): JobCheckpointRecord;
  heartbeat(): JobHeartbeat;
  isCancellationRequested(): boolean;
  throwIfCancellationRequested(): void;
  /** Stable across attempts and restarts; consumers must pass it to an idempotent side-effect boundary. */
  effectKey(step: string): string;
}

export type JobHandler = (context: JobExecutionContext) => Promise<void>;

export interface DurableJobWorkerOptions {
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
}

export type WorkerCycleResult =
  | { readonly status: "IDLE" }
  | { readonly status: "SUCCEEDED" | "RETRY_WAIT" | "FAILED" | "CANCELLED"; readonly job: DurableJobRecord }
  | { readonly status: "ABANDONED" | "LEASE_LOST"; readonly jobId: string; readonly attemptId: string };

export interface JobAttemptList {
  readonly items: readonly JobAttemptSnapshot[];
}

export interface JobListCursor {
  readonly createdAt: string;
  readonly jobId: string;
}

export interface ListJobsRequest {
  /** Hard-bounded to 1..1000 records so restart projection recovery cannot become an unbounded read. */
  readonly limit: number;
  readonly statuses?: readonly JobSnapshot["status"][];
  readonly after?: JobListCursor;
}

export interface JobList {
  /** Redacted control-plane snapshots only; raw scheduling input and checkpoint payload never enter projections. */
  readonly items: readonly JobSnapshot[];
  readonly next?: JobListCursor;
}

export class JobIdempotencyConflictError extends Error {
  public constructor() {
    super("job idempotency key conflicts with a different input");
    this.name = "JobIdempotencyConflictError";
  }
}

export class JobLeaseLostError extends Error {
  public constructor() {
    super("job lease is expired or fenced by another worker");
    this.name = "JobLeaseLostError";
  }
}

export class JobCancellationRequestedError extends Error {
  public constructor() {
    super("job cancellation was requested at a safe boundary");
    this.name = "JobCancellationRequestedError";
  }
}

export class JobStaleRevisionError extends Error {
  public constructor() {
    super("job revision is stale");
    this.name = "JobStaleRevisionError";
  }
}

export class JobStateConflictError extends Error {
  public constructor(message = "job state does not allow this command") {
    super(message);
    this.name = "JobStateConflictError";
  }
}

export class JobNotFoundError extends Error {
  public constructor() {
    super("job was not found");
    this.name = "JobNotFoundError";
  }
}

export class RetryableJobError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "RetryableJobError";
  }
}

export class NonRetryableJobError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "NonRetryableJobError";
  }
}
