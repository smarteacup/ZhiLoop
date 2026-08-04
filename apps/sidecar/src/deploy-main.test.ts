import { createHash } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { REQUIRED_LOCAL_RELEASE_FILES } from "@zhiloop/local-deployment";

import { SidecarApplication } from "./application.js";
import { runDeploymentCli } from "./deployment-cli.js";
import { startSidecarServer, stopSidecarServer } from "./transport.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sink(): { stream: Writable; value(): string } {
  let text = "";
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }),
    value: () => text,
  };
}

interface FixtureOptions {
  readonly version?: string;
  readonly deployMain?: string;
  readonly nodePath?: string;
  readonly pluginVersion?: string;
  readonly protocolVersion?: number;
}

async function fixture(options: FixtureOptions = {}): Promise<{ home: string; artifact: string }> {
  const home = await mkdtemp(join(tmpdir(), "zhiloop-cli-"));
  roots.push(home);
  const artifact = join(home, "artifact");
  const files: Array<{ readonly path: string; readonly sha256: string; readonly mode: number }> = [];
  for (const relative of REQUIRED_LOCAL_RELEASE_FILES) {
    const content = relative === "apps/sidecar/dist/deploy-main.js" && options.deployMain !== undefined
      ? options.deployMain
      : relative.endsWith(".json")
        ? "{}\n"
        : relative.endsWith(".html")
          ? "<!doctype html><title>ZhiLoop</title>\n"
          : `// fixture ${relative}\n`;
    await mkdir(join(artifact, ...relative.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(artifact, ...relative.split("/")), content);
    files.push({ path: relative, sha256: createHash("sha256").update(content).digest("hex"), mode: 0o444 });
  }
  await writeFile(join(artifact, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version: options.version ?? "0.1.0",
    pluginVersion: options.pluginVersion ?? "0.1.0",
    protocolVersion: options.protocolVersion ?? 1,
    sourceCommit: "d3bdb8b",
    nodePath: options.nodePath ?? process.execPath,
    nodeVersion: process.versions.node,
    createdAt: "2026-08-03T00:00:00.000Z",
    files,
  }));
  return { home, artifact };
}

