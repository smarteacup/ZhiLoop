import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SidecarCompatibilityPolicy } from "@zhiloop/plugin-runtime";

import type { DeploymentStep, ReleaseFile, ReleaseMetadata } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

export const REQUIRED_LOCAL_RELEASE_FILES = Object.freeze([
  "apps/sidecar/dist/main.js",
  "apps/sidecar/dist/deploy-main.js",
  "apps/cli/dist/ui-main.js",
  "apps/cli/dist/ui-cli.js",
  "apps/console-gateway/dist/main.js",
  "apps/console-web/dist/index.html",
  "node_modules/@zhiloop/console-gateway/package.json",
  "node_modules/@zhiloop/automatic-ingestion/package.json",
  "node_modules/@zhiloop/configuration-service/package.json",
  "node_modules/@zhiloop/control-api/package.json",
  "node_modules/@zhiloop/job-runtime/package.json",
  "node_modules/@zhiloop/local-deployment/package.json",
  "node_modules/@zhiloop/observability/package.json",
  "node_modules/zod/package.json",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || isAbsolute(value)) {
    throw new Error("release file path must be relative");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized === ".." || normalized.split("/").includes(".")) {
    throw new Error("release file path must not escape the artifact");
  }
  return normalized;
}

export function parseReleaseMetadata(value: unknown): ReleaseMetadata {
  if (!isRecord(value) || value["schemaVersion"] !== 1 || !SEMVER.test(String(value["version"]))
    || !SEMVER.test(String(value["pluginVersion"])) || !Number.isSafeInteger(value["protocolVersion"])
    || (value["protocolVersion"] as number) < 1 || typeof value["sourceCommit"] !== "string"
    || !/^[a-f0-9]{7,64}$/u.test(value["sourceCommit"]) || typeof value["nodePath"] !== "string"
    || !isAbsolute(value["nodePath"]) || typeof value["nodeVersion"] !== "string"
    || !SEMVER.test(value["nodeVersion"]) || typeof value["createdAt"] !== "string"
    || Number.isNaN(Date.parse(value["createdAt"])) || !Array.isArray(value["files"])) {
    throw new Error("release metadata has an unsupported shape");
  }
  const files: ReleaseFile[] = value["files"].map((entry: unknown) => {
    if (!isRecord(entry) || !SHA256.test(String(entry["sha256"])) || !Number.isSafeInteger(entry["mode"])
      || (entry["mode"] as number) < 0o400 || (entry["mode"] as number) > 0o755) {
      throw new Error("release metadata contains an invalid file entry");
    }
    return Object.freeze({ path: safeRelativePath(entry["path"]), sha256: String(entry["sha256"]), mode: entry["mode"] as number });
  });
  if (files.length === 0 || new Set(files.map(({ path }) => path)).size !== files.length || files.some(({ path }) => path === "release.json")) {
    throw new Error("release metadata must contain unique payload files");
  }
  return Object.freeze({
    schemaVersion: 1,
    version: value["version"] as string,
    pluginVersion: value["pluginVersion"] as string,
    protocolVersion: value["protocolVersion"] as number,
    sourceCommit: value["sourceCommit"],
    nodePath: resolve(value["nodePath"]),
    nodeVersion: value["nodeVersion"],
    createdAt: value["createdAt"],
    files: Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path))),
  });
}

async function readMetadata(directory: string): Promise<ReleaseMetadata> {
  const path = join(directory, "release.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_BYTES) throw new Error("release.json must be a bounded regular file");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("release.json is not valid JSON");
  }
  return parseReleaseMetadata(value);
}

