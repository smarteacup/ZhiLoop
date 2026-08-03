import { describe, expect, it } from "vitest";

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
  });
});
