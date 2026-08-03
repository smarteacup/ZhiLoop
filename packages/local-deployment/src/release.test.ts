import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { assertSupportedDeploymentNodeVersion, stageReleaseStep, verifyReleaseArtifact } from "./release.js";
import { executeDeploymentTransaction } from "./transaction.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function artifact(): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "zhiloop-release-"));
  roots.push(root);
  const directory = join(root, "artifact");
  const payload = join(directory, "apps", "sidecar", "dist", "main.js");
  await mkdir(join(directory, "apps", "sidecar", "dist"), { recursive: true });
  const content = "#!/usr/bin/env node\nconsole.log('sidecar');\n";
  await writeFile(payload, content, { mode: 0o555 });
  await writeFile(join(directory, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0",
    pluginVersion: "0.1.0",
    protocolVersion: 1,
    sourceCommit: "d3bdb8b",
    nodePath: process.execPath,
    nodeVersion: process.versions.node,
    createdAt: "2026-08-03T00:00:00.000Z",
    files: [{
      path: "apps/sidecar/dist/main.js",
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: 0o555,
    }],
  }));
  return { root, directory };
}

describe("release verification and staging", () => {
  it("verifies inventory and stages an immutable release transactionally", async () => {
    const value = await artifact();
    const verified = await verifyReleaseArtifact(value.directory);
    expect(verified.metadata.version).toBe("0.1.0");
    expect(verified.digest).toMatch(/^[a-f0-9]{64}$/u);
    const target = join(value.root, "installed", "releases", "0.1.0");
    await executeDeploymentTransaction([await stageReleaseStep("stage", value.directory, target)], {
      journalPath: join(value.root, "journal.json"), operation: "install", randomId: () => "release-stage",
    });
    expect(await readFile(join(target, "apps", "sidecar", "dist", "main.js"), "utf8")).toContain("sidecar");
  });

  it("reuses byte-identical immutable content", async () => {
    const value = await artifact();
    const target = join(value.root, "installed", "releases", "0.1.0");
    const first = await stageReleaseStep("first", value.directory, target);
    await executeDeploymentTransaction([first], {
      journalPath: join(value.root, "first.json"), operation: "install", randomId: () => "first",
    });
    const second = await stageReleaseStep("second", value.directory, target);
    await executeDeploymentTransaction([second], {
      journalPath: join(value.root, "second.json"), operation: "upgrade", randomId: () => "second",
    });
    expect(await verifyReleaseArtifact(target)).toMatchObject({ digest: (await verifyReleaseArtifact(value.directory)).digest });
  });

  it("treats metadata Node fields as provenance and never executes their path", async () => {
    const value = await artifact();
    const marker = join(value.root, "untrusted-node-executed");
    const untrustedNode = join(value.root, "untrusted-node");
    await writeFile(untrustedNode, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
    const metadata = JSON.parse(await readFile(join(value.directory, "release.json"), "utf8")) as Record<string, unknown>;
    metadata["nodePath"] = untrustedNode;
    metadata["nodeVersion"] = "23.0.0";
    await writeFile(join(value.directory, "release.json"), JSON.stringify(metadata));

    await expect(verifyReleaseArtifact(value.directory)).resolves.toMatchObject({ metadata: { nodePath: untrustedNode, nodeVersion: "23.0.0" } });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the supported current-runtime version boundaries", () => {
    expect(() => assertSupportedDeploymentNodeVersion("24.17.9")).toThrow("unsupported");
    expect(() => assertSupportedDeploymentNodeVersion("24.18.0")).not.toThrow();
    expect(() => assertSupportedDeploymentNodeVersion("25.8.1")).not.toThrow();
    expect(() => assertSupportedDeploymentNodeVersion("26.99.0")).not.toThrow();
    expect(() => assertSupportedDeploymentNodeVersion("27.0.0")).toThrow("unsupported");
    expect(() => assertSupportedDeploymentNodeVersion("v25.8.1")).toThrow("unsupported");
    expect(() => assertSupportedDeploymentNodeVersion("24.18.0-rc.1")).toThrow("unsupported");
  });

  it("removes a newly staged release after a later transaction failure", async () => {
    const value = await artifact();
    const target = join(value.root, "installed", "releases", "0.1.0");
    await expect(executeDeploymentTransaction([await stageReleaseStep("stage", value.directory, target)], {
      journalPath: join(value.root, "journal.json"), operation: "install", failAfterStep: "stage", randomId: () => "rollback",
    })).rejects.toThrow("injected");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to reuse a same-content release whose metadata differs", async () => {
    const value = await artifact();
    const target = join(value.root, "installed", "releases", "0.1.0");
    await mkdir(join(value.root, "installed", "releases"), { recursive: true });
    await cp(value.directory, target, { recursive: true });
    const metadataPath = join(target, "release.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata["sourceCommit"] = "deadbee";
    await writeFile(metadataPath, JSON.stringify(metadata));

    await expect(stageReleaseStep("stage", value.directory, target)).rejects.toThrow(
      "different content or metadata",
    );
  });

  it("rejects tampering, extra files, symbolic links, and version collisions", async () => {
    const tampered = await artifact();
    await chmod(join(tampered.directory, "apps", "sidecar", "dist", "main.js"), 0o644);
    await writeFile(join(tampered.directory, "apps", "sidecar", "dist", "main.js"), "tampered");
    await expect(verifyReleaseArtifact(tampered.directory)).rejects.toThrow("integrity");

    const extra = await artifact();
    await writeFile(join(extra.directory, "extra.txt"), "extra");
    await expect(verifyReleaseArtifact(extra.directory)).rejects.toThrow("inventory");

    const linked = await artifact();
    await symlink(join(linked.directory, "release.json"), join(linked.directory, "linked.json"));
    await expect(verifyReleaseArtifact(linked.directory)).rejects.toThrow("symbolic link");

    const collision = await artifact();
    const target = join(collision.root, "installed", "releases", "0.1.0");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "release.json"), "{}");
    await expect(stageReleaseStep("collision", collision.directory, target)).rejects.toThrow();
  });
});
