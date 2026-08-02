import type {
  DaemonComponentHealth,
  DaemonHealthSnapshot,
  DaemonRuntimeOptions,
  DaemonRuntimePorts,
  DaemonState,
  DaemonWorkerCycle,
} from "./types.js";

const DEFAULT_DEADLINES = Object.freeze({
  UserPromptSubmit: 500,
  PostToolUse: 100,
  Stop: 3_000,
  SessionEnd: 100,
  other: 100,
});
const MAX_HOOK_DEADLINE_MS = 3_000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
const MAX_SHUTDOWN_DEADLINE_MS = 30_000;

function safeDiagnostic(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/[\0\r\n]/gu, " ").slice(0, 500);
}

function hookEvent(input: unknown): keyof typeof DEFAULT_DEADLINES {
  if (typeof input !== "object" || input === null) return "other";
  const value = (input as { hook_event_name?: unknown }).hook_event_name;
  return typeof value === "string" && value in DEFAULT_DEADLINES
    ? value as keyof typeof DEFAULT_DEADLINES
    : "other";
}

function validDeadline(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer within 1..${maximum}`);
  }
  return value;
}

function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, deadlineMs: number, parent: AbortSignal): Promise<T> {
  if (parent.aborted) return Promise.reject(parent.reason);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("daemon operation deadline exceeded");
      controller.abort(error);
      reject(error);
    }, deadlineMs);
    timer.unref?.();
  });
  return Promise.race([operation(controller.signal), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  });
}

function timestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("daemon clock returned an invalid Date");
  return value.toISOString();
}

export class ZhiLoopDaemonRuntime {
  readonly #ports: DaemonRuntimePorts;
  readonly #options: DaemonRuntimeOptions;
  readonly #clock: () => Date;
  readonly #deadlines: typeof DEFAULT_DEADLINES;
  readonly #shutdownDeadlineMs: number;
  #state: DaemonState = "STOPPED";
  #startedAt: string | undefined;
  #diagnostic: string | undefined;
  #workerDiagnostic: string | undefined;
  #controller = new AbortController();
  #startedComponents: DaemonRuntimePorts["components"][number][] = [];
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #workerPromise: Promise<DaemonWorkerCycle> | undefined;
  #lastWorkerCycle: DaemonWorkerCycle | undefined;
  #inflight = new Set<Promise<unknown>>();

  constructor(ports: DaemonRuntimePorts, options: DaemonRuntimeOptions) {
    if (ports.components.length === 0 || new Set(ports.components.map(({ name }) => name)).size !== ports.components.length
      || ports.components.some(({ name }) => name.trim().length === 0 || name.length > 100 || /[\0\r\n]/u.test(name))) {
      throw new Error("daemon components must have unique safe names");
    }
    this.#ports = ports;
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#deadlines = Object.freeze(Object.fromEntries(Object.entries(DEFAULT_DEADLINES).map(([name, fallback]) => [
      name,
      validDeadline(options.hookDeadlinesMs?.[name as keyof typeof DEFAULT_DEADLINES] ?? fallback, MAX_HOOK_DEADLINE_MS, `${name} deadline`),
    ]))) as typeof DEFAULT_DEADLINES;
    this.#shutdownDeadlineMs = validDeadline(options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS, MAX_SHUTDOWN_DEADLINE_MS, "shutdownDeadlineMs");
  }

  get state(): DaemonState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state === "READY") return;
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#state === "STOPPING") throw new Error("daemon is stopping");
    this.#state = "STARTING";
    this.#diagnostic = undefined;
    this.#workerDiagnostic = undefined;
    this.#controller = new AbortController();
    this.#startPromise = this.#startComponents().finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  async #startComponents(): Promise<void> {
    try {
      for (const component of this.#ports.components) {
        await component.start(this.#controller.signal);
        this.#startedComponents.push(component);
      }
      if (this.#controller.signal.aborted) throw this.#controller.signal.reason;
      this.#startedAt = timestamp(this.#clock);
      this.#state = "READY";
    } catch (error) {
      this.#diagnostic = safeDiagnostic(error);
      this.#controller.abort(error);
      await Promise.allSettled([...this.#startedComponents].reverse().map((component) => component.stop()));
      this.#startedComponents = [];
      this.#state = "DEGRADED";
      throw error;
    }
  }

  async handleHook(input: unknown): Promise<string> {
    if (this.#state !== "READY") return "";
    const event = hookEvent(input);
    const operation = withDeadline(
      (signal) => this.#ports.hook.handle(input, signal),
      this.#deadlines[event],
      this.#controller.signal,
    ).then((output) => {
      const value = output ?? "";
      return value.length <= 1_048_576 && !value.includes("\0") ? value : "";
    }, () => "");
    this.#track(operation);
    return operation;
  }

  async handleMcp(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
    if (this.#state !== "READY") throw new Error("daemon is not ready");
    if (signal.aborted) throw signal.reason;
    const operation = this.#ports.mcp.handle(input, AbortSignal.any([signal, this.#controller.signal]));
    this.#track(operation);
    return operation;
  }

  async runWorkerOnce(): Promise<DaemonWorkerCycle> {
    if (this.#state !== "READY") throw new Error("daemon is not ready");
    this.#workerPromise ??= this.#ports.worker.runOnce(this.#controller.signal).then((cycle) => {
      if (!Number.isSafeInteger(cycle.consumed) || cycle.consumed < 0
        || !Number.isSafeInteger(cycle.produced) || cycle.produced < 0
        || !Number.isSafeInteger(cycle.cursor) || cycle.cursor < 0
        || !Number.isSafeInteger(cycle.retryableFailures) || cycle.retryableFailures < 0
        || (this.#lastWorkerCycle !== undefined && cycle.cursor < this.#lastWorkerCycle.cursor)) {
        throw new Error("daemon worker returned an invalid cycle");
      }
      this.#lastWorkerCycle = Object.freeze({
        consumed: cycle.consumed,
        produced: cycle.produced,
        cursor: cycle.cursor,
        retryableFailures: cycle.retryableFailures,
      });
      this.#workerDiagnostic = undefined;
      return this.#lastWorkerCycle;
    }).catch((error: unknown) => {
      this.#workerDiagnostic = safeDiagnostic(error);
      throw error;
    }).finally(() => {
      this.#workerPromise = undefined;
    });
    this.#track(this.#workerPromise);
    return this.#workerPromise;
  }

  #track(operation: Promise<unknown>): void {
    this.#inflight.add(operation);
    void operation.finally(() => this.#inflight.delete(operation)).catch(() => undefined);
  }

  async health(): Promise<DaemonHealthSnapshot> {
    const components: DaemonComponentHealth[] = [];
    for (const component of this.#ports.components) {
      try {
        const result = await component.health(this.#controller.signal);
        if (typeof result.healthy !== "boolean" || (result.diagnostic !== undefined && typeof result.diagnostic !== "string")) {
          throw new Error("component returned invalid health");
        }
        components.push(Object.freeze({
          name: component.name,
          healthy: result.healthy,
          ...(result.diagnostic === undefined ? {} : { diagnostic: safeDiagnostic(result.diagnostic) }),
        }));
      } catch (error) {
        components.push(Object.freeze({ name: component.name, healthy: false, diagnostic: safeDiagnostic(error) }));
      }
    }
    const ready = this.#state === "READY" && this.#workerDiagnostic === undefined && components.every(({ healthy }) => healthy);
    const diagnostic = this.#diagnostic ?? this.#workerDiagnostic;
    return Object.freeze({
      schemaVersion: 1,
      status: ready ? "READY" : "DEGRADED",
      pluginVersion: this.#options.compatibility.pluginVersion,
      sidecarVersion: this.#options.sidecarVersion,
      protocolVersion: this.#options.compatibility.protocolVersion,
      hookSchemaVersion: this.#options.compatibility.hookSchemaVersion,
      appServerSchemaVersion: this.#options.compatibility.appServerSchemaVersion,
      startedAt: this.#startedAt ?? timestamp(this.#clock),
      daemonState: this.#state,
      components: Object.freeze(components),
      ...(this.#lastWorkerCycle === undefined ? {} : { lastWorkerCycle: this.#lastWorkerCycle }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
  }

  async stop(): Promise<void> {
    if (this.#state === "STOPPED") return;
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#state = "STOPPING";
    this.#controller.abort(new Error("daemon is stopping"));
    const starting = this.#startPromise;
    this.#stopPromise = (async () => {
      if (starting !== undefined) await starting.catch(() => undefined);
      await this.#stopComponents();
    })().finally(() => {
      this.#stopPromise = undefined;
    });
    return this.#stopPromise;
  }

  async #stopComponents(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#inflight]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.#shutdownDeadlineMs); }),
      ]);
      const outcomes = await Promise.allSettled([...this.#startedComponents].reverse().map((component) => component.stop()));
      this.#startedComponents = [];
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") {
        this.#diagnostic = safeDiagnostic(failed.reason);
        this.#state = "DEGRADED";
        throw failed.reason;
      }
      this.#state = "STOPPED";
      this.#startedAt = undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
