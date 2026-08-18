import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeRevalidateJobInput } from "@zhiloop/evolution-job-runtime";

import type { GitKnowledgeChangeObservation } from "./git-source.js";

const MAX_PROJECTS = 1_000;
const SAFE_ID = /^[A-Za-z0-9._:@+=-]{1,500}$/u;
const CONTROL = /[\0\r\n]/u;
const DEFAULT_RECIPE_SELECTION_HASH = createHash("sha256").update("all-current-recipes-v1").digest("hex");

export const KNOWLEDGE_CHANGE_SIGNAL_SOURCES = [
  "CODEX_FILE_CHANGE",
  "WORKTREE_WATCHER",
  "GIT_LIFECYCLE",
  "FALLBACK_SCAN",
  "PRE_INJECTION",
] as const;

export type KnowledgeChangeSignalSource = (typeof KNOWLEDGE_CHANGE_SIGNAL_SOURCES)[number];

export interface KnowledgeChangeSignal {
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly source: KnowledgeChangeSignalSource;
  readonly observedAt: string;
  readonly pathsHint?: readonly string[];
}

export interface KnowledgeChangeSourcePort {
  observe(projectId: string, repositoryRoot: string): void;
  observedProjects(): readonly { readonly projectId: string; readonly repositoryRoot: string }[];
  scanProject(projectId: string): Promise<unknown>;
  listPending(limit?: number, projectId?: string, afterObservationId?: string): readonly GitKnowledgeChangeObservation[];
  baseline?(projectId: string): { readonly head: string; readonly statusFingerprint: string } | undefined;
}

export interface KnowledgeRevalidateJobPort {
  enqueue(input: KnowledgeRevalidateJobInput, maxAttempts: number): {
    readonly status: "CREATED" | "EXISTING";
    readonly job: { readonly snapshot: { readonly jobId: string } };
  };
}

export interface KnowledgeChangeTimerHandle { cancel(): void; }
export interface KnowledgeChangeTimerPort {
  schedule(delayMs: number, task: () => void): KnowledgeChangeTimerHandle;
}

export interface KnowledgeChangeIntakeOptions {
  readonly source: KnowledgeChangeSourcePort;
  readonly jobs: KnowledgeRevalidateJobPort;
  readonly clock?: () => Date;
  readonly timer?: KnowledgeChangeTimerPort;
  readonly debounceMs?: number;
  readonly fallbackIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly recipeSelectionHash?: (projectId: string) => string;
}

export interface KnowledgeChangeIntakeState {
  readonly status: "STOPPED" | "READY" | "DEGRADED";
  readonly pendingSignals: number;
  readonly running: boolean;
  readonly completedCycles: number;
  readonly failedCycles: number;
  readonly lastReasonCode?: string;
}

export interface KnowledgeLiveRevisionState {
  readonly projectId: string;
  readonly status: "PENDING" | "CURRENT";
  readonly codeRevision?: string;
  readonly graphRevision?: string;
  readonly reasonCode: string;
  readonly updatedAt: string;
}

export interface KnowledgeChangeCycleResult {
  readonly scannedProjects: number;
  readonly enqueuedJobs: number;
  readonly reusedJobs: number;
}

interface ScheduleRow {
  readonly project_id: string;
  readonly repository_root: string;
  readonly next_scan_at_ms: number;
}

