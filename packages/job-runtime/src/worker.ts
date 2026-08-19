import { jobEffectKey } from "./serialization.js";
import type { SqliteDurableJobStore } from "./store.js";
import {
  JobCancellationRequestedError,
  JobLeaseLostError,
  NonRetryableJobError,
  RetryableJobError,
  type DurableJobWorkerOptions,
  type JobCheckpointRecord,
  type JobExecutionContext,
  type JobHandler,
  type JobLeaseReference,
  type WorkerCycleResult,
} from "./types.js";

const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;

function code(value: string, fallback: string): string {
  return FAILURE_CODE.test(value) ? value : fallback;
}

export class DurableJobWorker {
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;

  public constructor(
    private readonly store: SqliteDurableJobStore,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    options: DurableJobWorkerOptions,
  ) {
    this.#workerId = options.workerId;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.floor(this.#leaseMs / 3));
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 10 || this.#leaseMs > 3_600_000) {
      throw new Error("worker leaseMs must be between 10 and 3600000");
    }
    if (!Number.isSafeInteger(this.#heartbeatMs) || this.#heartbeatMs < 10 || this.#heartbeatMs >= this.#leaseMs) {
      throw new Error("heartbeatMs must be at least 10 and less than leaseMs");
    }
  }

  public async runOnce(signal: AbortSignal = new AbortController().signal): Promise<WorkerCycleResult> {
    if (signal.aborted) return Object.freeze({ status: "IDLE" });
    const claimed = this.store.claimNext(this.#workerId, this.#leaseMs);
    if (claimed.status === "EMPTY") return Object.freeze({ status: "IDLE" });
    const claim = claimed.claim;
    const reference: JobLeaseReference = Object.freeze({
      jobId: claim.jobId,
      attemptId: claim.attemptId,
      workerId: claim.workerId,
      fencingToken: claim.fencingToken,
    });
    const controller = new AbortController();
    let checkpoint: JobCheckpointRecord | undefined = claim.checkpoint;
    let leaseLost = false;
    let heartbeatFailed = false;
    let cancellationRequested = false;
    const abort = (): void => {
      clearInterval(heartbeat);
      controller.abort(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const heartbeat = setInterval(() => {
      try {
        const result = this.store.heartbeat(reference, this.#leaseMs);
        if (result.cancellationRequested) {
          cancellationRequested = true;
          clearInterval(heartbeat);
          controller.abort(new JobCancellationRequestedError());
        }
      } catch (error) {
        clearInterval(heartbeat);
        leaseLost = error instanceof JobLeaseLostError;
        heartbeatFailed = !leaseLost;
        controller.abort(error);
      }
    }, this.#heartbeatMs);
    heartbeat.unref?.();
    const context: JobExecutionContext = Object.freeze({
      jobId: claim.jobId,
      jobType: claim.jobType,
      attemptId: claim.attemptId,
      attempt: claim.snapshot.attempt,
      fencingToken: claim.fencingToken,
      idempotencyKey: claim.idempotencyKey,
      input: claim.input,
      signal: controller.signal,
      getCheckpoint: () => checkpoint,
      saveCheckpoint: (data: unknown, progress: number) => {
        checkpoint = this.store.saveCheckpoint(reference, data, progress);
        return checkpoint;
      },
      heartbeat: () => this.store.heartbeat(reference, this.#leaseMs),
      isCancellationRequested: () => this.store.isCancellationRequested(reference),
      throwIfCancellationRequested: () => {
        if (this.store.isCancellationRequested(reference)) throw new JobCancellationRequestedError();
      },
      effectKey: (step: string) => jobEffectKey(claim.idempotencyKey, step),
    });
    const handler = this.handlers[claim.jobType];
    try {
      if (handler === undefined) {
        const job = this.store.fail(reference, { code: "JOB_HANDLER_NOT_FOUND", retryable: false });
        return Object.freeze({ status: "FAILED", job });
      }
      await handler(context);
      if (cancellationRequested) {
        const job = this.store.acknowledgeCancellation(reference);
        return Object.freeze({ status: "CANCELLED", job });
      }
      if (signal.aborted || heartbeatFailed) {
        return Object.freeze({ status: "ABANDONED", jobId: claim.jobId, attemptId: claim.attemptId });
      }
      if (leaseLost) return Object.freeze({ status: "LEASE_LOST", jobId: claim.jobId, attemptId: claim.attemptId });
      const job = this.store.succeed(reference);
      return Object.freeze({ status: "SUCCEEDED", job });
    } catch (error) {
      if (leaseLost || error instanceof JobLeaseLostError) {
        return Object.freeze({ status: "LEASE_LOST", jobId: claim.jobId, attemptId: claim.attemptId });
      }
      if (cancellationRequested) {
        const job = this.store.acknowledgeCancellation(reference);
        return Object.freeze({ status: "CANCELLED", job });
      }
      if (signal.aborted || heartbeatFailed) {
        return Object.freeze({ status: "ABANDONED", jobId: claim.jobId, attemptId: claim.attemptId });
      }
      if (error instanceof JobCancellationRequestedError) {
        const job = this.store.acknowledgeCancellation(reference);
        return Object.freeze({ status: "CANCELLED", job });
      }
      const retryable = !(error instanceof NonRetryableJobError);
      const failureCode = error instanceof RetryableJobError
        ? code(error.code, "JOB_HANDLER_FAILED")
        : error instanceof NonRetryableJobError
          ? code(error.code, "JOB_NON_RETRYABLE_FAILURE")
          : "JOB_HANDLER_FAILED";
      const job = this.store.fail(reference, { code: failureCode, retryable });
      const status = job.snapshot.status === "RETRY_WAIT" ? "RETRY_WAIT"
        : job.snapshot.status === "CANCELLED" ? "CANCELLED"
          : "FAILED";
      return Object.freeze({ status, job });
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
    }
  }
}
