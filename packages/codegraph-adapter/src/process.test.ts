import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeCodeGraphProcess } from "./process.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

async function cwd(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "zhiloop-codegraph-process-")); roots.push(root); return root;
}

describe("NodeCodeGraphProcess", () => {
  it("runs a fixed argv without a shell and captures bounded output", async () => {
    const result = await new NodeCodeGraphProcess().run({ executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')", "literal;$(unsafe)"],
      cwd: await cwd(), timeoutMs: 2_000, maxOutputBytes: 1_024 });
    expect(result).toEqual({ exitCode: 0, stdout: "literal;$(unsafe)", stderr: "diagnostic", timedOut: false, outputExceeded: false });
  });

  it("kills the process group when the timeout is reached", async () => {
    const result = await new NodeCodeGraphProcess().run({ executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"], cwd: await cwd(), timeoutMs: 20, maxOutputBytes: 1_024 });
    expect(result.timedOut).toBe(true); expect(result.exitCode).not.toBe(0);
  });

  it("kills and truncates a process that exceeds the combined output bound", async () => {
    const result = await new NodeCodeGraphProcess().run({ executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096))"], cwd: await cwd(), timeoutMs: 2_000, maxOutputBytes: 64 });
    expect(result.outputExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(64);
  });

  it("rejects a missing executable", async () => {
    await expect(new NodeCodeGraphProcess().run({ executable: "/definitely/missing/zhiloop-codegraph",
      args: [], cwd: await cwd(), timeoutMs: 100, maxOutputBytes: 64 })).rejects.toBeInstanceOf(Error);
  });
});
