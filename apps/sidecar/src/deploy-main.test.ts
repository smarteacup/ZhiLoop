import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function fixture(): Promise<{ home: string; artifact: string }> {
  const home = await mkdtemp(join(tmpdir(), "zhiloop-cli-"));
  roots.push(home);
  const artifact = join(home, "artifact");
  const files: Array<{ readonly path: string; readonly sha256: string; readonly mode: number }> = [];
  for (const relative of REQUIRED_LOCAL_RELEASE_FILES) {
    const content = relative.endsWith(".json") ? "{}\n" : relative.endsWith(".html") ? "<!doctype html><title>ZhiLoop</title>\n" : `// fixture ${relative}\n`;
    await mkdir(join(artifact, ...relative.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(artifact, ...relative.split("/")), content);
    files.push({ path: relative, sha256: createHash("sha256").update(content).digest("hex"), mode: 0o444 });
  }
  await writeFile(join(artifact, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0",
    pluginVersion: "0.1.0",
    protocolVersion: 1,
    sourceCommit: "d3bdb8b",
    nodePath: process.execPath,
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
