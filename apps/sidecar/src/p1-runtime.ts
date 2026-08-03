import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  AutomaticIngestionService,
  SqliteAutomaticIngestionCheckpointStore,
  type AutomaticIngestionRunReport,
  type BackfillRecoveryPort,
  type SessionCapturePort,
  type SessionRelationSourcePort,
  type SessionRelationStorePort,
} from "@zhiloop/automatic-ingestion";
import type { JobCommandResult, JobSnapshot } from "@zhiloop/control-api";
import {
  DurableJobWorker,
  SqliteDurableJobStore,
  type JobExecutionContext,
  type JobListCursor,
  type JobOperatorCommandRequest,
  type WorkerCycleResult,
} from "@zhiloop/job-runtime";
import type { SessionCatalogQueryPort } from "@zhiloop/session-catalog";

const AUTOMATIC_SCAN_JOB = "AUTOMATIC_INGESTION_SCAN";
const JOB_RECOVERY_PAGE_SIZE = 100;
const MAX_JOB_RECOVERY_PAGES = 1_000;

export interface P1RuntimeConfiguration {
  readonly sessionScanIntervalMs: number;
  readonly followDebounceMs: number;
  readonly workerPollIntervalMs: number;
  readonly workerConcurrency: number;
  readonly scanBatchSize: number;
  readonly captureBatchSize: number;
  readonly captureRetry: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maximumDelayMs: number;
    readonly jitterRatio: number;
  };
}

export const DEFAULT_P1_RUNTIME_CONFIGURATION: P1RuntimeConfiguration = Object.freeze({
  sessionScanIntervalMs: 60_000,
  followDebounceMs: 1_000,
  workerPollIntervalMs: 1_000,
  workerConcurrency: 2,
  scanBatchSize: 100,
  captureBatchSize: 100,
  captureRetry: Object.freeze({ maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 }),
});

export interface P1TimerHandle {
  cancel(): void;
}

export interface P1TimerPort {
  schedule(delayMs: number, task: () => void): P1TimerHandle;
}

export interface SafeAutomaticIngestionReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly catalogCoverage: "COMPLETE" | "BOUNDED";
  readonly relationCoverage: "NOT_CONFIGURED" | "COMPLETE" | "BOUNDED" | "FAILED";
  readonly scannedSessions: number;
  readonly discoveredSessions: number;
  readonly changedSessions: number;
  readonly capturedSessions: number;
  readonly recoveredSessions: number;
  readonly observedRelations: number;
  readonly pendingSessions: number;
  readonly diagnosticCodes: readonly string[];
}

export interface P1RuntimeState {
  readonly automaticIngestion: "READY" | "STOPPED" | "DEGRADED";
  readonly backfillRecovery: "READY" | "NOT_CONFIGURED";
  readonly relationObservation: "READY" | "NOT_CONFIGURED";
  readonly jobProjectionRecovery: "COMPLETE" | "BOUNDED" | "FAILED" | "NOT_STARTED";
  readonly projectedJobs: number;
  readonly diagnosticCodes: readonly string[];
  readonly lastIngestionReport?: SafeAutomaticIngestionReport;
}

export interface P1SidecarRuntimeDependencies {
  readonly stateDirectory: string;
  readonly catalog: SessionCatalogQueryPort;
  readonly capture: SessionCapturePort;
  readonly projectJob: (snapshot: JobSnapshot) => void | Promise<void>;
  readonly recovery?: BackfillRecoveryPort;
  readonly relationSource?: SessionRelationSourcePort;
  readonly relationStore?: SessionRelationStorePort;
  readonly configuration?: P1RuntimeConfiguration;
  readonly enabled?: boolean;
  readonly now?: () => Date;
  readonly timer?: P1TimerPort;
  readonly workerId?: string;
  readonly onIngestionReport?: (report: SafeAutomaticIngestionReport) => void | Promise<void>;
}

