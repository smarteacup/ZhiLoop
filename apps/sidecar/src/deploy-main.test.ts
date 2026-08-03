import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runDeploymentCli } from "./deployment-cli.js";

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
  const relative = "apps/sidecar/dist/main.js";
  const content = "sidecar";
  await mkdir(join(artifact, "apps", "sidecar", "dist"), { recursive: true });
  await writeFile(join(artifact, relative), content);
  await writeFile(join(artifact, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0",
    pluginVersion: "0.1.0",
    protocolVersion: 1,
    sourceCommit: "d3bdb8b",
    nodePath: process.execPath,
    nodeVersion: process.versions.node,
    createdAt: "2026-08-03T00:00:00.000Z",
    files: [{ path: relative, sha256: createHash("sha256").update(content).digest("hex"), mode: 0o444 }],
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
});