describe("deployment CLI", () => {
  it("renders an install plan without applying it", async () => {
    const value = await fixture();
    const stdout = sink();
    const stderr = sink();
    expect(await runDeploymentCli([
      "install", "--home", value.home, "--artifact", value.artifact, "--json",
    ], stdout.stream, stderr.stream)).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({ mode: "SHADOW", version: "0.1.0" });
    expect(stderr.value()).toBe("");
  });

  it("validates required arguments and shows bounded usage", async () => {
    const value = await fixture();
    await expect(runDeploymentCli(["install", "--home", value.home], sink().stream, sink().stream)).rejects.toThrow("--artifact");
    const stderr = sink();
    expect(await runDeploymentCli(["unknown", "--home", value.home], sink().stream, stderr.stream)).toBe(64);
    expect(stderr.value()).toContain("usage: zhiloop");
  });

  it("delegates an old runtime upgrade only after verification and leaves CCM opaque", async () => {
    const maliciousRoot = await mkdtemp(join(tmpdir(), "zhiloop-malicious-node-"));
    roots.push(maliciousRoot);
    const maliciousMarker = join(maliciousRoot, "executed");
    const maliciousNode = join(maliciousRoot, "node");
    await writeFile(maliciousNode, `#!/bin/sh\ntouch ${JSON.stringify(maliciousMarker)}\nexit 99\n`, { mode: 0o755 });
    const value = await fixture({
      version: "0.3.11",
      nodePath: maliciousNode,
      deployMain: "process.stdout.write(JSON.stringify({runtime:'artifact',args:process.argv.slice(2)}));\n",
    });
    const ccmConfig = join(value.home, ".ccm", "config.json");
    await mkdir(join(value.home, ".ccm"), { recursive: true });
    await writeFile(ccmConfig, "{\"credential\":\"preserve-me\"}\n");
    const stdout = sink();
    const stderr = sink();

    expect(await runDeploymentCli([
      "upgrade", "--home", value.home, "--artifact", value.artifact, "--json",
    ], stdout.stream, stderr.stream, {
      currentVersion: "0.2.1",
      currentEntrypoint: join(value.home, "installed-old", "apps", "sidecar", "dist", "deploy-main.js"),
    })).toBe(0);

    const delegated = JSON.parse(stdout.value()) as { runtime: string; args: string[] };
    expect(delegated.runtime).toBe("artifact");
    expect(delegated.args[0]).toBe("upgrade");
    const artifactIndex = delegated.args.indexOf("--artifact");
    expect(delegated.args[artifactIndex + 1]).toContain("zhiloop-delegated-release-");
    await expect(access(delegated.args[artifactIndex + 1] ?? "")).rejects.toThrow();
    expect(stderr.value()).toBe("");
    await expect(access(maliciousMarker)).rejects.toThrow();
    expect(await readFile(ccmConfig, "utf8")).toBe("{\"credential\":\"preserve-me\"}\n");
  });

  it("does not recursively delegate the same version or an artifact-local runtime", async () => {
    const sameVersion = await fixture({
      version: "0.2.1",
      deployMain: "process.stdout.write('unexpected delegation');\n",
    });
    const sameOutput = sink();
    expect(await runDeploymentCli([
      "upgrade", "--home", sameVersion.home, "--artifact", sameVersion.artifact, "--json",
    ], sameOutput.stream, sink().stream, {
      currentVersion: "0.2.1",
      currentEntrypoint: join(sameVersion.home, "old", "deploy-main.js"),
    })).toBe(0);
    expect(JSON.parse(sameOutput.value())).toMatchObject({ mode: "SHADOW", version: "0.2.1" });

    const artifactLocal = await fixture({
      version: "0.3.11",
      deployMain: "process.stdout.write('unexpected delegation');\n",
    });
    const localOutput = sink();
    expect(await runDeploymentCli([
      "upgrade", "--home", artifactLocal.home, "--artifact", artifactLocal.artifact, "--json",
    ], localOutput.stream, sink().stream, {
      currentVersion: "0.2.1",
      currentEntrypoint: join(artifactLocal.artifact, "apps", "sidecar", "dist", "deploy-main.js"),
    })).toBe(0);
    expect(JSON.parse(localOutput.value())).toMatchObject({ mode: "SHADOW", version: "0.3.11" });
  });

  it("never executes a tampered artifact", async () => {
    const marker = join(tmpdir(), `zhiloop-unverified-${process.pid}-${Date.now()}`);
    const value = await fixture({
      version: "0.3.11",
      deployMain: `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'executed');\n`,
    });
    await appendFile(join(value.artifact, "apps", "sidecar", "dist", "deploy-main.js"), "// tampered\n");

    await expect(runDeploymentCli([
      "upgrade", "--home", value.home, "--artifact", value.artifact, "--json",
    ], sink().stream, sink().stream, { currentVersion: "0.2.1" })).rejects.toThrow("integrity verification");
    await expect(access(marker)).rejects.toThrow();

    const incompatibleMarker = `${marker}-incompatible`;
    const incompatible = await fixture({
      version: "0.3.11",
      pluginVersion: "9.0.0",
      deployMain: `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(incompatibleMarker)}, 'executed');\n`,
    });
    await expect(runDeploymentCli([
      "upgrade", "--home", incompatible.home, "--artifact", incompatible.artifact, "--json",
    ], sink().stream, sink().stream, { currentVersion: "0.2.1" })).rejects.toThrow("incompatible");
    await expect(access(incompatibleMarker)).rejects.toThrow();
  });

  it("preserves child exit codes and bounds delegated timeout and output", async () => {
    const failed = await fixture({
      version: "0.3.11",
      deployMain: "process.stdout.write('child-out'); process.stderr.write('child-err'); process.exitCode = 42;\n",
    });
    const failedStdout = sink();
    const failedStderr = sink();
    expect(await runDeploymentCli([
      "upgrade", "--home", failed.home, "--artifact", failed.artifact,
    ], failedStdout.stream, failedStderr.stream, { currentVersion: "0.2.1" })).toBe(42);
    expect(failedStdout.value()).toBe("child-out");
    expect(failedStderr.value()).toBe("child-err");

    const noisy = await fixture({
      version: "0.3.11",
      deployMain: "process.stdout.write('x'.repeat(10_000)); process.stderr.write('y'.repeat(10_000)); setInterval(() => {}, 1_000);\n",
    });
    const noisyStdout = sink();
    const noisyStderr = sink();
    expect(await runDeploymentCli([
      "upgrade", "--home", noisy.home, "--artifact", noisy.artifact,
    ], noisyStdout.stream, noisyStderr.stream, {
      currentVersion: "0.2.1",
      delegationMaxOutputBytes: 128,
      delegationTimeoutMs: 1_000,
    })).toBe(70);
    expect(Buffer.byteLength(noisyStdout.value())).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(noisyStderr.value())).toBeLessThanOrEqual(128);
    expect(noisyStderr.value()).toContain("DELEGATED_DEPLOYMENT_OUTPUT_LIMIT");

    const hanging = await fixture({ version: "0.3.11", deployMain: "setInterval(() => {}, 1_000);\n" });
    const hangingStderr = sink();
    expect(await runDeploymentCli([
      "upgrade", "--home", hanging.home, "--artifact", hanging.artifact,
    ], sink().stream, hangingStderr.stream, {
      currentVersion: "0.2.1",
      delegationTimeoutMs: 20,
      delegationMaxOutputBytes: 256,
    })).toBe(70);
    expect(hangingStderr.value()).toContain("DELEGATED_DEPLOYMENT_TIMEOUT");
  });

  it("returns stable capture usage and Sidecar-unavailable diagnostics", async () => {
    const value = await fixture();
    const missing = sink();
    expect(await runDeploymentCli(["capture", "--home", value.home], sink().stream, missing.stream)).toBe(64);
    expect(missing.value()).toContain("--session");

    const unavailable = sink();
    expect(await runDeploymentCli([
      "capture", "--home", value.home, "--session", "session-a", "--json",
    ], sink().stream, unavailable.stream)).toBe(69);
    expect(JSON.parse(unavailable.value())).toMatchObject({ status: "FAILED", errorCode: "SIDECAR_UNAVAILABLE" });
  });

  it("requests a dry-run capture through the Sidecar without direct ledger writes", async () => {
    const value = await fixture();
    const sessionsRoot = join(value.home, ".codex", "sessions");
    const transcriptDirectory = join(sessionsRoot, "2026", "08", "03");
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(join(transcriptDirectory, "rollout-session-a.jsonl"), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-03T00:00:00.000Z", payload: { id: "session-a", session_id: "session-a", cli_version: "0.145.0" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-03T00:00:01.000Z", payload: { type: "user_message", message: "preview" } }),
    ].join("\n") + "\n");
    const config = {
      schemaVersion: 1 as const,
      rolloutMode: "SHADOW" as const,
      socketPath: join(value.home, ".ckl", "run", "sidecar.sock"),
      codexSessionsRoot: sessionsRoot,
      ledgerPath: join(value.home, ".ckl", "knowledge", "events.sqlite"),
      spoolPath: join(value.home, ".ckl", "spool"),
      logPath: join(value.home, ".ckl", "logs", "sidecar.jsonl"),
      hookMaxInputBytes: 5_242_880,
      hookTimeoutMs: 750,
      logMaxBytes: 5_242_880,
      logRetainFiles: 3,
    };
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      const stdout = sink();
      expect(await runDeploymentCli([
        "capture", "--home", value.home, "--session", "session-a", "--dry-run", "--json",
      ], stdout.stream, sink().stream)).toBe(0);
      expect(JSON.parse(stdout.value())).toMatchObject({ status: "PREVIEWED", projectedEvents: 2, appendedEvents: 0 });
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });
});
