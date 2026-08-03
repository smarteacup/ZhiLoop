import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  launchConsoleGateway,
  parseConsoleUiOptions,
  runConsoleUi,
  type ConsoleProcessPort,
} from "./ui-cli.js";

class FakeChild extends EventEmitter implements ConsoleProcessPort {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    this.emit("close", null, signal);
    return true;
  });
}

describe("Console UI process launcher", () => {
  it("parses a bounded configuration without exposing a remote bind option", () => {
    expect(parseConsoleUiOptions(["--home", "/tmp/zhiloop-home", "--port", "0", "--no-open", "--json"])).toEqual({
      home: "/tmp/zhiloop-home",
      port: 0,
      openBrowser: false,
      json: true,
    });
    expect(() => parseConsoleUiOptions(["--host", "0.0.0.0"])).toThrow("unknown ui option");
    expect(() => parseConsoleUiOptions(["--port", "65536"])).toThrow("between 0 and 65535");
    expect(() => parseConsoleUiOptions(["--home"])).toThrow("requires a value");
    expect(() => parseConsoleUiOptions(["--json", "--json"])).toThrow("only be specified once");
  });

  it("spawns the release-owned independent Gateway entry with exact arguments", async () => {
    const child = new FakeChild();
    const inspected = vi.fn(async () => undefined);
    const spawned = vi.fn((node: string, entry: string, args: readonly string[]) => {
      void node;
      void entry;
      void args;
      return child;
    });
    const launched = launchConsoleGateway(["--home", "/tmp/zhiloop-home", "--no-open", "--port", "0"], {
      inspectEntrypoint: inspected,
      spawnGateway: spawned,
    });
    expect(inspected).toHaveBeenCalledWith("/tmp/zhiloop-home/.local/share/zhiloop/current/apps/console-gateway/dist/main.js");
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledWith(
        process.execPath,
        "/tmp/zhiloop-home/.local/share/zhiloop/current/apps/console-gateway/dist/main.js",
        ["--home", "/tmp/zhiloop-home", "--no-open", "--port", "0"],
      ));
    child.exitCode = 0;
    child.emit("close", 0, null);
    await expect(launched).resolves.toBe(0);
  });

  it("maps a terminated child to success and removes installed signal relays", async () => {
    const child = new FakeChild();
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const launched = launchConsoleGateway(["--home", "/tmp/zhiloop-home"], {
      inspectEntrypoint: async () => undefined,
      spawnGateway: () => child,
    });
    await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
    child.signalCode = "SIGTERM";
    child.emit("close", null, "SIGTERM");
    await expect(launched).resolves.toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("returns a bounded safe error when the release entry is missing", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.setEncoding("utf8");
    const chunks: string[] = [];
    stderr.on("data", (chunk: string) => chunks.push(chunk));
    const code = await runConsoleUi(["--home", "/tmp/zhiloop-home"], stdout, stderr, {
      inspectEntrypoint: async () => { throw new Error("missing\nsecret"); },
    });
    expect(code).toBe(1);
    expect(chunks.join("")).toBe("Error: missing secret\n");
  });
});