class NodeP1Timer implements P1TimerPort {
  schedule(delayMs: number, task: () => void): P1TimerHandle {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeConfiguration(input: P1RuntimeConfiguration): P1RuntimeConfiguration {
  const sessionScanIntervalMs = boundedInteger(input.sessionScanIntervalMs, 5_000, 86_400_000, "sessionScanIntervalMs");
  const followDebounceMs = boundedInteger(input.followDebounceMs, 100, 60_000, "followDebounceMs");
  const workerPollIntervalMs = boundedInteger(input.workerPollIntervalMs, 100, 60_000, "workerPollIntervalMs");
  const workerConcurrency = boundedInteger(input.workerConcurrency, 1, 32, "workerConcurrency");
  const scanBatchSize = boundedInteger(input.scanBatchSize, 1, 1_000, "scanBatchSize");
  const captureBatchSize = boundedInteger(input.captureBatchSize, 1, 1_000, "captureBatchSize");
  const maxAttempts = boundedInteger(input.captureRetry.maxAttempts, 1, 20, "captureRetry.maxAttempts");
  const baseDelayMs = boundedInteger(input.captureRetry.baseDelayMs, 100, 300_000, "captureRetry.baseDelayMs");
  const maximumDelayMs = boundedInteger(input.captureRetry.maximumDelayMs, 100, 3_600_000, "captureRetry.maximumDelayMs");
  if (baseDelayMs > maximumDelayMs) throw new Error("captureRetry.baseDelayMs must not exceed maximumDelayMs");
  if (!Number.isFinite(input.captureRetry.jitterRatio) || input.captureRetry.jitterRatio < 0 || input.captureRetry.jitterRatio > 1) {
    throw new Error("captureRetry.jitterRatio must be between 0 and 1");
  }
  return Object.freeze({
    sessionScanIntervalMs,
    followDebounceMs,
    workerPollIntervalMs,
    workerConcurrency,
    scanBatchSize,
    captureBatchSize,
    captureRetry: Object.freeze({ maxAttempts, baseDelayMs, maximumDelayMs, jitterRatio: input.captureRetry.jitterRatio }),
  });
}

function safeReport(report: AutomaticIngestionRunReport): SafeAutomaticIngestionReport {
  return Object.freeze({
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    catalogCoverage: report.catalogCoverage,
    relationCoverage: report.relationCoverage,
    scannedSessions: report.scannedSessions,
    discoveredSessions: report.discoveredSessions,
    changedSessions: report.changedSessions,
    capturedSessions: report.capturedSessions,
    recoveredSessions: report.recoveredSessions,
    observedRelations: report.observedRelations,
    pendingSessions: report.pendingSessions,
    diagnosticCodes: Object.freeze([...new Set(report.diagnostics.map(({ code }) => code))].sort()),
  });
}

/**
 * P1 background composition. It owns no hook callback and all scheduling is completion-based,
 * bounded and non-reentrant, keeping capture/scan work outside the hook deadline path.
 */
export class P1SidecarRuntime {
  readonly #dependencies: P1SidecarRuntimeDependencies;
  readonly #timer: P1TimerPort;
  readonly #jobPath: string;
  readonly #checkpointPath: string;
  readonly #checkpointStore: SqliteAutomaticIngestionCheckpointStore;
  #configuration: P1RuntimeConfiguration;
  #jobStore: SqliteDurableJobStore;
  #worker: DurableJobWorker;
  #ingestion: AutomaticIngestionService;
  #scanTimer: P1TimerHandle | undefined;
  #pollTimer: P1TimerHandle | undefined;
  #scanTail: Promise<void> | undefined;
  #pollTail: Promise<void> | undefined;
  #started = false;
  #closed = false;
  #generation = 0;
  #projectedJobs = 0;
  #projectionRecovery: P1RuntimeState["jobProjectionRecovery"] = "NOT_STARTED";
  #recoveryAttempted = false;
  #diagnosticCodes = new Set<string>();
  #lastReport: SafeAutomaticIngestionReport | undefined;

  private constructor(dependencies: P1SidecarRuntimeDependencies, configuration: P1RuntimeConfiguration) {
    this.#dependencies = dependencies;
    this.#timer = dependencies.timer ?? new NodeP1Timer();
    this.#configuration = configuration;
    this.#jobPath = join(dependencies.stateDirectory, "p1-jobs.sqlite");
    this.#checkpointPath = join(dependencies.stateDirectory, "p1-ingestion.sqlite");
    this.#checkpointStore = new SqliteAutomaticIngestionCheckpointStore(this.#checkpointPath);
    this.#jobStore = this.#createJobStore(configuration);
    this.#ingestion = this.#createIngestion(configuration);
    this.#worker = this.#createWorker(this.#jobStore, this.#ingestion);
  }

  static async create(dependencies: P1SidecarRuntimeDependencies): Promise<P1SidecarRuntime> {
    await mkdir(dependencies.stateDirectory, { recursive: true, mode: 0o700 });
    return new P1SidecarRuntime(dependencies, normalizeConfiguration(dependencies.configuration ?? DEFAULT_P1_RUNTIME_CONFIGURATION));
  }

  #createJobStore(configuration: P1RuntimeConfiguration): SqliteDurableJobStore {
    return new SqliteDurableJobStore(this.#jobPath, {
      ...(this.#dependencies.now === undefined ? {} : { clock: this.#dependencies.now }),
      retryPolicy: {
        baseDelayMs: configuration.captureRetry.baseDelayMs,
        maxDelayMs: configuration.captureRetry.maximumDelayMs,
        jitterRatio: configuration.captureRetry.jitterRatio,
      },
    });
  }

  #createIngestion(configuration: P1RuntimeConfiguration): AutomaticIngestionService {
    return new AutomaticIngestionService({
      catalog: this.#dependencies.catalog,
      capture: this.#dependencies.capture,
      checkpoints: this.#checkpointStore,
      ...(this.#dependencies.recovery === undefined ? {} : { recovery: this.#dependencies.recovery }),
      ...(this.#dependencies.relationSource === undefined ? {} : { relationSource: this.#dependencies.relationSource }),
      ...(this.#dependencies.relationStore === undefined ? {} : { relationStore: this.#dependencies.relationStore }),
      ...(this.#dependencies.now === undefined ? {} : { now: this.#dependencies.now }),
    }, {
      scanIntervalMs: configuration.sessionScanIntervalMs,
      followDebounceMs: configuration.followDebounceMs,
      retryDelayMs: configuration.captureRetry.baseDelayMs,
      pageSize: Math.min(100, configuration.scanBatchSize),
      maxSessionsPerScan: configuration.scanBatchSize,
      maxCapturesPerRun: configuration.captureBatchSize,
    });
  }

  #createWorker(store: SqliteDurableJobStore, ingestion: AutomaticIngestionService): DurableJobWorker {
    return new DurableJobWorker(store, {
      [AUTOMATIC_SCAN_JOB]: async (context: JobExecutionContext) => {
        context.throwIfCancellationRequested();
        const report = safeReport(await ingestion.runOnce());
        context.throwIfCancellationRequested();
        context.saveCheckpoint(report, 1);
        this.#lastReport = report;
        await this.#dependencies.onIngestionReport?.(report);
      },
    }, { workerId: this.#dependencies.workerId ?? `sidecar-p1-${process.pid}`, leaseMs: 60_000, heartbeatMs: 20_000 });
  }

  async start(): Promise<boolean> {
    this.#assertOpen();
    if (this.#started) return false;
    if (!this.#recoveryAttempted) {
      this.#recoveryAttempted = true;
      await this.#recoverJobProjection();
    }
    if (this.#dependencies.enabled === false) return false;
    this.#started = true;
    this.#generation += 1;
    this.#scheduleScan(this.#configuration.sessionScanIntervalMs, this.#generation);
    this.#schedulePoll(this.#configuration.workerPollIntervalMs, this.#generation);
    return true;
  }

  async triggerAutomaticScan(): Promise<JobSnapshot> {
    this.#assertOpen();
    const now = this.#now();
    const window = Math.floor(now.getTime() / this.#configuration.sessionScanIntervalMs);
    const result = this.#jobStore.enqueue({
      jobType: AUTOMATIC_SCAN_JOB,
      idempotencyKey: `automatic-ingestion:scan:v1:${this.#configuration.sessionScanIntervalMs}:${window}`,
      input: { window, scanIntervalMs: this.#configuration.sessionScanIntervalMs },
      maxAttempts: this.#configuration.captureRetry.maxAttempts,
    });
    await this.#project(result.job.snapshot);
    return result.job.snapshot;
  }

  async runJobWorkerOnce(signal?: AbortSignal): Promise<WorkerCycleResult> {
    this.#assertOpen();
    const cycle = signal === undefined ? this.#worker.runOnce() : this.#worker.runOnce(signal);
    const running = this.#jobStore.list({ limit: 100, statuses: ["RUNNING"] });
    for (const snapshot of running.items) await this.#project(snapshot);
    const result = await cycle;
    if ("job" in result) await this.#project(result.job.snapshot);
    else if ("jobId" in result) {
      const persisted = this.#jobStore.get(result.jobId);
      if (persisted !== undefined) await this.#project(persisted.snapshot);
    }
    return result;
  }

  async runJobWorkersOnce(signal?: AbortSignal): Promise<readonly WorkerCycleResult[]> {
    this.#assertOpen();
    return await Promise.all(Array.from(
      { length: this.#configuration.workerConcurrency },
      async () => await this.runJobWorkerOnce(signal),
    ));
  }

  async cancelJob(request: JobOperatorCommandRequest): Promise<JobCommandResult> {
    this.#assertOpen();
    const result = this.#jobStore.cancel(request);
    await this.#project(result.job);
    return result;
  }

  async retryJob(request: JobOperatorCommandRequest): Promise<JobCommandResult> {
    this.#assertOpen();
    const result = this.#jobStore.manualRetry(request);
    await this.#project(result.job);
    return result;
  }

  hasJob(jobId: string): boolean {
    this.#assertOpen();
    return this.#jobStore.get(jobId) !== undefined;
  }

  /** Applies active-consumer configuration and returns an idempotent last-known-good rollback closure. */
  async applyConfiguration(nextInput: P1RuntimeConfiguration): Promise<() => Promise<void>> {
    this.#assertOpen();
    const next = normalizeConfiguration(nextInput);
    const previous = this.#configuration;
    await this.#reconfigure(next);
    let rolledBack = false;
    return async () => {
      if (rolledBack || this.#closed) return;
      rolledBack = true;
      await this.#reconfigure(previous);
    };
  }

  state(): P1RuntimeState {
    const automaticIngestion = this.#diagnosticCodes.has("JOB_PROJECTION_FAILED") ? "DEGRADED"
      : this.#started ? "READY" : "STOPPED";
    return Object.freeze({
      automaticIngestion,
      backfillRecovery: this.#dependencies.recovery === undefined ? "NOT_CONFIGURED" : "READY",
      relationObservation: this.#dependencies.relationSource === undefined || this.#dependencies.relationStore === undefined
        ? "NOT_CONFIGURED" : "READY",
      jobProjectionRecovery: this.#projectionRecovery,
      projectedJobs: this.#projectedJobs,
      diagnosticCodes: Object.freeze([...this.#diagnosticCodes].sort()),
      ...(this.#lastReport === undefined ? {} : { lastIngestionReport: this.#lastReport }),
    });
  }

  async stop(): Promise<boolean> {
    if (!this.#started) return false;
    this.#started = false;
    this.#generation += 1;
    this.#scanTimer?.cancel();
    this.#pollTimer?.cancel();
    this.#scanTimer = undefined;
    this.#pollTimer = undefined;
    await Promise.all([this.#scanTail, this.#pollTail].filter((tail): tail is Promise<void> => tail !== undefined));
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.stop();
    this.#jobStore.close();
    this.#checkpointStore.close();
    this.#closed = true;
  }

  async #reconfigure(next: P1RuntimeConfiguration): Promise<void> {
    const wasStarted = this.#started;
    await this.stop();
    let candidateStore: SqliteDurableJobStore | undefined;
    let candidateIngestion: AutomaticIngestionService;
    let candidateWorker: DurableJobWorker;
    try {
      candidateStore = this.#createJobStore(next);
      candidateIngestion = this.#createIngestion(next);
      candidateWorker = this.#createWorker(candidateStore, candidateIngestion);
    } catch (error) {
      candidateStore?.close();
      if (wasStarted) {
        this.#started = true;
        this.#generation += 1;
        this.#scheduleScan(this.#configuration.sessionScanIntervalMs, this.#generation);
        this.#schedulePoll(this.#configuration.workerPollIntervalMs, this.#generation);
      }
      throw error;
    }
    const previousStore = this.#jobStore;
    this.#jobStore = candidateStore;
    this.#ingestion = candidateIngestion;
    this.#worker = candidateWorker;
    this.#configuration = next;
    previousStore.close();
    if (wasStarted) {
      this.#started = true;
      this.#generation += 1;
      this.#scheduleScan(next.sessionScanIntervalMs, this.#generation);
      this.#schedulePoll(next.workerPollIntervalMs, this.#generation);
    }
  }

  async #recoverJobProjection(): Promise<void> {
    let after: JobListCursor | undefined;
    let projectionFailed = false;
    try {
      for (let pageNumber = 0; pageNumber < MAX_JOB_RECOVERY_PAGES; pageNumber += 1) {
        const page = this.#jobStore.list({ limit: JOB_RECOVERY_PAGE_SIZE, ...(after === undefined ? {} : { after }) });
        for (const snapshot of page.items) {
          if (!(await this.#project(snapshot))) projectionFailed = true;
        }
        if (page.next === undefined) {
          this.#projectionRecovery = projectionFailed ? "FAILED" : "COMPLETE";
          if (projectionFailed) this.#diagnosticCodes.add("JOB_PROJECTION_RECOVERY_FAILED");
          return;
        }
        after = page.next;
      }
      this.#projectionRecovery = "BOUNDED";
      this.#diagnosticCodes.add("JOB_PROJECTION_RECOVERY_BOUNDED");
    } catch {
      this.#projectionRecovery = "FAILED";
      this.#diagnosticCodes.add("JOB_PROJECTION_RECOVERY_FAILED");
    }
  }

  async #project(snapshot: JobSnapshot): Promise<boolean> {
    try {
      await this.#dependencies.projectJob(snapshot);
      this.#projectedJobs += 1;
      return true;
    } catch {
      this.#diagnosticCodes.add("JOB_PROJECTION_FAILED");
      return false;
    }
  }

  #scheduleScan(delayMs: number, generation: number): void {
    this.#scanTimer = this.#timer.schedule(delayMs, () => {
      this.#scanTimer = undefined;
      if (!this.#started || generation !== this.#generation || this.#scanTail !== undefined) return;
      const tail = this.triggerAutomaticScan().then(() => undefined, () => {
        this.#diagnosticCodes.add("AUTOMATIC_SCAN_SCHEDULE_FAILED");
      });
      this.#scanTail = tail;
      void tail.finally(() => {
        if (this.#scanTail === tail) this.#scanTail = undefined;
        if (this.#started && generation === this.#generation) this.#scheduleScan(this.#configuration.sessionScanIntervalMs, generation);
      });
    });
  }

  #schedulePoll(delayMs: number, generation: number): void {
    this.#pollTimer = this.#timer.schedule(delayMs, () => {
      this.#pollTimer = undefined;
      if (!this.#started || generation !== this.#generation || this.#pollTail !== undefined) return;
      const tail = this.runJobWorkersOnce().then(() => undefined, () => {
        this.#diagnosticCodes.add("JOB_POLL_FAILED");
      });
      this.#pollTail = tail;
      void tail.finally(() => {
        if (this.#pollTail === tail) this.#pollTail = undefined;
        if (this.#started && generation === this.#generation) this.#schedulePoll(this.#configuration.workerPollIntervalMs, generation);
      });
    });
  }

  #now(): Date {
    const value = this.#dependencies.now?.() ?? new Date();
    if (!Number.isFinite(value.getTime())) throw new Error("P1 runtime clock returned an invalid date");
    return value;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("P1 Sidecar runtime is closed");
  }
}
