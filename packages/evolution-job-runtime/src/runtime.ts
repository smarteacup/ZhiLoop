import type { JobAttemptSnapshot, JobSnapshot } from "@zhiloop/control-api";
import {
  DurableJobWorker,
  SqliteDurableJobStore,
  type DurableJobRecord,
  type DurableJobStoreOptions,
  type EnqueueJobResult,
  type JobHandler,
  type JobOperatorCommandRequest,
  type JobOperatorCommandResult,
  type WorkerCycleResult,
} from "@zhiloop/job-runtime";

import {
  EVOLUTION_JOB_TYPES,
  evolutionJobIdempotencyKey,
  parseEvolutionJobInput,
  type EvolutionJobInput,
  type EvolutionJobType,
} from "./contracts.js";

export type EvolutionJobCapabilityStatus = "READY" | "NOT_CONFIGURED" | "DEGRADED";

export interface EvolutionJobCapability {
  readonly jobType: EvolutionJobType;
  readonly status: EvolutionJobCapabilityStatus;
  readonly reasonCode: "EVOLUTION_JOB_HANDLER_READY" | "EVOLUTION_JOB_HANDLER_NOT_CONFIGURED" | "EVOLUTION_JOB_RUNTIME_CLOSED";
}

export interface EvolutionJobProjection {
  readonly jobId: string;
  readonly jobType: EvolutionJobType;
  readonly status: JobSnapshot["status"];
  readonly revision: number;
  readonly progress: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly projectId?: string;
  readonly entityRef: string;
  readonly sourceRef?: string;
  readonly checkpointPhase?: string;
  readonly nextAttemptAt?: string;
  readonly lastFailure?: { readonly code: string; readonly retryable: boolean; readonly occurredAt: string };
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface EvolutionJobPage {
  readonly items: readonly EvolutionJobProjection[];
  readonly next?: { readonly createdAt: string; readonly jobId: string };
}

export interface EvolutionJobRuntimeOptions {
  readonly workerId: string;
  readonly handlers: Partial<Record<EvolutionJobType, JobHandler>>;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly store?: DurableJobStoreOptions;
}

export class EvolutionJobCapabilityError extends Error {
  readonly code = "EVOLUTION_JOB_CAPABILITY_NOT_CONFIGURED";
  readonly retryable = false;

  constructor(readonly jobType: EvolutionJobType) {
    super(`evolution job handler is not configured: ${jobType}`);
    this.name = "EvolutionJobCapabilityError";
  }
}

function safePhase(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const phase = (value as Readonly<Record<string, unknown>>)["phase"];
  return typeof phase === "string" && /^[A-Z][A-Z0-9_]{0,119}$/u.test(phase) ? phase : undefined;
}

function project(record: DurableJobRecord): EvolutionJobProjection {
  const input = parseEvolutionJobInput(record.input);
  const snapshot = record.snapshot;
  const checkpointPhase = safePhase(record.checkpoint?.data);
  const common = {
    jobId: snapshot.jobId,
    jobType: input.jobType,
    status: snapshot.status,
    revision: snapshot.revision ?? 0,
    progress: snapshot.progress,
    attempt: snapshot.attempt,
    maxAttempts: snapshot.maxAttempts,
    ...(snapshot.nextAttemptAt === undefined ? {} : { nextAttemptAt: snapshot.nextAttemptAt }),
    ...(snapshot.lastFailure === undefined ? {} : { lastFailure: snapshot.lastFailure }),
    ...(snapshot.createdAt === undefined ? {} : { createdAt: snapshot.createdAt }),
    ...(snapshot.updatedAt === undefined ? {} : { updatedAt: snapshot.updatedAt }),
    ...(checkpointPhase === undefined ? {} : { checkpointPhase }),
  };
  switch (input.jobType) {
    case "KNOWLEDGE_COMPILE":
      return Object.freeze({ ...common, entityRef: `session:${input.sessionId}:${input.sourceRange.from}-${input.sourceRange.to}` });
    case "KNOWLEDGE_REVALIDATE":
      return Object.freeze({ ...common, projectId: input.projectId, entityRef: input.sourceRef, sourceRef: input.sourceRef });
    case "KNOWLEDGE_REPAIR_DRAFT":
      return Object.freeze({ ...common, projectId: input.projectId, entityRef: `${input.assetId}@${input.assetVersion}` });
    case "CODEGRAPH_INITIALIZE":
      return Object.freeze({ ...common, projectId: input.projectId, entityRef: input.repositoryIdentity });
    case "LEGACY_KNOWLEDGE_MIGRATION":
      return Object.freeze({ ...common, projectId: input.projectId, entityRef: `${input.migrationVersion}:${input.pageCursor}` });
  }
}

export class EvolutionJobRuntime {
  readonly #store: SqliteDurableJobStore;
  readonly #handlers: Readonly<Partial<Record<EvolutionJobType, JobHandler>>>;
  readonly #worker: DurableJobWorker;
  #closed = false;

