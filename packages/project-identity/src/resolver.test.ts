import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CliGitProjectProbe, normalizeGitRemote, resolveProjectIdentity } from "./resolver.js";
import type { GitProjectFacts, GitProjectProbe } from "./types.js";

function probe(facts: GitProjectFacts | undefined): GitProjectProbe {
  return { inspect: async () => facts };
}

describe("normalizeGitRemote", () => {
  it("unifies common GitHub transport and casing variants without retaining credentials", () => {
    const expected = "github.com/smarteacup/zhiloop";
    expect(normalizeGitRemote("git@GitHub.com:SmartEACup/ZhiLoop.git")).toBe(expected);
    expect(normalizeGitRemote("ssh://git@github.com:22/SmartEACup/ZhiLoop.git")).toBe(expected);
    expect(normalizeGitRemote("https://token-value@github.com/SmartEACup/ZhiLoop.git?x=1#fragment")).toBe(expected);
    expect(normalizeGitRemote("https://token-value@github.com/SmartEACup/ZhiLoop.git")).not.toContain("token-value");
  });

  it("keeps distinct hosts, repositories, and non-default ports separate", () => {
    expect(normalizeGitRemote("git@github.com:org/one.git")).not.toBe(normalizeGitRemote("git@github.com:org/two.git"));
    expect(normalizeGitRemote("git@github.com:org/one.git")).not.toBe(normalizeGitRemote("git@gitlab.com:org/one.git"));
    expect(normalizeGitRemote("ssh://git@example.com:2222/Org/Repo.git")).toBe("example.com:2222/Org/Repo");
    expect(normalizeGitRemote("ssh://git@example.com/Org/Repo.git")).toBe("example.com/Org/Repo");
  });

  it("rejects local, malformed, traversal, and unsupported remotes", () => {
    expect(normalizeGitRemote("/tmp/repository.git")).toBeUndefined();
    expect(normalizeGitRemote("file:///tmp/repository.git")).toBeUndefined();
    expect(normalizeGitRemote("https://github.com/org/%2E%2E/repo.git")).toBeUndefined();
    expect(normalizeGitRemote("git@bad..host:org/repo.git")).toBeUndefined();
    expect(normalizeGitRemote(" ")).toBeUndefined();
  });
});

