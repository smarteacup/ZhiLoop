import { describe, expect, it } from "vitest";

import {
  CONSOLE_QUERY_TIMEOUT_MS,
  CONSOLE_MODEL_QUERY_TIMEOUT_MS,
  formatConsoleRuntimeAnnouncement,
  parseConsoleRuntimeOptions,
  resolveConsoleRuntimePaths,
} from "./runtime.js";

describe("Console Gateway runtime", () => {
  it("parses bounded launcher options", () => {
    expect(parseConsoleRuntimeOptions(["--home", "/tmp/operator", "--port", "31415", "--no-open", "--json"])).toEqual({ home: "/tmp/operator", port: 31415, openBrowser: false, json: true });
    expect(() => parseConsoleRuntimeOptions(["--home", "/"])).toThrow(/home/u);
    expect(() => parseConsoleRuntimeOptions(["--port", "65536"])).toThrow(/port/u);
    expect(() => parseConsoleRuntimeOptions(["--unknown"])).toThrow(/unknown/u);
  });

  it("resolves only the owner-local Sidecar socket and release Web assets", () => {
    expect(CONSOLE_QUERY_TIMEOUT_MS).toBe(15_000);
    expect(CONSOLE_MODEL_QUERY_TIMEOUT_MS).toBe(120_000);
    expect(resolveConsoleRuntimePaths("/Users/operator", "file:///release/apps/console-gateway/dist/runtime.js")).toEqual({
      socketPath: "/Users/operator/.ckl/run/sidecar.sock",
      staticRoot: "/release/apps/console-web/dist/",
    });
  });

  it("never writes the bootstrap fragment in default browser-open output", () => {
    const address = { origin: "http://127.0.0.1:3000", bootstrapUrl: "http://127.0.0.1:3000/#bootstrap=secret" };
    const opened = formatConsoleRuntimeAnnouncement({ json: true, openBrowser: true }, address, true);
    expect(opened).toContain('"status":"RUNNING"');
    expect(opened).toContain('"browserOpened":true');
    expect(opened).not.toContain("secret");
    const manual = formatConsoleRuntimeAnnouncement({ json: true, openBrowser: false }, address, false);
    expect(manual).toContain("#bootstrap=secret");
  });
});
