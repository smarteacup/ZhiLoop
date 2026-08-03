import { isAbsolute, join, resolve } from "node:path";

import type { DeploymentPaths } from "./types.js";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

function safeHome(home: string): string {
  if (!isAbsolute(home) || home.includes("\0") || /[\r\n]/u.test(home)) throw new Error("deployment home must be an absolute safe path");
  const normalized = resolve(home);
  if (normalized === "/") throw new Error("deployment home must not be the filesystem root");
  return normalized;
}

export function resolveDeploymentPaths(home: string, version: string): DeploymentPaths {
  const normalizedHome = safeHome(home);
  if (!VERSION.test(version)) throw new Error("release version must be semantic version text");
  const shareDirectory = join(normalizedHome, ".local", "share", "zhiloop");
  const releasesDirectory = join(shareDirectory, "releases");
  const stateDirectory = join(normalizedHome, ".ckl");
  const installDirectory = join(stateDirectory, "install");
  const logDirectory = join(stateDirectory, "logs");
  return Object.freeze({
    home: normalizedHome,
    binDirectory: join(normalizedHome, ".local", "bin"),
    shareDirectory,
    releasesDirectory,
    releaseDirectory: join(releasesDirectory, version),
    currentLink: join(shareDirectory, "current"),
    sidecarLauncher: join(normalizedHome, ".local", "bin", "zhiloop-sidecar"),
    zhiloopLauncher: join(normalizedHome, ".local", "bin", "zhiloop"),
    stateDirectory,
    configPath: join(stateDirectory, "config.json"),
    socketPath: join(stateDirectory, "run", "sidecar.sock"),
    codexSessionsRoot: join(normalizedHome, ".codex", "sessions"),
    ledgerPath: join(stateDirectory, "knowledge", "events.sqlite"),
    spoolDirectory: join(stateDirectory, "spool"),
    logDirectory,
    sidecarLogPath: join(logDirectory, "sidecar.jsonl"),
    serviceStdoutPath: join(logDirectory, "service.stdout.log"),
    serviceStderrPath: join(logDirectory, "service.stderr.log"),
    installDirectory,
    manifestPath: join(installDirectory, "manifest.json"),
    journalPath: join(installDirectory, "journal.json"),
    hookReceiptPath: join(installDirectory, "receipts", "codex-hooks.json"),
    hookTrustReceiptPath: join(installDirectory, "receipts", "codex-hook-trust.json"),
    codexHooksPath: join(normalizedHome, ".codex", "hooks.json"),
    codexConfigPath: join(normalizedHome, ".codex", "config.toml"),
    launchAgentPath: join(normalizedHome, "Library", "LaunchAgents", "dev.zhiloop.sidecar.plist"),
  });
}
