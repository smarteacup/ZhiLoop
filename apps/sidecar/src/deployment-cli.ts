import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Writable } from "node:stream";

import {
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

import { SIDECAR_COMPATIBILITY } from "./metadata.js";
import { requestSidecar } from "./transport.js";

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

export async function runDeploymentCli(args: readonly string[], stdout: Writable, stderr: Writable): Promise<number> {
  const command = args[0];
  const json = args.includes("--json");
  const apply = args.includes("--apply");
  const home = selectedHome(args);
  const service = new MacOsLaunchctlController();
  if (command === "install" || command === "upgrade") {
    const artifact = option(args, "--artifact");
    if (artifact === undefined) throw new Error(`${command} requires --artifact <absolute-release-directory>`);
    const options = {
      home,
      artifactDirectory: resolve(artifact),
      service,
      health: probe(home),
      compatibility: SIDECAR_COMPATIBILITY,
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
  stderr.write("usage: zhiloop <install|upgrade|doctor|uninstall> [--home PATH] [--artifact PATH] [--apply] [--json]\n");
  return 64;
}
