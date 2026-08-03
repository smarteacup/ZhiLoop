import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { stageReleaseStep, verifyReleaseArtifact } from "./release.js";
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

  it("removes a newly staged release after a later transaction failure", async () => {
    const value = await artifact();
    const target = join(value.root, "installed", "releases", "0.1.0");
    await expect(executeDeploymentTransaction([await stageReleaseStep("stage", value.directory, target)], {
      journalPath: join(value.root, "journal.json"), operation: "install", failAfterStep: "stage", randomId: () => "rollback",
    })).rejects.toThrow("injected");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
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

    const unsupported = await artifact();
    const unsupportedMetadata = JSON.parse(await readFile(join(unsupported.directory, "release.json"), "utf8")) as Record<string, unknown>;
    unsupportedMetadata["nodeVersion"] = "23.0.0";
    await writeFile(join(unsupported.directory, "release.json"), JSON.stringify(unsupportedMetadata));
    await expect(verifyReleaseArtifact(unsupported.directory)).rejects.toThrow("unsupported");

    const collision = await artifact();
    const target = join(collision.root, "installed", "releases", "0.1.0");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "release.json"), "{}");
    await expect(stageReleaseStep("collision", collision.directory, target)).rejects.toThrow();
  });
});
