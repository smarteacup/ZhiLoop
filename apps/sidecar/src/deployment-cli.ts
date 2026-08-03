import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Writable } from "node:stream";

import {
  delegateUpgradeToVerifiedArtifact,
  doctorLocalInstallation,
  installLocalRelease,
  MacOsLaunchctlController,
  planLocalInstall,
  purgeLocalData,
  readDeploymentManifest,
  resolveDeploymentPaths,
  uninstallLocalRelease,
  type HealthProbe,
} from "@zhiloop/local-deployment";
import type { SidecarHealth } from "@zhiloop/plugin-runtime";

import { SIDECAR_COMPATIBILITY, SIDECAR_VERSION } from "./metadata.js";
import { requestSidecar, SidecarRequestError } from "./transport.js";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function selectedHome(args: readonly string[]): string {
  return resolve(option(args, "--home") ?? homedir());
}

function output(value: unknown, stream: Writable, json: boolean): void {
  if (json) {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "object" && value !== null && "items" in value && Array.isArray((value as { items: unknown }).items)) {
    for (const item of (value as { items: Array<{ action: string; summary: string; path?: string }> }).items) {
      stream.write(`${item.action.padEnd(7)} ${item.summary}${item.path === undefined ? "" : `: ${item.path}`}\n`);
    }
    return;
  }
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function probe(home: string): HealthProbe {
  const paths = resolveDeploymentPaths(home, "0.0.0");
  return {
    health: async () => await requestSidecar(paths.socketPath, { type: "health" }, 1_000) as SidecarHealth,
  };
}

function captureErrorCode(error: unknown): string {
  if (error instanceof SidecarRequestError) return error.code;
  if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT")) {
    return "SIDECAR_UNAVAILABLE";
  }
  return "CAPTURE_REQUEST_FAILED";
}

function captureExitCode(code: string): number {
  if (code === "INVALID_SESSION_ID") return 64;
  if (code === "SESSION_NOT_FOUND") return 66;
  if (code === "SIDECAR_UNAVAILABLE") return 69;
  return 70;
}

export interface DeploymentCliRuntime {
  readonly currentVersion?: string;
  readonly currentEntrypoint?: string;
  readonly delegationTimeoutMs?: number;
  readonly delegationMaxOutputBytes?: number;
}

export async function runDeploymentCli(
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
  runtime: DeploymentCliRuntime = {},
): Promise<number> {
  const command = args[0];
  const json = args.includes("--json");
  const apply = args.includes("--apply");
  const home = selectedHome(args);
  const service = new MacOsLaunchctlController();
  if (command === "acceptance") {
    const sessionId = option(args, "--session");
    const taskCreatedAt = option(args, "--created-at");
    if (sessionId === undefined || taskCreatedAt === undefined) {
      stderr.write("usage: zhiloop acceptance --session <new-session-id> --created-at <ISO-8601> [--home PATH] [--json]\n");
      return 64;
    }
    try {
      const paths = resolveDeploymentPaths(home, "0.0.0");
      const result = await requestSidecar(paths.socketPath, {
        type: "acceptance.verify",
        sessionId,
        taskCreatedAt,
      }, 10_000);
      output(result, stdout, json);
      return (result as { result?: { status?: string } }).result?.status === "VERIFIED" ? 0 : 1;
    } catch (error) {
      const errorCode = captureErrorCode(error);
      output({ schemaVersion: 1, status: "FAILED", errorCode }, stderr, true);
      return captureExitCode(errorCode);
    }
  }
  if (command === "capture") {
    const sessionId = option(args, "--session");
    if (sessionId === undefined) {
      stderr.write("usage: zhiloop capture --session <id> [--dry-run] [--home PATH] [--json]\n");
      return 64;
    }
    try {
      const paths = resolveDeploymentPaths(home, "0.0.0");
      const report = await requestSidecar(paths.socketPath, {
        type: "capture-session",
        sessionId,
        dryRun: args.includes("--dry-run"),
      }, 30_000);
      output(report, stdout, json);
      return 0;
    } catch (error) {
      const errorCode = captureErrorCode(error);
      output({
        schemaVersion: 1,
        status: "FAILED",
        errorCode,
        ...(error instanceof SidecarRequestError && error.lineNumber !== undefined ? { lineNumber: error.lineNumber } : {}),
        ...(error instanceof SidecarRequestError && error.byteOffset !== undefined ? { byteOffset: error.byteOffset } : {}),
      }, stderr, true);
      return captureExitCode(errorCode);
    }
  }
  if (command === "install" || command === "upgrade") {
    const artifact = option(args, "--artifact");
    if (artifact === undefined) throw new Error(`${command} requires --artifact <absolute-release-directory>`);
    const artifactDirectory = resolve(artifact);
    const codexExecutable = option(args, "--codex-executable");
    if (command === "upgrade") {
      const delegation = await delegateUpgradeToVerifiedArtifact({
        artifactDirectory,
        home,
        args,
        currentVersion: runtime.currentVersion ?? SIDECAR_VERSION,
        ...(runtime.currentEntrypoint === undefined ? {} : { currentEntrypoint: runtime.currentEntrypoint }),
        compatibility: SIDECAR_COMPATIBILITY,
        stdout,
        stderr,
        ...(runtime.delegationTimeoutMs === undefined ? {} : { timeoutMs: runtime.delegationTimeoutMs }),
        ...(runtime.delegationMaxOutputBytes === undefined ? {} : { maxOutputBytes: runtime.delegationMaxOutputBytes }),
      });
      if (delegation.delegated) return delegation.exitCode;
    }
    const options = {
      home,
      artifactDirectory,
      service,
      health: probe(home),
      compatibility: SIDECAR_COMPATIBILITY,
      ...(codexExecutable === undefined ? {} : { codexExecutable }),
    };
    const plan = await planLocalInstall(options);
    if (!apply) {
      output(plan, stdout, json);
      return 0;
    }
    const result = await installLocalRelease(options);
    output({ status: "INSTALLED", version: result.manifest.version, mode: result.plan.mode, journal: result.journal.state }, stdout, json);
    return 0;
  }
  if (command === "doctor") {
    const report = await doctorLocalInstallation({ home, service, health: probe(home), compatibility: SIDECAR_COMPATIBILITY });
    output(report, stdout, json);
    return report.healthy ? 0 : 1;
  }
  if (command === "uninstall") {
    const manifestPath = resolveDeploymentPaths(home, "0.0.0").manifestPath;
    const manifest = await readDeploymentManifest(manifestPath);
    if (!apply) {
      output({
        schemaVersion: 1,
        operation: "uninstall",
        status: manifest === undefined ? "NOT_INSTALLED" : "PLANNED",
        retainedData: true,
        managedPaths: manifest?.managedPaths ?? [],
      }, stdout, json);
      return 0;
    }
    const result = await uninstallLocalRelease({ home, service });
    if (args.includes("--purge-data")) {
      const confirmation = option(args, "--confirm") ?? "";
      await purgeLocalData(home, confirmation);
    }
    output(result, stdout, json);
    return 0;
  }
  stderr.write("usage: zhiloop <acceptance|capture|install|upgrade|doctor|uninstall> [options]\n");
  return 64;
}
