import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveProjectIdentity } from "../packages/project-identity/dist/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", ["-C", cwd, ...args], { timeout: 5_000, maxBuffer: 64 * 1024 });
}

test("Project Identity Git adapter uses argument-safe local metadata commands only", async () => {
  const source = await readFile("packages/project-identity/src/resolver.ts", "utf8");
  assert.match(source, /execFile/);
  assert.doesNotMatch(source, /import\s+\{\s*(?:exec|spawn)\s*\}\s+from\s+["']node:child_process|shell:\s*true|fetch\(|https\.request|node:http/);
});

test("CKL-301: real Git worktrees share portable and local fallback identities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zhiloop-project-identity-"));
  const repository = path.join(directory, "repository");
  const linked = path.join(directory, "linked-worktree");
  try {
    await mkdir(repository);
    await git(repository, "init");
    await git(repository, "config", "user.name", "ZhiLoop Gate");
    await git(repository, "config", "user.email", "gate@zhiloop.invalid");
    await writeFile(path.join(repository, "package.json"), "{}\n", "utf8");
    await git(repository, "add", "package.json");
    await git(repository, "commit", "-m", "fixture");
    await git(repository, "remote", "add", "origin", "git@github.com:SmartEACup/ZhiLoop.git");
    await git(repository, "worktree", "add", "-b", "identity-gate", linked);

    const main = await resolveProjectIdentity(repository);
    const worktree = await resolveProjectIdentity(linked);
    assert.equal(main.context.projectId, worktree.context.projectId);
    assert.equal(main.context.portable, true);
    assert.equal(worktree.context.portable, true);
    assert.equal(main.context.repositoryRemote, "github.com/smarteacup/zhiloop");
    assert.notEqual(main.context.repositoryRoot, worktree.context.repositoryRoot);

    await git(repository, "remote", "remove", "origin");
    const localMain = await resolveProjectIdentity(repository);
    const localWorktree = await resolveProjectIdentity(linked);
    assert.equal(localMain.context.projectId, localWorktree.context.projectId);
    assert.equal(localMain.context.portable, false);
    assert.equal(localWorktree.context.portable, false);
    assert.notEqual(localMain.context.projectId, main.context.projectId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
