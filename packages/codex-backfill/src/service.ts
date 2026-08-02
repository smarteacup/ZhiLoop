import { createHash } from "node:crypto";

import type { EventEnvelope } from "@zhiloop/domain";
import { canonicalStringify, CodexAppServerEventAdapter } from "@zhiloop/ingestion-codex";

import type {
  BackfillCheckpointStore,
  BackfillEventSink,
  BackfillPolicy,
  BackfillReport,
  BackfillRequest,
  BackfillScope,
  BackfillSkipReason,
  BackfillThreadPlan,
  CodexHistoryPort,
  HistoricalThread,
  HistoricalThreadSummary,
  ProcessedThreadPort,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_THREADS = 1_000;
const MAX_MAX_THREADS = 100_000;
const DEFAULT_MAX_THREAD_BYTES = 16 * 1024 * 1024;
const MAX_THREAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_TURNS = 2;
const DEFAULT_SOURCE_KINDS = ["cli", "vscode", "appServer"] as const;
const DEFAULT_SENSITIVE_TERMS = ["password", "secret", "token", "credential", "密码", "密钥"] as const;
const SAFE_SOURCE_KIND = /^[A-Za-z][A-Za-z0-9]{0,99}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

interface NormalizedRequest {
  readonly scope: BackfillScope;
  readonly dryRun: boolean;
  readonly archived: boolean;
  readonly sourceKinds: readonly string[];
  readonly pageSize: number;
  readonly maxThreads: number;
  readonly maxThreadBytes: number;
  readonly policy: Required<BackfillPolicy>;
  readonly signal?: AbortSignal;
}

interface Counters {
  scannedThreads: number;
  eligibleThreads: number;
  processedThreads: number;
  skippedThreads: number;
  appendedEvents: number;
  duplicateEvents: number;
  estimatedBytes: number;
}

interface Evaluation {
  readonly plan: BackfillThreadPlan;
  readonly thread?: HistoricalThread;
  readonly skipReason?: BackfillSkipReason;
}

function uniqueSorted(values: readonly string[], field: string): readonly string[] {
  const result = [...new Set(values)].sort();
  if (result.some((value) => typeof value !== "string" || value.trim().length === 0 || value.length > 1_000 || /[\0\r\n]/u.test(value))) {
    throw new Error(`${field} contains an invalid value`);
  }
  return Object.freeze(result);
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${field} must be between 1 and ${maximum}`);
  return resolved;
}

function normalizeScope(scope: BackfillScope): BackfillScope {
  if (scope === null || typeof scope !== "object" || (scope.level !== "PROJECT" && scope.level !== "GLOBAL")) throw new Error("backfill scope is invalid");
  if (scope.level === "PROJECT" && (!SAFE_IDENTIFIER.test(scope.projectId ?? "") || typeof scope.cwd !== "string" || scope.cwd.length === 0)) {
    throw new Error("PROJECT backfill requires projectId and cwd");
  }
  if (scope.level === "GLOBAL" && scope.projectId !== undefined) throw new Error("GLOBAL backfill cannot contain projectId");
  if (scope.cwd !== undefined && (scope.cwd.length > 4_000 || (!scope.cwd.startsWith("/") && !WINDOWS_ABSOLUTE_PATH.test(scope.cwd)) || /[\0\r\n]/u.test(scope.cwd))) throw new Error("backfill scope cwd is invalid");
  return Object.freeze({ level: scope.level, ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }), ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }) });
}

function normalizeRequest(request: BackfillRequest): NormalizedRequest {
  const scope = normalizeScope(request.scope);
  if (request.dryRun !== undefined && typeof request.dryRun !== "boolean") throw new Error("dryRun must be a boolean");
  if (request.archived !== undefined && typeof request.archived !== "boolean") throw new Error("archived must be a boolean");
  const sourceKinds = uniqueSorted(request.sourceKinds ?? DEFAULT_SOURCE_KINDS, "sourceKinds");
  if (sourceKinds.length < 1 || sourceKinds.some((kind) => !SAFE_SOURCE_KIND.test(kind))) throw new Error("sourceKinds is invalid");
  const policy = request.policy ?? {};
  const minTurns = positiveInteger(policy.minTurns, DEFAULT_MIN_TURNS, 10_000, "minTurns");
  return Object.freeze({
    scope,
    dryRun: request.dryRun ?? true,
    archived: request.archived ?? false,
    sourceKinds,
    pageSize: positiveInteger(request.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, "pageSize"),
    maxThreads: positiveInteger(request.maxThreads, DEFAULT_MAX_THREADS, MAX_MAX_THREADS, "maxThreads"),
    maxThreadBytes: positiveInteger(request.maxThreadBytes, DEFAULT_MAX_THREAD_BYTES, MAX_THREAD_BYTES, "maxThreadBytes"),
    policy: Object.freeze({
      minTurns,
      sensitiveThreadIds: uniqueSorted(policy.sensitiveThreadIds ?? [], "sensitiveThreadIds"),
      sensitivePreviewTerms: uniqueSorted(policy.sensitivePreviewTerms ?? DEFAULT_SENSITIVE_TERMS, "sensitivePreviewTerms"),
      sensitiveCwdPrefixes: uniqueSorted(policy.sensitiveCwdPrefixes ?? [], "sensitiveCwdPrefixes"),
    }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function requestHash(request: NormalizedRequest): string {
  return createHash("sha256").update(canonicalStringify({
    scope: request.scope,
    archived: request.archived,
    sourceKinds: request.sourceKinds,
    pageSize: request.pageSize,
    maxThreadBytes: request.maxThreadBytes,
    policy: request.policy,
  })).digest("hex");
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new Error("App Server history contains non-JSON data");
  }
}

function assertSummary(value: HistoricalThreadSummary): void {
  if (value === null || typeof value !== "object" || !SAFE_IDENTIFIER.test(value.id) || typeof value.preview !== "string" || typeof value.cwd !== "string"
    || (!value.cwd.startsWith("/") && !WINDOWS_ABSOLUTE_PATH.test(value.cwd))) {
    throw new Error("thread/list returned an invalid thread summary");
  }
  if (!Number.isFinite(value.createdAt) || value.createdAt < 0 || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    throw new Error("thread/list returned invalid timestamps");
  }
}

function pathWithin(path: string, prefix: string): boolean {
  const portable = (value: string): string => {
    const replaced = value.replaceAll("\\", "/");
    const normalized = replaced.endsWith("/") && replaced.length > 1 ? replaced.slice(0, -1) : replaced;
    return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase("en-US") : normalized;
  };
  const normalizedPath = portable(path);
  const normalizedPrefix = portable(prefix);
  if (normalizedPrefix === "/") return normalizedPath.startsWith("/");
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function sensitive(summary: HistoricalThreadSummary, policy: Required<BackfillPolicy>): boolean {
  if (policy.sensitiveThreadIds.includes(summary.id)) return true;
  if (policy.sensitiveCwdPrefixes.some((prefix) => pathWithin(summary.cwd, prefix))) return true;
  const preview = summary.preview.toLocaleLowerCase("en-US");
  return policy.sensitivePreviewTerms.some((term) => preview.includes(term.toLocaleLowerCase("en-US")));
}

function outOfScope(summary: HistoricalThreadSummary, scope: BackfillScope): boolean {
  return scope.level === "PROJECT" && !pathWithin(summary.cwd, scope.cwd as string);
}

function terminalTurn(turn: unknown): boolean {
  if (turn === null || typeof turn !== "object" || Array.isArray(turn)) throw new Error("thread/read returned an invalid turn");
  const status = (turn as Record<string, unknown>)["status"];
  if (typeof status !== "string") throw new Error("thread/read turn status is invalid");
  return status !== "inProgress";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function report(
  request: NormalizedRequest,
  threads: readonly BackfillThreadPlan[],
  counters: Counters,
  status: BackfillReport["status"],
  resumed: boolean,
  runId?: string,
  pauseReason?: BackfillReport["pauseReason"],
  nextCursor?: string,
): BackfillReport {
  return Object.freeze({
    ...(runId === undefined ? {} : { runId }),
    dryRun: request.dryRun,
    resumed,
    status,
    ...(pauseReason === undefined ? {} : { pauseReason }),
    scope: request.scope,
    threads: Object.freeze([...threads]),
    ...counters,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function notificationsForThread(thread: HistoricalThread): readonly unknown[] {
  const notifications: unknown[] = [{ method: "thread/started", params: { thread } }];
  for (const rawTurn of thread.turns) {
    if (rawTurn === null || typeof rawTurn !== "object" || Array.isArray(rawTurn)) throw new Error("thread/read returned an invalid turn");
    const turn = rawTurn as Record<string, unknown>;
    const turnId = turn["id"];
    const items = turn["items"];
    if (typeof turnId !== "string" || turnId.length === 0 || !Array.isArray(items)) throw new Error("thread/read returned an invalid turn identity or items");
    const startedAt = typeof turn["startedAt"] === "number" && Number.isFinite(turn["startedAt"]) ? turn["startedAt"] : thread.createdAt;
    const completedAt = typeof turn["completedAt"] === "number" && Number.isFinite(turn["completedAt"]) ? turn["completedAt"] : startedAt;
    for (const rawItem of items) {
      if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) throw new Error("thread/read returned an invalid item");
      const item = rawItem as Record<string, unknown>;
      notifications.push({
        method: "item/completed",
        params: { threadId: thread.id, turnId, completedAtMs: (item["type"] === "userMessage" ? startedAt : completedAt) * 1_000, item },
      });
    }
    notifications.push({ method: "turn/completed", params: { threadId: thread.id, turn } });
  }
  return Object.freeze(notifications);
}

function projectEvents(thread: HistoricalThread): readonly EventEnvelope[] {
  const adapter = new CodexAppServerEventAdapter({ ...(thread.cliVersion === undefined ? {} : { sourceVersion: thread.cliVersion }) });
  const events: EventEnvelope[] = [];
  for (const notification of notificationsForThread(thread)) {
    const result = adapter.adapt(notification);
    if (!result.ok) throw new Error(`historical thread ${thread.id} cannot be adapted: ${result.error.code}: ${result.error.message}`);
    events.push(...result.value.events);
  }
  return Object.freeze(events);
}

export interface CodexBackfillServiceOptions {
  readonly checkpoint?: BackfillCheckpointStore;
  readonly eventSink?: BackfillEventSink;
  readonly processedThreads?: ProcessedThreadPort;
}

export class CodexBackfillService {
  readonly #history: CodexHistoryPort;
  readonly #checkpoint: BackfillCheckpointStore | undefined;
  readonly #eventSink: BackfillEventSink | undefined;
  readonly #processedThreads: ProcessedThreadPort | undefined;

  constructor(history: CodexHistoryPort, options: CodexBackfillServiceOptions = {}) {
    this.#history = history;
    this.#checkpoint = options.checkpoint;
    this.#eventSink = options.eventSink;
    this.#processedThreads = options.processedThreads;
  }

  async execute(input: BackfillRequest): Promise<BackfillReport> {
    const request = normalizeRequest(input);
    if (!request.dryRun && (this.#checkpoint === undefined || this.#eventSink === undefined)) {
      throw new Error("live backfill requires checkpoint and eventSink ports");
    }
    const scopeKey = canonicalStringify(request.scope);
    const started = request.dryRun ? undefined : (this.#checkpoint as BackfillCheckpointStore).startOrResume(requestHash(request), scopeKey);
    const runId = started?.checkpoint.runId;
    let cursor = started?.checkpoint.cursor;
    const seenCursors = new Set<string>();
    const seenThreads = new Set<string>();
    const plans: BackfillThreadPlan[] = [];
    const counters: Counters = { scannedThreads: 0, eligibleThreads: 0, processedThreads: 0, skippedThreads: 0, appendedEvents: 0, duplicateEvents: 0, estimatedBytes: 0 };
    let handled = 0;

    while (true) {
      if (isAborted(request.signal)) return report(request, plans, counters, "PAUSED", started?.resumed ?? false, runId, "ABORTED", cursor);
      const page = await this.#history.listThreads({
        ...(cursor === undefined ? {} : { cursor }),
        limit: request.pageSize,
        archived: request.archived,
        sourceKinds: request.sourceKinds,
        ...(request.scope.cwd === undefined ? {} : { cwd: request.scope.cwd }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (!Array.isArray(page.data)) throw new Error("thread/list returned invalid data");
      if (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || page.nextCursor.length === 0)) throw new Error("thread/list returned an invalid cursor");

      for (const summary of page.data) {
        assertSummary(summary);
        counters.scannedThreads += 1;
        if (seenThreads.has(summary.id)) {
          const duplicatePlan = { threadId: summary.id, cwd: summary.cwd, estimatedBytes: jsonBytes(summary), decision: "DUPLICATE_LISTING" as const };
          plans.push(Object.freeze(duplicatePlan)); counters.skippedThreads += 1; continue;
        }
        seenThreads.add(summary.id);
        const checkpointStatus = runId === undefined ? undefined : (this.#checkpoint as BackfillCheckpointStore).threadStatus(runId, summary.id);
        if (checkpointStatus === "COMPLETED" || checkpointStatus === "SKIPPED") {
          plans.push(Object.freeze({ threadId: summary.id, cwd: summary.cwd, estimatedBytes: jsonBytes(summary), decision: "ALREADY_PROCESSED" }));
          counters.skippedThreads += 1; continue;
        }
        if (handled >= request.maxThreads) return report(request, plans, counters, "PAUSED", started?.resumed ?? false, runId, "MAX_THREADS", cursor);
        handled += 1;
        if (isAborted(request.signal)) return report(request, plans, counters, "PAUSED", started?.resumed ?? false, runId, "ABORTED", cursor);
        if (runId !== undefined) (this.#checkpoint as BackfillCheckpointStore).markThread(runId, summary.id, "PROCESSING");
        const evaluation = await this.#evaluate(summary, request);
        plans.push(evaluation.plan);
        counters.estimatedBytes += evaluation.plan.estimatedBytes;
        if (evaluation.skipReason !== undefined) {
          counters.skippedThreads += 1;
          if (runId !== undefined) (this.#checkpoint as BackfillCheckpointStore).markThread(runId, summary.id, "SKIPPED", evaluation.skipReason);
          continue;
        }
        counters.eligibleThreads += 1;
        if (request.dryRun) continue;
        const events = projectEvents(evaluation.thread as HistoricalThread);
        for (const event of events) {
          const append = (this.#eventSink as BackfillEventSink).append(event);
          if (append.status === "appended") counters.appendedEvents += 1;
          else counters.duplicateEvents += 1;
        }
        counters.processedThreads += 1;
        (this.#checkpoint as BackfillCheckpointStore).markThread(runId as string, summary.id, "COMPLETED");
      }

      const nextCursor = page.nextCursor;
      if (nextCursor !== undefined && (nextCursor === cursor || seenCursors.has(nextCursor))) throw new Error("thread/list cursor loop detected");
      if (runId !== undefined) (this.#checkpoint as BackfillCheckpointStore).advance(runId, cursor, nextCursor);
      if (nextCursor === undefined) {
        if (runId !== undefined) (this.#checkpoint as BackfillCheckpointStore).complete(runId, nextCursor);
        return report(request, plans, counters, request.dryRun ? "DRY_RUN" : "COMPLETED", started?.resumed ?? false, runId);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async #evaluate(summary: HistoricalThreadSummary, request: NormalizedRequest): Promise<Evaluation> {
    const summaryBytes = jsonBytes(summary);
    const skip = (reason: BackfillSkipReason): Evaluation => ({
      plan: Object.freeze({ threadId: summary.id, cwd: summary.cwd, estimatedBytes: summaryBytes, decision: reason }),
      skipReason: reason,
    });
    if (outOfScope(summary, request.scope)) return skip("OUT_OF_SCOPE");
    if (sensitive(summary, request.policy)) return skip("SENSITIVE_SESSION");
    if (await this.#processedThreads?.isProcessed(summary.id) === true) return skip("ALREADY_PROCESSED");
    const thread = await this.#history.readThread(summary.id, request.signal);
    if (thread.id !== summary.id || thread.cwd !== summary.cwd || !Array.isArray(thread.turns)) throw new Error("thread/read response does not match thread/list summary");
    const estimatedBytes = jsonBytes(thread);
    if (estimatedBytes > request.maxThreadBytes) return { plan: Object.freeze({ threadId: summary.id, cwd: summary.cwd, turnCount: thread.turns.length, estimatedBytes, decision: "OVERSIZED_SESSION" }), skipReason: "OVERSIZED_SESSION" };
    if (thread.turns.some((turn) => !terminalTurn(turn))) return { plan: Object.freeze({ threadId: summary.id, cwd: summary.cwd, turnCount: thread.turns.length, estimatedBytes, decision: "ACTIVE_SESSION" }), skipReason: "ACTIVE_SESSION" };
    if (thread.turns.length < request.policy.minTurns) return { plan: Object.freeze({ threadId: summary.id, cwd: summary.cwd, turnCount: thread.turns.length, estimatedBytes, decision: "SHORT_SESSION" }), skipReason: "SHORT_SESSION" };
    return { plan: Object.freeze({ threadId: summary.id, cwd: summary.cwd, turnCount: thread.turns.length, estimatedBytes, decision: "ELIGIBLE" }), thread };
  }
}