  constructor(filename: string, options: EvolutionJobRuntimeOptions) {
    const unknown = Object.keys(options.handlers).filter((key) => !EVOLUTION_JOB_TYPES.includes(key as EvolutionJobType));
    if (unknown.length > 0) throw new Error("EVOLUTION_JOB_HANDLER_TYPE_INVALID");
    this.#handlers = Object.freeze({ ...options.handlers });
    this.#store = new SqliteDurableJobStore(filename, options.store);
    try {
      this.#worker = new DurableJobWorker(this.#store, this.#handlers as Readonly<Record<string, JobHandler>>, {
        workerId: options.workerId,
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      });
    } catch (error) {
      this.#store.close();
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("EVOLUTION_JOB_RUNTIME_CLOSED");
  }

  capabilities(): readonly EvolutionJobCapability[] {
    return Object.freeze(EVOLUTION_JOB_TYPES.map((jobType): EvolutionJobCapability => Object.freeze({
      jobType,
      status: this.#closed ? "DEGRADED" : this.#handlers[jobType] === undefined ? "NOT_CONFIGURED" : "READY",
      reasonCode: this.#closed ? "EVOLUTION_JOB_RUNTIME_CLOSED"
        : this.#handlers[jobType] === undefined ? "EVOLUTION_JOB_HANDLER_NOT_CONFIGURED" : "EVOLUTION_JOB_HANDLER_READY",
    })));
  }

  enqueue(input: EvolutionJobInput, maxAttempts: number): EnqueueJobResult {
    this.#assertOpen();
    const parsed = parseEvolutionJobInput(input);
    if (this.#handlers[parsed.jobType] === undefined) throw new EvolutionJobCapabilityError(parsed.jobType);
    return this.#store.enqueue({
      jobType: parsed.jobType,
      idempotencyKey: evolutionJobIdempotencyKey(parsed),
      input: parsed,
      maxAttempts,
    });
  }

  get(jobId: string): EvolutionJobProjection | undefined {
    this.#assertOpen();
    const record = this.#store.get(jobId);
    return record === undefined ? undefined : project(record);
  }

  list(request: { readonly limit: number; readonly statuses?: readonly JobSnapshot["status"][]; readonly after?: { readonly createdAt: string; readonly jobId: string } }): EvolutionJobPage {
    this.#assertOpen();
    const page = this.#store.list(request);
    const items = page.items.map((snapshot) => {
      const record = this.#store.get(snapshot.jobId);
      if (record === undefined) throw new Error("EVOLUTION_JOB_PROJECTION_SOURCE_MISSING");
      return project(record);
    });
    return Object.freeze({ items: Object.freeze(items), ...(page.next === undefined ? {} : { next: page.next }) });
  }

  attempts(jobId: string): readonly JobAttemptSnapshot[] {
    this.#assertOpen();
    return this.#store.listAttempts(jobId).items;
  }

  cancel(request: JobOperatorCommandRequest): JobOperatorCommandResult {
    this.#assertOpen();
    return this.#store.cancel(request);
  }

  retry(request: JobOperatorCommandRequest): JobOperatorCommandResult {
    this.#assertOpen();
    return this.#store.manualRetry(request);
  }

  async runOnce(signal?: AbortSignal): Promise<WorkerCycleResult> {
    this.#assertOpen();
    return await this.#worker.runOnce(signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#store.close();
    this.#closed = true;
  }
}
