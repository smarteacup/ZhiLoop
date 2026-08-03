import { describe, expect, it, vi } from "vitest";

import { MacOsLaunchctlController, renderLaunchAgent } from "./macos.js";
import { resolveDeploymentPaths } from "./paths.js";

describe("macOS deployment adapter", () => {
  it("renders absolute argument arrays without shell or environment injection", () => {
    const paths = resolveDeploymentPaths("/Users/test & user", "0.1.0");
    const plist = renderLaunchAgent(paths);
    expect(plist).toContain("/Users/test &amp; user/.local/bin/zhiloop-sidecar");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).not.toContain("EnvironmentVariables");
    expect(plist).not.toContain("/bin/sh");
  });

  it("rejects an invalid GUI user id", () => {
    expect(() => new MacOsLaunchctlController(-1)).toThrow("user id");
    expect(() => new MacOsLaunchctlController(1.5)).toThrow("user id");
  });

  it("maps launchctl print results to bounded service states", async () => {
    for (const [result, expected] of [
      [{ code: 0, stderr: "" }, "RUNNING"],
      [{ code: 113, stderr: "Could not find service" }, "STOPPED"],
      [{ code: 1, stderr: "permission denied" }, "UNKNOWN"],
    ] as const) {
      const run = vi.fn(async () => result);
      await expect(new MacOsLaunchctlController(501, { run }).status()).resolves.toBe(expected);
      expect(run).toHaveBeenCalledWith(["print", "gui/501/dev.zhiloop.sidecar"]);
    }
  });

  it("bootstraps immediately, accepts an already-running service and retries transient I/O failures", async () => {
    let calls = 0; const sleeps: number[] = [];
    const controller = new MacOsLaunchctlController(501, {
      run: async (args) => {
        if (args[0] === "print") return { code: calls === 2 ? 0 : 1, stderr: calls === 2 ? "" : "not ready" };
        calls += 1;
        return calls === 1 ? { code: 5, stderr: "Input/output error" } : { code: 0, stderr: "" };
      },
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });
    await expect(controller.bootstrap("/tmp/sidecar.plist")).resolves.toBeUndefined();
    expect(sleeps).toEqual([100]);

    const running = new MacOsLaunchctlController(501, { run: async (args) => args[0] === "print" ? { code: 0, stderr: "" } : { code: 1, stderr: "fatal" } });
    await expect(running.bootstrap("/tmp/sidecar.plist")).resolves.toBeUndefined();
  });

  it("fails bootstrap on a permanent error or exhausted transient retries", async () => {
    const permanent = new MacOsLaunchctlController(501, { run: async (args) => args[0] === "print" ? { code: 1, stderr: "unknown" } : { code: 9, stderr: "permission denied" } });
    await expect(permanent.bootstrap("/tmp/sidecar.plist")).rejects.toThrow("permission denied");
    const transient = new MacOsLaunchctlController(501, { run: async (args) => args[0] === "print" ? { code: 1, stderr: "unknown" } : { code: 5, stderr: "I/O error" }, sleep: async () => undefined });
    await expect(transient.bootstrap("/tmp/sidecar.plist")).rejects.toThrow("I/O error");
  });

  it("kickstarts only when stopped and handles success, transient progress and fatal failures", async () => {
    const alreadyRunning = vi.fn(async () => ({ code: 0, stderr: "" }));
    await expect(new MacOsLaunchctlController(501, { run: alreadyRunning }).kickstart()).resolves.toBeUndefined();
    expect(alreadyRunning).toHaveBeenCalledOnce();

    let kickstarts = 0;
    const retry = new MacOsLaunchctlController(501, {
      run: async (args) => {
        if (args[0] === "print") return { code: 1, stderr: "not ready" };
        kickstarts += 1; return kickstarts === 1 ? { code: 37, stderr: "operation in progress" } : { code: 0, stderr: "" };
      }, sleep: async () => undefined,
    });
    await expect(retry.kickstart()).resolves.toBeUndefined();
    expect(kickstarts).toBe(2);
    const fatal = new MacOsLaunchctlController(501, { run: async (args) => args[0] === "print" ? { code: 1, stderr: "stopped" } : { code: 9, stderr: "denied" } });
    await expect(fatal.kickstart()).rejects.toThrow("denied");
  });

  it("boots out idempotently, waits for STOPPED and fails on permanent or stuck states", async () => {
    let prints = 0; const sleeps: number[] = [];
    const delayed = new MacOsLaunchctlController(501, {
      run: async (args) => args[0] === "bootout" ? { code: 0, stderr: "" } : (++prints < 3 ? { code: 0, stderr: "" } : { code: 113, stderr: "not found" }),
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });
    await expect(delayed.bootout()).resolves.toBeUndefined();
    expect(sleeps).toEqual([100, 200]);
    const absent = new MacOsLaunchctlController(501, { run: async () => ({ code: 113, stderr: "No such process" }) });
    await expect(absent.bootout()).resolves.toBeUndefined();
    const denied = new MacOsLaunchctlController(501, { run: async () => ({ code: 1, stderr: "permission denied" }) });
    await expect(denied.bootout()).rejects.toThrow("permission denied");
    const stuck = new MacOsLaunchctlController(501, { run: async (args) => args[0] === "bootout" ? { code: 0, stderr: "" } : { code: 0, stderr: "" }, sleep: async () => undefined });
    await expect(stuck.bootout()).rejects.toThrow("did not reach STOPPED");
  });
});
