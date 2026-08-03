import type {
  CAPABILITY_STATUSES,
  INJECTION_STATUSES,
  JOB_ATTEMPT_STATUSES,
  JOB_CANCELLATION_STATUSES,
  JOB_IDEMPOTENCY_STATUSES,
  JOB_LEASE_STATUSES,
  JOB_STATUSES,
  STAGE_STATUSES,
} from "./constants.js";

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];
export type StageStatus = (typeof STAGE_STATUSES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobAttemptStatus = (typeof JOB_ATTEMPT_STATUSES)[number];
export type JobLeaseStatus = (typeof JOB_LEASE_STATUSES)[number];
export type JobCancellationStatus = (typeof JOB_CANCELLATION_STATUSES)[number];
export type JobIdempotencyStatus = (typeof JOB_IDEMPOTENCY_STATUSES)[number];
export type InjectionStatus = (typeof INJECTION_STATUSES)[number];
export type StateMachineKind = "capability" | "stage" | "job" | "jobAttempt" | "jobLease" | "jobCancellation" | "jobIdempotency" | "injection";

type StatusFor<K extends StateMachineKind> = K extends "capability" ? CapabilityStatus
  : K extends "stage" ? StageStatus
    : K extends "job" ? JobStatus
      : K extends "jobAttempt" ? JobAttemptStatus
        : K extends "jobLease" ? JobLeaseStatus
          : K extends "jobCancellation" ? JobCancellationStatus
            : K extends "jobIdempotency" ? JobIdempotencyStatus
              : InjectionStatus;

const capabilityTransitions: Readonly<Record<CapabilityStatus, ReadonlySet<CapabilityStatus>>> = {
  NOT_IMPLEMENTED: new Set(["DISABLED"]),
  DISABLED: new Set(["NOT_CONFIGURED", "NOT_VERIFIED", "STARTING"]),
  NOT_CONFIGURED: new Set(["DISABLED", "NOT_VERIFIED", "STARTING"]),
  NOT_VERIFIED: new Set(["DISABLED", "STARTING", "READY", "FAILED"]),
  STARTING: new Set(["READY", "DEGRADED", "FAILED", "DISABLED"]),
  READY: new Set(["DEGRADED", "FAILED", "DISABLED", "NOT_CONFIGURED"]),
  DEGRADED: new Set(["READY", "FAILED", "DISABLED", "NOT_CONFIGURED"]),
  FAILED: new Set(["STARTING", "DEGRADED", "DISABLED", "NOT_CONFIGURED"]),
};

const stageTransitions: Readonly<Record<StageStatus, ReadonlySet<StageStatus>>> = {
  NOT_APPLICABLE: new Set(),
  PENDING: new Set(["RUNNING", "BLOCKED", "SKIPPED", "DISABLED", "FAILED"]),
  RUNNING: new Set(["SUCCEEDED", "FAILED", "BLOCKED", "SKIPPED"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(["PENDING", "RUNNING"]),
  BLOCKED: new Set(["PENDING", "RUNNING", "SKIPPED", "DISABLED"]),
  SKIPPED: new Set(),
  DISABLED: new Set(["PENDING"]),
};

const jobTransitions: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  QUEUED: new Set(["RUNNING", "CANCELLED"]),
  RUNNING: new Set(["SUCCEEDED", "FAILED", "RETRY_WAIT", "CANCELLED"]),
  RETRY_WAIT: new Set(["QUEUED", "RUNNING", "FAILED", "CANCELLED"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(["QUEUED"]),
  CANCELLED: new Set(),
};

const jobAttemptTransitions: Readonly<Record<JobAttemptStatus, ReadonlySet<JobAttemptStatus>>> = {
  RUNNING: new Set(["SUCCEEDED", "RETRYABLE_FAILED", "TERMINAL_FAILED", "CANCELLED", "LEASE_LOST"]),
  SUCCEEDED: new Set(),
  RETRYABLE_FAILED: new Set(),
  TERMINAL_FAILED: new Set(),
  CANCELLED: new Set(),
  LEASE_LOST: new Set(),
};

const jobLeaseTransitions: Readonly<Record<JobLeaseStatus, ReadonlySet<JobLeaseStatus>>> = {
  ACTIVE: new Set(["EXPIRED", "RELEASED"]),
  EXPIRED: new Set(),
  RELEASED: new Set(),
};

const jobCancellationTransitions: Readonly<Record<JobCancellationStatus, ReadonlySet<JobCancellationStatus>>> = {
  NOT_REQUESTED: new Set(["REQUESTED"]),
  REQUESTED: new Set(["ACKNOWLEDGED", "REJECTED"]),
  ACKNOWLEDGED: new Set(),
  REJECTED: new Set(),
};

const jobIdempotencyTransitions: Readonly<Record<JobIdempotencyStatus, ReadonlySet<JobIdempotencyStatus>>> = {
  RESERVED: new Set(["COMPLETED"]),
  COMPLETED: new Set(),
};

const injectionTransitions: Readonly<Record<InjectionStatus, ReadonlySet<InjectionStatus>>> = {
  PENDING: new Set(["RETRIEVING", "DISABLED", "INVALID_INPUT", "ERROR"]),
  RETRIEVING: new Set([
    "SHADOWED", "INJECTED", "NO_CONTEXT", "ROLLED_BACK", "TIMEOUT", "PROVIDER_ERROR", "INVALID_CONTEXT", "ERROR",
  ]),
  DISABLED: new Set(),
  SHADOWED: new Set(),
  INJECTED: new Set(),
  NO_CONTEXT: new Set(),
  ROLLED_BACK: new Set(),
  INVALID_INPUT: new Set(),
  TIMEOUT: new Set(),
  PROVIDER_ERROR: new Set(),
  INVALID_CONTEXT: new Set(),
  ERROR: new Set(),
};

const transitions = {
  capability: capabilityTransitions,
  stage: stageTransitions,
  job: jobTransitions,
  jobAttempt: jobAttemptTransitions,
  jobLease: jobLeaseTransitions,
  jobCancellation: jobCancellationTransitions,
  jobIdempotency: jobIdempotencyTransitions,
  injection: injectionTransitions,
} as const;

export function canTransition<K extends StateMachineKind>(
  kind: K,
  from: StatusFor<K>,
  to: StatusFor<K>,
): boolean {
  if (from === to) return true;
  const map = transitions[kind] as Readonly<Record<string, ReadonlySet<string>>>;
  return map[from]?.has(to) ?? false;
}

export function assertTransition<K extends StateMachineKind>(kind: K, from: StatusFor<K>, to: StatusFor<K>): void {
  if (!canTransition(kind, from, to)) throw new Error(`illegal ${kind} transition: ${from} -> ${to}`);
}