class NodeKnowledgeChangeTimer implements KnowledgeChangeTimerPort {
  schedule(delayMs: number, task: () => void): KnowledgeChangeTimerHandle {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw new Error(`KNOWLEDGE_CHANGE_${name}_INVALID`);
  return selected;
}

function safeId(value: string): boolean { return SAFE_ID.test(value) && value !== "." && value !== ".."; }
function safeRoot(value: string): boolean { return isAbsolute(value) && resolve(value) === value && !CONTROL.test(value) && value.length <= 4_096; }
function safeHintPath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.startsWith("/") && !value.includes("\\") && !CONTROL.test(value)
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function safeHash(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function now(clock: () => Date): { readonly iso: string; readonly epochMs: number } {
  const value = clock();
  const epochMs = value.getTime();
  const iso = value.toISOString();
  if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== iso) throw new Error("KNOWLEDGE_CHANGE_CLOCK_INVALID");
  return { iso, epochMs };
}
function validateSignal(signal: KnowledgeChangeSignal): void {
  let normalizedObservedAt: string;
  try { normalizedObservedAt = new Date(signal.observedAt).toISOString(); }
  catch { throw new Error("KNOWLEDGE_CHANGE_SIGNAL_INVALID"); }
  if (!safeId(signal.projectId) || !safeRoot(signal.repositoryRoot)
    || !KNOWLEDGE_CHANGE_SIGNAL_SOURCES.includes(signal.source)
    || normalizedObservedAt !== signal.observedAt) throw new Error("KNOWLEDGE_CHANGE_SIGNAL_INVALID");
  if (signal.pathsHint !== undefined && (signal.pathsHint.length > 10_000 || signal.pathsHint.some((path) =>
    typeof path !== "string" || !safeHintPath(path)))) {
    throw new Error("KNOWLEDGE_CHANGE_SIGNAL_INVALID");
  }
}

export class KnowledgeChangeIntake {
  readonly #database: DatabaseSync;
  readonly #source: KnowledgeChangeSourcePort;
  readonly #jobs: KnowledgeRevalidateJobPort;
  readonly #clock: () => Date;
  readonly #timerPort: KnowledgeChangeTimerPort;
  readonly #debounceMs: number;
  readonly #fallbackIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #recipeSelectionHash: (projectId: string) => string;
  readonly #pendingSignals = new Map<string, number>();
  readonly #projects = new Map<string, string>();
  #timer: KnowledgeChangeTimerHandle | undefined;
  #tail: Promise<KnowledgeChangeCycleResult> | undefined;
  #started = false;
  #closed = false;
  #generation = 0;
  #completedCycles = 0;
  #failedCycles = 0;
  #lastReasonCode: string | undefined;

