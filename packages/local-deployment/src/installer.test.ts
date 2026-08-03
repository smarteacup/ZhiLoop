import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import type { CodexHookState, CodexHookTrustControlPort, CodexHookTrustInspection, SidecarHealth } from "@zhiloop/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { installLocalRelease, planLocalInstall } from "./installer.js";
import { REQUIRED_LOCAL_RELEASE_FILES } from "./release.js";
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

async function artifact(root: string, version = "0.1.0", nodePath = process.execPath): Promise<string> {
  const directory = join(root, `artifact-${version}`);
  const files = new Map(REQUIRED_LOCAL_RELEASE_FILES.map((path) => [path,
    path.endsWith(".html")
      ? "<!doctype html><title>ZhiLoop</title>\n"
      : path.endsWith("package.json")
        ? `${JSON.stringify({ name: path.split("/package.json")[0]!.replace("node_modules/", "") })}\n`
        : "#!/usr/bin/env node\n// release fixture\n",
  ]));
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
    nodePath,
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

class FakeHookTrustControl implements CodexHookTrustControlPort {
  readonly #states = new Map<string, Record<string, CodexHookState>>();
  readonly #versions = new Map<string, number>();

  async inspect(input: { readonly targetPath: string; readonly configPath: string }): Promise<CodexHookTrustInspection> {
    const configuration = JSON.parse(await readFile(input.targetPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command?: string }> }>>;
    };
    const hooks = Object.entries(configuration.hooks).flatMap(([event, groups]) => event === "SessionEnd" ? [] : groups.flatMap((group, groupIndex) =>
      group.hooks.map((handler, handlerIndex) => ({
        key: `${input.targetPath}:${event.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase()}:${groupIndex}:${handlerIndex}`,
        eventName: `${event.slice(0, 1).toLowerCase()}${event.slice(1)}`,
        handlerType: handler.type,
        command: handler.command ?? null,
        sourcePath: input.targetPath,
        source: "user",
        enabled: true,
        isManaged: false,
        currentHash: `sha256:${createHash("sha256").update(`${event}\0${JSON.stringify(group)}\0${handlerIndex}`).digest("hex")}`,
        trustStatus: "untrusted" as const,
      })),
    ));
    const version = this.#versions.get(input.configPath) ?? 0;
    return {
      hooks,
      states: structuredClone(this.#states.get(input.configPath) ?? {}),
      configVersion: `sha256:${createHash("sha256").update(`config-${version}`).digest("hex")}`,
    };
  }

  async replaceStates(input: {
    readonly configPath: string;
    readonly expectedVersion?: string;
    readonly states: Readonly<Record<string, CodexHookState>>;
  }): Promise<{ readonly configVersion: string }> {
    const version = this.#versions.get(input.configPath) ?? 0;
    const current = `sha256:${createHash("sha256").update(`config-${version}`).digest("hex")}`;
    if (input.expectedVersion !== current) throw new Error("stale fake Codex config version");
    this.#states.set(input.configPath, structuredClone(input.states));
    this.#versions.set(input.configPath, version + 1);
    return { configVersion: `sha256:${createHash("sha256").update(`config-${version + 1}`).digest("hex")}` };
  }
}

const hookTrustControl = new FakeHookTrustControl();

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
    expect(new Set(REQUIRED_LOCAL_RELEASE_FILES).size).toBe(REQUIRED_LOCAL_RELEASE_FILES.length);
    expect(REQUIRED_LOCAL_RELEASE_FILES).toEqual(expect.arrayContaining([
      "apps/sidecar/dist/main.js",
      "apps/sidecar/dist/deploy-main.js",
      "apps/console-gateway/dist/main.js",
      "apps/console-web/dist/index.html",
      "node_modules/@zhiloop/p4-console-runtime/package.json",
      "node_modules/@zhiloop/active-rollout-service/package.json",
      "node_modules/@zhiloop/local-deployment/package.json",
    ]));
  });

  it("plans without host mutation", async () => {
    const targetHome = await home();
    const source = await artifact(targetHome);
    const service = new FakeService();
    const plan = await planLocalInstall({ home: targetHome, artifactDirectory: source, service, health: { health: async () => ready() }, compatibility });
    expect(plan).toMatchObject({ mode: "SHADOW", version: "0.1.0" });
    expect(plan.items.map(({ id }) => id)).toContain("merge-codex-hooks");
    expect(plan.items.map(({ id }) => id)).toContain("trust-codex-hooks");
    await expect(lstat(join(targetHome, ".ckl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.calls).toEqual([]);
  });

  it("binds an explicit regular Codex executable and rejects unsafe bindings", async () => {
    const targetHome = await home();
    const source = await artifact(targetHome);
    const executable = join(targetHome, "trusted-codex");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome,
      artifactDirectory: source,
      service,
      health: { health: async () => ready() },
      compatibility,
      hookTrustControl,
      codexExecutable: executable,
      readinessAttempts: 1,
      readinessDelayMs: 0,
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({
      codexQuery: { enabled: true, executable, userConfiguration: "ALLOW" },
    });
    await installLocalRelease({
      home: targetHome,
      artifactDirectory: source,
      service,
      health: { health: async () => ready() },
      compatibility,
      hookTrustControl,
      readinessAttempts: 1,
      readinessDelayMs: 0,
    });
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({
      codexQuery: { enabled: true, executable, userConfiguration: "ALLOW" },
    });
    const invalidInherited = JSON.parse(await readFile(paths.configPath, "utf8")) as Record<string, unknown>;
    invalidInherited["codexQuery"] = { enabled: false, executable };
    await writeFile(paths.configPath, `${JSON.stringify(invalidInherited, null, 2)}\n`, { mode: 0o600 });
    await expect(installLocalRelease({
      home: targetHome,
      artifactDirectory: source,
      service,
      health: { health: async () => ready() },
      compatibility,
      hookTrustControl,
      readinessAttempts: 1,
      readinessDelayMs: 0,
    })).rejects.toThrow("existing Codex query configuration has an unsupported shape");
    await writeFile(paths.configPath, "[]\n", { mode: 0o600 });
    await expect(installLocalRelease({
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility, hookTrustControl,
      readinessAttempts: 1, readinessDelayMs: 0,
    })).rejects.toThrow("existing sidecar configuration has an unsupported shape");
    await writeFile(paths.configPath, `${JSON.stringify({ ...invalidInherited, codexQuery: null })}\n`, { mode: 0o600 });
    await expect(installLocalRelease({
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility, hookTrustControl,
      readinessAttempts: 1, readinessDelayMs: 0,
    })).rejects.toThrow("existing Codex query configuration has an unsupported shape");
    await writeFile(paths.configPath, `${JSON.stringify({ ...invalidInherited, codexQuery: [] })}\n`, { mode: 0o600 });
    await expect(installLocalRelease({
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility, hookTrustControl,
      readinessAttempts: 1, readinessDelayMs: 0,
    })).rejects.toThrow("existing Codex query configuration has an unsupported shape");
    await writeFile(paths.configPath, Buffer.alloc(1_048_577), { mode: 0o600 });
    await expect(installLocalRelease({
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility, hookTrustControl,
      readinessAttempts: 1, readinessDelayMs: 0,
    })).rejects.toThrow("existing sidecar configuration must be a bounded regular file");
    await unlink(paths.configPath);
    await installLocalRelease({
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility, hookTrustControl,
      readinessAttempts: 1, readinessDelayMs: 0,
    });
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).not.toHaveProperty("codexQuery");
    await expect(planLocalInstall({
      home: targetHome,
      artifactDirectory: source,
      service,
      health: { health: async () => ready() },
      compatibility,
      codexExecutable: "relative-codex",
    })).rejects.toThrow("absolute safe path");
    await chmod(executable, 0o600);
    await expect(planLocalInstall({
      home: targetHome,
      artifactDirectory: source,
      service,
      health: { health: async () => ready() },
      compatibility,
      codexExecutable: executable,
    })).rejects.toThrow("regular executable");
  });

  it("installs SHADOW, preserves CCM hooks and credentials, and is idempotent", async () => {
    const targetHome = await home();
    const untrustedNodeMarker = join(targetHome, "untrusted-node-executed");
    const untrustedNode = join(targetHome, "untrusted-node");
    await writeFile(untrustedNode, `#!/bin/sh\ntouch ${JSON.stringify(untrustedNodeMarker)}\nprintf 'v%s\\n' ${JSON.stringify(process.versions.node)}\n`, { mode: 0o755 });
    const source = await artifact(targetHome, "0.1.0", untrustedNode);
    const before = await seedCcmHooks(targetHome);
    const service = new FakeService();
    const options = {
      home: targetHome, artifactDirectory: source, service,
      health: { health: async () => ready() }, compatibility,
      hookTrustControl,
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
    const sidecarLauncher = await readFile(paths.sidecarLauncher, "utf8");
    expect(cliLauncher).toContain('if [ "$1" = "ui" ]');
    expect(cliLauncher).toContain("apps/cli/dist/ui-main.js");
    expect(cliLauncher).toContain("apps/sidecar/dist/deploy-main.js");
    expect(cliLauncher).toContain(process.execPath);
    expect(sidecarLauncher).toContain(process.execPath);
    expect(cliLauncher).not.toContain(untrustedNode);
    expect(sidecarLauncher).not.toContain(untrustedNode);
    await expect(access(untrustedNodeMarker)).rejects.toMatchObject({ code: "ENOENT" });
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
      hookTrustControl,
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
      hookTrustControl,
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
        hookTrustControl,
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
      hookTrustControl,
      artifactDirectory: await artifact(targetHome, "0.4.0"),
      service,
      health: { health: async () => ready("0.4.0") },
      compatibility,
    })).rejects.toThrow("ownership does not match");
  });

  it("adopts the new trust receipt only when upgrading a legacy owned manifest without an existing receipt", async () => {
    const targetHome = await home();
    await seedCcmHooks(targetHome);
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome,
      artifactDirectory: await artifact(targetHome, "0.1.0"),
      service,
      health: { health: async () => ready("0.1.0") },
      compatibility,
      hookTrustControl,
      readinessAttempts: 1,
      readinessDelayMs: 0,
      randomId: () => "legacy-base",
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    await unlink(paths.hookTrustReceiptPath);
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8")) as { managedPaths: string[] };
    manifest.managedPaths = manifest.managedPaths.filter((path) => path !== paths.hookTrustReceiptPath);
    await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await installLocalRelease({
      home: targetHome,
      artifactDirectory: await artifact(targetHome, "0.2.0"),
      service,
      health: { health: async () => ready("0.2.0") },
      compatibility,
      hookTrustControl,
      readinessAttempts: 1,
      readinessDelayMs: 0,
      randomId: () => "legacy-upgrade",
    });
    expect((await lstat(paths.hookTrustReceiptPath)).isFile()).toBe(true);
    const upgraded = JSON.parse(await readFile(paths.manifestPath, "utf8")) as { managedPaths: string[] };
    expect(upgraded.managedPaths).toContain(paths.hookTrustReceiptPath);
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
      hookTrustControl,
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
      hookTrustControl,
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
      hookTrustControl,
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
      home: targetHome, service, randomId: () => "uninstall", removalToken: "remove-1", hookTrustControl,
    });
    expect(removed).toMatchObject({ status: "REMOVED" });
    expect(await readFile(paths.ledgerPath, "utf8")).toBe("durable-knowledge");
    expect(await readFile(join(targetHome, ".ccm", "config.json"), "utf8")).toBe(before.ccmText);
    expect(await readFile(paths.codexHooksPath, "utf8")).toBe(before.hooksText);
    for (const path of [paths.releaseDirectory, paths.currentLink, paths.sidecarLauncher, paths.zhiloopLauncher, paths.launchAgentPath, paths.configPath, paths.manifestPath]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await uninstallLocalRelease({ home: targetHome, service, hookTrustControl })).toMatchObject({ status: "NOT_INSTALLED" });
  });

  it("reports every fail-closed doctor condition without mutating the installation", async () => {
    const absentHome = await home();
    expect(await doctorLocalInstallation({
      home: absentHome,
      service: new FakeService(),
      health: { health: async () => undefined },
      compatibility,
    })).toEqual({
      schemaVersion: 1,
      healthy: false,
      mode: "UNKNOWN",
      checks: [{ id: "manifest", status: "FAIL", code: "NOT_INSTALLED" }],
    });

    const targetHome = await home();
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome,
      artifactDirectory: await artifact(targetHome),
      service,
      hookTrustControl,
      health: { health: async () => shadowReady() },
      compatibility,
      readinessAttempts: 1,
      readinessDelayMs: 0,
      randomId: () => "doctor-failures",
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    const manifestText = await readFile(paths.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText) as { releaseDigest: string };
    await writeFile(paths.manifestPath, JSON.stringify({ ...manifest, releaseDigest: "0".repeat(64) }));
    let report = await doctorLocalInstallation({
      home: targetHome,
      service,
      health: { health: async () => shadowReady() },
      compatibility,
    });
    expect(report.checks).toContainEqual({ id: "release", status: "FAIL", code: "DIGEST_MISMATCH" });

    await writeFile(paths.manifestPath, manifestText);
    await chmod(paths.configPath, 0o644);
    await chmod(paths.sidecarLauncher, 0o600);
    service.running = false;
    report = await doctorLocalInstallation({
      home: targetHome,
      service,
      health: { health: async () => { throw new Error("sidecar unavailable"); } },
      compatibility,
    });
    expect(report).toMatchObject({ healthy: false, mode: "UNKNOWN", version: "0.1.0" });
    expect(report.checks).toEqual(expect.arrayContaining([
      { id: "config-permissions", status: "FAIL", code: "MODE_INVALID" },
      { id: "launcher-permissions", status: "FAIL", code: "MODE_INVALID" },
      { id: "service", status: "FAIL", code: "STOPPED" },
      { id: "compatibility", status: "FAIL", code: expect.any(String) },
      { id: "rollout", status: "FAIL", code: "MODE_INVALID" },
    ]));

    await unlink(join(paths.releaseDirectory, "apps/sidecar/dist/main.js"));
    report = await doctorLocalInstallation({
      home: targetHome,
      service,
      health: { health: async () => undefined },
      compatibility,
    });
    expect(report.checks).toContainEqual({ id: "release", status: "FAIL", code: "INTEGRITY_FAILED" });
  });

  it("managed-unmerge preserves safe external hook drift", async () => {
    const targetHome = await home();
    await seedCcmHooks(targetHome);
    const service = new FakeService();
    await installLocalRelease({
      home: targetHome, artifactDirectory: await artifact(targetHome), service,
      hookTrustControl,
      health: { health: async () => ready() }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "drift-install",
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    const hooks = JSON.parse(await readFile(paths.codexHooksPath, "utf8")) as { hooks: Record<string, unknown[]> };
    hooks.hooks["SessionStart"]?.push({ hooks: [{ type: "command", command: "/user/new-hook" }] });
    await writeFile(paths.codexHooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    await uninstallLocalRelease({ home: targetHome, service, randomId: () => "drift-uninstall", removalToken: "remove-2", hookTrustControl });
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
      hookTrustControl,
      health: { health: async () => ready() }, compatibility,
      readinessAttempts: 1, readinessDelayMs: 0, randomId: () => "rollback-install",
    });
    const paths = resolveDeploymentPaths(targetHome, "0.1.0");
    await expect(uninstallLocalRelease({
      home: targetHome, service, failAfterStep: "remove-current", randomId: () => "rollback-uninstall", removalToken: "remove-3", hookTrustControl,
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
