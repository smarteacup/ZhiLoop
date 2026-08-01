import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectContext } from "@zhiloop/domain";

import type {
  CliGitProjectProbeOptions,
  GitProjectFacts,
  GitProjectProbe,
  ProjectIdentityResolution,
  ProjectIdentityResolverOptions,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CASE_INSENSITIVE_REPOSITORY_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const DEFAULT_MARKERS = [
  ".zhiloop-project",
  ".git",
  "package.json",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
  "go.mod",
  ".project",
] as const;

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value).normalize("NFKC");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function normalizedRepositoryPath(host: string, pathname: string): string | undefined {
  let value: string;
  try {
    value = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  value = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  value = value.replace(/\.git$/i, "");
  if (value.length === 0 || value.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    return undefined;
  }
  return CASE_INSENSITIVE_REPOSITORY_HOSTS.has(host) ? value.toLocaleLowerCase("en-US") : value;
}

function isValidHost(host: string): boolean {
  if (host.length < 1 || host.length > 253 || host.includes("..")) return false;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true;
  return host.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

export function normalizeGitRemote(remote: string): string | undefined {
  if (typeof remote !== "string") return undefined;
  const input = remote.trim().normalize("NFKC");
  if (input.length === 0 || input.includes("\0")) return undefined;
  if (/%2e/i.test(input)) return undefined;
  const scp = input.includes("://") ? null : /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(input);
  if (scp !== null && !/^[A-Za-z]:[\\/]/.test(input)) {
    const host = (scp[1] as string).toLocaleLowerCase("en-US").replace(/\.$/, "");
    const repositoryPath = normalizedRepositoryPath(host, scp[2] as string);
    return !isValidHost(host) || repositoryPath === undefined ? undefined : `${host}/${repositoryPath}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }
  if (!["ssh:", "git:", "http:", "https:"].includes(parsed.protocol)) return undefined;
  const host = parsed.hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
  const repositoryPath = normalizedRepositoryPath(host, parsed.pathname);
  if (!isValidHost(host) || repositoryPath === undefined) return undefined;
  const defaultPort = (parsed.protocol === "ssh:" && (parsed.port === "" || parsed.port === "22"))
    || (parsed.protocol === "http:" && (parsed.port === "" || parsed.port === "80"))
    || (parsed.protocol === "https:" && (parsed.port === "" || parsed.port === "443"))
    || (parsed.protocol === "git:" && parsed.port === "");
  const authority = defaultPort ? host : `${host}:${parsed.port}`;
  return `${authority}/${repositoryPath}`;
}

function assertFacts(facts: GitProjectFacts): void {
  if (
    facts.repositoryRoot.trim().length === 0 || facts.repositoryRoot.length > 16_384
    || facts.gitCommonDir.trim().length === 0 || facts.gitCommonDir.length > 16_384
  ) {
    throw new Error("Git probe returned incomplete project facts");
  }
  if (facts.remoteUrl !== undefined && (facts.remoteUrl.trim().length === 0 || facts.remoteUrl.length > 16_384)) {
    throw new Error("Git probe returned an invalid remote");
  }
  if (facts.branch !== undefined && (
    facts.branch.trim().length === 0 || facts.branch.length > 500 || /[\0\r\n]/.test(facts.branch)
  )) {
    throw new Error("Git probe returned an invalid branch");
  }
}

async function existingMarker(directory: string, markers: readonly string[]): Promise<string | undefined> {
  for (const marker of markers) {
    try {
      await access(path.join(directory, marker));
      return marker;
    } catch {
      // Try the next marker or ancestor.
    }
  }
  return undefined;
}

async function localRoot(cwd: string, markers: readonly string[]): Promise<{ root: string; marker: string }> {
  let current = cwd;
  while (true) {
    const marker = await existingMarker(current, markers);
    if (marker !== undefined) return { root: current, marker };
    const parent = path.dirname(current);
    if (parent === current) return { root: cwd, marker: "directory" };
    current = parent;
  }
}

async function resolveExistingDirectory(cwd: string): Promise<string> {
  if (typeof cwd !== "string" || cwd.trim().length === 0) throw new Error("cwd must be a non-empty path");
  return normalizePath(await realpath(cwd));
}

function context(value: ProjectContext): ProjectContext {
  return deepFreeze(value);
}

export async function resolveProjectIdentity(
  cwd: string,
  options: ProjectIdentityResolverOptions = {},
): Promise<ProjectIdentityResolution> {
  const resolvedCwd = await resolveExistingDirectory(cwd);
  const probe = options.gitProbe ?? new CliGitProjectProbe();
  const facts = await probe.inspect(resolvedCwd);
  if (facts !== undefined) {
    assertFacts(facts);
    const repositoryRoot = normalizePath(await realpath(facts.repositoryRoot));
    const commonDir = normalizePath(await realpath(facts.gitCommonDir));
    const remote = facts.remoteUrl === undefined ? undefined : normalizeGitRemote(facts.remoteUrl);
    if (remote !== undefined) {
      return deepFreeze({
        context: context({
          projectId: hash(["project-identity-v1", "portable-git", remote]),
          repositoryRoot,
          repositoryRemote: remote,
          ...(facts.branch === undefined ? {} : { branch: facts.branch }),
          portable: true,
        }),
        source: "GIT_REMOTE" as const,
        rootMarker: "git-remote",
        reasonCodes: ["NORMALIZED_GIT_REMOTE", "WORKTREE_COMMON_IDENTITY"],
      });
    }
    return deepFreeze({
      context: context({
        projectId: hash(["project-identity-v1", "local-git", commonDir]),
        repositoryRoot,
        ...(facts.branch === undefined ? {} : { branch: facts.branch }),
        portable: false,
      }),
      source: "GIT_LOCAL" as const,
      rootMarker: commonDir,
      reasonCodes: [facts.remoteUrl === undefined ? "NO_GIT_REMOTE" : "NON_PORTABLE_GIT_REMOTE", "GIT_COMMON_DIR_FALLBACK"],
    });
  }

  const markers = options.markerNames ?? DEFAULT_MARKERS;
  if (markers.length === 0 || markers.some((marker) =>
    marker.trim().length === 0 || marker.length > 255 || path.isAbsolute(marker)
    || path.basename(marker) !== marker || marker === "." || marker === "..")) {
    throw new Error("markerNames must contain non-empty relative names");
  }
  const discovered = await localRoot(resolvedCwd, markers);
  const repositoryRoot = normalizePath(await realpath(discovered.root));
  return deepFreeze({
    context: context({
      projectId: hash(["project-identity-v1", "filesystem-local", repositoryRoot, discovered.marker]),
      repositoryRoot,
      portable: false,
    }),
    source: "FILESYSTEM_LOCAL" as const,
    rootMarker: discovered.marker,
    reasonCodes: ["NO_GIT_REPOSITORY", "FILESYSTEM_ROOT_MARKER"],
  });
}

async function gitOutput(executable: string, timeoutMs: number, cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync(executable, ["-C", cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      encoding: "utf8",
    });
    const output = result.stdout.trim();
    return output.length === 0 ? undefined : output;
  } catch {
    return undefined;
  }
}

export class CliGitProjectProbe implements GitProjectProbe {
  readonly #executable: string;
  readonly #timeoutMs: number;

  constructor(options: CliGitProjectProbeOptions = {}) {
    this.#executable = options.executable ?? "git";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.#executable.trim().length === 0) throw new Error("Git executable must be non-empty");
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`Git timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
    }
  }

  async inspect(cwd: string): Promise<GitProjectFacts | undefined> {
    const repositoryRoot = await gitOutput(this.#executable, this.#timeoutMs, cwd, ["rev-parse", "--show-toplevel"]);
    if (repositoryRoot === undefined) return undefined;
    const [commonOutput, branch, remoteOutput] = await Promise.all([
      gitOutput(this.#executable, this.#timeoutMs, repositoryRoot, ["rev-parse", "--git-common-dir"]),
      gitOutput(this.#executable, this.#timeoutMs, repositoryRoot, ["symbolic-ref", "--short", "-q", "HEAD"]),
      gitOutput(this.#executable, this.#timeoutMs, repositoryRoot, ["remote"]),
    ]);
    if (commonOutput === undefined) return undefined;
    const gitCommonDir = path.isAbsolute(commonOutput) ? commonOutput : path.resolve(repositoryRoot, commonOutput);
    const remoteNames = remoteOutput
      ?.split(/\r?\n/).map((item) => item.trim())
      .filter((item) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(item)).sort();
    let remoteName: string | undefined;
    if (remoteNames !== undefined && remoteNames.length > 0) {
      const [pushDefault, branchRemote] = await Promise.all([
        gitOutput(this.#executable, this.#timeoutMs, repositoryRoot, ["config", "--get", "remote.pushDefault"]),
        branch === undefined
          ? Promise.resolve(undefined)
          : gitOutput(this.#executable, this.#timeoutMs, repositoryRoot, ["config", "--get", `branch.${branch}.remote`]),
      ]);
      remoteName = [pushDefault, branchRemote, remoteNames.includes("origin") ? "origin" : undefined, remoteNames[0]]
        .find((item) => item !== undefined && item !== "." && remoteNames.includes(item));
    }
    const remoteUrl = remoteName === undefined
      ? undefined
      : await gitOutput(this.#executable, this.#timeoutMs, repositoryRoot, ["remote", "get-url", remoteName]);
    return {
      repositoryRoot,
      gitCommonDir,
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
      ...(branch === undefined ? {} : { branch }),
    };
  }
}
