import type { AutomaticIngestionRunReport, ScheduledTaskHandle, SchedulerTimerPort } from "./types.js";
import type { AutomaticIngestionService } from "./service.js";

export class NodeSchedulerTimer implements SchedulerTimerPort {
  schedule(delayMs: number, task: () => void): ScheduledTaskHandle {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  }
}

export interface AutomaticIngestionSchedulerOptions {
  readonly timer?: SchedulerTimerPort;
  readonly onReport?: (report: AutomaticIngestionRunReport) => void;
  readonly onError?: (error: unknown) => void;
}

/** Non-overlapping, completion-based scheduling prevents busy and zero-delay loops. */
export class AutomaticIngestionScheduler {
  readonly #timer: SchedulerTimerPort;
  readonly #onReport: ((report: AutomaticIngestionRunReport) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #scheduled: ScheduledTaskHandle | undefined;
  #running: Promise<AutomaticIngestionRunReport> | undefined;
  #started = false;
  #generation = 0;

  constructor(private readonly service: AutomaticIngestionService, options: AutomaticIngestionSchedulerOptions = {}) {
    this.#timer = options.timer ?? new NodeSchedulerTimer();
    this.#onReport = options.onReport;
    this.#onError = options.onError;
  }

  start(): boolean {
    if (this.#started) return false;
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

  async trigger(): Promise<AutomaticIngestionRunReport> {
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
