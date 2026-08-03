import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import type { SidecarHealth } from "@zhiloop/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { installLocalRelease, planLocalInstall, REQUIRED_LOCAL_RELEASE_FILES } from "./installer.js";
import { doctorLocalInstallation } from "./doctor.js";
import { resolveDeploymentPaths } from "./paths.js";
import type { HealthProbe, ServiceController } from "./types.js";
import { purgeLocalData, uninstallLocalRelease } from "./uninstaller.js";

const roots: string[] = [];
const compatibility = {
  pluginVersion: "0.1.0",
  minimumSidecarVersion: "0.1.0",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "zhiloop-home-"));
  roots.push(value);
  return value;
}

async function artifact(root: string, version = "0.1.0"): Promise<string> {
  const directory = join(root, `artifact-${version}`);
  const files = new Map([
    ["apps/sidecar/dist/main.js", "#!/usr/bin/env node\n// sidecar\n"],
    ["apps/sidecar/dist/deploy-main.js", "#!/usr/bin/env node\n// deploy cli\n"],
    ["apps/cli/dist/ui-main.js", "#!/usr/bin/env node\n// ui cli\n"],
    ["apps/cli/dist/ui-cli.js", "// ui launcher\n"],
    ["apps/console-gateway/dist/main.js", "#!/usr/bin/env node\n// gateway executable\n"],
    ["apps/console-web/dist/index.html", "<!doctype html><title>ZhiLoop</title>\n"],
    ["node_modules/@zhiloop/console-gateway/package.json", "{\"name\":\"@zhiloop/console-gateway\"}\n"],
    ["node_modules/@zhiloop/control-api/package.json", "{\"name\":\"@zhiloop/control-api\"}\n"],
    ["node_modules/@zhiloop/local-deployment/package.json", "{\"name\":\"@zhiloop/local-deployment\"}\n"],
    ["node_modules/zod/package.json", "{\"name\":\"zod\"}\n"],
  ]);
  for (const [path, content] of files) {
    const target = join(directory, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, { mode: 0o555 });
  }
  await writeFile(join(directory, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version,
    pluginVersion: "0.1.0",
    protocolVersion: 1,
    sourceCommit: "d3bdb8b",
    nodePath: process.execPath,
    nodeVersion: process.versions.node,
    createdAt: "2026-08-03T00:00:00.000Z",
    files: [...files].map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: 0o555,
    })),
  }));
  return directory;
}

function ready(version = "0.1.0"): SidecarHealth {
  return {
    schemaVersion: 1,
    status: "READY",
    pluginVersion: "0.1.0",
    sidecarVersion: version,
    protocolVersion: 1,
    hookSchemaVersion: "codex-hooks-v1",
    appServerSchemaVersion: "codex-app-server-v2",
    startedAt: "2026-08-03T00:00:00.000Z",
  };
}

function shadowReady(version = "0.1.0"): SidecarHealth {
  return { ...ready(version), rolloutMode: "SHADOW" } as SidecarHealth;
}

class FakeService implements ServiceController {
  running = false;
  readonly calls: string[] = [];

  async bootstrap(path: string): Promise<void> { this.calls.push(`bootstrap:${path}`); }
  async kickstart(): Promise<void> { this.calls.push("kickstart"); this.running = true; }
  async bootout(): Promise<void> { this.calls.push("bootout"); this.running = false; }
  async status(): Promise<"RUNNING" | "STOPPED"> { return this.running ? "RUNNING" : "STOPPED"; }
}

async function seedCcmHooks(targetHome: string): Promise<{ hooksText: string; ccmText: string }> {
  const hooks = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/node /home/.ccm/codex-hook-handler.js" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "/node /home/.ccm/codex-hook-handler.js" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: "env CCM_HOOK_PLATFORM=codex /node /home/.ccm/security-hook.js" },
        { type: "command", command: "env CCM_HOOK_PLATFORM=codex /node /home/.ccm/post-tool-hook.js" },
      ] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "env CCM_HOOK_PLATFORM=codex /node /home/.ccm/prompt-security-hook.js" }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "env CCM_HOOK_PLATFORM=codex /node /home/.ccm/post-tool-hook.js" }] }],
    },
    unrelated: { owner: "user" },
  };
  const hooksText = `${JSON.stringify(hooks, null, 2)}\n`;
  const ccmText = `${JSON.stringify({ remoteUploadToken: "do-not-touch", promptEnhanceEnabled: true }, null, 2)}\n`;
  await mkdir(join(targetHome, ".codex"), { recursive: true });
  await mkdir(join(targetHome, ".ccm"), { recursive: true });
  await writeFile(join(targetHome, ".codex", "hooks.json"), hooksText);
  await writeFile(join(targetHome, ".ccm", "config.json"), ccmText);
  return { hooksText, ccmText };
}