async function scanFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`release artifact contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await scanFiles(directory, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`release artifact contains an unsupported file type: ${relativePath}`);
  }
  return files.sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export interface VerifiedRelease {
  readonly metadata: ReleaseMetadata;
  readonly digest: string;
}

function sameVerifiedRelease(left: VerifiedRelease, right: VerifiedRelease): boolean {
  return left.digest === right.digest
    && JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}

export function assertSupportedDeploymentNodeVersion(version: string): void {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null) throw new Error("current Node runtime version is unsupported");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 24 || major >= 27 || (major === 24 && minor < 18)) {
    throw new Error("current Node runtime version is unsupported");
  }
}

export async function verifyReleaseArtifact(directory: string): Promise<VerifiedRelease> {
  if (!isAbsolute(directory)) throw new Error("release artifact path must be absolute");
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("release artifact must be a real directory");
  assertSupportedDeploymentNodeVersion(process.versions.node);
  const metadata = await readMetadata(directory);
  const actual = await scanFiles(directory);
  const expected = ["release.json", ...metadata.files.map(({ path }) => path)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("release artifact file inventory does not match metadata");
  for (const file of metadata.files) {
    const path = join(directory, ...file.path.split("/"));
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || await sha256(path) !== file.sha256) {
      throw new Error(`release file failed integrity verification: ${file.path}`);
    }
  }
  const digest = createHash("sha256").update(metadata.files.map(({ path, sha256: hash, mode }) => `${path}\0${hash}\0${mode.toString(8)}\n`).join("")).digest("hex");
  return Object.freeze({ metadata, digest });
}

export async function verifyCompatibleLocalReleaseArtifact(
  directory: string,
  compatibility: SidecarCompatibilityPolicy,
): Promise<VerifiedRelease> {
  const verified = await verifyReleaseArtifact(resolve(directory));
  const files = new Set(verified.metadata.files.map(({ path }) => path));
  const missing = REQUIRED_LOCAL_RELEASE_FILES.filter((path) => !files.has(path));
  if (missing.length > 0) throw new Error(`release artifact is missing required local runtime files: ${missing.join(", ")}`);
  if (verified.metadata.pluginVersion !== compatibility.pluginVersion
    || verified.metadata.protocolVersion !== compatibility.protocolVersion) {
    throw new Error("release artifact is incompatible with the requested plugin contract");
  }
  return verified;
}

async function copyVerifiedRelease(source: string, target: string, verified: VerifiedRelease): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const file of verified.metadata.files) {
    const destination = join(target, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(source, ...file.path.split("/")), destination);
    if (process.platform !== "win32") await chmod(destination, file.mode);
  }
  await writeFile(join(target, "release.json"), `${JSON.stringify(verified.metadata, null, 2)}\n`, { flag: "wx", mode: 0o444 });
}

export interface VerifiedReleaseSnapshot {
  readonly directory: string;
  readonly verified: VerifiedRelease;
  cleanup(): Promise<void>;
}

export async function createVerifiedReleaseSnapshot(
  source: string,
  compatibility: SidecarCompatibilityPolicy,
): Promise<VerifiedReleaseSnapshot> {
  const verified = await verifyCompatibleLocalReleaseArtifact(resolve(source), compatibility);
  const root = await mkdtemp(join(tmpdir(), "zhiloop-delegated-release-"));
  const directory = join(root, "artifact");
  try {
    await copyVerifiedRelease(resolve(source), directory, verified);
    const copied = await verifyReleaseArtifact(directory);
    if (!sameVerifiedRelease(copied, verified)) {
      throw new Error("verified release snapshot does not match the source artifact");
    }
    return Object.freeze({
      directory,
      verified: copied,
      cleanup: async () => rm(root, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function stageReleaseStep(id: string, artifactDirectory: string, releaseDirectory: string): Promise<DeploymentStep> {
  const source = resolve(artifactDirectory);
  const target = resolve(releaseDirectory);
  const verified = await verifyReleaseArtifact(source);
  if (basename(target) !== verified.metadata.version || relative(dirname(target), target).startsWith(`..${sep}`)) {
    throw new Error("release target does not match release metadata version");
  }
  let reuse = false;
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("release target must be a real directory or absent");
    const existing = await verifyReleaseArtifact(target);
    if (!sameVerifiedRelease(existing, verified)) {
      throw new Error("installed release version has different content or metadata");
    }
    reuse = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return Object.freeze({
    id,
    apply: async () => {
      if (reuse) return async () => undefined;
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await copyVerifiedRelease(source, temporary, verified);
        const staged = await verifyReleaseArtifact(temporary);
        if (!sameVerifiedRelease(staged, verified)) {
          throw new Error("staged release does not match the verified source artifact");
        }
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
      return async () => rm(target, { recursive: true, force: true });
    },
  });
}