  constructor(databasePath: string, options: KnowledgeChangeIntakeOptions) {
    this.#source = options.source;
    this.#jobs = options.jobs;
    this.#clock = options.clock ?? (() => new Date());
    this.#timerPort = options.timer ?? new NodeKnowledgeChangeTimer();
    this.#debounceMs = bounded(options.debounceMs, 500, 0, 60_000, "DEBOUNCE_MS");
    this.#fallbackIntervalMs = bounded(options.fallbackIntervalMs, 60_000, 100, 86_400_000, "FALLBACK_INTERVAL_MS");
    this.#maxAttempts = bounded(options.maxAttempts, 5, 1, 1_000, "MAX_ATTEMPTS");
    this.#recipeSelectionHash = options.recipeSelectionHash ?? (() => DEFAULT_RECIPE_SELECTION_HASH);
    const observed = options.source.observedProjects();
    if (observed.length > MAX_PROJECTS) throw new Error("KNOWLEDGE_CHANGE_PROJECT_LIMIT_EXCEEDED");
    for (const project of observed) {
      if (!safeId(project.projectId) || !safeRoot(project.repositoryRoot) || this.#projects.has(project.projectId)) {
        throw new Error("KNOWLEDGE_CHANGE_PROJECT_REGISTRY_CORRUPT");
      }
      this.#projects.set(project.projectId, project.repositoryRoot);
    }
    this.#database = new DatabaseSync(databasePath);
    try {
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(databasePath, 0o600);
      this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_change_schedules(
          project_id TEXT PRIMARY KEY, repository_root TEXT NOT NULL,
          next_scan_at_ms INTEGER NOT NULL CHECK(next_scan_at_ms >= 0), updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS knowledge_change_intake_meta(
          component TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS knowledge_change_live_revisions(
          project_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('PENDING','CURRENT')),
          code_revision TEXT, graph_revision TEXT, reason_code TEXT NOT NULL, updated_at TEXT NOT NULL,
          CHECK((status='CURRENT')=(code_revision IS NOT NULL))
        ) STRICT;
        INSERT INTO knowledge_change_intake_meta(component, version) VALUES ('intake', 1)
          ON CONFLICT(component) DO UPDATE SET version=MAX(version, excluded.version);
      `);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error("KNOWLEDGE_CHANGE_INTAKE_CLOSED"); }

  observeProject(projectId: string, repositoryRoot: string): void {
    this.#assertOpen();
    if (!safeId(projectId) || !safeRoot(repositoryRoot)) throw new Error("KNOWLEDGE_CHANGE_PROJECT_INVALID");
    this.#source.observe(projectId, repositoryRoot);
    this.#projects.set(projectId, repositoryRoot);
    const time = now(this.#clock);
    const existing = this.#database.prepare("SELECT repository_root FROM knowledge_change_schedules WHERE project_id=?")
      .get(projectId) as { readonly repository_root: string } | undefined;
    if (existing !== undefined && existing.repository_root !== repositoryRoot) throw new Error("KNOWLEDGE_CHANGE_PROJECT_ROOT_CONFLICT");
    this.#database.prepare(`INSERT INTO knowledge_change_schedules(project_id, repository_root, next_scan_at_ms, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET updated_at=excluded.updated_at`)
      .run(projectId, repositoryRoot, existing === undefined ? time.epochMs : time.epochMs + this.#fallbackIntervalMs, time.iso);
    this.#database.prepare(`INSERT INTO knowledge_change_live_revisions
      (project_id,status,code_revision,graph_revision,reason_code,updated_at) VALUES (?,'PENDING',NULL,NULL,'INITIAL_SCAN_REQUIRED',?)
      ON CONFLICT(project_id) DO NOTHING`).run(projectId, time.iso);
    if (this.#started) this.#scheduleNext();
  }

  notify(signal: KnowledgeChangeSignal): void {
    this.#assertOpen();
    validateSignal(signal);
    if (this.#projects.get(signal.projectId) !== signal.repositoryRoot) throw new Error("KNOWLEDGE_CHANGE_PROJECT_NOT_OBSERVED");
    const dueAt = now(this.#clock).epochMs + this.#debounceMs;
    this.#pendingSignals.set(signal.projectId, dueAt);
    this.#markRevisionPending(signal.projectId, `SIGNAL_${signal.source}`);
    const updatedAt = now(this.#clock).iso;
    const scheduled = this.#database.prepare(`UPDATE knowledge_change_schedules SET next_scan_at_ms=MIN(next_scan_at_ms,?),updated_at=?
      WHERE project_id=?`).run(dueAt, updatedAt, signal.projectId);
    if (scheduled.changes !== 1) throw new Error("KNOWLEDGE_CHANGE_SCHEDULE_MISSING");
    if (this.#started) this.#scheduleNext();
  }

  state(): KnowledgeChangeIntakeState {
    this.#assertOpen();
    return Object.freeze({
      status: !this.#started ? "STOPPED" : this.#lastReasonCode === undefined ? "READY" : "DEGRADED",
      pendingSignals: this.#pendingSignals.size,
      running: this.#tail !== undefined,
      completedCycles: this.#completedCycles,
      failedCycles: this.#failedCycles,
      ...(this.#lastReasonCode === undefined ? {} : { lastReasonCode: this.#lastReasonCode }),
    });
  }

  read(projectId: string): { readonly projectId: string; readonly codeRevision: string; readonly graphRevision?: string } | undefined {
    const state = this.liveRevisionState(projectId);
    return state?.status !== "CURRENT" || state.codeRevision === undefined ? undefined : Object.freeze({
      projectId, codeRevision: state.codeRevision, ...(state.graphRevision === undefined ? {} : { graphRevision: state.graphRevision }),
    });
  }

  liveRevisionState(projectId: string): KnowledgeLiveRevisionState | undefined {
    this.#assertOpen();
    if (!safeId(projectId)) throw new Error("KNOWLEDGE_CHANGE_PROJECT_INVALID");
    const row = this.#database.prepare("SELECT * FROM knowledge_change_live_revisions WHERE project_id=?").get(projectId) as
      { project_id: string; status: "PENDING" | "CURRENT"; code_revision: string | null; graph_revision: string | null;
        reason_code: string; updated_at: string } | undefined;
    return row === undefined ? undefined : Object.freeze({ projectId: row.project_id, status: row.status,
      ...(row.code_revision === null ? {} : { codeRevision: row.code_revision }),
      ...(row.graph_revision === null ? {} : { graphRevision: row.graph_revision }),
      reasonCode: row.reason_code, updatedAt: row.updated_at });
  }

  updateGraphRevision(projectId: string, codeRevision: string, graphRevision: string): void {
    this.#assertOpen();
    if (!safeId(projectId) || codeRevision.length < 1 || codeRevision.length > 4_096 || CONTROL.test(codeRevision)
      || graphRevision.length < 1 || graphRevision.length > 4_096 || CONTROL.test(graphRevision)) {
      throw new Error("KNOWLEDGE_CHANGE_GRAPH_REVISION_INVALID");
    }
    const time = now(this.#clock);
    const update = this.#database.prepare(`UPDATE knowledge_change_live_revisions SET graph_revision=?,reason_code='GRAPH_REVISION_CONFIRMED',updated_at=?
      WHERE project_id=? AND status='CURRENT' AND code_revision=?`).run(graphRevision, time.iso, projectId, codeRevision);
    if (update.changes !== 1) throw new Error("KNOWLEDGE_CHANGE_GRAPH_REVISION_CONFLICT");
  }

  async start(): Promise<void> {
    this.#assertOpen();
    if (this.#started) return;
    this.#started = true;
    this.#generation += 1;
    const time = now(this.#clock);
    for (const [projectId, repositoryRoot] of [...this.#projects].sort(([left], [right]) => left.localeCompare(right))) {
      const existing = this.#database.prepare("SELECT repository_root FROM knowledge_change_schedules WHERE project_id=?")
        .get(projectId) as { readonly repository_root: string } | undefined;
      if (existing !== undefined && existing.repository_root !== repositoryRoot) {
        this.#started = false;
        throw new Error("KNOWLEDGE_CHANGE_PROJECT_ROOT_CONFLICT");
      }
      this.#database.prepare(`INSERT INTO knowledge_change_schedules(project_id, repository_root, next_scan_at_ms, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING`)
        .run(projectId, repositoryRoot, existing === undefined ? time.epochMs : time.epochMs + this.#fallbackIntervalMs, time.iso);
      this.#database.prepare(`INSERT INTO knowledge_change_live_revisions
        (project_id,status,code_revision,graph_revision,reason_code,updated_at) VALUES (?,'PENDING',NULL,NULL,'RECOVERY_SCAN_REQUIRED',?)
        ON CONFLICT(project_id) DO NOTHING`).run(projectId, time.iso);
    }
    try { await this.#runCycle(false); }
    catch { /* State and retry scheduling are recorded by #runCycle. */ }
    this.#scheduleNext();
  }

  async flush(): Promise<KnowledgeChangeCycleResult> {
    this.#assertOpen();
    return await this.#runCycle(true);
  }

  /** Synchronously attaches already-observed immutable changes to durable jobs; it never scans Git. */
  enqueuePending(projectId: string): readonly string[] {
    this.#assertOpen();
    if (!safeId(projectId) || !this.#projects.has(projectId)) throw new Error("KNOWLEDGE_CHANGE_PROJECT_NOT_OBSERVED");
    return Object.freeze(this.#enqueuePending(new Set<string>(), projectId).jobIds);
  }

  async stop(): Promise<void> {
    if (this.#closed || !this.#started) return;
    this.#started = false;
    this.#generation += 1;
    this.#timer?.cancel();
    this.#timer = undefined;
    const tail = this.#tail;
    if (tail !== undefined) await tail.catch(() => undefined);
  }

  close(): void {
    if (this.#closed) return;
    if (this.#started || this.#tail !== undefined) throw new Error("KNOWLEDGE_CHANGE_INTAKE_MUST_STOP_FIRST");
    this.#timer?.cancel();
    this.#database.close();
    this.#closed = true;
  }

  async #runCycle(forceAll: boolean): Promise<KnowledgeChangeCycleResult> {
    if (this.#tail !== undefined) {
      const result = await this.#tail;
      return forceAll ? await this.#runCycle(true) : result;
    }
    const tail = this.#performCycle(forceAll);
    this.#tail = tail;
    try {
      const result = await tail;
      this.#completedCycles += 1;
      this.#lastReasonCode = undefined;
      return result;
    } catch (error) {
      this.#failedCycles += 1;
      this.#lastReasonCode = error instanceof Error ? error.message.slice(0, 200) : "KNOWLEDGE_CHANGE_CYCLE_FAILED";
      this.#deferFailedWakeups();
      throw error;
    } finally {
      if (this.#tail === tail) this.#tail = undefined;
    }
  }

  async #performCycle(forceAll: boolean): Promise<KnowledgeChangeCycleResult> {
    const time = now(this.#clock);
    const schedules = this.#scheduleRows();
    const dueProjects = new Set(forceAll ? schedules.map((row) => row.project_id) : schedules
      .filter((row) => row.next_scan_at_ms <= time.epochMs || (this.#pendingSignals.get(row.project_id) ?? Infinity) <= time.epochMs)
      .map((row) => row.project_id));
    const recovered = this.#enqueuePending();
    let scanFailure: unknown;
    for (const projectId of dueProjects) {
      try {
        this.#markRevisionPending(projectId, "AUTHORITATIVE_SCAN_RUNNING");
        const changes = await this.#source.scanProject(projectId);
        const baseline = this.#source.baseline?.(projectId);
        const codeRevision = changes !== undefined && typeof changes === "object" && changes !== null && "sourceRef" in changes
          ? String(changes.sourceRef)
          : baseline === undefined ? undefined : `git:${baseline.head}:${baseline.statusFingerprint}`;
        if (codeRevision === undefined) throw new Error("KNOWLEDGE_CHANGE_CURRENT_REVISION_UNAVAILABLE");
        this.#confirmRevision(projectId, codeRevision);
      }
      catch (error) { scanFailure ??= error; }
    }
    const discovered = this.#enqueuePending(recovered.seenObservationIds);
    if (scanFailure !== undefined) throw scanFailure;
    const updated = now(this.#clock);
    const update = this.#database.prepare("UPDATE knowledge_change_schedules SET next_scan_at_ms=?, updated_at=? WHERE project_id=?");
    for (const projectId of dueProjects) {
      update.run(updated.epochMs + this.#fallbackIntervalMs, updated.iso, projectId);
      this.#pendingSignals.delete(projectId);
    }
    return Object.freeze({
      scannedProjects: dueProjects.size,
      enqueuedJobs: recovered.enqueuedJobs + discovered.enqueuedJobs,
      reusedJobs: recovered.reusedJobs + discovered.reusedJobs,
    });
  }

  #enqueuePending(seenObservationIds = new Set<string>(), projectId?: string): {
    readonly enqueuedJobs: number;
    readonly reusedJobs: number;
    readonly seenObservationIds: Set<string>;
    readonly jobIds: string[];
  } {
    let after: string | undefined;
    let enqueuedJobs = 0;
    let reusedJobs = 0;
    const jobIds: string[] = [];
    for (;;) {
      const page = this.#source.listPending(1_000, projectId, after);
      for (const item of page) {
        if (seenObservationIds.has(item.observationId)) continue;
        seenObservationIds.add(item.observationId);
        const recipeSelectionHash = this.#recipeSelectionHash(item.projectId);
        if (!safeHash(recipeSelectionHash)) throw new Error("KNOWLEDGE_CHANGE_RECIPE_SELECTION_HASH_INVALID");
        const input: KnowledgeRevalidateJobInput = Object.freeze({
          schemaVersion: 1,
          jobType: "KNOWLEDGE_REVALIDATE",
          projectId: item.projectId,
          repositoryRoot: item.repositoryRoot,
          sourceRef: item.sourceRef,
          changeSetHash: item.observationHash,
          recipeSelectionHash,
        });
        const result = this.#jobs.enqueue(input, this.#maxAttempts);
        jobIds.push(result.job.snapshot.jobId);
        if (result.status === "CREATED") enqueuedJobs += 1;
        else reusedJobs += 1;
      }
      if (page.length < 1_000) break;
      after = page[page.length - 1]!.observationId;
    }
    return { enqueuedJobs, reusedJobs, seenObservationIds, jobIds };
  }

  #scheduleRows(): readonly ScheduleRow[] {
    const rows = this.#database.prepare("SELECT * FROM knowledge_change_schedules ORDER BY project_id LIMIT 1001")
      .all() as unknown as ScheduleRow[];
    if (rows.length > MAX_PROJECTS) throw new Error("KNOWLEDGE_CHANGE_PROJECT_LIMIT_EXCEEDED");
    return rows;
  }

  #deferFailedWakeups(): void {
    const time = now(this.#clock);
    const retryAt = time.epochMs + Math.max(100, this.#debounceMs);
    this.#database.prepare("UPDATE knowledge_change_schedules SET next_scan_at_ms=?, updated_at=? WHERE next_scan_at_ms<=?")
      .run(retryAt, time.iso, time.epochMs);
    for (const [projectId, dueAt] of this.#pendingSignals) {
      if (dueAt <= time.epochMs) this.#pendingSignals.set(projectId, retryAt);
    }
  }

  #markRevisionPending(projectId: string, reasonCode: string): void {
    const time = now(this.#clock);
    const update = this.#database.prepare(`UPDATE knowledge_change_live_revisions SET status='PENDING',code_revision=NULL,
      graph_revision=NULL,reason_code=?,updated_at=? WHERE project_id=?`).run(reasonCode, time.iso, projectId);
    if (update.changes !== 1) throw new Error("KNOWLEDGE_CHANGE_LIVE_REVISION_MISSING");
  }

  #confirmRevision(projectId: string, codeRevision: string): void {
    if (codeRevision.length < 1 || codeRevision.length > 4_096 || CONTROL.test(codeRevision)) {
      throw new Error("KNOWLEDGE_CHANGE_CURRENT_REVISION_INVALID");
    }
    const time = now(this.#clock);
    const update = this.#database.prepare(`UPDATE knowledge_change_live_revisions SET status='CURRENT',code_revision=?,
      graph_revision=NULL,reason_code='GIT_REVISION_CONFIRMED',updated_at=? WHERE project_id=?`).run(codeRevision, time.iso, projectId);
    if (update.changes !== 1) throw new Error("KNOWLEDGE_CHANGE_LIVE_REVISION_MISSING");
  }

  #scheduleNext(): void {
    if (!this.#started || this.#closed) return;
    this.#timer?.cancel();
    const schedules = this.#scheduleRows();
    const deadlines = [
      ...schedules.map((row) => row.next_scan_at_ms),
      ...this.#pendingSignals.values(),
    ];
    if (deadlines.length === 0) { this.#timer = undefined; return; }
    const delay = Math.max(0, Math.min(...deadlines) - now(this.#clock).epochMs);
    const generation = this.#generation;
    this.#timer = this.#timerPort.schedule(delay, () => {
      this.#timer = undefined;
      if (!this.#started || generation !== this.#generation) return;
      void this.#runCycle(false).catch(() => undefined).finally(() => {
        if (this.#started && generation === this.#generation) this.#scheduleNext();
      });
    });
  }
}