describe("local installer", () => {
  it("publishes one required runtime inventory for release fixture owners", () => {
    expect(REQUIRED_LOCAL_RELEASE_FILES).toEqual([
      "apps/sidecar/dist/main.js",
      "apps/sidecar/dist/deploy-main.js",
      "apps/cli/dist/ui-main.js",
      "apps/cli/dist/ui-cli.js",
      "apps/console-gateway/dist/main.js",
      "apps/console-web/dist/index.html",
      "node_modules/@zhiloop/console-gateway/package.json",
      "node_modules/@zhiloop/control-api/package.json",
      "node_modules/@zhiloop/local-deployment/package.json",
      "node_modules/zod/package.json",
    ]);
  });

  it("plans without host mutation", async () => {
    const targetHome = await home();
    const source = await artifact(targetHome);
    const service = new FakeService();
    const plan = await planLocalInstall({ home: targetHome, artifactDirectory: source, service, health: { health: async () => ready() }, compatibility });
    expect(plan).toMatchObject({ mode: "SHADOW", version: "0.1.0" });
    expect(plan.items.map(({ id }) => id)).toContain("merge-codex-hooks");
    await expect(lstat(join(targetHome, ".ckl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.calls).toEqual([]);
  });

  it("installs SHADOW, preserves CCM hooks and credentials, and is idempotent", async () => {
    const targetHome = await home();
    const source = await artifact(targetHome);
    const before = await seedCcmHooks(targetHome);
    const service = new FakeService();
    const options = {
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "install-1",
      clock: () => new Date("2026-08-03T01:00:00.000Z"),
    };
    const result = await installLocalRelease(options);
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    expect(result.journal.state).toBe("COMMITTED");
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({
      rolloutMode: "SHADOW",
      codexSessionsRoot: paths.codexSessionsRoot,
    });
    expect(await readlink(paths.currentLink)).toBe("releases/0.1.0");
    expect((await lstat(paths.configPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.sidecarLauncher)).mode & 0o777).toBe(0o700);
    const cliLauncher = await readFile(paths.zhiloopLauncher, "utf8");
    expect(cliLauncher).toContain('if [ "$1" = "ui" ]');
    expect(cliLauncher).toContain("apps/cli/dist/ui-main.js");
    expect(cliLauncher).toContain("apps/sidecar/dist/deploy-main.js");
    expect(await readFile(join(targetHome, ".ccm", "config.json"), "utf8")).toBe(before.ccmText);
    const installedHooks = JSON.parse(await readFile(paths.codexHooksPath, "utf8")) as typeof JSON;
    expect(JSON.stringify(installedHooks)).toContain("CCM_HOOK_PLATFORM=codex");
    expect(JSON.stringify(installedHooks)).toContain("zhiloop-sidecar");
    expect((installedHooks as unknown as { unrelated: unknown }).unrelated).toEqual({ owner: "user" });
    expect(await readFile(paths.launchAgentPath, "utf8")).toContain(paths.sidecarLauncher);
    expect(await readFile(paths.launchAgentPath, "utf8")).not.toContain("<key>EnvironmentVariables</key>");

    await installLocalRelease({ ...options, randomId: () => "install-2" });
    const repeated = await readFile(paths.codexHooksPath, "utf8");
    expect((repeated.match(/zhiloop-sidecar/gu) ?? []).length).toBe(4);
    expect(await readFile(join(targetHome, ".ccm", "config.json"), "utf8")).toBe(before.ccmText);
  });

  it("rolls an unhealthy upgrade back to the previous release and restarts it", async () => {
    const targetHome = await home();
    await seedCcmHooks(targetHome);
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome, artifactDirectory: await artifact(targetHome, "0.1.0"), service,
      health: { health: async () => ready("0.1.0") }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "initial",
    });
    expect(service.running).toBe(true);
    const paths = resolveDeploymentPaths(targetHome, "0.2.0");
    const hooksBefore = await readFile(paths.codexHooksPath, "utf8");
    const launcherBefore = await readFile(paths.zhiloopLauncher, "utf8");
    const failingHealth: HealthProbe = { health: async () => undefined };
    await expect(installLocalRelease({
      home: targetHome, artifactDirectory: await artifact(targetHome, "0.2.0"), service,
      health: failingHealth, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "upgrade",
    })).rejects.toThrow("READY");
    expect(await readlink(paths.currentLink)).toBe("releases/0.1.0");
    expect(JSON.parse(await readFile(paths.manifestPath, "utf8"))).toMatchObject({ version: "0.1.0" });
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe(hooksBefore);
    expect(await readFile(paths.zhiloopLauncher, "utf8")).toBe(launcherBefore);
    expect(service.running).toBe(true);
  });

  it("rejects an otherwise valid release that omits the isolated Console runtime", async () => {
    const targetHome = await home();
    const source = await artifact(targetHome);
    const metadataPath = join(source, "release.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { files: Array<{ path: string }> };
    metadata.files = metadata.files.filter(({ path }) => path !== "apps/console-web/dist/index.html");
    await unlink(join(source, "apps", "console-web", "dist", "index.html"));
    await writeFile(metadataPath, JSON.stringify(metadata));
    const service = new FakeService();
    await expect(planLocalInstall({
      home: targetHome,
      artifactDirectory: source,
      service,
      health: { health: async () => ready() },
      compatibility,
    })).rejects.toThrow("missing required local runtime files");
    expect(service.calls).toEqual([]);
  });

  it("accepts retained semver release ownership across three upgrades and rejects unrelated manifest paths", async () => {
    const targetHome = await home();
    await seedCcmHooks(targetHome);
    const service = new FakeService();
    for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
      await installLocalRelease({
        home: targetHome,
        artifactDirectory: await artifact(targetHome, version),
        service,
        health: { health: async () => ready(version) },
        compatibility,
        readinessAttempts: 1,
        readinessDelayMs: 0,
        randomId: () => `upgrade-${version.replaceAll(".", "-")}`,
      });
    }
    const paths = resolveDeploymentPaths(targetHome, "0.3.0");
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8")) as { managedPaths: string[] };
    expect(manifest.managedPaths).toEqual(expect.arrayContaining([
      resolveDeploymentPaths(targetHome, "0.1.0").releaseDirectory,
      resolveDeploymentPaths(targetHome, "0.2.0").releaseDirectory,
      resolveDeploymentPaths(targetHome, "0.3.0").releaseDirectory,
    ]));
    manifest.managedPaths.push(join(targetHome, "unrelated-owned-path"));
    await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(installLocalRelease({
      home: targetHome,
      artifactDirectory: await artifact(targetHome, "0.4.0"),
      service,
      health: { health: async () => ready("0.4.0") },
      compatibility,
    })).rejects.toThrow("ownership does not match");
  });

  it("rejects a conflicting ZhiLoop hook before service activation", async () => {
    const targetHome = await home();
    const source = await artifact(targetHome);
    await mkdir(join(targetHome, ".codex"), { recursive: true });
    await writeFile(join(targetHome, ".codex", "hooks.json"), JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "/different/zhiloop-sidecar hook" }] }],
    } }));
    const service = new FakeService();
    await expect(installLocalRelease({
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0,
    })).rejects.toThrow("different ZhiLoop hook");
    expect(service.calls).toEqual([]);
    expect(await readFile(join(targetHome, ".codex", "hooks.json"), "utf8")).toContain("/different/zhiloop-sidecar");
  });

  it("refuses to overwrite an unowned deployment target without a manifest", async () => {
    const targetHome = await home();
    const source = await artifact(targetHome);
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    await mkdir(paths.binDirectory, { recursive: true });
    await writeFile(paths.sidecarLauncher, "user-owned-launcher");
    const service = new FakeService();
    await expect(installLocalRelease({
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility,
    })).rejects.toThrow("unowned deployment target");
    expect(await readFile(paths.sidecarLauncher, "utf8")).toBe("user-owned-launcher");
    expect(service.calls).toEqual([]);
  });

  it("reports deployment health and uninstalls only owned files while retaining knowledge and CCM", async () => {
    const targetHome = await home();
    const before = await seedCcmHooks(targetHome);
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome, artifactDirectory: await artifact(targetHome), service,
      health: { health: async () => shadowReady() }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "doctor-install",
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    await mkdir(join(paths.ledgerPath, ".."), { recursive: true });
    await writeFile(paths.ledgerPath, "durable-knowledge");
    expect(await doctorLocalInstallation({
      home: targetHome, service, health: { health: async () => shadowReady() }, compatibility,
    })).toMatchObject({ healthy: true, mode: "SHADOW", version: "0.1.0" });

    const removed = await uninstallLocalRelease({
      home: targetHome, service, randomId: () => "uninstall", removalToken: "remove-1",
    });
    expect(removed).toMatchObject({ status: "REMOVED" });
    expect(await readFile(paths.ledgerPath, "utf8")).toBe("durable-knowledge");
    expect(await readFile(join(targetHome, ".ccm", "config.json"), "utf8")).toBe(before.ccmText);
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe(before.hooksText);
    for (const path of [paths.releaseDirectory, paths.currentLink, paths.sidecarLauncher, paths.zhiloopLauncher, paths.launchAgentPath, paths.configPath, paths.manifestPath]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await uninstallLocalRelease({ home: targetHome, service })).toMatchObject({ status: "NOT_INSTALLED" });
  });

  it("managed-unmerge preserves safe external hook drift", async () => {
    const targetHome = await home();
    await seedCcmHooks(targetHome);
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome, artifactDirectory: await artifact(targetHome), service,
      health: { health: async () => ready() }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "drift-install",
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    const hooks = JSON.parse(await readFile(paths.codexHooksPath, "utf8")) as { hooks: Record<string, unknown[]> };
    hooks.hooks["SessionStart"]?.push({ hooks: [{ type: "command", command: "/user/new-hook" }] });
    await writeFile(paths.codexHooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    await uninstallLocalRelease({ home: targetHome, service, randomId: () => "drift-uninstall", removalToken: "remove-2" });
    const after = await readFile(paths.codexHooksPath, "utf8");
    expect(after).toContain("/user/new-hook");
    expect(after).toContain("CCM_HOOK_PLATFORM=codex");
    expect(after).not.toContain("zhiloop-sidecar");
  });

  it("rolls a failed uninstall back and keeps the previous service running", async () => {
    const targetHome = await home();
    await seedCcmHooks(targetHome);
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome, artifactDirectory: await artifact(targetHome), service,
      health: { health: async () => ready() }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "rollback-install",
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    await expect(uninstallLocalRelease({
      home: targetHome, service, failAfterStep: "remove-current", randomId: () => "rollback-uninstall", removalToken: "remove-3",
    })).rejects.toThrow("injected");
    expect(await readlink(paths.currentLink)).toBe("releases/0.1.0");
    expect(await readFile(paths.codexHooksPath, "utf8")).toContain("zhiloop-sidecar");
    expect(service.running).toBe(true);
  });

  it("requires a separate exact confirmation before purging retained data", async () => {
    const targetHome = await home();
    const paths = resolveDeploymentPaths(targetHome, "0.0.0");
    await mkdir(paths.installDirectory, { recursive: true });
    await writeFile(paths.journalPath, JSON.stringify({ operation: "uninstall", state: "COMMITTED" }));
    await writeFile(join(paths.stateDirectory, "retained.txt"), "keep");
    await expect(purgeLocalData(targetHome, "yes")).rejects.toThrow("exact");
    expect(await readFile(join(paths.stateDirectory, "retained.txt"), "utf8")).toBe("keep");
    await purgeLocalData(targetHome, "PURGE-ZHILOOP-DATA");
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
