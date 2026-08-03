import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";

import {
  evaluateSidecarCompatibility,
  CodexAppServerHookTrustControl,
  CodexHookTrustInstaller,
  HookConfigurationInstaller,
  parseHookConfiguration,
  ZHILOOP_HOOK_CONFIGURATION,
  type HookConfiguration,
  type CodexHookTrustControlPort,
  type ManagedHookEntry,
  type SidecarCompatibilityPolicy,
} from "@zhiloop/plugin-runtime";

import { renderLaunchAgent } from "./macos.js";
import { resolveDeploymentPaths } from "./paths.js";
import { stageReleaseStep, verifyCompatibleLocalReleaseArtifact } from "./release.js";
import { pathExists } from "./secure-files.js";
import { replaceFileStep, replaceSymlinkStep } from "./steps.js";
import { executeDeploymentTransaction } from "./transaction.js";
import type {
  DeploymentManifest,
  DeploymentPlan,
  DeploymentPlanItem,
  DeploymentStep,
  DeploymentTransactionResult,
  HealthProbe,
  ReleaseMetadata,
  ServiceController,
} from "./types.js";

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_CONFIGURATION_BYTES = 1_048_576;

export interface LocalInstallOptions {
  readonly home: string;
  readonly artifactDirectory: string;
  readonly service: ServiceController;
  readonly health: HealthProbe;
  readonly compatibility: SidecarCompatibilityPolicy;
  readonly readinessAttempts?: number;
  readonly readinessDelayMs?: number;
  readonly failAfterStep?: string;
  readonly clock?: () => Date;
  readonly randomId?: () => string;
  readonly hookTrustControl?: CodexHookTrustControlPort;
  readonly codexExecutable?: string;
}

export interface LocalInstallResult extends DeploymentTransactionResult {
  readonly plan: DeploymentPlan;
  readonly manifest: DeploymentManifest;
}

function shellQuote(value: string): string {
  if (value.includes("\0") || /[\r\n]/u.test(value)) throw new Error("launcher path contains unsafe characters");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function launcher(nodePath: string, entrypoint: string, configPath: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(entrypoint)} "$@" --config ${shellQuote(configPath)}\n`;
}

export function renderZhiLoopLauncher(nodePath: string, deploymentEntrypoint: string, uiEntrypoint: string): string {
  return `#!/bin/sh\nif [ "$1" = "ui" ]; then\n  shift\n  exec ${shellQuote(nodePath)} ${shellQuote(uiEntrypoint)} "$@"\nfi\nexec ${shellQuote(nodePath)} ${shellQuote(deploymentEntrypoint)} "$@"\n`;
}

export function managedHookConfiguration(sidecarLauncher: string, configPath: string): HookConfiguration {
  const command = `${shellQuote(sidecarLauncher)} hook --config ${shellQuote(configPath)}`;
  const cloned = structuredClone(ZHILOOP_HOOK_CONFIGURATION);
  for (const groups of Object.values(cloned.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.type === "command") {
          (hook as { command: string }).command = command;
          delete (hook as { commandWindows?: string }).commandWindows;
        }
      }
    }
  }
  return parseHookConfiguration(cloned);
}

async function validateCodexExecutable(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("Codex executable must be an absolute safe path");
  }
  const normalized = resolve(value);
  const stat = await lstat(normalized);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o111) === 0)) {
    throw new Error("Codex executable must be a regular executable file");
  }
  return normalized;
}

async function inheritedCodexExecutable(configPath: string): Promise<string | undefined> {
  if (!(await pathExists(configPath))) return undefined;
  const metadata = await lstat(configPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONFIGURATION_BYTES) {
    throw new Error("existing sidecar configuration must be a bounded regular file");
  }
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("existing sidecar configuration has an unsupported shape");
  }
  const query = (parsed as { codexQuery?: unknown }).codexQuery;
  if (query === undefined) return undefined;
  if (typeof query !== "object" || query === null || Array.isArray(query)
    || (query as { enabled?: unknown }).enabled !== true
    || typeof (query as { executable?: unknown }).executable !== "string") {
    throw new Error("existing Codex query configuration has an unsupported shape");
  }
  return await validateCodexExecutable((query as { executable: string }).executable);
}

