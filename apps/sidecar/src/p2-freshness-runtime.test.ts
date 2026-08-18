import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitKnowledgeChangeSource } from "./p2-freshness-runtime.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("GitKnowledgeChangeSource", () => {
  it("establishes a baseline and emits bounded paths for edits and reverts", async () => {
    const root = mkdtempSync(join(tmpdir(), "zhiloop-freshness-git-"));
    const state = mkdtempSync(join(tmpdir(), "zhiloop-freshness-state-"));
    directories.push(root, state);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "runtime.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "runtime.ts"], { cwd: root });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    const source = new GitKnowledgeChangeSource(join(state, "freshness.sqlite"));
    source.observe("project-a", root);
    expect(await source.scan()).toEqual([]);
    writeFileSync(join(root, "runtime.ts"), "export const value = 2;\n");
    const edited = await source.scan();
    expect(edited).toMatchObject([{ projectId: "project-a", changedPaths: ["runtime.ts"] }]);
    expect(await source.scan()).toMatchObject([{ sourceRef: edited[0]?.sourceRef, changedPaths: ["runtime.ts"] }]);
    source.acknowledge(edited[0]!);
    execFileSync("git", ["checkout", "--", "runtime.ts"], { cwd: root });
    const reverted = await source.scan();
    expect(reverted).toMatchObject([{ projectId: "project-a", changedPaths: ["runtime.ts"] }]);
    source.acknowledge(reverted[0]!);
    expect(await source.scan()).toEqual([]);
    source.close();
  });

  it("rejects project identity remapping", () => {
    const root = mkdtempSync(join(tmpdir(), "zhiloop-freshness-identity-"));
    const other = mkdtempSync(join(tmpdir(), "zhiloop-freshness-other-"));
    const state = mkdtempSync(join(tmpdir(), "zhiloop-freshness-identity-state-"));
    directories.push(root, other, state);
    const source = new GitKnowledgeChangeSource(join(state, "freshness.sqlite"));
    source.observe("project-a", root);
    expect(() => source.observe("project-a", other)).toThrow("ROOT_CONFLICT");
    source.close();
  });

  it("falls back to all tracked files when a rewritten history removes the baseline commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "zhiloop-freshness-rewrite-"));
    const state = mkdtempSync(join(tmpdir(), "zhiloop-freshness-rewrite-state-"));
    directories.push(root, state);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "old.ts"), "export const oldValue = 1;\n");
    execFileSync("git", ["add", "old.ts"], { cwd: root });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    const source = new GitKnowledgeChangeSource(join(state, "freshness.sqlite"));
    source.observe("project-rewrite", root);
    expect(await source.scan()).toEqual([]);

    execFileSync("git", ["checkout", "--orphan", "replacement"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["rm", "-rf", "."], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "new.ts"), "export const newValue = 2;\n");
    execFileSync("git", ["add", "new.ts"], { cwd: root });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "replacement"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["reflog", "expire", "--expire=now", "--all"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["gc", "--prune=now"], { cwd: root, stdio: "ignore" });

    expect(await source.scan()).toMatchObject([{ projectId: "project-rewrite", changedPaths: ["new.ts", "old.ts"] }]);
    source.close();
  });
});
