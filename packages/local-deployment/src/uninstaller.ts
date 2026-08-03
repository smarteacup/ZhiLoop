import { lstat, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

import { HookConfigurationInstaller, type HookConfiguration } from "@zhiloop/plugin-runtime";

import { managedHookConfiguration, readDeploymentManifest } from "./installer.js";
import { resolveDeploymentPaths } from "./paths.js";
import { pathExists } from "./secure-files.js";
import { quarantineDirectoryStep, removeRegularFileStep, removeSymlinkStep } from "./steps.js";
import { executeDeploymentTransaction } from "./transaction.js";
import type { DeploymentStep, ServiceController } from "./types.js";

export interface LocalUninstallOptions {
  readonly home: string;
  readonly service: ServiceController;
  readonly failAfterStep?: string;
  readonly clock?: () => Date;
  readonly randomId?: () => string;
  readonly removalToken?: string;
}

export interface LocalUninstallResult {
  readonly status: "REMOVED" | "NOT_INSTALLED";
  readonly retainedData: readonly string[];
}

function releasePathsFromManifest(paths: ReturnType<typeof resolveDeploymentPaths>, managedPaths: readonly string[]): string[] {
  const fixed = new Set([
    paths.currentLink, paths.sidecarLauncher, paths.zhiloopLauncher,
    paths.configPath, paths.launchAgentPath, paths.hookReceiptPath, paths.manifestPath,
  ]);
  const releases = managedPaths.filter((path) => !fixed.has(path));
  if (managedPaths.length !== fixed.size + releases.length || [...fixed].some((path) => !managedPaths.includes(path))
    || releases.length === 0 || !releases.includes(paths.releaseDirectory)
    || new Set(releases).size !== releases.length
    || releases.some((path) => dirname(path) !== paths.releasesDirectory || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(basename(path)))) {
    throw new Error("deployment manifest ownership does not match this installation layout");
  }
  return releases;
}

async function hookRemovalStep(paths: ReturnType<typeof resolveDeploymentPaths>, managed: HookConfiguration): Promise<DeploymentStep> {
  const installer = new HookConfigurationInstaller();
  return Object.freeze({
    id: "unmerge-codex-hooks",
    apply: async () => {
      const result = await installer.uninstall(paths.codexHooksPath, paths.hookReceiptPath);
      if (result.status === "CONFLICT") throw new Error("Codex hooks contain a conflicting ZhiLoop edit");
      return async () => {
        if (result.status === "REMOVED") {
          await installer.install({ targetPath: paths.codexHooksPath, receiptPath: paths.hookReceiptPath, managedConfiguration: managed });
        }
      };
    },
  });
}

function stopServiceStep(service: ServiceController, path: string, wasRunning: boolean): DeploymentStep {
  return Object.freeze({
    id: "stop-service",
    apply: async () => {
      await service.bootout();
      return async () => {
        if (wasRunning) {
          await service.bootstrap(path);
          await service.kickstart();
        }
      };
    },
  });
}

export async function uninstallLocalRelease(options: LocalUninstallOptions): Promise<LocalUninstallResult> {
  const manifestPath = resolveDeploymentPaths(options.home, "0.0.0").manifestPath;
  const manifest = await readDeploymentManifest(manifestPath);
  if (manifest === undefined) return Object.freeze({ status: "NOT_INSTALLED", retainedData: Object.freeze([]) });
  const paths = resolveDeploymentPaths(options.home, manifest.version);
  if (manifest.managedPaths.some((path) => !isAbsolute(path))) throw new Error("deployment manifest contains a relative managed path");
  const releasePaths = releasePathsFromManifest(paths, manifest.managedPaths);
  const token = options.removalToken ?? "pending";
  const directoryRemovals = await Promise.all(releasePaths.map((path, index) =>
    quarantineDirectoryStep(`remove-release-${index}`, path, `${token}-${index}`),
  ));
  const wasRunning = await options.service.status() === "RUNNING";
  const steps: DeploymentStep[] = [
    stopServiceStep(options.service, paths.launchAgentPath, wasRunning),
    await hookRemovalStep(paths, managedHookConfiguration(paths.sidecarLauncher, paths.configPath)),
    await removeRegularFileStep("remove-launch-agent", paths.launchAgentPath),
    await removeRegularFileStep("remove-sidecar-launcher", paths.sidecarLauncher),
    await removeRegularFileStep("remove-cli-launcher", paths.zhiloopLauncher),
    await removeRegularFileStep("remove-config", paths.configPath),
    await removeSymlinkStep("remove-current", paths.currentLink),
    ...directoryRemovals.map(({ step }) => step),
    await removeRegularFileStep("remove-manifest", paths.manifestPath),
  ];
  await executeDeploymentTransaction(steps, {
    journalPath: paths.journalPath,
    operation: "uninstall",
    ...(options.failAfterStep === undefined ? {} : { failAfterStep: options.failAfterStep }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.randomId === undefined ? {} : { randomId: options.randomId }),
  });
  for (const removal of directoryRemovals) await removal.cleanup();
  return Object.freeze({
    status: "REMOVED",
    retainedData: Object.freeze([paths.ledgerPath, paths.spoolDirectory, paths.logDirectory, paths.journalPath]),
  });
}

export async function purgeLocalData(home: string, confirmation: string): Promise<void> {
  if (confirmation !== "PURGE-ZHILOOP-DATA") throw new Error("purge requires exact PURGE-ZHILOOP-DATA confirmation");
  const paths = resolveDeploymentPaths(home, "0.0.0");
  if (await pathExists(paths.manifestPath)) throw new Error("uninstall ZhiLoop before purging retained data");
  const stat = await lstat(paths.stateDirectory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ZhiLoop state must be a real directory before purge");
  const journal = await readFile(paths.journalPath, "utf8").catch(() => "");
  if (journal.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(journal) as unknown;
    } catch {
      throw new Error("latest deployment journal is invalid");
    }
    if (typeof parsed !== "object" || parsed === null
      || (parsed as { operation?: unknown }).operation !== "uninstall"
      || (parsed as { state?: unknown }).state !== "COMMITTED") {
      throw new Error("latest deployment journal is not a committed uninstall");
    }
  }
  await rm(paths.stateDirectory, { recursive: true, force: true });
}