function configuration(paths: ReturnType<typeof resolveDeploymentPaths>, codexExecutable?: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    rolloutMode: "SHADOW",
    socketPath: paths.socketPath,
    codexSessionsRoot: paths.codexSessionsRoot,
    ledgerPath: paths.ledgerPath,
    spoolPath: paths.spoolDirectory,
    logPath: paths.sidecarLogPath,
    hookMaxInputBytes: 5_242_880,
    hookTimeoutMs: 750,
    logMaxBytes: 5_242_880,
    logRetainFiles: 3,
    ...(codexExecutable === undefined ? {} : {
      codexQuery: { enabled: true, executable: codexExecutable, userConfiguration: "ALLOW" },
    }),
  }, null, 2)}\n`;
}

function now(clock: () => Date): string {
  const value = clock();
  if (Number.isNaN(value.getTime())) throw new Error("installer clock returned an invalid date");
  return value.toISOString();
}

function parseManifest(value: unknown): DeploymentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1 || (value as { state?: unknown }).state !== "ACTIVE"
    || typeof (value as { version?: unknown }).version !== "string" || typeof (value as { installedAt?: unknown }).installedAt !== "string"
    || Number.isNaN(Date.parse(String((value as { installedAt?: unknown }).installedAt)))
    || !/^[a-f0-9]{64}$/u.test(String((value as { releaseDigest?: unknown }).releaseDigest))
    || typeof (value as { sourceArtifact?: unknown }).sourceArtifact !== "string"
    || !isAbsolute((value as { sourceArtifact: string }).sourceArtifact)
    || !Array.isArray((value as { managedPaths?: unknown }).managedPaths)
    || !(value as { managedPaths: unknown[] }).managedPaths.every((path) => typeof path === "string" && isAbsolute(path))) {
    throw new Error("deployment manifest has an unsupported shape");
  }
  return value as unknown as DeploymentManifest;
}

export async function readDeploymentManifest(path: string): Promise<DeploymentManifest | undefined> {
  if (!(await pathExists(path))) return undefined;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) throw new Error("deployment manifest must be a bounded regular file");
  return parseManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function planItem(id: string, action: DeploymentPlanItem["action"], summary: string, path?: string): DeploymentPlanItem {
  return Object.freeze({ id, action, summary, ...(path === undefined ? {} : { path }) });
}

function buildPlan(paths: ReturnType<typeof resolveDeploymentPaths>, metadata: ReleaseMetadata, releaseExists: boolean): DeploymentPlan {
  return Object.freeze({
    schemaVersion: 1,
    mode: "SHADOW",
    version: metadata.version,
    items: Object.freeze([
      planItem("stage-release", releaseExists ? "REUSE" : "CREATE", "verify and stage immutable release", paths.releaseDirectory),
      planItem("write-config", "REPLACE", "write SHADOW-only sidecar configuration", paths.configPath),
      planItem("write-launch-agent", "REPLACE", "write macOS user LaunchAgent", paths.launchAgentPath),
      planItem("switch-current", "REPLACE", "atomically select the release", paths.currentLink),
      planItem("write-sidecar-launcher", "REPLACE", "write stable sidecar launcher", paths.sidecarLauncher),
      planItem("write-cli-launcher", "REPLACE", "write stable deployment and local Console CLI launcher", paths.zhiloopLauncher),
      planItem("merge-codex-hooks", "MERGE", "add owned ZhiLoop hooks without changing CCM", paths.codexHooksPath),
      planItem("trust-codex-hooks", "MERGE", "register exact owned Hook hashes through Codex app-server", paths.codexConfigPath),
      planItem("write-manifest", "REPLACE", "record deployment ownership", paths.manifestPath),
      planItem("activate-service", "START", "bootstrap READY/SHADOW LaunchAgent", paths.launchAgentPath),
    ]),
  });
}

function expectedManagedPaths(paths: ReturnType<typeof resolveDeploymentPaths>): Set<string> {
  return new Set([
    paths.releaseDirectory, paths.currentLink, paths.sidecarLauncher, paths.zhiloopLauncher,
    paths.configPath, paths.launchAgentPath, paths.hookReceiptPath, paths.hookTrustReceiptPath, paths.manifestPath,
  ]);
}

function isManagedReleasePath(paths: ReturnType<typeof resolveDeploymentPaths>, candidate: string): boolean {
  const version = relative(paths.releasesDirectory, candidate);
  if (version.length === 0 || version.startsWith("..") || isAbsolute(version) || /[/\\]/u.test(version)) return false;
  try {
    return resolveDeploymentPaths(paths.home, version).releaseDirectory === candidate;
  } catch {
    return false;
  }
}

async function validateExistingOwnership(paths: ReturnType<typeof resolveDeploymentPaths>, manifest: DeploymentManifest | undefined): Promise<void> {
  if (manifest !== undefined) {
    const expected = expectedManagedPaths(resolveDeploymentPaths(paths.home, manifest.version));
    const unique = new Set(manifest.managedPaths);
    const legacyTrustReceiptMissing = !unique.has(paths.hookTrustReceiptPath);
    const required = new Set(expected);
    if (legacyTrustReceiptMissing) required.delete(paths.hookTrustReceiptPath);
    if (unique.size !== manifest.managedPaths.length
      || [...required].some((path) => !unique.has(path))
      || manifest.managedPaths.some((path) => !expected.has(path) && !isManagedReleasePath(paths, path))) {
      throw new Error("deployment manifest ownership does not match this installation layout");
    }
    if (legacyTrustReceiptMissing && await pathExists(paths.hookTrustReceiptPath)) {
      throw new Error(`refusing to adopt an unowned deployment target: ${paths.hookTrustReceiptPath}`);
    }
    return;
  }
  const unownedTargets = [
    paths.currentLink, paths.sidecarLauncher, paths.zhiloopLauncher, paths.configPath,
    paths.launchAgentPath, paths.hookReceiptPath, paths.hookTrustReceiptPath, paths.manifestPath,
  ];
  for (const target of unownedTargets) {
    if (await pathExists(target)) throw new Error(`refusing to overwrite an unowned deployment target: ${target}`);
  }
}

interface HookInstallState {
  inserted: readonly ManagedHookEntry[];
}

async function hookStep(paths: ReturnType<typeof resolveDeploymentPaths>, state: HookInstallState): Promise<DeploymentStep> {
  const installer = new HookConfigurationInstaller();
  const alreadyInstalled = await pathExists(paths.hookReceiptPath);
  return Object.freeze({
    id: "merge-codex-hooks",
    apply: async () => {
      const receipt = await installer.install({
        targetPath: paths.codexHooksPath,
        receiptPath: paths.hookReceiptPath,
        managedConfiguration: managedHookConfiguration(paths.sidecarLauncher, paths.configPath),
      });
      state.inserted = receipt.inserted;
      return async () => {
        if (!alreadyInstalled) {
          const result = await installer.uninstall(paths.codexHooksPath, paths.hookReceiptPath);
          if (result.status === "CONFLICT") throw new Error("Codex hooks drifted during deployment rollback");
        }
      };
    },
  });
}

function hookTrustControl(options: LocalInstallOptions, paths: ReturnType<typeof resolveDeploymentPaths>): CodexHookTrustControlPort {
  return options.hookTrustControl ?? new CodexAppServerHookTrustControl({ codexHome: resolve(paths.home, ".codex") });
}

function hookTrustStep(
  options: LocalInstallOptions,
  paths: ReturnType<typeof resolveDeploymentPaths>,
  state: HookInstallState,
): DeploymentStep {
  const installer = new CodexHookTrustInstaller();
  const control = hookTrustControl(options, paths);
  const alreadyInstalled = pathExists(paths.hookTrustReceiptPath);
  return Object.freeze({
    id: "trust-codex-hooks",
    apply: async () => {
      const existed = await alreadyInstalled;
      try {
        await installer.install({
          targetPath: paths.codexHooksPath,
          configPath: paths.codexConfigPath,
          receiptPath: paths.hookTrustReceiptPath,
          cwd: paths.home,
          inserted: state.inserted,
          requiredEvents: ["UserPromptSubmit", "PostToolUse", "Stop"],
          optionalUndiscoveredEvents: ["SessionEnd"],
          control,
        });
      } catch (error) {
        if (!existed && await pathExists(paths.hookTrustReceiptPath)) {
          const cleanup = await installer.uninstall({
            targetPath: paths.codexHooksPath,
            configPath: paths.codexConfigPath,
            receiptPath: paths.hookTrustReceiptPath,
            cwd: paths.home,
            control,
          });
          if (cleanup.status === "CONFLICT") {
            throw new AggregateError([error], "Codex Hook trust failed and its partial state could not be rolled back", { cause: error });
          }
        }
        throw error;
      }
      return async () => {
        if (!existed) {
          const result = await installer.uninstall({
            targetPath: paths.codexHooksPath,
            configPath: paths.codexConfigPath,
            receiptPath: paths.hookTrustReceiptPath,
            cwd: paths.home,
            control,
          });
          if (result.status === "CONFLICT") throw new Error("Codex Hook trust drifted during deployment rollback");
        }
      };
    },
  });
}

async function waitUntilReady(options: LocalInstallOptions, expectedSidecarVersion: string): Promise<void> {
  const attempts = options.readinessAttempts ?? 60;
  const delayMs = options.readinessDelayMs ?? 250;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 200 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new Error("readiness settings are outside supported bounds");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await options.health.health().catch(() => undefined);
    const report = evaluateSidecarCompatibility(health, options.compatibility);
    if (report.compatible && health?.sidecarVersion === expectedSidecarVersion) return;
    if (attempt + 1 < attempts && delayMs > 0) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
  }
  throw new Error("sidecar did not reach compatible READY health");
}

function serviceStep(options: LocalInstallOptions, launchAgentPath: string, expectedSidecarVersion: string, state: { touched: boolean }): DeploymentStep {
  return Object.freeze({
    id: "activate-service",
    apply: async () => {
      state.touched = true;
      await options.service.bootout();
      try {
        await options.service.bootstrap(launchAgentPath);
        await options.service.kickstart();
        await waitUntilReady(options, expectedSidecarVersion);
      } catch (error) {
        await options.service.bootout().catch(() => undefined);
        throw error;
      }
      return async () => options.service.bootout();
    },
  });
}

export async function planLocalInstall(options: LocalInstallOptions): Promise<DeploymentPlan> {
  const verified = await verifyCompatibleLocalReleaseArtifact(resolve(options.artifactDirectory), options.compatibility);
  await validateCodexExecutable(options.codexExecutable);
  const paths = resolveDeploymentPaths(options.home, verified.metadata.version);
  return buildPlan(paths, verified.metadata, await pathExists(paths.releaseDirectory));
}

export async function installLocalRelease(options: LocalInstallOptions): Promise<LocalInstallResult> {
  const artifact = resolve(options.artifactDirectory);
  const verified = await verifyCompatibleLocalReleaseArtifact(artifact, options.compatibility);
  const paths = resolveDeploymentPaths(options.home, verified.metadata.version);
  const previous = await readDeploymentManifest(paths.manifestPath);
  await validateExistingOwnership(paths, previous);
  const codexExecutable = options.codexExecutable === undefined && previous !== undefined
    ? await inheritedCodexExecutable(paths.configPath)
    : await validateCodexExecutable(options.codexExecutable);
  const previousServiceState = await options.service.status();
  const plan = buildPlan(paths, verified.metadata, await pathExists(paths.releaseDirectory));
  const installedAt = now(options.clock ?? (() => new Date()));
  const retainedReleaseVersions = previous === undefined
    ? []
    : [previous.version, previous.previousVersion].filter((version): version is string => version !== undefined && version !== verified.metadata.version);
  const retainedReleasePaths = retainedReleaseVersions.map((version) => resolveDeploymentPaths(options.home, version).releaseDirectory);
  const managedPaths = Object.freeze([...new Set([
    paths.releaseDirectory, paths.currentLink, paths.sidecarLauncher, paths.zhiloopLauncher,
    paths.configPath, paths.launchAgentPath, paths.hookReceiptPath, paths.hookTrustReceiptPath, paths.manifestPath,
    ...retainedReleasePaths,
  ])]);
  const manifest: DeploymentManifest = Object.freeze({
    schemaVersion: 1,
    state: "ACTIVE",
    version: verified.metadata.version,
    installedAt,
    releaseDigest: verified.digest,
    sourceArtifact: artifact,
    managedPaths,
    ...(previous === undefined ? {} : { previousVersion: previous.version }),
  });
  const sidecarEntrypoint = resolve(paths.currentLink, "apps", "sidecar", "dist", "main.js");
  const deploymentEntrypoint = resolve(paths.currentLink, "apps", "sidecar", "dist", "deploy-main.js");
  const uiEntrypoint = resolve(paths.currentLink, "apps", "cli", "dist", "ui-main.js");
  const hookInstallState: HookInstallState = { inserted: Object.freeze([]) };
  const steps: DeploymentStep[] = [
    await stageReleaseStep("stage-release", artifact, paths.releaseDirectory),
    await replaceFileStep("write-config", paths.configPath, configuration(paths, codexExecutable), 0o600),
    await replaceFileStep("write-launch-agent", paths.launchAgentPath, renderLaunchAgent(paths), 0o600),
    await replaceSymlinkStep("switch-current", paths.currentLink, paths.releaseDirectory),
    await replaceFileStep("write-sidecar-launcher", paths.sidecarLauncher, launcher(process.execPath, sidecarEntrypoint, paths.configPath), 0o700),
    await replaceFileStep(
      "write-cli-launcher",
      paths.zhiloopLauncher,
      renderZhiLoopLauncher(process.execPath, deploymentEntrypoint, uiEntrypoint),
      0o700,
    ),
    await hookStep(paths, hookInstallState),
    hookTrustStep(options, paths, hookInstallState),
    await replaceFileStep("write-manifest", paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600),
  ];
  const serviceState = { touched: false };
  steps.push(serviceStep(options, paths.launchAgentPath, verified.metadata.version, serviceState));
  try {
    const result = await executeDeploymentTransaction(steps, {
      journalPath: paths.journalPath,
      operation: previous === undefined ? "install" : "upgrade",
      ...(options.failAfterStep === undefined ? {} : { failAfterStep: options.failAfterStep }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.randomId === undefined ? {} : { randomId: options.randomId }),
    });
    return Object.freeze({ ...result, plan, manifest });
  } catch (error) {
    if (serviceState.touched && previousServiceState === "RUNNING" && await pathExists(paths.launchAgentPath)) {
      await options.service.bootstrap(paths.launchAgentPath).then(() => options.service.kickstart()).catch(() => undefined);
    }
    throw error;
  }
}

export function releaseDigestOf(manifest: DeploymentManifest): string {
  return createHash("sha256").update(`${manifest.version}\0${manifest.releaseDigest}`).digest("hex");
}
