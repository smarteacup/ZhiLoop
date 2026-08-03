import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { renderZhiLoopLauncher } from "./installer.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("stable zhiloop launcher", () => {
  it("dispatches only the exact ui command and preserves every remaining argument", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhiloop-ui-launcher-"));
    roots.push(root);
    const ui = join(root, "ui entry.js");
    const deployment = join(root, "deployment entry.js");
    const launcher = join(root, "zhiloop");
    await writeFile(ui, "process.stdout.write(JSON.stringify({target:'ui',args:process.argv.slice(2)}));\n");
    await writeFile(deployment, "process.stdout.write(JSON.stringify({target:'deployment',args:process.argv.slice(2)}));\n");
    await writeFile(launcher, renderZhiLoopLauncher(process.execPath, deployment, ui));
    await chmod(launcher, 0o700);

    expect(JSON.parse((await execFileAsync(launcher, ["ui", "--port", "0", "argument with spaces"])).stdout)).toEqual({
      target: "ui",
      args: ["--port", "0", "argument with spaces"],
    });
    expect(JSON.parse((await execFileAsync(launcher, ["doctor", "--json"])).stdout)).toEqual({
      target: "deployment",
      args: ["doctor", "--json"],
    });
    expect(JSON.parse((await execFileAsync(launcher, ["ui-extra"])).stdout)).toEqual({
      target: "deployment",
      args: ["ui-extra"],
    });
  });
});
