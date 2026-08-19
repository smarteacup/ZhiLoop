import { join } from "node:path";

import {
  KnowledgeCompilationScheduler,
  KnowledgeCompilationService,
  SqliteKnowledgeCompilationCheckpointStore,
  type KnowledgeCompilationConfiguration,
  type CompilationDispatchPort,
  type CompilationCapacityPort,
  type CompilationObservationPort,
  type KnowledgeCompilationPipelineIdentity,
  type KnowledgeCompilationRunReport,
  type KnowledgeCompilationTimerPort,
} from "@zhiloop/knowledge-compilation-scheduler";
import type { SessionCatalogQueryPort } from "@zhiloop/session-catalog";

export type P2AutomaticCompilationStatus = "READY" | "STOPPED" | "DEGRADED" | "DISABLED";

export interface P2AutomaticCompilationRuntimeOptions {
  readonly stateDirectory: string;
  readonly catalog: SessionCatalogQueryPort;
  readonly adapter: CompilationObservationPort & CompilationDispatchPort;
  readonly capacity?: CompilationCapacityPort;
  readonly pipeline: KnowledgeCompilationPipelineIdentity;
  readonly configuration?: KnowledgeCompilationConfiguration;
  readonly now?: () => Date;
  readonly timer?: KnowledgeCompilationTimerPort;
  readonly onReport?: (report: KnowledgeCompilationRunReport) => void;
}

/** Owns M1 scheduling state. Candidate execution remains in the existing P2 durable worker. */
export class P2AutomaticCompilationRuntime {
  readonly #store: SqliteKnowledgeCompilationCheckpointStore;
  readonly #catalog: SessionCatalogQueryPort;
  readonly #adapter: CompilationObservationPort & CompilationDispatchPort;
  readonly #capacity: CompilationCapacityPort | undefined;
  readonly #now: (() => Date) | undefined;
  readonly #timer: KnowledgeCompilationTimerPort | undefined;
  readonly #onReport: ((report: KnowledgeCompilationRunReport) => void) | undefined;
  #service: KnowledgeCompilationService;
  #scheduler: KnowledgeCompilationScheduler;
  #started = false;
  #closed = false;
  #lastReport: KnowledgeCompilationRunReport | undefined;
  #lastError = false;
  #pipeline: KnowledgeCompilationPipelineIdentity;

  constructor(options: P2AutomaticCompilationRuntimeOptions) {
    this.#store = new SqliteKnowledgeCompilationCheckpointStore(join(options.stateDirectory, "automatic-knowledge-compilation.sqlite"));
    this.#catalog = options.catalog;
    this.#adapter = options.adapter;
    this.#capacity = options.capacity;
    this.#now = options.now;
    this.#timer = options.timer;
    this.#onReport = options.onReport;
    this.#pipeline = options.pipeline;
    this.#service = this.#createService(options.pipeline, options.configuration ?? {});
    this.#scheduler = this.#createScheduler(this.#service);
  }

  state(): {
    readonly automaticCompile: P2AutomaticCompilationStatus;
    readonly lastAutomaticCompileReport?: KnowledgeCompilationRunReport;
  } {
    this.#assertOpen();
    const status: P2AutomaticCompilationStatus = !this.#service.configuration.enabled
      ? "DISABLED"
      : !this.#started
        ? "STOPPED"
        : this.#lastError || (this.#lastReport?.failedSessions ?? 0) > 0
          ? "DEGRADED"
          : "READY";
    return Object.freeze({
      automaticCompile: status,
      ...(this.#lastReport === undefined ? {} : { lastAutomaticCompileReport: this.#lastReport }),
    });
  }

  start(): boolean {
    this.#assertOpen();
    if (this.#started) return false;
    this.#started = true;
    this.#scheduler.start();
    return true;
  }

  async stop(): Promise<boolean> {
    this.#assertOpen();
    if (!this.#started) return false;
    this.#started = false;
    this.#scheduler.stop();
    await this.#scheduler.drain();
    return true;
  }

  async trigger(): Promise<KnowledgeCompilationRunReport> {
    this.#assertOpen();
    return await this.#scheduler.trigger();
  }

  async applyConfiguration(
    configuration: KnowledgeCompilationConfiguration,
    pipeline: KnowledgeCompilationPipelineIdentity,
  ): Promise<() => Promise<void>> {
    this.#assertOpen();
    const previousConfiguration = this.#service.configuration;
    const previousPipeline = this.#pipeline;
    await this.#reconfigure(configuration, pipeline);
    let rolledBack = false;
    return async () => {
      if (rolledBack || this.#closed) return;
      rolledBack = true;
      await this.#reconfigure(previousConfiguration, previousPipeline);
    };
  }

  async #reconfigure(
    configuration: KnowledgeCompilationConfiguration,
    pipeline: KnowledgeCompilationPipelineIdentity,
  ): Promise<void> {
    const candidateService = this.#createService(pipeline, configuration);
    const candidateScheduler = this.#createScheduler(candidateService);
    const wasStarted = this.#started;
    this.#scheduler.stop();
    await this.#scheduler.drain();
    this.#service = candidateService;
    this.#scheduler = candidateScheduler;
    this.#pipeline = pipeline;
    this.#lastError = false;
    if (wasStarted) this.#scheduler.start();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#started) await this.stop();
    else await this.#scheduler.drain();
    this.#store.close();
    this.#closed = true;
  }

  #createService(
    pipeline: KnowledgeCompilationPipelineIdentity,
    configuration: KnowledgeCompilationConfiguration,
  ): KnowledgeCompilationService {
    return new KnowledgeCompilationService({
      catalog: this.#catalog,
      observations: this.#adapter,
      checkpoints: this.#store,
      dispatcher: this.#adapter,
      ...(this.#capacity === undefined ? {} : { capacity: this.#capacity }),
      pipeline,
      ...(this.#now === undefined ? {} : { now: this.#now }),
    }, configuration);
  }

  #createScheduler(service: KnowledgeCompilationService): KnowledgeCompilationScheduler {
    return new KnowledgeCompilationScheduler(service, {
      ...(this.#timer === undefined ? {} : { timer: this.#timer }),
      onReport: (report) => {
        this.#lastReport = report;
        this.#lastError = false;
        this.#onReport?.(report);
      },
      onError: () => { this.#lastError = true; },
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("automatic compilation runtime is closed");
  }
}
