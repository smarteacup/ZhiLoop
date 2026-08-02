import process from "node:process";

import { describe, expect, it } from "vitest";

import { NodeCodexExecProcess } from "./process.js";

function request(overrides: Partial<Parameters<NodeCodexExecProcess["run"]>[0]> = {}): Parameters<NodeCodexExecProcess["run"]>[0] {
  return {
    executable: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    cwd: process.cwd(),
    stdin: "hello",
    signal: new AbortController().signal,
    maxStdoutBytes: 100,
    maxStderrBytes: 100,
    ...overrides,
  };
}

describe("NodeCodexExecProcess", () => {
  it("executes without a shell and captures bounded stdio", async () => {
    await expect(new NodeCodexExecProcess().run(request())).resolves.toEqual({
      exitCode: 0, signal: null, stdout: "hello", stderr: "",
    });
  });

  it("rejects output overflow and aborts an active child", async () => {
    await expect(new NodeCodexExecProcess().run(request({
      args: ["-e", "process.stdout.write('overflow')"],
      stdin: "",
      maxStdoutBytes: 2,
    }))).rejects.toThrow("output exceeded");

    const controller = new AbortController();
    const running = new NodeCodexExecProcess().run(request({
      args: ["-e", "setInterval(() => {}, 1000)"], signal: controller.signal,
    }));
    controller.abort("test");
    await expect(running).rejects.toBeDefined();
  });

  it("rejects invalid or already-aborted requests before spawning", async () => {
    const controller = new AbortController();
    controller.abort("already done");
    await expect(new NodeCodexExecProcess().run(request({ signal: controller.signal }))).rejects.toBe("already done");
    await expect(new NodeCodexExecProcess().run(request({ executable: "" }))).rejects.toThrow("executable");
    await expect(new NodeCodexExecProcess().run(request({ args: ["\0"] }))).rejects.toThrow("arguments");
    await expect(new NodeCodexExecProcess().run(request({ cwd: "" }))).rejects.toThrow("cwd");
    await expect(new NodeCodexExecProcess().run(request({ maxStderrBytes: 0 }))).rejects.toThrow("output limit");
  });
});
