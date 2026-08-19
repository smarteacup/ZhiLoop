import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitKnowledgeChangeSource,
  parseGitNameStatusPaths,
  parseGitStatusPaths,
  type GitProcessPort,
} from "./git-source.js";

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
  diff = "";
  tracked = "";
  failDiff = false;
  missingBaseline = false;

  async run(_cwd: string, args: readonly string[]): Promise<string> {
    if (args[0] === "rev-parse") return `${this.head}\n`;
    if (args[0] === "status") return this.status;
    if (args[0] === "diff") {
      if (this.missingBaseline) throw new Error("GIT_CHANGESET_BASELINE_OBJECT_MISSING");
      if (this.failDiff) throw new Error("missing object");
      return this.diff;
    }
    if (args[0] === "ls-files") return this.tracked;
    throw new Error(`unexpected git operation: ${String(args[0])}`);
  }
}

describe("Git output parsing", () => {
  it("keeps both sides of status and committed renames", () => {
    expect(parseGitStatusPaths("R  new.ts\0old.ts\0 M same.ts\0?? untracked.ts\0"))
      .toEqual(["new.ts", "old.ts", "same.ts", "untracked.ts"]);
    expect(parseGitNameStatusPaths("R100\0old.ts\0new.ts\0M\0same.ts\0"))
      .toEqual(["new.ts", "old.ts", "same.ts"]);
  });

  it("rejects malformed, traversal and oversized output", () => {
    expect(() => parseGitStatusPaths("M bad.ts\0")).toThrow("STATUS_INVALID");
    expect(() => parseGitStatusPaths("?? ../secret\0")).toThrow("PATH_INVALID");
    expect(() => parseGitNameStatusPaths("R100\0only-one.ts\0")).toThrow("RENAME_INVALID");
    expect(() => parseGitStatusPaths("?? a.ts\0\0?? b.ts\0")).toThrow("OUTPUT_INVALID");
    expect(() => parseGitStatusPaths(`?? ${"a".repeat(2_000)}\0`, 1_024)).toThrow("OUTPUT_LIMIT_EXCEEDED");
    expect(() => parseGitStatusPaths("R  only-new.ts\0")).toThrow("RENAME_INVALID");
    expect(() => parseGitNameStatusPaths("INVALID\0a.ts\0")).toThrow("DIFF_STATUS_INVALID");
    expect(() => parseGitNameStatusPaths("M\0")).toThrow("DIFF_PATH_INVALID");
    expect(() => parseGitStatusPaths("?? a.ts\0?? b.ts\0", undefined, 1)).toThrow("PATH_LIMIT_EXCEEDED");
  });
});

