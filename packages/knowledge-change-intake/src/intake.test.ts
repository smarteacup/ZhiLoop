import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitKnowledgeChangeSource, type GitProcessPort } from "./git-source.js";
import {
  KnowledgeChangeIntake,
  type KnowledgeChangeTimerHandle,
  type KnowledgeChangeTimerPort,
  type KnowledgeRevalidateJobPort,
} from "./intake.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory(name: string): string {
  const value = mkdtempSync(join(tmpdir(), name));
  directories.push(value);
  return value;
}

class FakeGit implements GitProcessPort {
  head = "a".repeat(40);
  status = "";
  async run(_cwd: string, args: readonly string[]): Promise<string> {
    if (args[0] === "rev-parse") return `${this.head}\n`;
    if (args[0] === "status") return this.status;
    if (args[0] === "diff") return "";
    if (args[0] === "ls-files") return "";
    throw new Error("unexpected git operation");
  }
}

class FakeJobs implements KnowledgeRevalidateJobPort {
  readonly inputs: unknown[] = [];
  fail = false;
  enqueue(input: Parameters<KnowledgeRevalidateJobPort["enqueue"]>[0]): ReturnType<KnowledgeRevalidateJobPort["enqueue"]> {
    if (this.fail) throw new Error("JOB_STORE_UNAVAILABLE");
    const existing = this.inputs.some((item) => JSON.stringify(item) === JSON.stringify(input));
    if (!existing) this.inputs.push(input);
    return { status: existing ? "EXISTING" : "CREATED", job: { snapshot: { jobId: `job-${this.inputs.length}` } } };
  }
}

class FakeTimer implements KnowledgeChangeTimerPort {
  task: (() => void) | undefined;
  delayMs: number | undefined;
  schedule(delayMs: number, task: () => void): KnowledgeChangeTimerHandle {
    this.delayMs = delayMs;
    this.task = task;
    let cancelled = false;
    return { cancel: () => { cancelled = true; if (this.task === task) this.task = undefined; },
      get cancelled() { return cancelled; } } as KnowledgeChangeTimerHandle;
  }
  fire(): void { const task = this.task; this.task = undefined; task?.(); }
}

function clock(initial = "2026-08-19T00:00:00.000Z"): { now: () => Date; advance: (milliseconds: number) => void } {
  let current = Date.parse(initial);
  return { now: () => new Date(current), advance: (milliseconds) => { current += milliseconds; } };
}

