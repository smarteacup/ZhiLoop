import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { EvolutionJobRuntime, parseEvolutionJobInput, type CodeGraphInitializeJobInput, type EvolutionJobCapability,
  type EvolutionJobProjection, type LegacyKnowledgeMigrationJobInput } from "@zhiloop/evolution-job-runtime";
import type { CodeGraphProcessPort } from "@zhiloop/codegraph-adapter";
import type { KnowledgeCandidate } from "@zhiloop/domain";
import { GitKnowledgeChangeSource, KnowledgeChangeIntake, type KnowledgeChangeIntakeState } from "@zhiloop/knowledge-change-intake";
import { createKnowledgeCompileHandler, createKnowledgeRepairDraftHandler, createKnowledgeRevalidateHandler,
  createLegacyKnowledgeMigrationHandler } from "@zhiloop/knowledge-evolution-jobs";
import type { FreshnessCompensationPort, LiveKnowledgeRevisionReadPort, SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import type { FreshnessSchedulerConfiguration } from "@zhiloop/knowledge-freshness";
import { SqliteKnowledgeRepairDraftStore, type KnowledgeRepairDraft, type RepairDraftListRequest,
  type RepairDraftPage } from "@zhiloop/knowledge-repair-drafts";
import { LegacyKnowledgeMigrationRollbackService, LegacyKnowledgeMigrationService,
  SqliteLegacyKnowledgeMigrationStore, type LegacyMigrationPage, type LegacyMigrationPreview } from
  "@zhiloop/knowledge-legacy-migration";
import { SqliteOperationalAlertStore, type AlertOperatorCommand, type OperationalAlertInput,
  type OperationalAlertPage } from "@zhiloop/operational-alerts";
import type { EvolutionOperationsSnapshot, JobSnapshot, KnowledgeEvolutionView, KnowledgeRepairDraftView,
  KnowledgeRepairSubmissionResult, KnowledgeRevalidationCommandResult, OperationalAlertConsolePage } from "@zhiloop/control-api";

import { P2DurableKnowledgeCompilationPort } from "./p2-evolution-jobs.js";
import { ProductionFreshnessVerifier } from "./p2-freshness-runtime.js";
import type { P2CandidatePreviewPort } from "./p2-preview-coordinator.js";
import type { P2ProductionComposition } from "./p2-production.js";
import type { P2SidecarRuntime } from "./p2-runtime.js";
import { CodeGraphLifecycleService, codeGraphCommitFingerprint } from "./p2-codegraph-lifecycle.js";
import { EvolutionCommandReceiptStore } from "./p2-evolution-command-store.js";

const MAX_WORK_PER_CYCLE = 100;

function consoleJob(job: EvolutionJobProjection): JobSnapshot {
  const observedAt = job.updatedAt ?? job.createdAt ?? new Date().toISOString();
  const terminal = job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "CANCELLED";
  return Object.freeze({ schemaVersion: 1, jobId: job.jobId, jobType: job.jobType, revision: job.revision,
    status: job.status, attempt: job.attempt, maxAttempts: job.maxAttempts, progress: job.progress,
    ...(job.createdAt === undefined ? {} : { createdAt: job.createdAt }),
    ...(job.updatedAt === undefined ? {} : { updatedAt: job.updatedAt }),
    ...(terminal ? { completedAt: observedAt } : {}),
    ...(job.nextAttemptAt === undefined ? {} : { nextAttemptAt: job.nextAttemptAt }),
    ...(job.lastFailure === undefined ? {} : { lastFailure: job.lastFailure }),
    reasonCode: job.status === "QUEUED" ? "JOB_QUEUED" : job.status === "RUNNING" ? "JOB_RUNNING"
      : job.status === "RETRY_WAIT" ? "JOB_RETRY_WAIT" : job.status === "SUCCEEDED" ? "JOB_SUCCEEDED"
        : job.status === "CANCELLED" ? "JOB_CANCELLED" : "JOB_FAILED",
    observedAt, lastTransitionAt: observedAt, retryable: job.status === "RETRY_WAIT",
    evidenceRefs: [`evolution:${job.jobType.toLowerCase()}`] });
}

function repairDraftView(draft: KnowledgeRepairDraft): KnowledgeRepairDraftView {
  return Object.freeze({ draftId: draft.draftId, projectId: draft.projectId,
    assetId: draft.sourceKnowledge.assetId, assetVersion: draft.sourceKnowledge.assetVersion,
    conflictRunId: draft.conflict.runId, status: draft.status, revision: draft.revision,
    changedAssertions: draft.changedAssertions.slice(0, 100).map((item) => Object.freeze({
      assertionId: item.assertionId, assertionKind: item.assertionKind, reasonCodes: [...item.reasonCodes].slice(0, 16),
    })), reasonCodes: [...draft.reasonCodes].slice(0, 100),
    ...(draft.proposedCandidate === undefined ? {} : { proposedCandidate: {
      candidateId: draft.proposedCandidate.candidateId, title: draft.proposedCandidate.title,
      summary: draft.proposedCandidate.summary, body: draft.proposedCandidate.body.slice(0, 64_000),
    } }), createdAt: draft.createdAt, updatedAt: draft.updatedAt });
}

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

export interface P2EvolutionAlertConfiguration {
  readonly enabled: boolean;
  readonly onPermanentJobFailure: boolean;
  readonly onCodeGraphUnavailable: boolean;
  readonly onStaleKnowledgeDetected: boolean;
}

const DISABLED_ALERTS: P2EvolutionAlertConfiguration = Object.freeze({
  enabled: false, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false,
});

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
  readonly #migrations: SqliteLegacyKnowledgeMigrationStore;
  readonly #migrationService: LegacyKnowledgeMigrationService;
  readonly #migrationRollback: LegacyKnowledgeMigrationRollbackService;
  readonly #alerts: SqliteOperationalAlertStore;
  readonly #codeGraph: CodeGraphLifecycleService;
  readonly #commands: EvolutionCommandReceiptStore;
  readonly #production: Pick<P2ProductionComposition, "verificationStore" | "registry">;
  readonly #freshness: SqliteKnowledgeFreshnessStore;
  readonly #alertConfiguration: P2EvolutionAlertConfiguration;
  readonly #roots = new Map<string, string>();
  readonly #stateDirectory: string;
  readonly #commandFlights = new Map<string, { readonly fingerprint: string; readonly promise: Promise<unknown> }>();
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
    readonly production: Pick<P2ProductionComposition, "verification" | "verificationStore" | "registry">;
    readonly preview: P2CandidatePreviewPort;
    readonly p2Runtime: P2SidecarRuntime;
    readonly configuration?: Partial<P2EvolutionRuntimeConfiguration>;
    readonly alertConfiguration?: Partial<P2EvolutionAlertConfiguration>;
    /** Injectable only at the process boundary; production keeps the fixed, shell-free CodeGraph adapter. */
    readonly codeGraphProcess?: CodeGraphProcessPort;
    readonly codeGraphExecutable?: string;
    readonly onJob?: (job: EvolutionJobProjection) => void;
  }) {
    this.#production = options.production;
    this.#freshness = options.freshnessStore;
    this.#stateDirectory = options.stateDirectory;
    this.#configuration = normalizeP2EvolutionRuntimeConfiguration(options.configuration);
    this.#alertConfiguration = Object.freeze({ ...DISABLED_ALERTS, ...options.alertConfiguration });
    if (Object.values(this.#alertConfiguration).some((value) => typeof value !== "boolean")) {
      throw new Error("P2_EVOLUTION_ALERT_CONFIGURATION_INVALID");
    }
    // Reuse the legacy filename so its acknowledged baseline is migrated in place instead of silently reset.
    this.#source = new GitKnowledgeChangeSource(join(options.stateDirectory, "git-freshness-baseline.sqlite"));
    try { this.#repairDrafts = new SqliteKnowledgeRepairDraftStore(join(options.stateDirectory, "knowledge-repair-drafts.sqlite")); }
    catch (error) { this.#source.close(); throw error; }
    try { this.#alerts = new SqliteOperationalAlertStore(join(options.stateDirectory, "operational-alerts.sqlite")); }
    catch (error) { this.#repairDrafts.close(); this.#source.close(); throw error; }
    try { this.#migrations = new SqliteLegacyKnowledgeMigrationStore(join(options.stateDirectory, "legacy-knowledge-migrations.sqlite")); }
    catch (error) { this.#alerts.close(); this.#repairDrafts.close(); this.#source.close(); throw error; }
    try { this.#codeGraph = new CodeGraphLifecycleService({ databasePath: join(options.stateDirectory, "codegraph-lifecycle.sqlite"),
      projectRoot: (projectId) => this.#roots.get(projectId),
      ...(options.codeGraphProcess === undefined ? {} : { process: options.codeGraphProcess }),
      ...(options.codeGraphExecutable === undefined ? {} : { executable: options.codeGraphExecutable }) }); }
    catch (error) { this.#migrations.close(); this.#alerts.close(); this.#repairDrafts.close(); this.#source.close(); throw error; }
    try { this.#commands = new EvolutionCommandReceiptStore(join(options.stateDirectory, "evolution-command-receipts.sqlite")); }
    catch (error) { this.#codeGraph.close(); this.#migrations.close(); this.#alerts.close(); this.#repairDrafts.close(); this.#source.close(); throw error; }
    this.#migrationService = new LegacyKnowledgeMigrationService({ registry: options.production.registry,
      recipes: options.production.verificationStore, freshness: options.freshnessStore, store: this.#migrations });
    this.#migrationRollback = new LegacyKnowledgeMigrationRollbackService({ store: this.#migrations,
      recipes: options.production.verificationStore, freshness: options.freshnessStore });
    this.#verifier = new ProductionFreshnessVerifier(options.production.verification, (revision) => {
      if (revision.graphRevision !== undefined) {
        try { this.#intake.updateGraphRevision(revision.projectId, revision.codeRevision, revision.graphRevision); }
        catch { /* A newer Git revision correctly invalidates a late graph result. */ }
      }
    }, (unavailable) => {
      if (!this.#alertConfiguration.enabled || !this.#alertConfiguration.onCodeGraphUnavailable) return;
      void this.#emitAlert({ eventId: `codegraph:${unavailable.runId}`, observedAt: unavailable.observedAt,
        dedupKey: `codegraph:${unavailable.projectId}`, severity: "WARNING", type: "CODEGRAPH_UNAVAILABLE",
        projectId: unavailable.projectId, entityRef: unavailable.runId, reasonCodes: unavailable.reasonCodes });
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
            onConflict: (conflict) => {
              if (!this.#alertConfiguration.enabled || !this.#alertConfiguration.onStaleKnowledgeDetected) return;
              void this.#emitAlert({ eventId: `stale:${conflict.verificationRunId}:${conflict.assetId}@${conflict.assetVersion}`,
                observedAt: conflict.observedAt, dedupKey: `stale:${conflict.projectId}:${conflict.assetId}@${conflict.assetVersion}`,
                severity: "WARNING", type: "STALE_KNOWLEDGE", projectId: conflict.projectId,
                entityRef: `${conflict.assetId}@${conflict.assetVersion}`,
                reasonCodes: ["FRESHNESS_CONFLICT", ...conflict.reasonCodes] });
            },
            repairJobs: { enqueue: (input) => this.enqueue(input, this.#configuration.maxAttempts) } })(context),
          KNOWLEDGE_COMPILE: createKnowledgeCompileHandler(new P2DurableKnowledgeCompilationPort(options.preview, options.p2Runtime)),
          KNOWLEDGE_REPAIR_DRAFT: createKnowledgeRepairDraftHandler({ freshness: options.freshnessStore,
            verification: options.production.verificationStore, drafts: this.#repairDrafts }),
          CODEGRAPH_INITIALIZE: this.#codeGraph.handler(),
          LEGACY_KNOWLEDGE_MIGRATION: createLegacyKnowledgeMigrationHandler({ store: this.#migrations,
            service: this.#migrationService, registryRevision: () => options.production.registry.activeIndexVersion,
            recipes: options.production.verificationStore, freshness: options.freshnessStore,
            verifier: options.production.verification,
            project: (projectId) => { const repositoryRoot = this.#roots.get(projectId);
              return repositoryRoot === undefined ? undefined : { projectId, repositoryRoot, portable: false }; },
            pageSize: this.#configuration.revalidationPageSize }),
        },
      });
    } catch (error) {
      this.#commands.close();
      this.#codeGraph.close();
      this.#alerts.close();
      this.#migrations.close();
      this.#repairDrafts.close();
      this.#source.close();
      throw error;
    }
    this.#onJob = options.onJob;
    try { this.#intake = this.#createIntake(this.#configuration); }
    catch (error) {
      this.#jobs.close();
      this.#commands.close();
      this.#codeGraph.close();
      this.#alerts.close();
      this.#migrations.close();
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

  observedProjects(): readonly { readonly projectId: string; readonly repositoryRoot: string }[] {
    this.#assertOpen();
    return Object.freeze([...this.#roots].sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([projectId, repositoryRoot]) => Object.freeze({ projectId, repositoryRoot })));
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
    if (this.#configuration.enabled) await this.#intake.start();
    await this.#runWorkerCycle();
    this.#schedulePoll();
    return true;
  }

  async trigger(): Promise<void> {
    this.#assertOpen();
    if (this.#configuration.enabled) await this.#intake.flush();
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
  listOperationalAlerts(request: Parameters<SqliteOperationalAlertStore["list"]>[0]): OperationalAlertPage {
    this.#assertOpen(); return this.#alerts.list(request);
  }

  knowledgeEvolution(knowledgeId: string): KnowledgeEvolutionView {
    this.#assertOpen();
    const projected = this.#production.registry.getAsset(knowledgeId, true);
    if (projected === undefined) throw new Error("KNOWLEDGE_EVOLUTION_NOT_FOUND");
    const asset = projected.asset; const projectId = "projectId" in asset.scope ? asset.scope.projectId : undefined;
    const freshness = this.#freshness.getState(asset.id, asset.version);
    const recipe = this.#production.verificationStore.getRecipe(asset.id, asset.version, "evidence-recipe-v1");
    const runs = this.#production.verificationStore.listRuns(asset.id, asset.version, 20);
    const drafts = this.#repairDrafts.list({ assetId: asset.id, assetVersion: asset.version, limit: 20 }).items;
    const jobs = this.#jobs.list({ limit: 1_000 }).items.filter((job) =>
      (job.jobType === "KNOWLEDGE_REPAIR_DRAFT" && job.entityRef === `${asset.id}@${asset.version}`)
      || (job.jobType === "KNOWLEDGE_REVALIDATE" && projectId !== undefined && job.projectId === projectId)).slice(0, 20);
    const enabled = this.#configuration.enabled && projectId !== undefined && this.#roots.has(projectId) && recipe !== undefined;
    const revision = Math.max(projected.indexVersion, freshness?.revision ?? 0,
      ...drafts.map((draft) => draft.revision), ...jobs.map((job) => job.revision), 0);
    return Object.freeze({ schemaVersion: 1, revision, knowledgeId: asset.id, knowledgeVersion: asset.version,
      ...(projectId === undefined ? {} : { projectId }), freshnessRevision: freshness?.revision ?? 0,
      ...(recipe === undefined ? {} : { recipe: { recipeVersion: recipe.recipeVersion,
        assertionsHash: recipe.assertionsHash, assertionCount: recipe.assertions.length, createdAt: recipe.createdAt } }),
      verificationRuns: runs.map((run) => Object.freeze({ runId: run.runId, purpose: run.purpose,
        projectId: run.projectId, codeRevision: run.codeRevision,
        ...(run.graphRevision === undefined ? {} : { graphRevision: run.graphRevision }),
        qualifyingProof: run.qualifyingProof, status: run.status,
        results: run.results.slice(0, 100).map((result) => Object.freeze({ assertionId: result.assertionId,
          assertionKind: result.assertionKind, status: result.status, reasonCodes: [...result.reasonCodes].slice(0, 16),
          ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }) })), completedAt: run.completedAt })),
      repairDrafts: drafts.map(repairDraftView), jobs: jobs.map(consoleJob),
      revalidationAction: { enabled, expectedKnowledgeVersion: asset.version,
        expectedFreshnessRevision: freshness?.revision ?? 0,
        reasonCode: enabled ? "ACTION_READY" : projectId === undefined ? "PROJECT_SCOPE_REQUIRED"
          : recipe === undefined ? "VERIFICATION_RECIPE_MISSING" : "KNOWLEDGE_EVOLUTION_DISABLED" },
      observedAt: new Date().toISOString() });
  }

  async revalidateKnowledge(command: { readonly knowledgeId: string; readonly expectedKnowledgeVersion: number;
    readonly expectedFreshnessRevision: number; readonly idempotencyKey: string; readonly requestedAt: string }): Promise<KnowledgeRevalidationCommandResult> {
    const fingerprint = createHash("sha256").update(JSON.stringify({ knowledgeId: command.knowledgeId,
      expectedKnowledgeVersion: command.expectedKnowledgeVersion,
      expectedFreshnessRevision: command.expectedFreshnessRevision })).digest("hex");
    return await this.#idempotent(command.idempotencyKey, fingerprint, command.requestedAt, async () => {
      const view = this.knowledgeEvolution(command.knowledgeId);
      if (view.knowledgeVersion !== command.expectedKnowledgeVersion || view.freshnessRevision !== command.expectedFreshnessRevision) {
        throw new Error("KNOWLEDGE_REVALIDATION_REVISION_CONFLICT");
      }
      if (!view.revalidationAction.enabled || view.projectId === undefined) throw new Error(view.revalidationAction.reasonCode);
      const repositoryRoot = this.#roots.get(view.projectId); if (repositoryRoot === undefined) throw new Error("KNOWLEDGE_PROJECT_UNOBSERVED");
      this.#intake.notify({ projectId: view.projectId, repositoryRoot, source: "PRE_INJECTION", observedAt: command.requestedAt });
      const cycle = await this.#intake.flush();
      const job = cycle.enqueuedJobs + cycle.reusedJobs === 0 ? undefined : this.#jobs.list({ limit: 1_000 }).items
        .find((item) => item.jobType === "KNOWLEDGE_REVALIDATE" && item.projectId === view.projectId);
      void this.#runWorkerCycle();
      return Object.freeze({ knowledgeId: view.knowledgeId, knowledgeVersion: view.knowledgeVersion,
        disposition: job === undefined ? "NO_CHANGES" as const : "QUEUED" as const,
        reasonCode: job === undefined ? "CODE_REVISION_ALREADY_CURRENT" : "KNOWLEDGE_REVALIDATION_QUEUED",
        ...(job === undefined ? {} : { job: consoleJob(job) }), observedAt: command.requestedAt });
    });
  }

  async submitRepairCandidate(command: { readonly draftId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string; readonly title: string; readonly summary: string; readonly body: string;
    readonly requestedAt: string }): Promise<KnowledgeRepairSubmissionResult> {
    const fingerprint = createHash("sha256").update(JSON.stringify({ draftId: command.draftId,
      expectedRevision: command.expectedRevision, title: command.title, summary: command.summary, body: command.body })).digest("hex");
    return await this.#idempotent(command.idempotencyKey, fingerprint, command.requestedAt, async () => {
      const draft = this.#repairDrafts.get(command.draftId); if (draft === undefined) throw new Error("REPAIR_DRAFT_NOT_FOUND");
      if (draft.revision !== command.expectedRevision) throw new Error("REPAIR_DRAFT_REVISION_CONFLICT");
      const candidateId = `repair-candidate-${createHash("sha256").update(JSON.stringify([
        command.draftId, command.idempotencyKey, command.title, command.summary, command.body,
      ])).digest("hex")}`;
      const source = draft.sourceKnowledge.candidate;
      const candidate = { ...source, candidateId, title: command.title, summary: command.summary, body: command.body,
        status: "PROPOSED" as const, correlationId: `repair:${draft.draftId}:${draft.revision}`,
        createdAt: draft.updatedAt, assertions: source.assertions.map((assertion) => ({ ...assertion, candidateId })) } as KnowledgeCandidate;
      const result = this.#repairDrafts.attachCandidate({ draftId: draft.draftId, expectedRevision: command.expectedRevision,
        effectKey: `console-repair:${command.idempotencyKey}`, candidate, updatedAt: draft.updatedAt });
      return Object.freeze({ draft: repairDraftView(result.draft) });
    });
  }

  async #idempotent<T>(idempotencyKey: string, fingerprint: string, createdAt: string, operation: () => Promise<T>): Promise<T> {
    const stored = this.#commands.get<T>(idempotencyKey, fingerprint); if (stored !== undefined) return stored;
    const current = this.#commandFlights.get(idempotencyKey);
    if (current !== undefined) {
      if (current.fingerprint !== fingerprint) throw new Error("EVOLUTION_COMMAND_IDEMPOTENCY_CONFLICT");
      return await current.promise as T;
    }
    const promise = operation().then((result) => this.#commands.save(idempotencyKey, fingerprint, result, createdAt));
    this.#commandFlights.set(idempotencyKey, { fingerprint, promise });
    try { return await promise; } finally { if (this.#commandFlights.get(idempotencyKey)?.promise === promise) this.#commandFlights.delete(idempotencyKey); }
  }

  async listCodeGraphProjects(limit = 100) {
    this.#assertOpen();
    const projects = this.observedProjects().slice(0, limit);
    const items = projects.map(({ projectId }) => {
      const capability = this.#codeGraph.view(projectId);
      const latest = this.#jobs.list({ limit: 1_000 }).items.find((job) => job.jobType === "CODEGRAPH_INITIALIZE" && job.projectId === projectId);
      return Object.freeze({ ...capability, ...(latest === undefined ? {} : { latestJob: consoleJob(latest) }) });
    });
    const revision = items.reduce((maximum, item) => Math.max(maximum, item.revision, item.latestJob?.revision ?? 0), 0);
    return Object.freeze({ revision, items: Object.freeze(items), bounded: this.#roots.size > limit, observedAt: new Date().toISOString() });
  }

  async previewCodeGraphInitialization(projectId: string, requestedAt: string) {
    this.#assertOpen(); return await this.#codeGraph.preview(projectId, requestedAt);
  }

  commitCodeGraphInitialization(request: { readonly projectId: string; readonly previewId: string;
    readonly repositoryIdentity: string; readonly expectedRevision: number; readonly idempotencyKey: string;
    readonly requestedAt: string }) {
    this.#assertOpen();
    const fingerprint = codeGraphCommitFingerprint(request);
    const receiptJobId = this.#codeGraph.receipt(request.idempotencyKey, fingerprint);
    if (receiptJobId !== undefined) {
      const job = this.#jobs.get(receiptJobId); if (job === undefined) throw new Error("CODEGRAPH_INITIALIZATION_RECEIPT_JOB_MISSING");
      return Object.freeze({ preview: this.#codeGraph.getPreview(request.previewId), job });
    }
    const preview = this.#codeGraph.validateCommit(request);
    const repository = this.#codeGraph.repository(request.projectId);
    const input: CodeGraphInitializeJobInput = Object.freeze({ schemaVersion: 1, jobType: "CODEGRAPH_INITIALIZE",
      projectId: request.projectId, repositoryRoot: repository.root, repositoryIdentity: repository.repositoryIdentity,
      adapterVersion: preview.providerVersion ?? "unknown" });
    const enqueued = this.enqueue(input, this.#configuration.maxAttempts);
    const job = this.#jobs.get(enqueued.job.snapshot.jobId);
    if (job === undefined) throw new Error("CODEGRAPH_INITIALIZATION_JOB_MISSING");
    this.#codeGraph.saveReceipt(request.idempotencyKey, fingerprint, job.jobId, request.requestedAt);
    void this.#runWorkerCycle();
    return Object.freeze({ preview, job });
  }

  listOperationalAlertsForConsole(request: { readonly projectId?: string; readonly limit: number;
    readonly cursor?: string }): OperationalAlertConsolePage {
    this.#assertOpen();
    let after: { readonly lastObservedAt: string; readonly alertId: string } | undefined;
    if (request.cursor !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as { value: string; digest: string };
        if (createHash("sha256").update(`zhiloop-alert:${decoded.value}`).digest("hex") !== decoded.digest) throw new Error();
        const parsed = JSON.parse(decoded.value) as { lastObservedAt: string; alertId: string };
        after = parsed;
      } catch { throw new Error("OPERATIONAL_ALERT_CURSOR_INVALID"); }
    }
    const page = this.#alerts.list({ limit: request.limit, ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      ...(after === undefined ? {} : { after }) });
    const observedAt = new Date().toISOString();
    const items = page.items.map((alert) => {
      const operatorState = this.#alerts.getOperatorState(alert.alertId);
      return Object.freeze({ ...alert, alertRevision: alert.revision, revision: operatorState?.revision ?? 0,
      reasonCodes: [...alert.reasonCodes], ...(operatorState === undefined ? {} : { operatorState }),
      diagnostic: Object.freeze({ reasonCode: alert.reasonCodes[0] ?? alert.type,
        message: "本地持久化告警，请检查关联实体与后台任务。", retryable: alert.severity !== "CRITICAL",
        suggestedAction: alert.type === "CODEGRAPH_UNAVAILABLE" ? "检查 CodeGraph 能力或执行显式初始化"
          : alert.type === "MIGRATION_FAILED" ? "打开迁移中心查看失败项目" : "打开关联实体查看完整证据" }),
      });
    });
    const nextCursor = page.next === undefined ? undefined : (() => {
      const value = JSON.stringify(page.next); const digest = createHash("sha256").update(`zhiloop-alert:${value}`).digest("hex");
      return Buffer.from(JSON.stringify({ value, digest })).toString("base64url");
    })();
    const revision = items.reduce((maximum, alert) => Math.max(maximum, alert.revision, alert.operatorState?.revision ?? 0), 0);
    return Object.freeze({ revision, items, ...(nextCursor === undefined ? {} : { nextCursor }),
      bounded: page.next !== undefined, observedAt });
  }

  acknowledgeOperationalAlert(command: Omit<AlertOperatorCommand, "actor">) {
    this.#assertOpen(); return this.#alerts.acknowledge({ ...command, actor: "local-console" });
  }

  suppressOperationalAlert(command: Omit<AlertOperatorCommand, "actor"> & { readonly suppressedUntil: string }) {
    this.#assertOpen(); return this.#alerts.suppress({ ...command, actor: "local-console" });
  }

  operationsSnapshot(): EvolutionOperationsSnapshot {
    this.#assertOpen();
    const now = new Date().toISOString(); const jobs = this.#jobs.list({ limit: 1_000 }).items;
    const section = (area: EvolutionOperationsSnapshot["sections"][number]["area"], types: readonly string[], revision: number,
      emptyReason: string, facts = 0, factStatus?: "READY" | "RUNNING" | "DEGRADED" | "FAILED"):
      EvolutionOperationsSnapshot["sections"][number] => {
      const selected = jobs.filter((job) => types.includes(job.jobType));
      const queued = selected.filter((job) => job.status === "QUEUED" || job.status === "RETRY_WAIT").length;
      const running = selected.filter((job) => job.status === "RUNNING").length;
      const failed = selected.filter((job) => job.status === "FAILED").length;
      const status = failed > 0 ? "FAILED" : running + queued > 0 ? "RUNNING"
        : factStatus ?? (selected.length + facts === 0 ? "EMPTY" : "READY");
      return Object.freeze({ area, revision: Math.max(revision, ...selected.map((job) => job.revision), 0),
        status, reasonCode: status === "FAILED" ? `${area}_FAILED` : status === "RUNNING" ? `${area}_IN_PROGRESS`
          : status === "DEGRADED" ? `${area}_DEGRADED` : status === "EMPTY" ? emptyReason : `${area}_READY`,
        queued, running, failed, updatedAt: selected.map((job) => job.updatedAt ?? job.createdAt ?? now).sort().at(-1) ?? now });
    };
    const repairDrafts = this.#repairDrafts.list({ limit: 100 }).items;
    const codeGraphCapabilities = [...this.#roots.keys()].slice(0, 100).map((projectId) => this.#codeGraph.view(projectId));
    const migrations = [...this.#roots.keys()].slice(0, 100)
      .flatMap((projectId) => this.#migrations.list(projectId, 100));
    const freshnessStates = this.#production.registry.listAssets({ limit: 1_000 })
      .map(({ asset }) => this.#freshness.getState(asset.id, asset.version)).filter((value) => value !== undefined);
    const maximumRevision = (values: readonly { readonly revision: number }[]): number =>
      values.reduce((maximum, value) => Math.max(maximum, value.revision), 0);
    const alertPage = this.#alerts.list({ limit: 1_000 });
    const alertRevision = alertPage.items.reduce((m, item) => Math.max(m, item.revision), 0);
    const sections = [
      section("COMPILE", ["KNOWLEDGE_COMPILE"], 0, "COMPILE_EMPTY"),
      section("REVALIDATE", ["KNOWLEDGE_REVALIDATE"], 0, "REVALIDATION_EMPTY"),
      section("REPAIR", ["KNOWLEDGE_REPAIR_DRAFT"], maximumRevision(repairDrafts), "REPAIR_EMPTY", repairDrafts.length,
        repairDrafts.some((draft) => draft.status === "FAILED") ? "FAILED" : undefined),
      section("CODEGRAPH", ["CODEGRAPH_INITIALIZE"], maximumRevision(codeGraphCapabilities), "CODEGRAPH_NOT_INITIALIZED",
        codeGraphCapabilities.length, codeGraphCapabilities.length > 0 && codeGraphCapabilities.every((item) => item.status === "READY")
          ? "READY" : codeGraphCapabilities.length === 0 ? undefined : codeGraphCapabilities.some((item) => item.status === "FAILED") ? "FAILED" : "DEGRADED"),
      section("FRESHNESS", ["KNOWLEDGE_REVALIDATE"], maximumRevision(freshnessStates), "FRESHNESS_EMPTY", freshnessStates.length,
        freshnessStates.some((state) => state.status === "CONFLICT" || state.status === "UNKNOWN") ? "DEGRADED" : undefined),
      section("MIGRATION", ["LEGACY_KNOWLEDGE_MIGRATION"], maximumRevision(migrations), "MIGRATION_EMPTY", migrations.length,
        migrations.some((item) => item.status === "FAILED") ? "FAILED"
          : migrations.some((item) => item.status === "COMMITTING" || item.status === "ROLLING_BACK") ? "RUNNING"
            : migrations.some((item) => item.status === "ROLLBACK_CONFLICT") ? "DEGRADED" : undefined),
      Object.freeze({ area: "ALERT" as const, revision: alertRevision,
        status: alertPage.items.some((item) => item.severity === "CRITICAL") ? "FAILED" as const
          : alertPage.items.length > 0 ? "DEGRADED" as const : "EMPTY" as const,
        reasonCode: alertPage.items.length > 0 ? "ACTIVE_OPERATIONAL_ALERTS" : "ALERT_EMPTY",
        queued: 0, running: 0, failed: alertPage.items.filter((item) => item.severity === "CRITICAL").length, updatedAt: now }),
      section("INJECTION", [], 0, "INJECTION_READ_MODEL_SEPARATE"),
    ];
    // All backing APIs above are synchronous and Sidecar-owned, so the event loop cannot interleave a write while composing this snapshot.
    // Revisions are deliberately independent counters and must not be compared for equality.
    return Object.freeze({ schemaVersion: 1, consistency: "CONSISTENT", observedAt: now, sections });
  }
  previewLegacyMigration(projectId: string, createdAt = new Date().toISOString()): LegacyMigrationPreview {
    this.#assertOpen();
    if (!this.#roots.has(projectId)) throw new Error("LEGACY_MIGRATION_PROJECT_UNOBSERVED");
    return this.#migrationService.dryRun({ projectId, createdAt });
  }
  getLegacyMigration(migrationId: string): LegacyMigrationPreview | undefined {
    this.#assertOpen(); return this.#migrations.get(migrationId);
  }
  listLegacyMigrations(projectId: string, limit = 100): readonly LegacyMigrationPreview[] {
    this.#assertOpen(); return this.#migrations.list(projectId, limit);
  }
  listLegacyMigrationItems(migrationId: string, limit = 100, afterOrdinal?: number): LegacyMigrationPage {
    this.#assertOpen(); return this.#migrations.items({ migrationId, limit,
      ...(afterOrdinal === undefined ? {} : { afterOrdinal }) });
  }
  commitLegacyMigration(request: { readonly migrationId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string; readonly updatedAt: string }): { readonly preview: LegacyMigrationPreview;
      readonly job: EvolutionJobProjection } {
    this.#assertOpen(); const current = this.#migrations.get(request.migrationId);
    if (current === undefined) throw new Error("LEGACY_MIGRATION_NOT_FOUND");
    if (current.status === "READY" && current.revision !== request.expectedRevision) {
      throw new Error("LEGACY_MIGRATION_REVISION_CONFLICT");
    }
    if (current.status === "READY"
      && current.sourceRegistryRevision !== this.#migrationService.ports.registry.activeIndexVersion) {
      throw new Error("LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT");
    }
    const input: LegacyKnowledgeMigrationJobInput = { schemaVersion: 1, jobType: "LEGACY_KNOWLEDGE_MIGRATION",
      migrationVersion: current.migrationVersion, projectId: current.projectId, migrationId: current.migrationId,
      previewRevision: request.expectedRevision + 1 };
    const enqueued = this.enqueue(input, this.#configuration.maxAttempts); const jobId = enqueued.job.snapshot.jobId;
    try {
      const preview = this.#migrations.transition({ migrationId: current.migrationId,
        expectedRevision: request.expectedRevision, effectKey: request.idempotencyKey, status: "COMMITTING", jobId,
        updatedAt: request.updatedAt });
      const job = this.#jobs.get(jobId); if (job === undefined) throw new Error("LEGACY_MIGRATION_JOB_MISSING");
      return Object.freeze({ preview, job });
    } catch (error) {
      const job = this.#jobs.get(jobId);
      if (enqueued.status === "CREATED" && job !== undefined) {
        try { this.#jobs.cancel({ jobId, expectedRevision: job.revision,
          idempotencyKey: `orphan-migration:${request.idempotencyKey}` }); } catch { /* orphan job fails closed on preview mismatch */ }
      }
      throw error;
    }
  }
  async rollbackLegacyMigration(request: { readonly migrationId: string; readonly expectedRevision: number;
    readonly idempotencyKey: string; readonly updatedAt: string }): Promise<LegacyMigrationPreview> {
    this.#assertOpen(); return await this.#migrationRollback.rollback(request);
  }

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
    for (const close of [() => this.#intake.close(), () => this.#jobs.close(), () => this.#commands.close(), () => this.#codeGraph.close(), () => this.#alerts.close(), () => this.#migrations.close(),
      () => this.#repairDrafts.close(), () => this.#source.close()]) {
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
    if (wasStarted && next.enabled) await this.#intake.start();
    if (wasStarted) this.#schedulePoll();
  }

  #schedulePoll(): void {
    if (!this.#started || this.#closed) return;
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
          if (result.status === "FAILED" && this.#alertConfiguration.enabled && this.#alertConfiguration.onPermanentJobFailure) {
            const failure = result.job.snapshot.lastFailure;
            const observedAt = failure?.occurredAt ?? result.job.snapshot.updatedAt ?? new Date().toISOString();
            let migration: LegacyMigrationPreview | undefined;
            try { const parsed = parseEvolutionJobInput(result.job.input);
              if (parsed.jobType === "LEGACY_KNOWLEDGE_MIGRATION") migration = this.#migrations.get(parsed.migrationId); } catch { /* invalid input already failed */ }
            if (migration !== undefined) {
              try { if (migration.status === "COMMITTING") this.#migrations.transition({ migrationId: migration.migrationId,
                expectedRevision: migration.revision, effectKey: `migration-failed:${jobId}:${result.job.snapshot.attempt}`,
                status: "FAILED", failureCode: failure?.code ?? "JOB_ATTEMPTS_EXHAUSTED", updatedAt: observedAt }); } catch { /* job failure remains authoritative */ }
              void this.#emitAlert({ eventId: `migration-failed:${jobId}:${result.job.snapshot.attempt}:${observedAt}`,
                observedAt, dedupKey: `migration-failed:${migration.migrationId}`, severity: "CRITICAL", type: "MIGRATION_FAILED",
                projectId: migration.projectId, entityRef: migration.migrationId,
                reasonCodes: [failure?.code ?? "JOB_ATTEMPTS_EXHAUSTED"] });
            } else {
              void this.#emitAlert({ eventId: `permanent-job:${jobId}:${result.job.snapshot.attempt}:${observedAt}`,
                observedAt, dedupKey: `permanent-job:${jobId}`, severity: "CRITICAL", type: "PERMANENT_JOB_FAILURE",
                entityRef: jobId, reasonCodes: [failure?.code ?? "JOB_ATTEMPTS_EXHAUSTED"] });
            }
          }
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
  async #emitAlert(input: OperationalAlertInput): Promise<void> {
    try { await this.#alerts.emit(input); }
    catch { /* The primary evolution state remains authoritative when alert persistence is unavailable. */ }
  }
  #project(jobId: string): void {
    const value = this.#jobs.get(jobId);
    if (value !== undefined) this.#onJob?.(value);
  }
}
