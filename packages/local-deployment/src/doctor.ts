import { lstat } from "node:fs/promises";

import { evaluateSidecarCompatibility, type SidecarCompatibilityPolicy } from "@zhiloop/plugin-runtime";

import { readDeploymentManifest } from "./installer.js";
import { resolveDeploymentPaths } from "./paths.js";
import { verifyReleaseArtifact } from "./release.js";
import type { HealthProbe, ServiceController } from "./types.js";

export interface DoctorCheck {
  readonly id: string;
  readonly status: "PASS" | "FAIL";
  readonly code: string;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly healthy: boolean;
  readonly mode: "SHADOW" | "UNKNOWN";
  readonly version?: string;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly home: string;
  readonly service: ServiceController;
  readonly health: HealthProbe;
  readonly compatibility: SidecarCompatibilityPolicy;
}

async function permissionCheck(path: string, expected: number): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && (process.platform === "win32" || (stat.mode & 0o777) === expected);
  } catch {
    return false;
  }
}

export async function doctorLocalInstallation(options: DoctorOptions): Promise<DoctorReport> {
  const manifestPath = resolveDeploymentPaths(options.home, "0.0.0").manifestPath;
  const manifest = await readDeploymentManifest(manifestPath);
  if (manifest === undefined) {
    const missing: DoctorCheck = { id: "manifest", status: "FAIL", code: "NOT_INSTALLED" };
    return Object.freeze({ schemaVersion: 1, healthy: false, mode: "UNKNOWN", checks: Object.freeze([missing]) });
  }
  const paths = resolveDeploymentPaths(options.home, manifest.version);
  const checks: DoctorCheck[] = [];
  try {
    const release = await verifyReleaseArtifact(paths.releaseDirectory);
    checks.push({ id: "release", status: release.digest === manifest.releaseDigest ? "PASS" : "FAIL", code: release.digest === manifest.releaseDigest ? "INTEGRITY_OK" : "DIGEST_MISMATCH" });
  } catch {
    checks.push({ id: "release", status: "FAIL", code: "INTEGRITY_FAILED" });
  }
  const configPermissions = await permissionCheck(paths.configPath, 0o600);
  const launcherPermissions = await permissionCheck(paths.sidecarLauncher, 0o700);
  checks.push({ id: "config-permissions", status: configPermissions ? "PASS" : "FAIL", code: configPermissions ? "MODE_OK" : "MODE_INVALID" });
  checks.push({ id: "launcher-permissions", status: launcherPermissions ? "PASS" : "FAIL", code: launcherPermissions ? "MODE_OK" : "MODE_INVALID" });
  const service = await options.service.status();
  checks.push({ id: "service", status: service === "RUNNING" ? "PASS" : "FAIL", code: service });
  const health = await options.health.health().catch(() => undefined);
  const compatibility = evaluateSidecarCompatibility(health, options.compatibility);
  checks.push({ id: "compatibility", status: compatibility.compatible ? "PASS" : "FAIL", code: compatibility.compatible ? "COMPATIBLE" : compatibility.issues[0]?.code ?? "UNAVAILABLE" });
  const mode = (health as { rolloutMode?: unknown } | undefined)?.rolloutMode === "SHADOW" ? "SHADOW" : "UNKNOWN";
  checks.push({ id: "rollout", status: mode === "SHADOW" ? "PASS" : "FAIL", code: mode === "SHADOW" ? "SHADOW" : "MODE_INVALID" });
  return Object.freeze({
    schemaVersion: 1,
    healthy: checks.every(({ status }) => status === "PASS"),
    mode,
    version: manifest.version,
    checks: Object.freeze(checks),
  });
}
