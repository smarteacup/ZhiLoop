import { createHash } from "node:crypto";

import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

import type { FreshnessWorkerRunResult } from "./worker.js";

const MAX_PENDING_PROJECTS = 100;
const MAX_CHANGE_KEYS = 10_000;

export interface FreshnessSchedulerConfiguration {
  readonly enabled: boolean;
  readonly changeDebounceMs: number;
  readonly fallbackScanIntervalMs: number;
  readonly maxAffectedPerJob: number;
}

export interface FreshnessSchedulerTimerHandle { cancel(): void }
export interface FreshnessSchedulerTimerPort { schedule(delayMs: number, task: () => void): FreshnessSchedulerTimerHandle }
export interface FreshnessChangeSourcePort {
  scan(signal?: AbortSignal): Promise<readonly KnowledgeChangeSet[]>;
  acknowledge?(changes: KnowledgeChangeSet): void | Promise<void>;
}
export interface FreshnessWorkerPort { run(changes: KnowledgeChangeSet, maxAffected: number, signal?: AbortSignal): Promise<FreshnessWorkerRunResult> }

export interface FreshnessSchedulerState {
  readonly status: "DISABLED" | "STOPPED" | "READY" | "DEGRADED";
  readonly pendingProjects: number;
  readonly running: boolean;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly lastReasonCode?: string;
}

