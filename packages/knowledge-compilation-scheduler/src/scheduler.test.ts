import { describe, expect, it, vi } from "vitest";

import { normalizeKnowledgeCompilationConfiguration } from "./decision.js";
import { KnowledgeCompilationScheduler } from "./scheduler.js";
import type { KnowledgeCompilationRunReport, KnowledgeCompilationTimerPort } from "./types.js";

function report(): KnowledgeCompilationRunReport {
  return {
    schemaVersion: 1,
    startedAt: "2026-08-18T10:00:00.000Z",
    completedAt: "2026-08-18T10:00:01.000Z",
    scannedSessions: 0,
    eligibleSessions: 0,
    queuedSessions: 0,
    currentSessions: 0,
    deferredSessions: 0,
    retrySessions: 0,
    failedSessions: 0,
    bounded: false,
    diagnostics: [],
  };
}

class Timer implements KnowledgeCompilationTimerPort {
  readonly tasks: Array<{ cancelled: boolean; task: () => void }> = [];

  schedule(_delayMs: number, task: () => void) {
    const record = { cancelled: false, task };
    this.tasks.push(record);
    return { cancel: () => { record.cancelled = true; } };
  }
}

describe("KnowledgeCompilationScheduler", () => {
  it("joins concurrent triggers and schedules the next run only after completion", async () => {
    const timer = new Timer();
    let resolveRun!: (value: KnowledgeCompilationRunReport) => void;
    const runOnce = vi.fn(async () => await new Promise<KnowledgeCompilationRunReport>((resolve) => { resolveRun = resolve; }));
    const scheduler = new KnowledgeCompilationScheduler({
      configuration: normalizeKnowledgeCompilationConfiguration({ scanIntervalMs: 1_000 }),
      runOnce,
    }, { timer });
    expect(scheduler.start()).toBe(true);
    expect(timer.tasks).toHaveLength(1);
    timer.tasks[0]!.task();
    const joined = scheduler.trigger();
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(timer.tasks).toHaveLength(1);
    resolveRun(report());
    await joined;
    await Promise.resolve();
    expect(timer.tasks).toHaveLength(2);
    expect(scheduler.stop()).toBe(true);
    expect(timer.tasks[1]!.cancelled).toBe(true);
  });

  it("does not start when automatic compilation is disabled", () => {
    const timer = new Timer();
    const scheduler = new KnowledgeCompilationScheduler({
      configuration: normalizeKnowledgeCompilationConfiguration({ enabled: false }),
      runOnce: async () => report(),
    }, { timer });
    expect(scheduler.start()).toBe(false);
    expect(timer.tasks).toHaveLength(0);
  });

  it("reports errors, avoids duplicate lifecycle transitions and can run again", async () => {
    const timer = new Timer();
    const onError = vi.fn();
    const onReport = vi.fn();
    const runOnce = vi.fn()
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce(report());
    const scheduler = new KnowledgeCompilationScheduler({
      configuration: normalizeKnowledgeCompilationConfiguration(),
      runOnce,
    }, { timer, onError, onReport });
    expect(scheduler.start()).toBe(true);
    expect(scheduler.start()).toBe(false);
    await expect(scheduler.trigger()).rejects.toThrow("scan failed");
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(scheduler.trigger()).resolves.toEqual(report());
    expect(onReport).toHaveBeenCalledTimes(1);
    await scheduler.drain();
    expect(scheduler.stop()).toBe(true);
    expect(scheduler.stop()).toBe(false);
  });

  it("does not let an old in-flight generation schedule into a restarted lifecycle", async () => {
    const timer = new Timer();
    let resolveRun!: (value: KnowledgeCompilationRunReport) => void;
    const scheduler = new KnowledgeCompilationScheduler({
      configuration: normalizeKnowledgeCompilationConfiguration(),
      runOnce: async () => await new Promise<KnowledgeCompilationRunReport>((resolve) => { resolveRun = resolve; }),
    }, { timer });
    expect(scheduler.start()).toBe(true);
    timer.tasks[0]!.task();
    expect(scheduler.stop()).toBe(true);
    expect(scheduler.start()).toBe(true);
    expect(timer.tasks).toHaveLength(2);
    resolveRun(report());
    await scheduler.drain();
    await Promise.resolve();
    expect(timer.tasks).toHaveLength(2);
    expect(scheduler.stop()).toBe(true);
  });

  it("executes the Node timer and supports cancelling it", async () => {
    const tasks: string[] = [];
    const { NodeKnowledgeCompilationTimer } = await import("./scheduler.js");
    const timer = new NodeKnowledgeCompilationTimer();
    const completed = new Promise<void>((resolve) => {
      timer.schedule(0, () => { tasks.push("ran"); resolve(); });
    });
    await completed;
    const cancelled = timer.schedule(10, () => { tasks.push("cancelled"); });
    cancelled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tasks).toEqual(["ran"]);
  });
});
