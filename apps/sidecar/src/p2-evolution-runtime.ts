import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { EvolutionJobRuntime, type EvolutionJobCapability, type EvolutionJobProjection } from "@zhiloop/evolution-job-runtime";
import { GitKnowledgeChangeSource, KnowledgeChangeIntake, type KnowledgeChangeIntakeState } from "@zhiloop/knowledge-change-intake";
import { createKnowledgeCompileHandler, createKnowledgeRepairDraftHandler, createKnowledgeRevalidateHandler } from "@zhiloop/knowledge-evolution-jobs";
import type { FreshnessCompensationPort, LiveKnowledgeRevisionReadPort, SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import type { FreshnessSchedulerConfiguration } from "@zhiloop/knowledge-freshness";
import { SqliteKnowledgeRepairDraftStore, type KnowledgeRepairDraft, type RepairDraftListRequest,
  type RepairDraftPage } from "@zhiloop/knowledge-repair-drafts";

import { P2DurableKnowledgeCompilationPort } from "./p2-evolution-jobs.js";
import { ProductionFreshnessVerifier } from "./p2-freshness-runtime.js";
import type { P2CandidatePreviewPort } from "./p2-preview-coordinator.js";
import type { P2ProductionComposition } from "./p2-production.js";
import type { P2SidecarRuntime } from "./p2-runtime.js";

const MAX_WORK_PER_CYCLE = 100;

export interface P2EvolutionRuntimeConfiguration {
  readonly enabled: boolean;
  readonly workerPollIntervalMs: number;
  readonly changeDebounceMs: number;
  readonly fallbackScanIntervalMs: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly maxAttempts: number;
  readonly revalidationPageSize: number;
  readonly maxAffectedPerJob: number;
  readonly freshnessGateDeadlineMs: number;
  readonly freshnessGateMaxItems: number;
  readonly freshnessGateMaxTargetedItems: number;
  readonly freshnessGateMinimumRemainingMs: number;
}

export interface P2EvolutionRuntimeState {
  readonly status: "DISABLED" | "STOPPED" | "READY" | "DEGRADED";
  readonly intake: KnowledgeChangeIntakeState;
  readonly capabilities: readonly EvolutionJobCapability[];
  readonly activeJobs: number;
  readonly completedWorkerCycles: number;
  readonly failedWorkerCycles: number;
  readonly lastReasonCode?: string;
}

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`P2_EVOLUTION_${name}_INVALID`);
  return value;
}

export function normalizeP2EvolutionRuntimeConfiguration(
  value: Partial<P2EvolutionRuntimeConfiguration> = {},
): P2EvolutionRuntimeConfiguration {
  const normalized = Object.freeze({
    enabled: value.enabled ?? true,
    workerPollIntervalMs: integer(value.workerPollIntervalMs ?? 1_000, 100, 60_000, "WORKER_POLL_INTERVAL_MS"),
    changeDebounceMs: integer(value.changeDebounceMs ?? 500, 0, 60_000, "CHANGE_DEBOUNCE_MS"),
    fallbackScanIntervalMs: integer(value.fallbackScanIntervalMs ?? 60_000, 100, 86_400_000, "FALLBACK_SCAN_INTERVAL_MS"),
    leaseMs: integer(value.leaseMs ?? 30_000, 10, 3_600_000, "LEASE_MS"),
    heartbeatMs: integer(value.heartbeatMs ?? 5_000, 10, 3_599_999, "HEARTBEAT_MS"),
    maxAttempts: integer(value.maxAttempts ?? 5, 1, 1_000, "MAX_ATTEMPTS"),
    revalidationPageSize: integer(value.revalidationPageSize ?? 100, 1, 1_000, "REVALIDATION_PAGE_SIZE"),
    maxAffectedPerJob: integer(value.maxAffectedPerJob ?? 10_000, 1, 100_000, "MAX_AFFECTED_PER_JOB"),
    freshnessGateDeadlineMs: integer(value.freshnessGateDeadlineMs ?? 150, 1, 200, "FRESHNESS_GATE_DEADLINE_MS"),
    freshnessGateMaxItems: integer(value.freshnessGateMaxItems ?? 100, 1, 1_000, "FRESHNESS_GATE_MAX_ITEMS"),
    freshnessGateMaxTargetedItems: integer(value.freshnessGateMaxTargetedItems ?? 0, 0, 20, "FRESHNESS_GATE_MAX_TARGETED_ITEMS"),
    freshnessGateMinimumRemainingMs: integer(value.freshnessGateMinimumRemainingMs ?? 20, 1, 200,
      "FRESHNESS_GATE_MINIMUM_REMAINING_MS"),
  });
  if (typeof normalized.enabled !== "boolean") throw new Error("P2_EVOLUTION_ENABLED_INVALID");
  if (normalized.heartbeatMs >= normalized.leaseMs) throw new Error("P2_EVOLUTION_HEARTBEAT_MUST_BE_BELOW_LEASE");
  if (normalized.fallbackScanIntervalMs < normalized.changeDebounceMs) {
    throw new Error("P2_EVOLUTION_FALLBACK_MUST_NOT_PRECEDE_DEBOUNCE");
  }
  if (normalized.freshnessGateMinimumRemainingMs > normalized.freshnessGateDeadlineMs) {
    throw new Error("P2_EVOLUTION_GATE_MINIMUM_MUST_NOT_EXCEED_DEADLINE");
  }
  return normalized;
}

