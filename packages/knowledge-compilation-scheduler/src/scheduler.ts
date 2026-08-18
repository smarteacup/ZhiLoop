import type {
  NormalizedKnowledgeCompilationConfiguration,
  KnowledgeCompilationRunReport,
  KnowledgeCompilationTimerPort,
  ScheduledCompilationTaskHandle,
} from "./types.js";

export interface KnowledgeCompilationRunnable {
  readonly configuration: NormalizedKnowledgeCompilationConfiguration;
  runOnce(): Promise<KnowledgeCompilationRunReport>;
}

export class NodeKnowledgeCompilationTimer implements KnowledgeCompilationTimerPort {
  schedule(delayMs: number, task: () => void): ScheduledCompilationTaskHandle {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  }
}

export interface KnowledgeCompilationSchedulerOptions {
  readonly timer?: KnowledgeCompilationTimerPort;
  readonly onReport?: (report: KnowledgeCompilationRunReport) => void;
  readonly onError?: (error: unknown) => void;
}

/** Non-overlapping and completion-based so a slow scan cannot create a busy loop. */
export class KnowledgeCompilationScheduler {
  readonly #timer: KnowledgeCompilationTimerPort;
  readonly #onReport: ((report: KnowledgeCompilationRunReport) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #scheduled: ScheduledCompilationTaskHandle | undefined;
  #running: Promise<KnowledgeCompilationRunReport> | undefined;
  #started = false;
  #generation = 0;

  constructor(private readonly service: KnowledgeCompilationRunnable, options: KnowledgeCompilationSchedulerOptions = {}) {
    this.#timer = options.timer ?? new NodeKnowledgeCompilationTimer();
    this.#onReport = options.onReport;
    this.#onError = options.onError;
  }

  get started(): boolean {
    return this.#started;
  }

  start(): boolean {
    if (this.#started || !this.service.configuration.enabled) return false;
    this.#started = true;
    this.#generation += 1;
    this.#schedule(this.service.configuration.scanIntervalMs, this.#generation);
    return true;
  }

  stop(): boolean {
    if (!this.#started) return false;
    this.#started = false;
    this.#generation += 1;
    this.#scheduled?.cancel();
    this.#scheduled = undefined;
    return true;
  }

  async trigger(): Promise<KnowledgeCompilationRunReport> {
    if (this.#running !== undefined) return this.#running;
    const run = this.service.runOnce();
    this.#running = run;
    try {
      const report = await run;
      this.#onReport?.(report);
      return report;
    } catch (error) {
      this.#onError?.(error);
      throw error;
    } finally {
      this.#running = undefined;
    }
  }

  async drain(): Promise<void> {
    await this.#running?.then(() => undefined, () => undefined);
  }

  #schedule(delayMs: number, generation: number): void {
    this.#scheduled = this.#timer.schedule(delayMs, () => {
      this.#scheduled = undefined;
      void this.trigger()
        .catch(() => undefined)
        .finally(() => {
          if (this.#started && this.#generation === generation) {
            this.#schedule(this.service.configuration.scanIntervalMs, generation);
          }
        });
    });
  }
}
