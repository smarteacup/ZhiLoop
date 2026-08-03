import { describe, expect, it } from "vitest";

import {
  controlRequestSchema,
  jobCommandResultSchema,
  jobAttemptSnapshotSchema,
  jobCancellationSchema,
  jobSnapshotSchema,
} from "./schemas.js";
import { canTransition } from "./state-machine.js";

const observedAt = "2026-08-03T12:00:00.000Z";

describe("durable job control contract", () => {
  it("keeps the P0 JobSnapshot shape backward compatible", () => {
    expect(jobSnapshotSchema.parse({
      schemaVersion: 1,
      jobId: "job-legacy",
      jobType: "CAPTURE",
      status: "QUEUED",
      attempt: 0,
      maxAttempts: 3,
      progress: 0,
      reasonCode: "JOB_QUEUED",
      observedAt,
      lastTransitionAt: observedAt,
      retryable: true,
      evidenceRefs: [],
    })).not.toHaveProperty("lease");
  });

  it("accepts bounded durable metadata without exposing checkpoint payload", () => {
    const snapshot = jobSnapshotSchema.parse({
      schemaVersion: 1,
      jobId: "job-durable",
      jobType: "BACKFILL",
      status: "RUNNING",
      attempt: 2,
      maxAttempts: 5,
      progress: 0.5,
      reasonCode: "JOB_RUNNING",
      observedAt,
      lastTransitionAt: observedAt,
      retryable: true,
      evidenceRefs: [],
      createdAt: observedAt,
      updatedAt: observedAt,
      lease: {
        attemptId: "attempt-2",
        workerId: "worker-1",
        fencingToken: 2,
        status: "ACTIVE",
        acquiredAt: observedAt,
        heartbeatAt: observedAt,
        expiresAt: "2026-08-03T12:01:00.000Z",
      },
      checkpoint: { revision: 3, payloadHash: "a".repeat(64), progress: 0.5, updatedAt: observedAt },
      cancellation: { status: "NOT_REQUESTED" },
      idempotency: { key: "backfill:project:revision:1", inputHash: "b".repeat(64), status: "RESERVED" },
    });
    expect(snapshot.checkpoint).not.toHaveProperty("payload");
    expect(JSON.stringify(snapshot)).not.toMatch(/prompt|authorization|secret/iu);
  });

  it("enforces attempt, lease and cancellation invariants", () => {
    expect(jobAttemptSnapshotSchema.safeParse({
      schemaVersion: 1,
      jobId: "job-1",
      attemptId: "attempt-1",
      attempt: 1,
      status: "LEASE_LOST",
      workerId: "worker-1",
      fencingToken: 1,
      startedAt: observedAt,
      heartbeatAt: observedAt,
      leaseExpiresAt: observedAt,
      finishedAt: observedAt,
      checkpointRevision: 0,
    }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse({
      schemaVersion: 1,
      jobId: "job-1",
      jobType: "CAPTURE",
      status: "QUEUED",
      attempt: 2,
      maxAttempts: 1,
      progress: 0,
      reasonCode: "JOB_QUEUED",
      observedAt,
      lastTransitionAt: observedAt,
      retryable: true,
      evidenceRefs: [],
    }).success).toBe(false);
    expect(jobCancellationSchema.safeParse({ status: "REQUESTED" }).success).toBe(false);
  });

  it("defines terminal attempt, fenced lease, cancellation and idempotency transitions", () => {
    expect(canTransition("jobAttempt", "RUNNING", "LEASE_LOST")).toBe(true);
    expect(canTransition("jobAttempt", "LEASE_LOST", "RUNNING")).toBe(false);
    expect(canTransition("jobLease", "ACTIVE", "EXPIRED")).toBe(true);
    expect(canTransition("jobLease", "EXPIRED", "ACTIVE")).toBe(false);
    expect(canTransition("jobCancellation", "REQUESTED", "ACKNOWLEDGED")).toBe(true);
    expect(canTransition("jobCancellation", "ACKNOWLEDGED", "REQUESTED")).toBe(false);
    expect(canTransition("jobIdempotency", "RESERVED", "COMPLETED")).toBe(true);
    expect(canTransition("jobIdempotency", "COMPLETED", "RESERVED")).toBe(false);
  });

  it("requires strict revision-bound idempotent operator commands", () => {
    const command = {
      schemaVersion: 1,
      requestId: "request-job-cancel",
      type: "job.cancel",
      jobId: "job-1",
      expectedRevision: 3,
      idempotencyKey: "operator:cancel:job:one",
    } as const;
    expect(controlRequestSchema.parse(command)).toEqual(command);
    expect(controlRequestSchema.safeParse({ ...command, unexpected: true }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...command, expectedRevision: -1 }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...command, idempotencyKey: "short" }).success).toBe(false);
    expect(controlRequestSchema.parse({ ...command, requestId: "request-job-retry", type: "job.retry" })).toMatchObject({ type: "job.retry" });

    const result = {
      schemaVersion: 1,
      action: "CANCEL",
      disposition: "APPLIED",
      job: {
        schemaVersion: 1,
        jobId: "job-1",
        jobType: "CAPTURE",
        revision: 4,
        status: "RUNNING",
        attempt: 1,
        maxAttempts: 3,
        progress: 0,
        reasonCode: "JOB_CANCELLATION_REQUESTED",
        observedAt,
        lastTransitionAt: observedAt,
        retryable: true,
        evidenceRefs: [],
      },
    } as const;
    expect(jobCommandResultSchema.parse(result)).toMatchObject({ job: { revision: 4 } });
    const legacyJob: Record<string, unknown> = { ...result.job };
    delete legacyJob["revision"];
    expect(jobCommandResultSchema.safeParse({ ...result, job: legacyJob }).success).toBe(false);
  });
});