function timer(delayMs: number, task: () => void): ReturnType<typeof setTimeout> {
  const handle = setTimeout(task, delayMs);
  handle.unref?.();
  return handle;
}

/** Owns all background code-knowledge evolution resources and their deterministic shutdown order. */
export class P2EvolutionRuntime implements LiveKnowledgeRevisionReadPort, FreshnessCompensationPort {
  readonly #source: GitKnowledgeChangeSource;
  readonly #jobs: EvolutionJobRuntime;
  readonly #verifier: ProductionFreshnessVerifier;
  readonly #repairDrafts: SqliteKnowledgeRepairDraftStore;
  readonly #roots = new Map<string, string>();
  readonly #stateDirectory: string;
  #configuration: P2EvolutionRuntimeConfiguration;
  #intake: KnowledgeChangeIntake;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #workerTail: Promise<void> | undefined;
  #workerAbort: AbortController | undefined;
  #started = false;
  #closed = false;
  #generation = 0;
  #completedWorkerCycles = 0;
  #failedWorkerCycles = 0;
  #lastReasonCode: string | undefined;

  constructor(options: {
    readonly stateDirectory: string;
    readonly freshnessStore: SqliteKnowledgeFreshnessStore;
    readonly production: Pick<P2ProductionComposition, "verification" | "verificationStore">;
    readonly preview: P2CandidatePreviewPort;
    readonly p2Runtime: P2SidecarRuntime;
    readonly configuration?: Partial<P2EvolutionRuntimeConfiguration>;
    readonly onJob?: (job: EvolutionJobProjection) => void;
  }) {
    this.#stateDirectory = options.stateDirectory;
    this.#configuration = normalizeP2EvolutionRuntimeConfiguration(options.configuration);
    // Reuse the legacy filename so its acknowledged baseline is migrated in place instead of silently reset.
    this.#source = new GitKnowledgeChangeSource(join(options.stateDirectory, "git-freshness-baseline.sqlite"));
    try { this.#repairDrafts = new SqliteKnowledgeRepairDraftStore(join(options.stateDirectory, "knowledge-repair-drafts.sqlite")); }
    catch (error) { this.#source.close(); throw error; }
    this.#verifier = new ProductionFreshnessVerifier(options.production.verification, (revision) => {
      if (revision.graphRevision !== undefined) {
        try { this.#intake.updateGraphRevision(revision.projectId, revision.codeRevision, revision.graphRevision); }
        catch { /* A newer Git revision correctly invalidates a late graph result. */ }
      }
    });
    for (const project of this.#source.observedProjects()) {
      this.#roots.set(project.projectId, project.repositoryRoot);
      this.#verifier.observe(project.projectId, project.repositoryRoot);
    }
    try {
      this.#jobs = new EvolutionJobRuntime(join(options.stateDirectory, "evolution-jobs.sqlite"), {
        workerId: `sidecar-${process.pid}-${randomUUID()}`,
        leaseMs: this.#configuration.leaseMs,
        heartbeatMs: this.#configuration.heartbeatMs,
        handlers: {
          KNOWLEDGE_REVALIDATE: async (context) => await createKnowledgeRevalidateHandler({ source: this.#source,
            store: options.freshnessStore, verifier: this.#verifier, pageSize: this.#configuration.revalidationPageSize,
            maxTargets: this.#configuration.maxAffectedPerJob,
            repairJobs: { enqueue: (input) => this.enqueue(input, this.#configuration.maxAttempts) } })(context),
          KNOWLEDGE_COMPILE: createKnowledgeCompileHandler(new P2DurableKnowledgeCompilationPort(options.preview, options.p2Runtime)),
          KNOWLEDGE_REPAIR_DRAFT: createKnowledgeRepairDraftHandler({ freshness: options.freshnessStore,
            verification: options.production.verificationStore, drafts: this.#repairDrafts }),
        },
      });
    } catch (error) {
      this.#repairDrafts.close();
      this.#source.close();
      throw error;
    }
    this.#onJob = options.onJob;
    try { this.#intake = this.#createIntake(this.#configuration); }
    catch (error) {
      this.#jobs.close();
      this.#repairDrafts.close();
      this.#source.close();
      throw error;
    }
  }

  readonly #onJob: ((job: EvolutionJobProjection) => void) | undefined;

  enqueue(...parameters: Parameters<EvolutionJobRuntime["enqueue"]>): ReturnType<EvolutionJobRuntime["enqueue"]> {
    const result = this.#jobs.enqueue(...parameters);
    this.#project(result.job.snapshot.jobId);
    return result;
  }

  getJob(jobId: string): EvolutionJobProjection | undefined { return this.#jobs.get(jobId); }
  cancel(...parameters: Parameters<EvolutionJobRuntime["cancel"]>): ReturnType<EvolutionJobRuntime["cancel"]> {
    const result = this.#jobs.cancel(...parameters);
    this.#project(parameters[0].jobId);
    return result;
  }
  retry(...parameters: Parameters<EvolutionJobRuntime["retry"]>): ReturnType<EvolutionJobRuntime["retry"]> {
    const result = this.#jobs.retry(...parameters);
    this.#project(parameters[0].jobId);
    return result;
  }

  jobs(): Pick<EvolutionJobRuntime, "enqueue" | "get" | "list" | "attempts" | "cancel" | "retry" | "capabilities"> {
    this.#assertOpen();
    return this.#jobs;
  }

  observeProject(projectId: string, projectRoot: string): void {
    this.#assertOpen();
    this.#roots.set(projectId, projectRoot);
    this.#verifier.observe(projectId, projectRoot);
    this.#intake.observeProject(projectId, projectRoot);
  }

  read(projectId: string) { this.#assertOpen(); return this.#intake.read(projectId); }

  schedule(request: Parameters<FreshnessCompensationPort["schedule"]>[0]): string {
    this.#assertOpen();
    const repositoryRoot = this.#roots.get(request.projectId);
    const identity = createHash("sha256").update(JSON.stringify([request.projectId, request.assetId, request.assetVersion,
      request.reasonCode, request.requiredCodeRevision ?? null, request.requiredGraphRevision ?? null])).digest("hex");
    if (repositoryRoot !== undefined && this.#configuration.enabled) {
      this.#intake.notify({ projectId: request.projectId, repositoryRoot, source: "PRE_INJECTION", observedAt: new Date().toISOString() });
      const existing = this.#intake.enqueuePending(request.projectId).at(-1);
      if (existing !== undefined) return existing;
    }
    return `evolution-compensation-${identity}`;
  }

  async start(): Promise<boolean> {
    this.#assertOpen();
    if (this.#started) return false;
    this.#started = true;
    this.#generation += 1;
    for (const job of this.#jobs.list({ limit: 1_000 }).items) this.#onJob?.(job);
    if (this.#configuration.enabled) {
      await this.#intake.start();
      await this.#runWorkerCycle();
      this.#schedulePoll();
    }
    return true;
  }

  async trigger(): Promise<void> {
    this.#assertOpen();
    if (!this.#configuration.enabled) return;
    await this.#intake.flush();
    await this.#runWorkerCycle();
  }

  state(): P2EvolutionRuntimeState {
    this.#assertOpen();
    const activeJobs = this.#jobs.list({ limit: 1_000, statuses: ["QUEUED", "RUNNING", "RETRY_WAIT"] }).items.length;
    const intake = this.#intake.state();
    const status = !this.#configuration.enabled ? "DISABLED" : !this.#started ? "STOPPED"
      : this.#lastReasonCode === undefined && intake.status !== "DEGRADED" ? "READY" : "DEGRADED";
    return Object.freeze({ status, intake, capabilities: this.#jobs.capabilities(), activeJobs,
      completedWorkerCycles: this.#completedWorkerCycles, failedWorkerCycles: this.#failedWorkerCycles,
      ...(this.#lastReasonCode === undefined ? {} : { lastReasonCode: this.#lastReasonCode }) });
  }

  listJobs(limit = 100): readonly EvolutionJobProjection[] { return this.#jobs.list({ limit }).items; }
  getRepairDraft(draftId: string): KnowledgeRepairDraft | undefined { this.#assertOpen(); return this.#repairDrafts.get(draftId); }
  listRepairDrafts(request: RepairDraftListRequest): RepairDraftPage { this.#assertOpen(); return this.#repairDrafts.list(request); }

  async applyConfiguration(configuration: FreshnessSchedulerConfiguration): Promise<() => Promise<void>> {
    this.#assertOpen();
    const next = normalizeP2EvolutionRuntimeConfiguration({ ...this.#configuration, enabled: configuration.enabled,
      changeDebounceMs: configuration.changeDebounceMs, fallbackScanIntervalMs: configuration.fallbackScanIntervalMs,
      maxAffectedPerJob: configuration.maxAffectedPerJob });
    const previous = this.#configuration;
    await this.#replaceIntake(next);
    let rolledBack = false;
    return async () => {
      if (rolledBack || this.#closed) return;
      rolledBack = true;
      await this.#replaceIntake(previous);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#started = false;
    this.#generation += 1;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#workerAbort?.abort(new Error("P2_EVOLUTION_RUNTIME_STOPPED"));
    let failure: unknown;
    try { await this.#intake.stop(); } catch (error) { failure = error; }
    await this.#workerTail?.catch(() => undefined);
    for (const close of [() => this.#intake.close(), () => this.#jobs.close(), () => this.#repairDrafts.close(), () => this.#source.close()]) {
      try { close(); } catch (error) { failure ??= error; }
    }
    this.#closed = true;
    if (failure !== undefined) throw failure;
  }

  #createIntake(configuration: P2EvolutionRuntimeConfiguration): KnowledgeChangeIntake {
    return new KnowledgeChangeIntake(join(this.#stateDirectory, "knowledge-change-intake.sqlite"), {
      source: this.#source, jobs: { enqueue: (...parameters) => this.enqueue(...parameters) }, debounceMs: configuration.changeDebounceMs,
      fallbackIntervalMs: configuration.fallbackScanIntervalMs, maxAttempts: configuration.maxAttempts,
    });
  }

  async #replaceIntake(next: P2EvolutionRuntimeConfiguration): Promise<void> {
    const wasStarted = this.#started;
    // Constructing the candidate proves schema, bounds and database availability before the live instance is stopped.
    const candidate = this.#createIntake(next);
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    try { await this.#intake.stop(); }
    catch (error) { candidate.close(); throw error; }
    const previous = this.#intake;
    previous.close();
    this.#configuration = next;
    this.#intake = candidate;
    if (wasStarted && next.enabled) {
      await this.#intake.start();
      this.#schedulePoll();
    }
  }

  #schedulePoll(): void {
    if (!this.#started || !this.#configuration.enabled || this.#closed) return;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    const generation = this.#generation;
    this.#pollTimer = timer(this.#configuration.workerPollIntervalMs, () => {
      this.#pollTimer = undefined;
      if (!this.#started || this.#closed || generation !== this.#generation) return;
      void this.#runWorkerCycle().finally(() => {
        if (this.#started && !this.#closed && generation === this.#generation) this.#schedulePoll();
      });
    });
  }

  async #runWorkerCycle(): Promise<void> {
    if (this.#workerTail !== undefined) return await this.#workerTail;
    const controller = new AbortController();
    this.#workerAbort = controller;
    const tail = (async () => {
      try {
        for (let count = 0; count < MAX_WORK_PER_CYCLE && !controller.signal.aborted; count += 1) {
          const result = await this.#jobs.runOnce(controller.signal);
          if (result.status === "IDLE") break;
          const jobId = "job" in result ? result.job.snapshot.jobId : result.jobId;
          this.#project(jobId);
        }
        this.#completedWorkerCycles += 1;
        this.#lastReasonCode = undefined;
      } catch (error) {
        this.#failedWorkerCycles += 1;
        this.#lastReasonCode = error instanceof Error ? error.message.slice(0, 200) : "P2_EVOLUTION_WORKER_FAILED";
      }
    })();
    this.#workerTail = tail;
    try { await tail; }
    finally {
      if (this.#workerTail === tail) this.#workerTail = undefined;
      if (this.#workerAbort === controller) this.#workerAbort = undefined;
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error("P2_EVOLUTION_RUNTIME_CLOSED"); }
  #project(jobId: string): void {
    const value = this.#jobs.get(jobId);
    if (value !== undefined) this.#onJob?.(value);
  }
}
