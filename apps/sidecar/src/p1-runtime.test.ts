import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CaptureSessionReport } from "@zhiloop/codex-session-capture";
import { CodexHookHandler } from "@zhiloop/hook-runtime";
import type {
  SessionCatalogEntry,
  SessionCatalogListRequest,
  SessionCatalogListResult,
  SessionCatalogQueryPort,
} from "@zhiloop/session-catalog";

import {
  DEFAULT_P1_RUNTIME_CONFIGURATION,
  P1SidecarRuntime,
  type P1RuntimeConfiguration,
  type P1TimerHandle,
  type P1TimerPort,
} from "./p1-runtime.js";

const BASE_TIME = "2026-08-03T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

class ManualTimer implements P1TimerPort {
  readonly entries: Array<{ readonly delayMs: number; readonly task: () => void; cancelled: boolean }> = [];

  schedule(delayMs: number, task: () => void): P1TimerHandle {
    const entry = { delayMs, task, cancelled: false };
    this.entries.push(entry);
    return Object.freeze({ cancel: () => { entry.cancelled = true; } });
  }

  activeDelays(): number[] {
    return this.entries.filter(({ cancelled }) => !cancelled).map(({ delayMs }) => delayMs).sort((left, right) => left - right);
  }

  fire(delayMs: number): void {
    const entry = this.entries.find((candidate) => !candidate.cancelled && candidate.delayMs === delayMs);
    if (entry === undefined) throw new Error(`no active ${delayMs}ms timer`);
    entry.cancelled = true;
    entry.task();
  }
}

function entry(sessionId: string): SessionCatalogEntry {
  return Object.freeze({
    schemaVersion: 1,
    sessionId,
    title: sessionId,
    titleSource: "SESSION_ID",
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    sourceFormatVersion: "jsonl-v1",
    safeSourceAlias: `session-${sessionId}`,
    captureStatus: "DISCOVERED_NOT_CAPTURED",
    firstActivityAt: BASE_TIME,
    lastActivityAt: BASE_TIME,
    timeGroup: "TODAY",
    eventCount: 0,
    turnCount: 0,
    ignoredRecords: 0,
    redactionCount: 0,
  });
}

class Catalog implements SessionCatalogQueryPort {
  readonly list = vi.fn(async (request: SessionCatalogListRequest = {}): Promise<SessionCatalogListResult> => ({
    items: request.after === undefined ? [entry("session-1")] : [],
    sourceCapabilities: [],
    diagnostics: [],
    revision: "catalog-1",
    changed: true,
  }));

  async get(sessionId: string): Promise<SessionCatalogEntry | undefined> {
    return sessionId === "session-1" ? entry(sessionId) : undefined;
  }
}

function captureReport(sessionId: string): CaptureSessionReport {
  return Object.freeze({
    schemaVersion: 1,
    status: "CAPTURED",
    sessionId,
    transcriptPath: `/safe/${sessionId}.jsonl`,
    batches: 1,
    projectedEvents: 1,
    appendedEvents: 1,
    duplicateEvents: 0,
    ignoredRecords: 0,
    eventTypes: Object.freeze({ "conversation.user_message": 1 }),
    sampledEvents: Object.freeze([]),
    sampledEventsTruncated: false,
    appendedEventIds: Object.freeze([`event-${sessionId}`]),
    duplicateEventIds: Object.freeze([]),
    eventIdsTruncated: false,
    cursor: Object.freeze({ byteOffset: 100, lineNumber: 2 }),
    hasMore: false,
    knowledgeCompiled: false,
  });
}

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zhiloop-p1-runtime-"));
  directories.push(directory);
  return directory;
}