describe("GitKnowledgeChangeSource durable observations", () => {
  it("validates public query, paging, acknowledgement and lifecycle boundaries", async () => {
    const root = directory("zhiloop-git-source-validation-");
    const other = directory("zhiloop-git-source-validation-other-");
    const git = new FakeGit();
    for (const [options, reason] of [
      [{ timeoutMs: 9 }, "timeoutMs is invalid"],
      [{ maxOutputBytes: 1_023 }, "maxOutputBytes is invalid"],
      [{ maxTotalPaths: 0 }, "maxTotalPaths is invalid"],
      [{ pathPageSize: 10_001 }, "pathPageSize is invalid"],
    ] as const) expect(() => new GitKnowledgeChangeSource(":memory:", { process: git, ...options })).toThrow(reason);

    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    source.observe("project-1", root);
    source.observe("project-1", root);
    expect(() => source.observe("..", root)).toThrow("PROJECT_INVALID");
    expect(() => source.observe("project-relative", "relative")).toThrow("PROJECT_INVALID");
    expect(() => source.observe("project-1", other)).toThrow("ROOT_CONFLICT");
    expect(await source.scanProject("project-1")).toBeUndefined();
    expect(await source.scan()).toEqual([]);
    git.head = "b".repeat(40);
    expect(await source.scan()).toEqual([]);
    await expect(source.scanProject("..")).rejects.toThrow("PROJECT_INVALID");
    await expect(source.scanProject("unknown")).rejects.toThrow("NOT_OBSERVED");
    git.status = " M src/runtime.ts\0";
    const changes = (await source.scan())[0]!;
    const observation = source.getObservation(changes.sourceRef, "project-1")!;

    expect(source.getObservation("missing")).toBeUndefined();
    expect(() => source.getObservation("")).toThrow("SOURCE_REF_INVALID");
    expect(() => source.getObservation(changes.sourceRef, "..")).toThrow("PROJECT_INVALID");
    expect(() => source.getObservation(changes.sourceRef, "project-1", "bad")).toThrow("OBSERVATION_HASH_INVALID");
    expect(() => source.listPending(0)).toThrow("PENDING_LIMIT_INVALID");
    expect(() => source.listPending(1, "..")).toThrow("PROJECT_INVALID");
    expect(() => source.listPending(1, "project-1", "..")).toThrow("CURSOR_INVALID");
    expect(source.listPending(1, "project-1", observation.observationId)).toEqual([]);
    expect(() => source.readPathPage("missing", 0)).toThrow("OBSERVATION_NOT_FOUND");
    expect(() => source.readPathPage(changes.sourceRef, -1, "project-1")).toThrow("PAGE_INVALID");
    expect(() => source.changeSet("missing")).toThrow("OBSERVATION_NOT_FOUND");
    expect(() => source.acknowledgeSource("..", changes.sourceRef, "1".repeat(64))).toThrow("ACK_INPUT_INVALID");
    expect(() => source.acknowledgeSource("project-1", changes.sourceRef, "bad")).toThrow("ACK_INPUT_INVALID");
    expect(() => source.acknowledgeSource("project-1", changes.sourceRef, "1".repeat(64), "bad")).toThrow("ACK_INPUT_INVALID");
    expect(() => source.acknowledgeSource("project-1", "missing", "1".repeat(64))).toThrow("ACK_CONFLICT");
    expect(() => source.baseline("..")).toThrow("PROJECT_INVALID");
    expect(source.baseline("unknown")).toBeUndefined();
    source.acknowledge(changes);
    expect(source.listPending()).toEqual([]);
    expect(() => source.acknowledge({ ...changes, sourceRef: "missing" })).toThrow("ACK_CONFLICT");
    expect(() => source.acknowledge({ ...changes, observedAt: "2026-08-20T00:00:00.000Z" })).toThrow("ACK_CONFLICT");
    source.close();
    source.close();
    expect(() => source.observedProjects()).toThrow("source is closed");
  });

  it("maps failures from the real Git process without leaking command diagnostics", async () => {
    const root = directory("zhiloop-git-source-not-a-repository-");
    const source = new GitKnowledgeChangeSource(":memory:");
    try {
      source.observe("project-1", root);
      await expect(source.scan()).rejects.toThrow("GIT_CHANGESET_COMMAND_FAILED");
    } finally { source.close(); }
  });

  it("detects persisted page, count and JSON corruption on read or acknowledgement", async () => {
    const root = directory("zhiloop-git-source-multi-corrupt-project-");
    const state = directory("zhiloop-git-source-multi-corrupt-state-");
    const filename = join(state, "git.sqlite");
    const git = new FakeGit();
    const first = new GitKnowledgeChangeSource(filename, { process: git });
    first.observe("project-1", root);
    await first.scan();
    git.status = " M a.ts\0";
    const changed = (await first.scan())[0]!;
    first.close();

    const database = new DatabaseSync(filename);
    database.prepare("UPDATE git_change_paths SET path='../bad'").run();
    database.prepare("UPDATE git_change_observations SET path_count=2,current_paths_json='not-json'").run();
    database.close();
    const corruptPage = new GitKnowledgeChangeSource(filename, { process: git });
    expect(() => corruptPage.readPathPage(changed.sourceRef, 0, "project-1")).toThrow("PATH_PAGE_CORRUPT");
    corruptPage.close();

    const repairPage = new DatabaseSync(filename);
    repairPage.prepare("UPDATE git_change_paths SET path='a.ts'").run();
    repairPage.close();
    const corruptCount = new GitKnowledgeChangeSource(filename, { process: git });
    expect(() => corruptCount.changeSet(changed.sourceRef, "project-1")).toThrow("PATH_COUNT_CORRUPT");
    expect(() => corruptCount.acknowledgeSource("project-1", changed.sourceRef, "1".repeat(64))).toThrow("STORED_PATHS_CORRUPT");
    corruptCount.close();

    const corruptJsonShape = "[1]";
    const corruptJsonHash = createHash("sha256").update(corruptJsonShape).digest("hex");
    const changeJson = new DatabaseSync(filename);
    changeJson.prepare("UPDATE git_change_observations SET current_paths_json=?,current_paths_hash=?")
      .run(corruptJsonShape, corruptJsonHash);
    changeJson.close();
    const invalidJsonShape = new GitKnowledgeChangeSource(filename, { process: git });
    expect(() => invalidJsonShape.acknowledgeSource("project-1", changed.sourceRef, "2".repeat(64))).toThrow("STORED_PATHS_CORRUPT");
    invalidJsonShape.close();
  });

  it("persists observed projects and pending observations across restart", async () => {
    const root = directory("zhiloop-git-source-project-");
    const state = directory("zhiloop-git-source-state-");
    const filename = join(state, "git.sqlite");
    const git = new FakeGit();
    const first = new GitKnowledgeChangeSource(filename, { process: git, clock: () => new Date("2026-08-19T00:00:00.000Z") });
    first.observe("project-1", root);
    expect(await first.scan()).toEqual([]);
    git.status = " M src/runtime.ts\0";
    const change = (await first.scan())[0]!;
    const observed = first.getObservation(change.sourceRef, "project-1")!;
    expect(observed).toMatchObject({ projectId: "project-1", baseRevision: 1, pathCount: 1, pageCount: 1, status: "PENDING" });
    first.close();

    const second = new GitKnowledgeChangeSource(filename, { process: git, clock: () => new Date("2026-08-19T00:00:01.000Z") });
    try {
      expect(second.observedProjects()).toEqual([{ projectId: "project-1", repositoryRoot: root }]);
      expect(second.listPending()).toEqual([observed]);
      expect(await second.scan()).toMatchObject([{ sourceRef: change.sourceRef, changedPaths: ["src/runtime.ts"] }]);
      expect(second.readPathPage(change.sourceRef, 0)).toMatchObject({ paths: ["src/runtime.ts"] });
    } finally { second.close(); }
  });

  it("stores more than ten thousand paths in deterministic resumable pages", async () => {
    const root = directory("zhiloop-git-source-large-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git, maxTotalPaths: 10_100, pathPageSize: 10_000 });
    try {
      source.observe("project-large", root);
      await source.scan();
      git.status = Array.from({ length: 10_001 }, (_, index) => `?? generated/file-${String(index).padStart(5, "0")}.ts\0`).join("");
      const change = (await source.scan())[0]!;
      expect(change.changedPaths).toHaveLength(10_001);
      const observed = source.getObservation(change.sourceRef, "project-large")!;
      expect(observed).toMatchObject({ pathCount: 10_001, pageCount: 2 });
      expect(source.readPathPage(change.sourceRef, 0)).toMatchObject({ paths: expect.any(Array), nextPage: 1 });
      expect(source.readPathPage(change.sourceRef, 0).paths).toHaveLength(10_000);
      expect(source.readPathPage(change.sourceRef, 1).paths).toHaveLength(1);
    } finally { source.close(); }
  });

  it("acknowledges with CAS and replays only the same effect", async () => {
    const root = directory("zhiloop-git-source-ack-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    try {
      source.observe("project-1", root);
      await source.scan();
      git.status = " M a.ts\0";
      const first = (await source.scan())[0]!;
      const firstEffect = "1".repeat(64);
      expect(source.acknowledgeSource("project-1", first.sourceRef, firstEffect)).toEqual({ status: "ACKNOWLEDGED", revision: 2 });
      expect(source.acknowledgeSource("project-1", first.sourceRef, firstEffect)).toEqual({ status: "IDEMPOTENT", revision: 2 });
      expect(() => source.acknowledgeSource("project-1", first.sourceRef, "2".repeat(64))).toThrow("ACK_CONFLICT");
      expect(source.baseline("project-1")?.revision).toBe(2);
    } finally { source.close(); }
  });

  it("preserves the baseline when two observations race", async () => {
    const root = directory("zhiloop-git-source-race-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    try {
      source.observe("project-1", root);
      await source.scan();
      git.status = " M a.ts\0";
      const first = (await source.scan())[0]!;
      git.status = " M b.ts\0";
      const second = (await source.scan())[0]!;
      source.acknowledgeSource("project-1", second.sourceRef, "2".repeat(64));
      expect(() => source.acknowledgeSource("project-1", first.sourceRef, "1".repeat(64))).toThrow("BASELINE_CAS_CONFLICT");
      expect(source.baseline("project-1")?.revision).toBe(2);
    } finally { source.close(); }
  });

  it("creates a new observation when an earlier HEAD and dirty state recur", async () => {
    const root = directory("zhiloop-git-source-recurrence-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    try {
      source.observe("project-1", root);
      await source.scan();
      git.status = " M a.ts\0";
      const first = (await source.scan())[0]!;
      const firstObservation = source.getObservation(first.sourceRef, "project-1")!;
      source.acknowledgeSource("project-1", first.sourceRef, "1".repeat(64), firstObservation.observationHash);
      git.status = "";
      const clean = (await source.scan())[0]!;
      const cleanObservation = source.getObservation(clean.sourceRef, "project-1")!;
      source.acknowledgeSource("project-1", clean.sourceRef, "2".repeat(64), cleanObservation.observationHash);
      git.status = " M a.ts\0";
      const repeated = (await source.scan())[0]!;
      expect(repeated.sourceRef).toBe(first.sourceRef);
      expect(() => source.getObservation(repeated.sourceRef, "project-1")).toThrow("SOURCE_REF_AMBIGUOUS");
      const pending = source.listPending(10, "project-1")[0]!;
      expect(pending.observationHash).not.toBe(firstObservation.observationHash);
      expect(source.changeSet(repeated.sourceRef, "project-1", pending.observationHash).changedPaths).toEqual(["a.ts"]);
    } finally { source.close(); }
  });

  it("falls back only for a missing baseline object and fails closed for other Git failures", async () => {
    const root = directory("zhiloop-git-source-command-failure-");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(":memory:", { process: git });
    try {
      source.observe("project-1", root);
      await source.scan();
      git.head = "b".repeat(40);
      git.failDiff = true;
      await expect(source.scan()).rejects.toThrow("GIT_CHANGESET_COMMAND_FAILED");
      expect(source.baseline("project-1")?.revision).toBe(1);
      git.failDiff = false;
      git.missingBaseline = true;
      git.tracked = "tracked.ts\0";
      expect(await source.scan()).toMatchObject([{ changedPaths: ["tracked.ts"] }]);
      expect(source.baseline("project-1")?.revision).toBe(1);
    } finally { source.close(); }
  });

  it("detects stored-current-path corruption before acknowledgement", async () => {
    const root = directory("zhiloop-git-source-corrupt-");
    const state = directory("zhiloop-git-source-corrupt-state-");
    const filename = join(state, "git.sqlite");
    const git = new FakeGit();
    const source = new GitKnowledgeChangeSource(filename, { process: git });
    source.observe("project-1", root);
    await source.scan();
    git.status = " M a.ts\0";
    const changed = (await source.scan())[0]!;
    source.close();
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE git_change_observations SET current_paths_json='[]'").run();
    database.close();
    const reopened = new GitKnowledgeChangeSource(filename, { process: git });
    try {
      expect(() => reopened.acknowledgeSource("project-1", changed.sourceRef, "1".repeat(64))).toThrow("STORED_PATHS_CORRUPT");
      expect(reopened.baseline("project-1")?.revision).toBe(1);
    } finally { reopened.close(); }
  });

  it("migrates the legacy baseline table without losing its revision", () => {
    const state = directory("zhiloop-git-source-migrate-");
    const filename = join(state, "git.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(`CREATE TABLE git_freshness_baseline(
      project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, head TEXT NOT NULL,
      status_fingerprint TEXT NOT NULL, changed_paths_json TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;`);
    database.prepare("INSERT INTO git_freshness_baseline VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy", "/repo", "a".repeat(40), "b".repeat(64), "[]", "2026-08-19T00:00:00.000Z");
    database.close();
    const source = new GitKnowledgeChangeSource(filename, { process: new FakeGit() });
    try { expect(source.baseline("legacy")).toMatchObject({ revision: 1, repositoryRoot: "/repo" }); }
    finally { source.close(); }
  });

  it("observes both sides of a real worktree rename", async () => {
    const root = directory("zhiloop-git-source-rename-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "old.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    const source = new GitKnowledgeChangeSource(":memory:");
    try {
      source.observe("project-rename", root);
      await source.scan();
      execFileSync("git", ["mv", "old.ts", "new.ts"], { cwd: root });
      expect(await source.scan()).toMatchObject([{ changedPaths: ["new.ts", "old.ts"] }]);
    } finally { source.close(); }
  });

  it("observes committed changes and a checkout to an older revision", async () => {
    const root = directory("zhiloop-git-source-commit-checkout-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "existing.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    const source = new GitKnowledgeChangeSource(":memory:");
    try {
      source.observe("project-history", root);
      await source.scan();
      writeFileSync(join(root, "existing.ts"), "export const value = 2;\n");
      writeFileSync(join(root, "added.ts"), "export const added = true;\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "change"], { cwd: root, stdio: "ignore" });
      const committed = (await source.scan())[0]!;
      expect(committed.changedPaths).toEqual(["added.ts", "existing.ts"]);
      const committedObservation = source.getObservation(committed.sourceRef, "project-history")!;
      source.acknowledgeSource("project-history", committed.sourceRef, "1".repeat(64), committedObservation.observationHash);
      execFileSync("git", ["checkout", "--detach", "HEAD^"], { cwd: root, stdio: "ignore" });
      expect(await source.scan()).toMatchObject([{ changedPaths: ["added.ts", "existing.ts"] }]);
    } finally { source.close(); }
  }, 10_000);
});
