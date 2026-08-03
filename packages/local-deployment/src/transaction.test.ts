import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDeploymentPaths } from "./paths.js";
import { replaceFileStep, replaceSymlinkStep } from "./steps.js";
import { executeDeploymentTransaction } from "./transaction.js";
import type { DeploymentStep } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "zhiloop-deploy-"));
  roots.push(value);
  return value;
}

describe("deployment paths", () => {
  it("resolves a current-user layout without touching CCM", async () => {
    const home = await root();
    const paths = resolveDeploymentPaths(home, "0.1.0");
    expect(paths.releaseDirectory).toBe(join(home, ".local", "share", "zhiloop", "releases", "0.1.0"));
    expect(paths.codexHooksPath).toBe(join(home, ".codex", "hooks.json"));
    expect(Object.values(paths).some((path) => path.includes(".ccm"))).toBe(false);
  });

  it("rejects broad homes and unsafe versions", () => {
    expect(() => resolveDeploymentPaths("/", "0.1.0")).toThrow("root");
    expect(() => resolveDeploymentPaths("relative", "0.1.0")).toThrow("absolute");
    expect(() => resolveDeploymentPaths("/tmp/user", "latest")).toThrow("semantic");
  });
});

describe("deployment transaction", () => {
  it("commits ordered file and current-link mutations", async () => {
    const directory = await root();
    const target = join(directory, "config.json");
    const release = join(directory, "releases", "0.1.0");
    await mkdir(release, { recursive: true });
    const steps = [
      await replaceFileStep("write-config", target, "new\n"),
      await replaceSymlinkStep("switch-current", join(directory, "current"), release),
    ];
    const result = await executeDeploymentTransaction(steps, {
      journalPath: join(directory, "journal.json"), operation: "install", randomId: () => "tx-1",
    });
    expect(result.journal).toMatchObject({ state: "COMMITTED", completedSteps: ["write-config", "switch-current"] });
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await readlink(join(directory, "current"))).toBe("releases/0.1.0");
  });

  it.each(["first", "second", "third"])("restores every earlier mutation after failure at %s", async (failedStep) => {
    const directory = await root();
    const targets = [join(directory, "a"), join(directory, "b"), join(directory, "c")];
    await Promise.all(targets.map((path, index) => writeFile(path, `before-${index}`)));
    const steps: DeploymentStep[] = [];
    for (const [index, id] of ["first", "second", "third"].entries()) {
      steps.push(await replaceFileStep(id, targets[index] as string, `after-${index}`));
    }
    await expect(executeDeploymentTransaction(steps, {
      journalPath: join(directory, "journal.json"), operation: "upgrade", failAfterStep: failedStep, randomId: () => "tx-fault",
    })).rejects.toThrow("injected deployment failure");
    await expect(Promise.all(targets.map((path) => readFile(path, "utf8")))).resolves.toEqual(["before-0", "before-1", "before-2"]);
    expect(JSON.parse(await readFile(join(directory, "journal.json"), "utf8"))).toMatchObject({ state: "ROLLED_BACK", failedStep });
  });

  it("rejects concurrent drift before replacement", async () => {
    const directory = await root();
    const target = join(directory, "config.json");
    await writeFile(target, "planned");
    const step = await replaceFileStep("write-config", target, "managed");
    await writeFile(target, "external-edit");
    await expect(executeDeploymentTransaction([step], {
      journalPath: join(directory, "journal.json"), operation: "install", randomId: () => "tx-drift",
    })).rejects.toThrow("changed after deployment planning");
    expect(await readFile(target, "utf8")).toBe("external-edit");
  });

  it("rejects symlinked file targets and non-managed current targets", async () => {
    const directory = await root();
    const real = join(directory, "real");
    const linked = join(directory, "linked");
    await writeFile(real, "external");
    await symlink(real, linked);
    await expect(replaceFileStep("unsafe", linked, "managed")).rejects.toThrow("regular file");
    const current = join(directory, "current");
    await writeFile(current, "not-our-link");
    await expect(replaceSymlinkStep("unsafe-current", current, real)).rejects.toThrow("symbolic link");
  });

  it("validates transaction identifiers and step ownership", async () => {
    const directory = await root();
    const step = await replaceFileStep("same", join(directory, "value"), "x");
    await expect(executeDeploymentTransaction([step, step], {
      journalPath: join(directory, "journal.json"), operation: "install",
    })).rejects.toThrow("unique");
    await expect(executeDeploymentTransaction([step], {
      journalPath: join(directory, "journal.json"), operation: "install", randomId: () => "bad/id",
    })).rejects.toThrow("safe token");
    expect((await lstat(directory)).isDirectory()).toBe(true);
  });
});