function configuration(overrides: Partial<P1RuntimeConfiguration> = {}): P1RuntimeConfiguration {
  return {
    ...DEFAULT_P1_RUNTIME_CONFIGURATION,
    sessionScanIntervalMs: 5_000,
    workerPollIntervalMs: 100,
    ...overrides,
    captureRetry: { ...DEFAULT_P1_RUNTIME_CONFIGURATION.captureRetry, ...overrides.captureRetry },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("P1SidecarRuntime", () => {
  it("keeps background work off the hook path and runs automatic scan as a durable, safely projected job", async () => {
    const timer = new ManualTimer();
    const catalog = new Catalog();
    const capture = vi.fn(async ({ sessionId }: { readonly sessionId: string }) => captureReport(sessionId));
    const projections: unknown[] = [];
    const reports: unknown[] = [];
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog,
      capture: { capture },
      projectJob: (snapshot) => { projections.push(snapshot); },
      onIngestionReport: (report) => { reports.push(report); },
      configuration: configuration(),
      timer,
      now: () => new Date(BASE_TIME),
      workerId: "test-worker",
    });

    await expect(runtime.start()).resolves.toBe(true);
    expect(timer.activeDelays()).toEqual([100, 5_000]);
    await expect(Promise.resolve("hook-ok")).resolves.toBe("hook-ok");
    expect(catalog.list).not.toHaveBeenCalled();

    await expect(runtime.triggerAutomaticScan()).resolves.toMatchObject({ status: "QUEUED", jobType: "AUTOMATIC_INGESTION_SCAN" });
    await expect(runtime.runJobWorkerOnce()).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(catalog.list).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(projections).toContainEqual(expect.objectContaining({ status: "RUNNING" }));
    expect(projections.at(-1)).toMatchObject({ status: "SUCCEEDED", checkpoint: { progress: 1 } });
    expect(projections.at(-1)).not.toHaveProperty("input");
    expect(reports.at(-1)).toEqual(expect.objectContaining({
      scannedSessions: 1,
      discoveredSessions: 1,
      relationCoverage: "NOT_CONFIGURED",
      diagnosticCodes: [],
    }));
    expect(reports.at(-1)).not.toHaveProperty("diagnostics");
    expect(runtime.state()).toMatchObject({
      automaticIngestion: "READY",
      backfillRecovery: "NOT_CONFIGURED",
      relationObservation: "NOT_CONFIGURED",
      jobProjectionRecovery: "COMPLETE",
    });
    await runtime.close();
  });

  it("projects revision-bound cancellation and manual retry commands from the durable store", async () => {
    const projections: Array<{ readonly jobId: string; readonly revision?: number | undefined; readonly status: string }> = [];
    let time = Date.parse(BASE_TIME);
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: { list: async () => { throw new Error("source unavailable"); }, get: async () => undefined },
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: (snapshot) => { projections.push(snapshot); },
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(time),
    });
    const queued = await runtime.triggerAutomaticScan();
    const cancelled = await runtime.cancelJob({
      jobId: queued.jobId,
      expectedRevision: queued.revision as number,
      idempotencyKey: "operator:cancel:runtime:one",
    });
    expect(cancelled).toMatchObject({ disposition: "APPLIED", job: { status: "CANCELLED", revision: 1 } });
    await expect(runtime.cancelJob({
      jobId: queued.jobId,
      expectedRevision: queued.revision as number,
      idempotencyKey: "operator:cancel:runtime:one",
    })).resolves.toMatchObject({ disposition: "REPLAYED" });

    time += 5_000;
    const retryable = await runtime.triggerAutomaticScan();
    await expect(runtime.runJobWorkerOnce()).resolves.toMatchObject({ status: "RETRY_WAIT" });
    const retryWaiting = projections.at(-1);
    if (retryWaiting === undefined) throw new Error("missing retry-wait projection");
    await expect(runtime.retryJob({
      jobId: retryable.jobId,
      expectedRevision: retryWaiting.revision as number,
      idempotencyKey: "operator:retry:runtime:one",
    })).resolves.toMatchObject({ disposition: "APPLIED", job: { status: "QUEUED" } });
    expect(projections.at(-1)).toMatchObject({ status: "QUEUED" });
    await runtime.close();
  });

  it("acknowledges a running cancellation at the post-ingestion safe boundary", async () => {
    let releaseCatalog: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const projections: Array<{ readonly jobId: string; readonly revision?: number | undefined; readonly status: string }> = [];
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: {
        list: async () => {
          await gate;
          return { items: [], sourceCapabilities: [], diagnostics: [], revision: "cancelled", changed: false };
        },
        get: async () => undefined,
      },
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: (snapshot) => { projections.push(snapshot); },
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(BASE_TIME),
    });
    const queued = await runtime.triggerAutomaticScan();
    const cycle = runtime.runJobWorkerOnce();
    await settle();
    const running = projections.find(({ jobId, status }) => jobId === queued.jobId && status === "RUNNING");
    if (running?.revision === undefined) throw new Error("missing running revision");
    await runtime.cancelJob({
      jobId: queued.jobId,
      expectedRevision: running.revision,
      idempotencyKey: "operator:cancel:running:safe",
    });
    releaseCatalog?.();
    await expect(cycle).resolves.toMatchObject({ status: "CANCELLED", job: { snapshot: { status: "CANCELLED" } } });
    expect(projections.at(-1)).toMatchObject({ status: "CANCELLED", cancellation: { status: "ACKNOWLEDGED" } });
    await runtime.close();
  });

  it("restores persisted JobSnapshot projections in bounded pages after restart", async () => {
    const directory = await stateDirectory();
    const catalog = new Catalog();
    let runtime = await P1SidecarRuntime.create({
      stateDirectory: directory,
      catalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(BASE_TIME),
      workerId: "first-worker",
    });
    await runtime.triggerAutomaticScan();
    await runtime.runJobWorkerOnce();
    await runtime.close();

    const restored: unknown[] = [];
    runtime = await P1SidecarRuntime.create({
      stateDirectory: directory,
      catalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: (snapshot) => { restored.push(snapshot); },
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(BASE_TIME),
      workerId: "restart-worker",
    });
    await runtime.start();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ status: "SUCCEEDED", jobType: "AUTOMATIC_INGESTION_SCAN" });
    expect(restored[0]).not.toHaveProperty("input");
    expect(runtime.state()).toMatchObject({ jobProjectionRecovery: "COMPLETE", projectedJobs: 1 });
    await runtime.close();
  });

  it("reports projection recovery failure and degrades without leaking or dropping the persisted job", async () => {
    const directory = await stateDirectory();
    const catalog = new Catalog();
    let runtime = await P1SidecarRuntime.create({
      stateDirectory: directory,
      catalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(BASE_TIME),
    });
    await runtime.triggerAutomaticScan();
    await runtime.close();

    runtime = await P1SidecarRuntime.create({
      stateDirectory: directory,
      catalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => { throw new Error("projection unavailable"); },
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(BASE_TIME),
    });
    await runtime.start();
    expect(runtime.state()).toMatchObject({
      automaticIngestion: "DEGRADED",
      jobProjectionRecovery: "FAILED",
      projectedJobs: 0,
      diagnosticCodes: ["JOB_PROJECTION_FAILED", "JOB_PROJECTION_RECOVERY_FAILED"],
    });
    await expect(runtime.runJobWorkerOnce(new AbortController().signal)).resolves.toMatchObject({ status: "SUCCEEDED" });
    await runtime.close();
  });

  it("uses completion-based non-reentrant timers and does not create a scan or poll call storm", async () => {
    const timer = new ManualTimer();
    let releaseCatalog: (() => void) | undefined;
    const catalogStarted = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const blockedCatalog: SessionCatalogQueryPort = {
      list: async () => {
        await catalogStarted;
        return { items: [], sourceCapabilities: [], diagnostics: [], revision: "blocked", changed: false };
      },
      get: async () => undefined,
    };
    let releaseProjection: (() => void) | undefined;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: blockedCatalog,
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: async () => await projectionGate,
      configuration: configuration(),
      timer,
      now: () => new Date(BASE_TIME),
      workerId: "test-worker",
    });
    await runtime.start();

    timer.fire(5_000);
    await settle();
    expect(timer.activeDelays()).toEqual([100]);
    releaseProjection?.();
    await settle();
    expect(timer.activeDelays()).toEqual([100, 5_000]);

    timer.fire(100);
    await settle();
    expect(timer.activeDelays()).toEqual([5_000]);
    releaseCatalog?.();
    await settle();
    expect(timer.activeDelays()).toEqual([100, 5_000]);
    await runtime.close();
  });

  it("reorders timers on hot configuration and returns an idempotent last-known-good rollback closure", async () => {
    const timer = new ManualTimer();
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: new Catalog(),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer,
      now: () => new Date(BASE_TIME),
    });
    await runtime.start();
    expect(timer.activeDelays()).toEqual([100, 5_000]);

    const rollback = await runtime.applyConfiguration(configuration({ sessionScanIntervalMs: 10_000, workerPollIntervalMs: 500 }));
    expect(timer.activeDelays()).toEqual([500, 10_000]);
    await rollback();
    expect(timer.activeDelays()).toEqual([100, 5_000]);
    await rollback();
    expect(timer.activeDelays()).toEqual([100, 5_000]);
    await expect(runtime.applyConfiguration(configuration({ workerPollIntervalMs: 0 }))).rejects.toThrow("workerPollIntervalMs");
    expect(timer.activeDelays()).toEqual([100, 5_000]);
    await runtime.close();
  });

  it("keeps last-known-good timers active if a hot configuration component cannot be reopened", async () => {
    const timer = new ManualTimer();
    const directory = await stateDirectory();
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: directory,
      catalog: new Catalog(),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer,
      now: () => new Date(BASE_TIME),
    });
    await runtime.start();
    await rm(join(directory, "p1-jobs.sqlite"));
    await mkdir(join(directory, "p1-jobs.sqlite"));
    await expect(runtime.applyConfiguration(configuration({ workerPollIntervalMs: 500 }))).rejects.toThrow();
    expect(timer.activeDelays()).toEqual([100, 5_000]);
    await runtime.close();
  });

  it("truthfully reports configured recovery/relation adapters and keeps report diagnostics code-only", async () => {
    const reports: unknown[] = [];
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: {
        list: async () => ({
          items: [{ ...entry("bad"), sessionId: "bad\nsession" }],
          sourceCapabilities: [], diagnostics: [], revision: "invalid-entry", changed: true,
        }),
        get: async () => undefined,
      },
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      recovery: { recover: async () => { throw new Error("not eligible"); } },
      relationSource: { list: async () => ({ items: [] }) },
      relationStore: { upsertMany: async () => undefined },
      projectJob: () => undefined,
      onIngestionReport: (report) => { reports.push(report); },
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(BASE_TIME),
    });
    await runtime.start();
    await runtime.triggerAutomaticScan();
    await runtime.runJobWorkerOnce();
    expect(runtime.state()).toMatchObject({ backfillRecovery: "READY", relationObservation: "READY" });
    expect(reports.at(-1)).toMatchObject({
      relationCoverage: "COMPLETE",
      diagnosticCodes: ["CATALOG_ENTRY_INVALID"],
    });
    expect(JSON.stringify(reports.at(-1))).not.toContain("bad\\nsession");
    await runtime.close();
  });

  it("bounds every hot setting before changing timers", async () => {
    const directory = await stateDirectory();
    const base = {
      stateDirectory: directory,
      catalog: new Catalog(),
      capture: { capture: async ({ sessionId }: { readonly sessionId: string }) => captureReport(sessionId) },
      projectJob: () => undefined,
      timer: new ManualTimer(),
    };
    const invalid = [
      configuration({ sessionScanIntervalMs: 0 }),
      configuration({ followDebounceMs: 0 }),
      configuration({ scanBatchSize: 0 }),
      configuration({ captureBatchSize: 0 }),
      configuration({ captureRetry: { ...DEFAULT_P1_RUNTIME_CONFIGURATION.captureRetry, maxAttempts: 0 } }),
      configuration({ captureRetry: { ...DEFAULT_P1_RUNTIME_CONFIGURATION.captureRetry, baseDelayMs: 2_000, maximumDelayMs: 1_000 } }),
      configuration({ captureRetry: { ...DEFAULT_P1_RUNTIME_CONFIGURATION.captureRetry, jitterRatio: 2 } }),
    ];
    for (const candidate of invalid) {
      await expect(P1SidecarRuntime.create({ ...base, configuration: candidate })).rejects.toThrow();
    }
  });

  it("contains scheduled failures and reschedules with a positive delay", async () => {
    const timer = new ManualTimer();
    let invalidClock = false;
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: new Catalog(),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer,
      now: () => invalidClock ? new Date(Number.NaN) : new Date(BASE_TIME),
    });
    await runtime.start();
    await expect(runtime.start()).resolves.toBe(false);
    invalidClock = true;
    timer.fire(5_000);
    timer.fire(100);
    await settle();
    expect(runtime.state().diagnosticCodes).toEqual(["AUTOMATIC_SCAN_SCHEDULE_FAILED", "JOB_POLL_FAILED"]);
    expect(timer.activeDelays()).toEqual([100, 5_000]);
    await runtime.close();
  });

  it("projects an abandoned persisted lease when shutdown wins during an in-flight scan", async () => {
    let releaseCatalog: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const projections: unknown[] = [];
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: {
        list: async () => {
          await gate;
          return { items: [], sourceCapabilities: [], diagnostics: [], revision: "released", changed: false };
        },
        get: async () => undefined,
      },
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: (snapshot) => { projections.push(snapshot); },
      configuration: configuration(),
      timer: new ManualTimer(),
      now: () => new Date(BASE_TIME),
    });
    await runtime.triggerAutomaticScan();
    const controller = new AbortController();
    const cycle = runtime.runJobWorkerOnce(controller.signal);
    await settle();
    controller.abort(new Error("Sidecar stopping"));
    releaseCatalog?.();
    await expect(cycle).resolves.toMatchObject({ status: "ABANDONED" });
    expect(projections.at(-1)).toMatchObject({ status: "RUNNING" });
    await runtime.close();
  });

  it("supports default enabled configuration and the production timer adapter", async () => {
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: new Catalog(),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
    });
    await expect(runtime.start()).resolves.toBe(true);
    await runtime.close();
  });

  it("keeps Hook P95 delta below 5ms while an automatic scan is in flight", async () => {
    let releaseCatalog: (() => void) | undefined;
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: {
        list: async () => {
          await catalogGate;
          return { items: [], sourceCapabilities: [], diagnostics: [], revision: "load-complete", changed: false };
        },
        get: async () => undefined,
      },
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer: new ManualTimer(),
    });
    const handler = new CodexHookHandler({
      sink: { enqueue: async () => undefined },
      spool: { store: async () => ({ status: "stored", fileName: "unused.json", redactionCount: 0 }) },
    });
    const hookInput = {
      hook_event_name: "UserPromptSubmit",
      session_id: "hook-load-isolation",
      turn_id: "turn-1",
      cwd: "/safe/project",
      prompt: "bounded performance fixture",
    };
    const measure = async (): Promise<number> => {
      const samples: number[] = [];
      for (let index = 0; index < 200; index += 1) {
        const startedAt = performance.now();
        await handler.handle({ ...hookInput, turn_id: `turn-${index}` });
        samples.push(performance.now() - startedAt);
      }
      samples.sort((left, right) => left - right);
      return samples[Math.ceil(samples.length * 0.95) - 1] as number;
    };
    const baselineP95 = await measure();
    await runtime.triggerAutomaticScan();
    const scan = runtime.runJobWorkerOnce();
    await settle();
    const loadedP95 = await measure();
    releaseCatalog?.();
    await expect(scan).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(loadedP95).toBeLessThan(100);
    expect(loadedP95 - baselineP95).toBeLessThan(5);
    await runtime.close();
  });

  it("stops and closes idempotently without leaving scheduled work or enabling a disabled runtime", async () => {
    const timer = new ManualTimer();
    const runtime = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: new Catalog(),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer,
    });
    await runtime.start();
    await expect(runtime.stop()).resolves.toBe(true);
    await expect(runtime.stop()).resolves.toBe(false);
    expect(timer.activeDelays()).toEqual([]);
    await expect(runtime.runJobWorkerOnce()).resolves.toEqual({ status: "IDLE" });
    await expect(runtime.start()).resolves.toBe(true);
    await expect(runtime.stop()).resolves.toBe(true);
    await runtime.close();
    await runtime.close();
    await expect(runtime.triggerAutomaticScan()).rejects.toThrow("closed");

    const disabledTimer = new ManualTimer();
    const disabled = await P1SidecarRuntime.create({
      stateDirectory: await stateDirectory(),
      catalog: new Catalog(),
      capture: { capture: async ({ sessionId }) => captureReport(sessionId) },
      projectJob: () => undefined,
      configuration: configuration(),
      timer: disabledTimer,
      enabled: false,
    });
    await expect(disabled.start()).resolves.toBe(false);
    expect(disabledTimer.activeDelays()).toEqual([]);
    expect(disabled.state().automaticIngestion).toBe("STOPPED");
    await disabled.close();
  });
});