describe("resolveProjectIdentity", () => {
  it("discovers a real Git repository through the default CLI probe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-cli-probe-"));
    try {
      execFileSync("git", ["-C", directory, "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", directory, "remote", "add", "origin", "https://github.com/SmartEACup/ZhiLoop.git"], { stdio: "ignore" });
      const resolved = await resolveProjectIdentity(directory);
      expect(resolved).toMatchObject({
        source: "GIT_REMOTE",
        context: { repositoryRemote: "github.com/smarteacup/zhiloop", portable: true },
      });
      expect(await new CliGitProjectProbe({ executable: "missing-git-executable" }).inspect(directory)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("assigns the same portable ID to different worktrees of one normalized remote", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-project-id-"));
    try {
      const common = join(directory, "main", ".git");
      const firstRoot = join(directory, "main");
      const secondRoot = join(directory, "worktree");
      mkdirSync(common, { recursive: true });
      mkdirSync(secondRoot, { recursive: true });
      const first = await resolveProjectIdentity(firstRoot, { gitProbe: probe({
        repositoryRoot: firstRoot,
        gitCommonDir: common,
        remoteUrl: "git@github.com:SmartEACup/ZhiLoop.git",
        branch: "main",
      }) });
      const second = await resolveProjectIdentity(secondRoot, { gitProbe: probe({
        repositoryRoot: secondRoot,
        gitCommonDir: common,
        remoteUrl: "https://github.com/smarteacup/zhiloop",
        branch: "feature",
      }) });

      expect(second.context.projectId).toBe(first.context.projectId);
      expect(first.context).toMatchObject({
        repositoryRemote: "github.com/smarteacup/zhiloop",
        portable: true,
        branch: "main",
      });
      expect(second.context.repositoryRoot).not.toBe(first.context.repositoryRoot);
      expect(first.source).toBe("GIT_REMOTE");
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.context)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never collides two different normalized remotes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-project-remotes-"));
    try {
      const root = join(directory, "repo");
      const common = join(root, ".git");
      mkdirSync(common, { recursive: true });
      const one = await resolveProjectIdentity(root, { gitProbe: probe({ repositoryRoot: root, gitCommonDir: common, remoteUrl: "git@github.com:org/one.git" }) });
      const two = await resolveProjectIdentity(root, { gitProbe: probe({ repositoryRoot: root, gitCommonDir: common, remoteUrl: "git@github.com:org/two.git" }) });
      expect(one.context.projectId).not.toBe(two.context.projectId);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the shared Git common directory for stable non-portable worktree identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-local-git-"));
    try {
      const common = join(directory, "main", ".git");
      const firstRoot = join(directory, "main");
      const secondRoot = join(directory, "worktree");
      mkdirSync(common, { recursive: true });
      mkdirSync(secondRoot, { recursive: true });
      const first = await resolveProjectIdentity(firstRoot, { gitProbe: probe({ repositoryRoot: firstRoot, gitCommonDir: common }) });
      const second = await resolveProjectIdentity(secondRoot, { gitProbe: probe({ repositoryRoot: secondRoot, gitCommonDir: common, remoteUrl: "/local/repo.git" }) });
      expect(first.context.projectId).toBe(second.context.projectId);
      expect(first.context.portable).toBe(false);
      expect(second.context.repositoryRemote).toBeUndefined();
      expect(second.reasonCodes).toContain("NON_PORTABLE_GIT_REMOTE");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finds the nearest filesystem marker and resolves symlinks to one local ID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-filesystem-id-"));
    try {
      const root = join(directory, "project");
      const nested = join(root, "src", "module");
      const alias = join(directory, "alias");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "package.json"), "{}", "utf8");
      symlinkSync(root, alias, "dir");
      const direct = await resolveProjectIdentity(nested, { gitProbe: probe(undefined) });
      const throughAlias = await resolveProjectIdentity(join(alias, "src", "module"), { gitProbe: probe(undefined) });
      expect(direct.context.projectId).toBe(throughAlias.context.projectId);
      expect(direct).toMatchObject({ source: "FILESYSTEM_LOCAL", rootMarker: "package.json" });
      expect(direct.context).toMatchObject({ repositoryRoot: realpathSync(root), portable: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps unrelated non-Git directories distinct and validates resolver inputs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-filesystem-distinct-"));
    try {
      const firstRoot = join(directory, "one");
      const secondRoot = join(directory, "two");
      mkdirSync(firstRoot);
      mkdirSync(secondRoot);
      const first = await resolveProjectIdentity(firstRoot, { gitProbe: probe(undefined), markerNames: [".marker"] });
      const second = await resolveProjectIdentity(secondRoot, { gitProbe: probe(undefined), markerNames: [".marker"] });
      expect(first.context.projectId).not.toBe(second.context.projectId);
      expect(first.rootMarker).toBe("directory");
      await expect(resolveProjectIdentity(firstRoot, { gitProbe: probe(undefined), markerNames: [] })).rejects.toThrow("markerNames");
      await expect(resolveProjectIdentity(firstRoot, { gitProbe: probe(undefined), markerNames: ["../package.json"] })).rejects.toThrow("markerNames");
      await expect(resolveProjectIdentity(" ")).rejects.toThrow("cwd");
      expect(() => new CliGitProjectProbe({ timeoutMs: 0 })).toThrow("timeoutMs");
      expect(() => new CliGitProjectProbe({ executable: " " })).toThrow("executable");
      await expect(resolveProjectIdentity(firstRoot, { gitProbe: probe({
        repositoryRoot: "",
        gitCommonDir: firstRoot,
      }) })).rejects.toThrow("incomplete project facts");
      await expect(resolveProjectIdentity(firstRoot, { gitProbe: probe({
        repositoryRoot: firstRoot,
        gitCommonDir: firstRoot,
        remoteUrl: " ",
      }) })).rejects.toThrow("invalid remote");
      await expect(resolveProjectIdentity(firstRoot, { gitProbe: probe({
        repositoryRoot: firstRoot,
        gitCommonDir: firstRoot,
        branch: "bad\nbranch",
      }) })).rejects.toThrow("invalid branch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