async function settle(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

describe("KnowledgeChangeIntake", () => {
  it("validates configuration, project, signal and graph revision boundaries", async () => {
    const root = directory("zhiloop-intake-validation-");
    const source = new GitKnowledgeChangeSource(":memory:", { process: new FakeGit() });
    for (const [options, reason] of [
      [{ debounceMs: -1 }, "DEBOUNCE_MS_INVALID"],
      [{ fallbackIntervalMs: 99 }, "FALLBACK_INTERVAL_MS_INVALID"],
      [{ maxAttempts: 0 }, "MAX_ATTEMPTS_INVALID"],
    ] as const) expect(() => new KnowledgeChangeIntake(":memory:", { source, jobs: new FakeJobs(), ...options })).toThrow(reason);
    const intake = new KnowledgeChangeIntake(":memory:", { source, jobs: new FakeJobs() });
    try {
      expect(intake.state()).toMatchObject({ status: "STOPPED", running: false });
      expect(() => intake.observeProject("..", root)).toThrow("PROJECT_INVALID");
      expect(() => intake.observeProject("project-1", "relative")).toThrow("PROJECT_INVALID");
      intake.observeProject("project-1", root);
      expect(intake.enqueuePending("project-1")).toEqual([]);
      expect(() => intake.enqueuePending("unknown")).toThrow("PROJECT_NOT_OBSERVED");
      expect(() => intake.liveRevisionState("..")).toThrow("PROJECT_INVALID");
      const signal = { projectId: "project-1", repositoryRoot: root, source: "WORKTREE_WATCHER" as const,
        observedAt: "2026-08-19T00:00:00.000Z" };
      for (const invalid of [
        { ...signal, observedAt: "not-a-date" },
        { ...signal, observedAt: "2026-08-19T00:00:00Z" },
        { ...signal, source: "UNKNOWN" as never },
        { ...signal, pathsHint: ["../secret"] },
        { ...signal, pathsHint: ["/absolute"] },
        { ...signal, pathsHint: ["a\\b"] },
        { ...signal, pathsHint: ["a//b"] },
      ]) expect(() => intake.notify(invalid)).toThrow("SIGNAL_INVALID");
      expect(() => intake.updateGraphRevision("project-1", "", "graph:1")).toThrow("GRAPH_REVISION_INVALID");
      expect(() => intake.updateGraphRevision("project-1", "git:other", "graph:1")).toThrow("GRAPH_REVISION_CONFLICT");
      await intake.flush();
      const revision = intake.read("project-1")!.codeRevision;
      intake.updateGraphRevision("project-1", revision, "graph:1");
      expect(intake.read("project-1")).toMatchObject({ codeRevision: revision, graphRevision: "graph:1" });
      await intake.start();
      await intake.start();
      expect(() => intake.close()).toThrow("MUST_STOP_FIRST");
      await intake.stop();
      await intake.stop();
    } finally { intake.close(); source.close(); }
    expect(() => intake.state()).toThrow("INTAKE_CLOSED");
  });

  it("fails closed when recipe selection does not return a SHA-256 identity", async () => {
    const root = directory("zhiloop-intake-recipe-hash-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    const intake = new KnowledgeChangeIntake(":memory:", { source, jobs: new FakeJobs(), recipeSelectionHash: () => "invalid" });
    try {
      intake.observeProject("project-1", root);
      await intake.flush();
      git.status = " M changed.ts\0";
      await expect(intake.flush()).rejects.toThrow("RECIPE_SELECTION_HASH_INVALID");
      expect(intake.state()).toMatchObject({ status: "STOPPED", failedCycles: 1, lastReasonCode: expect.stringContaining("RECIPE") });
    } finally { intake.close(); source.close(); }
  });

  it("coalesces signals but derives changes from authoritative Git state", async () => {
    const root = directory("zhiloop-intake-project-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    const jobs = new FakeJobs();
    const timer = new FakeTimer();
    const time = clock();
    const intake = new KnowledgeChangeIntake(":memory:", {
      source, jobs, timer, clock: time.now, debounceMs: 500, fallbackIntervalMs: 10_000,
    });
    try {
      intake.observeProject("project-1", root);
      await intake.flush();
      expect(intake.read("project-1")?.codeRevision).toMatch(/^git:/);
      await intake.start();
      git.status = " M authoritative.ts\0";
      const signal = { projectId: "project-1", repositoryRoot: root, source: "WORKTREE_WATCHER" as const,
        observedAt: time.now().toISOString(), pathsHint: ["wrong-hint.ts"] };
      intake.notify(signal);
      expect(intake.read("project-1")).toBeUndefined();
      intake.notify({ ...signal, source: "CODEX_FILE_CHANGE" });
      expect(intake.state().pendingSignals).toBe(1);
      expect(timer.delayMs).toBe(500);
      time.advance(500);
      timer.fire();
      await settle();
      expect(jobs.inputs).toMatchObject([{ projectId: "project-1", sourceRef: expect.stringMatching(/^git:/),
        changeSetHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
      expect(source.changeSet((jobs.inputs[0] as { sourceRef: string }).sourceRef, "project-1").changedPaths)
        .toEqual(["authoritative.ts"]);
      expect(intake.read("project-1")?.codeRevision).toBe((jobs.inputs[0] as { sourceRef: string }).sourceRef);
      expect(intake.state()).toMatchObject({ status: "READY", pendingSignals: 0, completedCycles: 3 });
    } finally { await intake.stop(); intake.close(); source.close(); }
  });

  it("rejects unknown projects and conflicting roots without scanning", async () => {
    const root = directory("zhiloop-intake-known-");
    const other = directory("zhiloop-intake-other-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    const scan = vi.spyOn(source, "scanProject");
    const intake = new KnowledgeChangeIntake(":memory:", { source, jobs: new FakeJobs() });
    try {
      intake.observeProject("known", root);
      expect(() => intake.notify({ projectId: "unknown", repositoryRoot: root, source: "PRE_INJECTION",
        observedAt: "2026-08-19T00:00:00.000Z" })).toThrow("PROJECT_NOT_OBSERVED");
      expect(() => intake.notify({ projectId: "known", repositoryRoot: other, source: "GIT_LIFECYCLE",
        observedAt: "2026-08-19T00:00:00.000Z" })).toThrow("PROJECT_NOT_OBSERVED");
      expect(scan).not.toHaveBeenCalled();
    } finally { intake.close(); source.close(); }
  });

  it("recovers an observation persisted before enqueue after restart", async () => {
    const root = directory("zhiloop-intake-recovery-project-");
    const state = directory("zhiloop-intake-recovery-state-");
    const sourceFile = join(state, "source.sqlite");
    const intakeFile = join(state, "intake.sqlite");
    const git = new FakeGit();
    const first = new GitKnowledgeChangeSource(sourceFile, { process: git });
    first.observe("project-1", root);
    await first.scan();
    git.status = " M recovered.ts\0";
    await first.scan();
    first.close();

    const second = new GitKnowledgeChangeSource(sourceFile, { process: git });
    const jobs = new FakeJobs();
    const intake = new KnowledgeChangeIntake(intakeFile, { source: second, jobs });
    try {
      await intake.start();
      expect(jobs.inputs).toHaveLength(1);
      expect(jobs.inputs[0]).toMatchObject({ projectId: "project-1", repositoryRoot: root });
    } finally { await intake.stop(); intake.close(); second.close(); }
  });

  it("persists fallback deadlines so watcher loss cannot suppress a scan", async () => {
    const root = directory("zhiloop-intake-fallback-project-");
    const state = directory("zhiloop-intake-fallback-state-");
    const sourceFile = join(state, "source.sqlite");
    const intakeFile = join(state, "intake.sqlite");
    const git = new FakeGit();
    const time = clock();
    const source = new GitKnowledgeChangeSource(sourceFile, { process: git, clock: time.now });
    const first = new KnowledgeChangeIntake(intakeFile, { source, jobs: new FakeJobs(), clock: time.now, fallbackIntervalMs: 1_000 });
    first.observeProject("project-1", root);
    await first.flush();
    first.close();
    git.status = "?? watcher-lost.ts\0";
    time.advance(1_001);
    const jobs = new FakeJobs();
    const second = new KnowledgeChangeIntake(intakeFile, { source, jobs, clock: time.now, fallbackIntervalMs: 1_000 });
    try {
      await second.start();
      expect(jobs.inputs).toHaveLength(1);
      expect(source.changeSet((jobs.inputs[0] as { sourceRef: string }).sourceRef, "project-1").changedPaths)
        .toEqual(["watcher-lost.ts"]);
    } finally { await second.stop(); second.close(); source.close(); }
  });

  it("defers a failed wakeup instead of entering a zero-delay retry loop", async () => {
    const root = directory("zhiloop-intake-retry-project-");
    const git = new FakeGit();
    const time = clock();
    const timer = new FakeTimer();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git, clock: time.now });
    const jobs = new FakeJobs();
    const intake = new KnowledgeChangeIntake(":memory:", {
      source, jobs, timer, clock: time.now, debounceMs: 0, fallbackIntervalMs: 10_000,
    });
    try {
      intake.observeProject("project-1", root);
      await intake.flush();
      await intake.start();
      git.status = " M retry.ts\0";
      jobs.fail = true;
      intake.notify({ projectId: "project-1", repositoryRoot: root, source: "WORKTREE_WATCHER",
        observedAt: time.now().toISOString() });
      timer.fire();
      await settle();
      expect(intake.state()).toMatchObject({ status: "DEGRADED", failedCycles: 1, pendingSignals: 1,
        lastReasonCode: "JOB_STORE_UNAVAILABLE" });
      expect(timer.delayMs).toBe(100);
      jobs.fail = false;
      time.advance(100);
      timer.fire();
      await settle();
      expect(intake.state()).toMatchObject({ status: "READY", pendingSignals: 0 });
      expect(jobs.inputs).toHaveLength(1);
    } finally { await intake.stop(); intake.close(); source.close(); }
  });

  it("waits for an active scan during graceful stop", async () => {
    const root = directory("zhiloop-intake-drain-project-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    const intake = new KnowledgeChangeIntake(":memory:", { source, jobs: new FakeJobs() });
    intake.observeProject("project-1", root);
    await intake.flush();
    await intake.start();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(source, "scanProject").mockImplementation(async () => { await blocked; return undefined; });
    const running = intake.flush();
    const stop = intake.stop();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    release();
    await Promise.all([running, stop]);
    expect(stopped).toBe(true);
    intake.close();
    source.close();
  });
});