class NodeTimer implements FreshnessSchedulerTimerPort {
  schedule(delayMs: number, task: () => void): FreshnessSchedulerTimerHandle {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  }
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is out of bounds`);
  return value;
}

function normalize(configuration: FreshnessSchedulerConfiguration): FreshnessSchedulerConfiguration {
  return Object.freeze({
    enabled: configuration.enabled,
    changeDebounceMs: bounded(configuration.changeDebounceMs, 100, 60_000, "changeDebounceMs"),
    fallbackScanIntervalMs: bounded(configuration.fallbackScanIntervalMs, 10_000, 86_400_000, "fallbackScanIntervalMs"),
    maxAffectedPerJob: bounded(configuration.maxAffectedPerJob, 1, 10_000, "maxAffectedPerJob"),
  });
}

function safeText(value: string, maximum: number): boolean {
  return value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function safePath(value: string): boolean {
  return safeText(value, 4_096) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validate(changes: KnowledgeChangeSet): void {
  if (!safeText(changes.projectId, 500) || !safeText(changes.sourceRef, 4_096) || !Number.isFinite(Date.parse(changes.observedAt))) {
    throw new Error("FRESHNESS_CHANGESET_IDENTITY_INVALID");
  }
  const sets = [changes.changedPaths, changes.changedSymbols, changes.changedConfigs, changes.changedDependencies];
  if (sets.some((items) => items.length > MAX_CHANGE_KEYS || new Set(items).size !== items.length)) throw new Error("FRESHNESS_CHANGESET_BOUNDS_INVALID");
  if (!changes.changedPaths.every(safePath)
    || ![...changes.changedSymbols, ...changes.changedConfigs, ...changes.changedDependencies].every((item) => safeText(item, 1_000))) {
    throw new Error("FRESHNESS_CHANGESET_CONTENT_INVALID");
  }
}

function merged(left: KnowledgeChangeSet | undefined, right: KnowledgeChangeSet): KnowledgeChangeSet {
  validate(right);
  if (left === undefined) return Object.freeze({ ...right,
    changedPaths: Object.freeze([...right.changedPaths]), changedSymbols: Object.freeze([...right.changedSymbols]),
    changedConfigs: Object.freeze([...right.changedConfigs]), changedDependencies: Object.freeze([...right.changedDependencies]),
  });
  if (left.projectId !== right.projectId) throw new Error("FRESHNESS_CHANGESET_PROJECT_MISMATCH");
  const union = (a: readonly string[], b: readonly string[]) => {
    const values = [...new Set([...a, ...b])].sort();
    if (values.length > MAX_CHANGE_KEYS) throw new Error("FRESHNESS_CHANGESET_MERGE_LIMIT_EXCEEDED");
    return Object.freeze(values);
  };
  return Object.freeze({
    projectId: right.projectId,
    changedPaths: union(left.changedPaths, right.changedPaths),
    changedSymbols: union(left.changedSymbols, right.changedSymbols),
    changedConfigs: union(left.changedConfigs, right.changedConfigs),
    changedDependencies: union(left.changedDependencies, right.changedDependencies),
    sourceRef: right.sourceRef,
    observedAt: new Date(Math.max(Date.parse(left.observedAt), Date.parse(right.observedAt))).toISOString(),
  });
}

function fingerprint(changes: KnowledgeChangeSet): string {
  return createHash("sha256").update(JSON.stringify(changes)).digest("hex");
}

/** Completion-based, single-flight scheduler. Adapters submit normalized ChangeSets; it never scans or initializes code tools itself. */
export class KnowledgeFreshnessScheduler {
  readonly #worker: FreshnessWorkerPort;
  readonly #source: FreshnessChangeSourcePort | undefined;
  readonly #timer: FreshnessSchedulerTimerPort;
  readonly #onResult: ((result: FreshnessWorkerRunResult) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #pending = new Map<string, KnowledgeChangeSet>();
  readonly #lastCompleted = new Map<string, string>();
  #configuration: FreshnessSchedulerConfiguration;
  #handle: FreshnessSchedulerTimerHandle | undefined;
  #tail: Promise<void> | undefined;
  #started = false;
  #closed = false;
  #completedRuns = 0;
  #failedRuns = 0;
  #degraded = false;
  #lastReasonCode: string | undefined;

  constructor(worker: FreshnessWorkerPort, configuration: FreshnessSchedulerConfiguration, options: {
    readonly source?: FreshnessChangeSourcePort;
    readonly timer?: FreshnessSchedulerTimerPort;
    readonly onResult?: (result: FreshnessWorkerRunResult) => void;
    readonly onError?: (error: unknown) => void;
  } = {}) {
    this.#worker = worker;
    this.#configuration = normalize(configuration);
    this.#source = options.source;
    this.#timer = options.timer ?? new NodeTimer();
    this.#onResult = options.onResult;
    this.#onError = options.onError;
  }

  state(): FreshnessSchedulerState {
    const status = !this.#configuration.enabled ? "DISABLED" : !this.#started ? "STOPPED" : this.#degraded ? "DEGRADED" : "READY";
    return Object.freeze({ status, pendingProjects: this.#pending.size, running: this.#tail !== undefined,
      completedRuns: this.#completedRuns, failedRuns: this.#failedRuns, ...(this.#lastReasonCode === undefined ? {} : { lastReasonCode: this.#lastReasonCode }) });
  }

  start(): boolean {
    this.#assertOpen();
    if (this.#started) return false;
    this.#started = true;
    if (this.#configuration.enabled) {
      this.#schedule(this.#source === undefined ? this.#configuration.changeDebounceMs : this.#configuration.fallbackScanIntervalMs);
    }
    return true;
  }

  submit(changes: KnowledgeChangeSet): "QUEUED" | "MERGED" | "DUPLICATE" {
    this.#assertOpen();
    validate(changes);
    if (!this.#configuration.enabled) return "DUPLICATE";
    const digest = fingerprint(changes);
    if (this.#lastCompleted.get(changes.projectId) === digest) return "DUPLICATE";
    const existing = this.#pending.get(changes.projectId);
    if (existing === undefined && this.#pending.size >= MAX_PENDING_PROJECTS) throw new Error("FRESHNESS_PENDING_PROJECT_LIMIT_EXCEEDED");
    this.#pending.set(changes.projectId, merged(existing, changes));
    if (this.#started && this.#tail === undefined) this.#schedule(this.#configuration.changeDebounceMs);
    return existing === undefined ? "QUEUED" : "MERGED";
  }

  async flush(): Promise<void> {
    this.#assertOpen();
    if (this.#tail !== undefined) return await this.#tail;
    this.#handle?.cancel();
    this.#handle = undefined;
    const operation = this.#run();
    this.#tail = operation;
    try { await operation; } finally { if (this.#tail === operation) this.#tail = undefined; }
  }

  async applyConfiguration(configuration: FreshnessSchedulerConfiguration): Promise<() => Promise<void>> {
    this.#assertOpen();
    const previous = this.#configuration;
    await this.#reconfigure(normalize(configuration));
    let rolledBack = false;
    return async () => { if (rolledBack || this.#closed) return; rolledBack = true; await this.#reconfigure(previous); };
  }

  async stop(): Promise<boolean> {
    this.#assertOpen();
    if (!this.#started) return false;
    this.#started = false;
    this.#handle?.cancel();
    this.#handle = undefined;
    await this.#tail;
    return true;
  }

  async close(): Promise<void> { if (this.#closed) return; if (this.#started) await this.stop(); else await this.#tail; this.#closed = true; }

  async #reconfigure(configuration: FreshnessSchedulerConfiguration): Promise<void> {
    this.#handle?.cancel();
    this.#handle = undefined;
    await this.#tail;
    this.#configuration = configuration;
    if (!configuration.enabled) this.#pending.clear();
    if (this.#started && configuration.enabled) this.#schedule(configuration.changeDebounceMs);
  }

  #schedule(delay: number): void {
    this.#handle?.cancel();
    if (!this.#started || !this.#configuration.enabled) return;
    this.#handle = this.#timer.schedule(delay, () => { this.#handle = undefined; void this.flush().catch(() => undefined); });
  }

  async #run(): Promise<void> {
    if (!this.#configuration.enabled) return;
    this.#degraded = false;
    try {
      if (this.#source !== undefined) for (const changes of await this.#source.scan()) this.submit(changes);
      const work = [...this.#pending.values()].sort((left, right) => left.projectId.localeCompare(right.projectId));
      this.#pending.clear();
      for (const changes of work) {
        try {
          const result = await this.#worker.run(changes, this.#configuration.maxAffectedPerJob);
          this.#completedRuns += 1;
          if (result.bounded) {
            this.#pending.set(changes.projectId, merged(this.#pending.get(changes.projectId), changes));
            this.#lastReasonCode = "AFFECTED_KNOWLEDGE_BATCH_PENDING";
          } else {
            await this.#source?.acknowledge?.(changes);
            this.#lastCompleted.set(changes.projectId, fingerprint(changes));
            this.#lastReasonCode = "FRESHNESS_REVALIDATED";
          }
          this.#onResult?.(result);
        } catch (error) {
          this.#pending.set(changes.projectId, merged(this.#pending.get(changes.projectId), changes));
          this.#failedRuns += 1;
          this.#degraded = true;
          this.#lastReasonCode = "FRESHNESS_REVALIDATION_FAILED";
          this.#onError?.(error);
        }
      }
    } catch (error) {
      this.#failedRuns += 1;
      this.#degraded = true;
      this.#lastReasonCode = "FRESHNESS_CHANGE_SOURCE_FAILED";
      this.#onError?.(error);
    } finally {
      if (this.#started) this.#schedule(this.#pending.size > 0 || this.#source === undefined
        ? this.#configuration.changeDebounceMs
        : this.#configuration.fallbackScanIntervalMs);
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error("freshness scheduler is closed"); }
}
