import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";

import type { SidecarCompatibilityPolicy } from "@zhiloop/plugin-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { delegateUpgradeToVerifiedArtifact } from "./artifact-delegation.js";
import { REQUIRED_LOCAL_RELEASE_FILES } from "./release.js";

const roots: string[] = [];
const compatibility: SidecarCompatibilityPolicy = {
  pluginVersion: "0.3.0", minimumSidecarVersion: "0.3.0", protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1", appServerSchemaVersion: "codex-app-server-v2",
};

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

class MemoryWritable extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); callback();
  }
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

async function artifact(version = "0.3.0"): Promise<{ root: string; directory: string; entrypoint: string }> {
  const root = await mkdtemp(join(tmpdir(), "zhiloop-delegation-")); roots.push(root);
  const directory = join(root, "artifact");
  const files: Array<{ path: string; sha256: string; mode: number }> = [];
  const deploymentProgram = String.raw`
const args = process.argv.slice(2);
if (args.includes("--hang")) setInterval(() => undefined, 1000);
else if (args.includes("--signal")) process.kill(process.pid, "SIGTERM");
else {
  const large = args.includes("--large");
  process.stdout.write(large ? "x".repeat(100000) : JSON.stringify({ args, cwd: process.cwd() }) + "\n");
  process.stderr.write(large ? "y".repeat(100000) : "delegated stderr\n");
  const index = args.indexOf("--exit");
  process.exit(index < 0 ? 0 : Number(args[index + 1]));
}
`;
  for (const relative of REQUIRED_LOCAL_RELEASE_FILES) {
    const body = relative === "apps/sidecar/dist/deploy-main.js" ? deploymentProgram
      : relative.endsWith(".json") ? JSON.stringify({ name: relative, version }) : `fixture:${relative}\n`;
    const target = join(directory, ...relative.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, { mode: relative.endsWith(".js") ? 0o555 : 0o444 });
    files.push({ path: relative, sha256: createHash("sha256").update(body).digest("hex"), mode: relative.endsWith(".js") ? 0o555 : 0o444 });
  }
  await writeFile(join(directory, "release.json"), JSON.stringify({
    schemaVersion: 1, version, pluginVersion: compatibility.pluginVersion, protocolVersion: compatibility.protocolVersion,
    sourceCommit: "abcdef0", nodePath: process.execPath, nodeVersion: process.versions.node,
    createdAt: "2026-08-03T00:00:00.000Z", files,
  }), { mode: 0o444 });
  return { root, directory, entrypoint: join(directory, "apps", "sidecar", "dist", "deploy-main.js") };
}

function options(value: Awaited<ReturnType<typeof artifact>>, args: readonly string[] = []) {
  const stdout = new MemoryWritable(); const stderr = new MemoryWritable();
  return {
    stdout, stderr,
    value: {
      artifactDirectory: value.directory, home: join(value.root, "home"), args,
      currentVersion: "0.2.0", compatibility, stdout, stderr,
    },
  };
}

describe("verified artifact deployment delegation", () => {
  it("does not recurse into the same version or the same real entrypoint", async () => {
    const value = await artifact();
    let target = options(value);
    await expect(delegateUpgradeToVerifiedArtifact({ ...target.value, currentVersion: "0.3.0" })).resolves.toEqual({ delegated: false });
    target = options(value);
    await expect(delegateUpgradeToVerifiedArtifact({ ...target.value, currentEntrypoint: value.entrypoint })).resolves.toEqual({ delegated: false });
    expect(await realpath(value.entrypoint)).toBe(await realpath(value.entrypoint));
  });

  it("executes only a verified snapshot and replaces host-owned artifact and home arguments", async () => {
    const value = await artifact(); const target = options(value, ["install", "--artifact", "/attacker/artifact", "--home", "/attacker/home", "--exit", "7"]);
    await expect(delegateUpgradeToVerifiedArtifact(target.value)).resolves.toEqual({ delegated: true, exitCode: 7 });
    const output = JSON.parse(target.stdout.text()) as { args: string[]; cwd: string };
    expect(output.args).toContain("install");
    expect(output.args).not.toContain("/attacker/artifact");
    expect(output.args).not.toContain("/attacker/home");
    expect(output.args[output.args.indexOf("--home") + 1]).toBe(join(value.root, "home"));
    expect(output.cwd).toContain("zhiloop-delegated-release-");
    expect(target.stderr.text()).toBe("delegated stderr\n");
  });

  it("appends absent owned options and handles an unavailable current entrypoint without trusting it", async () => {
    const value = await artifact(); const target = options(value, ["doctor"]);
    await expect(delegateUpgradeToVerifiedArtifact({ ...target.value, currentEntrypoint: join(value.root, "missing") })).resolves.toEqual({ delegated: true, exitCode: 0 });
    const output = JSON.parse(target.stdout.text()) as { args: string[] };
    expect(output.args).toEqual(expect.arrayContaining(["doctor", "--artifact", "--home"]));
  });

  it("rejects unsafe bounds and owned options with missing values before child execution", async () => {
    const value = await artifact();
    for (const override of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { maxOutputBytes: 0 }, { maxOutputBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
      const target = options(value);
      await expect(delegateUpgradeToVerifiedArtifact({ ...target.value, ...override })).rejects.toThrow("positive integer");
    }
    const target = options(value, ["install", "--artifact"]);
    await expect(delegateUpgradeToVerifiedArtifact(target.value)).rejects.toThrow("--artifact requires a value");
  });

  it("bounds stdout and stderr, terminates the child and emits a stable output-limit diagnostic", async () => {
    const value = await artifact(); const target = options(value, ["install", "--large"]);
    await expect(delegateUpgradeToVerifiedArtifact({ ...target.value, maxOutputBytes: 256, timeoutMs: 5_000 })).resolves.toEqual({ delegated: true, exitCode: 70, errorCode: "DELEGATED_DEPLOYMENT_OUTPUT_LIMIT" });
    expect(Buffer.byteLength(target.stdout.text())).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(target.stderr.text())).toBeLessThanOrEqual(256);
    expect(target.stderr.text()).toContain("DELEGATED_DEPLOYMENT_OUTPUT_LIMIT");
  });

  it("times out a hung artifact and reports a signalled artifact without leaking unbounded output", async () => {
    const value = await artifact();
    let target = options(value, ["install", "--hang"]);
    await expect(delegateUpgradeToVerifiedArtifact({ ...target.value, timeoutMs: 20, maxOutputBytes: 512 })).resolves.toEqual({ delegated: true, exitCode: 70, errorCode: "DELEGATED_DEPLOYMENT_TIMEOUT" });
    expect(target.stderr.text()).toContain("DELEGATED_DEPLOYMENT_TIMEOUT");
    target = options(value, ["install", "--signal"]);
    await expect(delegateUpgradeToVerifiedArtifact({ ...target.value, timeoutMs: 5_000, maxOutputBytes: 512 })).resolves.toEqual({ delegated: true, exitCode: 70, errorCode: "DELEGATED_DEPLOYMENT_SIGNALLED" });
    expect(target.stderr.text()).toContain("DELEGATED_DEPLOYMENT_SIGNALLED");
  });

  it("always removes the verified snapshot after a delegated run", async () => {
    const value = await artifact(); const target = options(value, ["doctor"]);
    await delegateUpgradeToVerifiedArtifact(target.value);
    const output = JSON.parse(target.stdout.text()) as { cwd: string };
    await expect(readFile(join(output.cwd, "release.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
