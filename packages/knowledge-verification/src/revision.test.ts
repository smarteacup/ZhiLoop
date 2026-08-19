import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GitProjectRevisionPort,
  NodeBoundedProjectFingerprint,
  NodeGitRevisionProcess,
  type GitRevisionProcessPort,
  type GitRevisionProcessResult,
} from "./revision.js";

class ScriptedProcess implements GitRevisionProcessPort {
  readonly calls: readonly string[][] = [];
  constructor(private readonly responses: GitRevisionProcessResult[]) {}
  async run(_cwd: string, args: readonly string[]): Promise<GitRevisionProcessResult> {
    (this.calls as string[][]).push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected process call");
    return response;
  }
}

function output(value: string, overrides: Partial<GitRevisionProcessResult> = {}): GitRevisionProcessResult {
  return { exitCode: 0, stdout: Buffer.from(value), timedOut: false, outputExceeded: false, ...overrides };
}

describe("GitProjectRevisionPort", () => {
  it("binds HEAD and the raw porcelain digest without exposing file names", async () => {
    const process = new ScriptedProcess([output(`${"a".repeat(40)}\n`), output(" M secret-name.ts\0")]);
    const revision = await new GitProjectRevisionPort(process).capture({ projectId: "project-1", repositoryRoot: "/repo", portable: false });
    expect(revision).toMatchObject({ capability: "READY", revision: expect.stringMatching(/^git:[a-f0-9]{40}:[a-f0-9]{64}$/u) });
    expect(JSON.stringify(revision)).not.toContain("secret-name.ts");
    expect(process.calls).toEqual([["rev-parse", "--verify", "HEAD"], [
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".",
      ":(exclude).codegraph", ":(exclude).codegraph/**", ":(exclude).zhiloop", ":(exclude).zhiloop/**",
    ]]);
  });

  it("degrades deterministically without a usable Git repository", async () => {
    const failed = new ScriptedProcess([output("", { exitCode: 128 }), output("", { exitCode: 128 })]);
    await expect(new GitProjectRevisionPort(failed).capture({ projectId: "project-1", repositoryRoot: "/repo", portable: false }))
      .resolves.toMatchObject({ capability: "DEGRADED", reasonCode: "PROJECT_FINGERPRINT_UNAVAILABLE", revision: expect.stringMatching(/^degraded:/u) });
  });

  it("uses an injected bounded non-Git project fingerprint without exposing repository data", async () => {
    const failed = new ScriptedProcess([output("", { exitCode: 128 }), output("", { exitCode: 128 })]);
    const port = new GitProjectRevisionPort(failed, 1_000, 1_048_576, {
      fingerprint: async () => ({ revision: `project:${"d".repeat(64)}`, bounded: false }),
    });
    await expect(port.capture({ projectId: "project-1", repositoryRoot: "/repo", portable: false })).resolves.toEqual({
      revision: `project:${"d".repeat(64)}`, capability: "DEGRADED", reasonCode: "PROJECT_FINGERPRINT_READY",
    });
  });

  it("changes the bounded non-Git fingerprint with source content and ignores generated dependency state", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zhiloop-project-fingerprint-"));
    try {
      writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
      mkdirSync(path.join(root, "node_modules"));
      writeFileSync(path.join(root, "node_modules", "generated.js"), "one");
      const fingerprint = new NodeBoundedProjectFingerprint();
      const first = await fingerprint.fingerprint(root, "project-1");
      writeFileSync(path.join(root, "node_modules", "generated.js"), "two");
      expect(await fingerprint.fingerprint(root, "project-1")).toEqual(first);
      writeFileSync(path.join(root, "source.ts"), "export const value = 2;\n");
      expect((await fingerprint.fingerprint(root, "project-1")).revision).not.toBe(first.revision);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a Git revision stable when CodeGraph updates its generated state", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zhiloop-git-revision-codegraph-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "source.ts"], { cwd: root });
      execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"],
        { cwd: root, stdio: "ignore" });
      const port = new GitProjectRevisionPort();
      const project = { projectId: "project-1", repositoryRoot: root, portable: false } as const;
      const before = await port.capture(project);
      mkdirSync(path.join(root, ".codegraph"));
      writeFileSync(path.join(root, ".codegraph", ".gitignore"), "*\n");
      writeFileSync(path.join(root, ".codegraph", "index.sqlite"), "generated");
      expect(await port.capture(project)).toEqual(before);
      writeFileSync(path.join(root, "source.ts"), "export const value = 2;\n");
      expect((await port.capture(project)).revision).not.toBe(before.revision);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports rootless, bounded fallback, invalid HEAD, and option failures deterministically", async () => {
    const rootless = await new GitProjectRevisionPort(new ScriptedProcess([])).capture({ projectId: "project-1", portable: false });
    expect(rootless).toMatchObject({ capability: "DEGRADED", reasonCode: "PROJECT_ROOT_UNAVAILABLE" });
    const invalidHead = new ScriptedProcess([output("not-a-head"), output("")]);
    const fallback = { fingerprint: async () => ({ revision: `project:${"b".repeat(64)}`, bounded: true }) };
    await expect(new GitProjectRevisionPort(invalidHead, 1_000, 1_024, fallback)
      .capture({ projectId: "project-1", repositoryRoot: "/repo", portable: false }))
      .resolves.toEqual({ revision: `project:${"b".repeat(64)}`, capability: "DEGRADED", reasonCode: "PROJECT_FINGERPRINT_BOUNDED" });
    expect(() => new GitProjectRevisionPort(new ScriptedProcess([]), 9)).toThrow("PROJECT_REVISION_OPTIONS_INVALID");
    expect(() => new GitProjectRevisionPort(new ScriptedProcess([]), 1_000, 0)).toThrow("PROJECT_REVISION_OPTIONS_INVALID");
    expect(() => new NodeBoundedProjectFingerprint(0)).toThrow("PROJECT_FINGERPRINT_OPTIONS_INVALID");
  });

  it("bounds non-Git scans across depth, file count, bytes, directories, and symlinks", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zhiloop-project-fingerprint-bounds-"));
    try {
      mkdirSync(path.join(root, "nested"));
      writeFileSync(path.join(root, "nested", "deep.txt"), "deep");
      writeFileSync(path.join(root, "large.txt"), "12345");
      writeFileSync(path.join(root, "small.txt"), "1");
      symlinkSync(path.join(root, "small.txt"), path.join(root, "link.txt"));
      await expect(new NodeBoundedProjectFingerprint(100, 100, 4, 1).fingerprint(root, "project-1"))
        .resolves.toMatchObject({ revision: expect.stringMatching(/^project:/u), bounded: true });
      await expect(new NodeBoundedProjectFingerprint(1, 100, 100, 10).fingerprint(root, "project-1"))
        .resolves.toMatchObject({ bounded: true });
      await expect(new NodeBoundedProjectFingerprint(100, 1, 100, 10).fingerprint(root, "project-1"))
        .resolves.toMatchObject({ bounded: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("executes Git through the argv-only Node process port", async () => {
    const result = await new NodeGitRevisionProcess().run(process.cwd(), ["--version"], 1_000, 1_024);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, outputExceeded: false });
    expect(result.stdout.toString("utf8")).toMatch(/^git version/u);
  });
});
