import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { ProjectContext } from "@zhiloop/domain";

import type { ProjectRevisionPort, ProjectRevisionSnapshot } from "./types.js";

export interface GitRevisionProcessResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

export interface GitRevisionProcessPort {
  run(cwd: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number): Promise<GitRevisionProcessResult>;
}

export interface ProjectFingerprintPort {
  fingerprint(repositoryRoot: string, projectId: string): Promise<{ readonly revision: string; readonly bounded: boolean }>;
}

const IGNORED_DIRECTORIES = new Set([".git", ".codegraph", ".zhiloop", "node_modules"]);

export class NodeBoundedProjectFingerprint implements ProjectFingerprintPort {
  constructor(
    private readonly maxFiles = 10_000,
    private readonly maxTotalBytes = 16_777_216,
    private readonly maxFileBytes = 1_048_576,
    private readonly maxDepth = 32,
  ) {
    if (![maxFiles, maxTotalBytes, maxFileBytes, maxDepth].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("PROJECT_FINGERPRINT_OPTIONS_INVALID");
    }
  }

  async fingerprint(repositoryRoot: string, projectId: string): Promise<{ readonly revision: string; readonly bounded: boolean }> {
    const root = await realpath(repositoryRoot);
    const hash = createHash("sha256").update(`project-fingerprint-v1\0${projectId}\0`);
    let files = 0;
    let bytes = 0;
    let bounded = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > this.maxDepth || files >= this.maxFiles || bytes >= this.maxTotalBytes) { bounded = true; return; }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files >= this.maxFiles || bytes >= this.maxTotalBytes) { bounded = true; break; }
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
        files += 1;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (entry.isSymbolicLink()) {
          const stat = await lstat(absolute);
          hash.update(`L\0${relative}\0${stat.size}\0${stat.mtimeMs}\0`);
          continue;
        }
        if (entry.isDirectory()) { hash.update(`D\0${relative}\0`); await visit(absolute, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const stat = await lstat(absolute);
        if (stat.size > this.maxFileBytes || bytes + stat.size > this.maxTotalBytes) {
          bounded = true;
          hash.update(`B\0${relative}\0${stat.size}\0${stat.mtimeMs}\0`);
          continue;
        }
        const handle = await open(absolute, "r");
        try {
          const buffer = Buffer.allocUnsafe(Math.min(this.maxFileBytes, this.maxTotalBytes - bytes) + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
          if (bytesRead > this.maxFileBytes || bytes + bytesRead > this.maxTotalBytes) {
            bounded = true;
            hash.update(`B\0${relative}\0${stat.size}\0${stat.mtimeMs}\0`);
            continue;
          }
          const content = buffer.subarray(0, bytesRead);
          bytes += bytesRead;
          hash.update(`F\0${relative}\0${bytesRead}\0`).update(content).update("\0");
        } finally { await handle.close(); }
      }
    };
    await visit(root, 0);
    return { revision: `project:${hash.digest("hex")}`, bounded };
  }
}

export class NodeGitRevisionProcess implements GitRevisionProcessPort {
  run(cwd: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number): Promise<GitRevisionProcessResult> {
    return new Promise((resolve) => {
      const child = spawn("git", [...args], { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let outputExceeded = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxOutputBytes) { outputExceeded = true; child.kill("SIGKILL"); return; }
        chunks.push(chunk);
      });
      child.once("error", () => { clearTimeout(timer); resolve({ exitCode: null, stdout: Buffer.alloc(0), timedOut, outputExceeded }); });
      child.once("close", (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(chunks), timedOut, outputExceeded }); });
    });
  }
}

export class GitProjectRevisionPort implements ProjectRevisionPort {
  constructor(
    private readonly process: GitRevisionProcessPort = new NodeGitRevisionProcess(),
    private readonly timeoutMs = 1_000,
    private readonly maxOutputBytes = 1_048_576,
    private readonly fallback: ProjectFingerprintPort = new NodeBoundedProjectFingerprint(),
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16_777_216) {
      throw new Error("PROJECT_REVISION_OPTIONS_INVALID");
    }
  }

  async #fallbackRevision(root: string, projectId: string): Promise<ProjectRevisionSnapshot> {
    try {
      const fallback = await this.fallback.fingerprint(root, projectId);
      return Object.freeze({ revision: fallback.revision, capability: "DEGRADED",
        reasonCode: fallback.bounded ? "PROJECT_FINGERPRINT_BOUNDED" : "PROJECT_FINGERPRINT_READY" });
    } catch {
      return Object.freeze({ revision: `degraded:${createHash("sha256").update(`${projectId}\0${root}`).digest("hex")}`,
        capability: "DEGRADED", reasonCode: "PROJECT_FINGERPRINT_UNAVAILABLE" });
    }
  }

  async capture(project: ProjectContext): Promise<ProjectRevisionSnapshot> {
    const root = project.repositoryRoot;
    if (root === undefined) return Object.freeze({ revision: `degraded:${createHash("sha256").update(project.projectId).digest("hex")}`,
      capability: "DEGRADED", reasonCode: "PROJECT_ROOT_UNAVAILABLE" });
    const [head, status] = await Promise.all([
      this.process.run(root, ["rev-parse", "--verify", "HEAD"], this.timeoutMs, 1_024),
      this.process.run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], this.timeoutMs, this.maxOutputBytes),
    ]);
    if (head.exitCode !== 0 || status.exitCode !== 0 || head.timedOut || status.timedOut || head.outputExceeded || status.outputExceeded) {
      return this.#fallbackRevision(root, project.projectId);
    }
    const headText = head.stdout.toString("utf8").trim();
    if (!/^[a-f0-9]{40,64}$/u.test(headText)) {
      return this.#fallbackRevision(root, project.projectId);
    }
    const dirtyDigest = createHash("sha256").update(status.stdout).digest("hex");
    return Object.freeze({ revision: `git:${headText}:${dirtyDigest}`, capability: "READY", reasonCode: "GIT_REVISION_READY" });
  }
}
