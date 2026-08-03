import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";

import type { SidecarCompatibilityPolicy } from "@zhiloop/plugin-runtime";

import { createVerifiedReleaseSnapshot, verifyCompatibleLocalReleaseArtifact } from "./release.js";

const DEPLOYMENT_ENTRYPOINT = join("apps", "sidecar", "dist", "deploy-main.js");
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;
const DELEGATION_FAILURE_EXIT_CODE = 70;

export type ArtifactDelegationErrorCode =
  | "DELEGATED_DEPLOYMENT_LAUNCH_FAILED"
  | "DELEGATED_DEPLOYMENT_OUTPUT_LIMIT"
  | "DELEGATED_DEPLOYMENT_SIGNALLED"
  | "DELEGATED_DEPLOYMENT_TIMEOUT";

export type ArtifactDelegationResult =
  | { readonly delegated: false }
  | {
    readonly delegated: true;
    readonly exitCode: number;
    readonly errorCode?: ArtifactDelegationErrorCode;
  };

export interface ArtifactDelegationOptions {
  readonly artifactDirectory: string;
  readonly home: string;
  readonly args: readonly string[];
  readonly currentVersion: string;
  readonly currentEntrypoint?: string;
  readonly compatibility: SidecarCompatibilityPolicy;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface CapturedOutput {
  readonly bytes: Buffer;
  readonly exceeded: boolean;
}

interface ChildResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly errorCode?: ArtifactDelegationErrorCode;
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`${name} must be a positive integer`);
  return selected;
}

async function sameRealFile(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false;
  try {
    return await realpath(resolve(left)) === await realpath(resolve(right));
  } catch {
    return false;
  }
}

function replaceOption(args: readonly string[], name: string, value: string): string[] {
  const result = [...args];
  const index = result.indexOf(name);
  if (index < 0) return [...result, name, value];
  if (index + 1 >= result.length) throw new Error(`${name} requires a value`);
  result[index + 1] = value;
  return result;
}

function boundedOutput(chunks: readonly Buffer[], totalBytes: number, maxBytes: number): CapturedOutput {
  const exceeded = totalBytes > maxBytes;
  if (chunks.length === 0) return { bytes: Buffer.alloc(0), exceeded };
  return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), exceeded };
}

function withDiagnostic(output: Buffer, errorCode: ArtifactDelegationErrorCode | undefined, maxBytes: number): Buffer {
  if (errorCode === undefined) return output.subarray(0, maxBytes);
  const diagnostic = Buffer.from(`delegated deployment failed: ${errorCode}\n`, "utf8");
  if (diagnostic.length >= maxBytes) return diagnostic.subarray(0, maxBytes);
  return Buffer.concat([output.subarray(0, maxBytes - diagnostic.length), diagnostic]);
}

async function executeDelegatedArtifact(
  nodePath: string,
  entrypoint: string,
  artifactDirectory: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ChildResult> {
  return await new Promise((resolveChild) => {
    const child = spawn(nodePath, [entrypoint, ...args], {
      cwd: artifactDirectory,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let launchFailed = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };
    const capture = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const previous = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maxOutputBytes - previous);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (previous + chunk.length > maxOutputBytes) {
        outputExceeded = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(stderrChunks, chunk, "stderr"));
    child.once("error", () => {
      launchFailed = true;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      const capturedStdout = boundedOutput(stdoutChunks, stdoutBytes, maxOutputBytes);
      const capturedStderr = boundedOutput(stderrChunks, stderrBytes, maxOutputBytes);
      const errorCode: ArtifactDelegationErrorCode | undefined = launchFailed
        ? "DELEGATED_DEPLOYMENT_LAUNCH_FAILED"
        : outputExceeded || capturedStdout.exceeded || capturedStderr.exceeded
          ? "DELEGATED_DEPLOYMENT_OUTPUT_LIMIT"
          : timedOut
            ? "DELEGATED_DEPLOYMENT_TIMEOUT"
            : signal !== null
              ? "DELEGATED_DEPLOYMENT_SIGNALLED"
              : undefined;
      resolveChild({
        exitCode: errorCode === undefined && code !== null ? code : DELEGATION_FAILURE_EXIT_CODE,
        stdout: capturedStdout.bytes,
        stderr: capturedStderr.bytes,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    });
  });
}

export async function delegateUpgradeToVerifiedArtifact(
  options: ArtifactDelegationOptions,
): Promise<ArtifactDelegationResult> {
  const artifactDirectory = resolve(options.artifactDirectory);
  const verified = await verifyCompatibleLocalReleaseArtifact(artifactDirectory, options.compatibility);
  const artifactEntrypoint = join(artifactDirectory, DEPLOYMENT_ENTRYPOINT);
  if (verified.metadata.version === options.currentVersion
    || await sameRealFile(options.currentEntrypoint, artifactEntrypoint)) {
    return Object.freeze({ delegated: false });
  }

  const timeoutMs = positiveBound(options.timeoutMs, DEFAULT_TIMEOUT_MS, "delegation timeout");
  const maxOutputBytes = positiveBound(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "delegation output limit");
  const snapshot = await createVerifiedReleaseSnapshot(artifactDirectory, options.compatibility);
  try {
    if (snapshot.verified.digest !== verified.digest
      || JSON.stringify(snapshot.verified.metadata) !== JSON.stringify(verified.metadata)) {
      throw new Error("release artifact changed while delegation was being prepared");
    }
    const snapshotEntrypoint = join(snapshot.directory, DEPLOYMENT_ENTRYPOINT);
    let delegatedArgs = replaceOption(options.args, "--artifact", snapshot.directory);
    delegatedArgs = replaceOption(delegatedArgs, "--home", resolve(options.home));
    const child = await executeDelegatedArtifact(
      process.execPath,
      snapshotEntrypoint,
      snapshot.directory,
      delegatedArgs,
      timeoutMs,
      maxOutputBytes,
    );
    if (child.stdout.length > 0) options.stdout.write(child.stdout);
    const delegatedStderr = withDiagnostic(child.stderr, child.errorCode, maxOutputBytes);
    if (delegatedStderr.length > 0) options.stderr.write(delegatedStderr);
    return Object.freeze({
      delegated: true,
      exitCode: child.exitCode,
      ...(child.errorCode === undefined ? {} : { errorCode: child.errorCode }),
    });
  } finally {
    await snapshot.cleanup();
  }
}
