import { describe, expect, it } from "vitest";
import { DEFAULT_CONSOLE_CONFIGURATION, type ConsoleConfiguration } from "@zhiloop/configuration-service";
import { verificationTimeoutMs } from "./application.js";

function configuration(queryTimeoutMs: number): ConsoleConfiguration {
  return {
    ...DEFAULT_CONSOLE_CONFIGURATION,
    codeIntelligence: {
      ...DEFAULT_CONSOLE_CONFIGURATION.codeIntelligence,
      queryTimeoutMs,
    },
  };
}

describe("verification timeout composition", () => {
  it("preserves scheduling margin around the before/probe/after CodeGraph sequence", () => {
    expect(verificationTimeoutMs(configuration(250))).toBe(15_000);
    expect(verificationTimeoutMs(configuration(1_000))).toBe(15_000);
  });

  it("scales with longer CodeGraph queries and remains bounded", () => {
    expect(verificationTimeoutMs(configuration(2_000))).toBe(16_000);
    expect(verificationTimeoutMs(configuration(10_000))).toBe(60_000);
  });
});
