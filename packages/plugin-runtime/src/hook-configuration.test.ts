import { describe, expect, it } from "vitest";

import {
  mergeHookConfigurations,
  parseHookConfiguration,
  parseHookConfigurationText,
  unmergeHookConfiguration,
  ZHILOOP_HOOK_CONFIGURATION,
} from "./hook-configuration.js";

const userGroup = {
  matcher: "Bash",
  hooks: [{ type: "command" as const, command: "ccm capture", timeout: 8 }],
};

describe("ZhiLoop Hook configuration", () => {
  it("appends managed hooks without mutating or replacing user and CCM hooks", () => {
    const existing = {
      description: "user hooks",
      custom: { owner: "ccm" },
      hooks: { PostToolUse: [userGroup], PreToolUse: [userGroup] },
    };
    const snapshot = structuredClone(existing);
    const result = mergeHookConfigurations(existing);
    expect(existing).toEqual(snapshot);
    expect(result.inserted).toHaveLength(4);
    expect(result.preexisting).toHaveLength(0);
    expect(result.configuration).toMatchObject({ description: "user hooks", custom: { owner: "ccm" } });
    expect(result.configuration.hooks["PostToolUse"]?.[0]).toEqual(userGroup);
    expect(result.configuration.hooks["PostToolUse"]).toHaveLength(2);
    expect(result.configuration.hooks["PreToolUse"]).toEqual([userGroup]);
  });

  it("is idempotent and does not claim preexisting ZhiLoop hooks for uninstall", () => {
    const first = mergeHookConfigurations({ hooks: {} });
    const second = mergeHookConfigurations(first.configuration);
    expect(second.inserted).toHaveLength(0);
    expect(second.preexisting).toHaveLength(4);
    expect(second.configuration).toEqual(first.configuration);
    expect(unmergeHookConfiguration(second.configuration, second.inserted).configuration).toEqual(first.configuration);
  });

  it("removes only receipt-owned groups and preserves changes added after installation", () => {
    const merged = mergeHookConfigurations({ hooks: { PreToolUse: [userGroup] } });
    const changed = structuredClone(merged.configuration);
    (changed.hooks as Record<string, unknown[]>)["Notification"] = [userGroup];
    const result = unmergeHookConfiguration(changed, merged.inserted);
    expect(result.conflicts).toHaveLength(0);
    expect(result.removed).toHaveLength(4);
    expect(result.configuration.hooks).toEqual({ PreToolUse: [userGroup], Notification: [userGroup] });
  });

  it("fails closed when an owned ZhiLoop group was modified", () => {
    const merged = mergeHookConfigurations({ hooks: {} });
    const changed = structuredClone(merged.configuration);
    const prompt = (changed.hooks as unknown as Record<string, Array<{ hooks: Array<{ timeout?: number }> }>>)["UserPromptSubmit"];
    if (prompt === undefined) throw new Error("fixture missing prompt hook");
    prompt[0]!.hooks[0]!.timeout = 9;
    const result = unmergeHookConfiguration(changed, merged.inserted);
    expect(result.conflicts).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
    expect(result.configuration).toEqual(changed);
    expect(result.configuration.hooks["UserPromptSubmit"]?.[0]?.hooks[0]?.timeout).toBe(9);
  });

  it("rejects a different installed ZhiLoop command instead of creating duplicates", () => {
    const conflict = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: '"$PLUGIN_ROOT/scripts/zhiloop-sidecar" hook', timeout: 30 }] }],
      },
    };
    expect(() => mergeHookConfigurations(conflict)).toThrow("different ZhiLoop hook");
  });

  it("validates malformed, oversized, and non-command configurations", () => {
    expect(() => parseHookConfiguration(null)).toThrow("JSON object");
    expect(() => parseHookConfiguration({ hooks: [] })).toThrow("hooks must be an object");
    expect(() => parseHookConfiguration({ hooks: { Stop: {} } })).toThrow("must be an array");
    expect(() => parseHookConfiguration({ hooks: { Stop: [{}] } })).toThrow("must contain hooks");
    expect(parseHookConfiguration({ hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "check" }] }] } })).toMatchObject({ hooks: { Stop: { length: 1 } } });
    expect(() => parseHookConfiguration({ hooks: { Stop: [{ hooks: [{ type: "command" }] }] } })).toThrow("command hook");
    expect(parseHookConfiguration({ description: "no hooks yet" })).toEqual({ description: "no hooks yet", hooks: {} });
    expect(() => mergeHookConfigurations({ hooks: {} }, { hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "x" }] }] } })).toThrow("only command hooks");
    expect(() => parseHookConfigurationText("{" )).toThrow("not valid JSON");
    expect(() => parseHookConfigurationText(`{"padding":"${"x".repeat(1_048_576)}"}`)).toThrow("exceeds 1 MiB");
    expect(() => parseHookConfiguration({ hooks: {}, invalid: Number.NaN })).toThrow("finite JSON number");
    expect(() => parseHookConfiguration({ hooks: {}, invalid: undefined })).toThrow("only JSON values");
    expect(() => parseHookConfiguration({ hooks: {}, invalid: new Date() })).toThrow("plain JSON objects");
    const cyclic: Record<string, unknown> = { hooks: {} };
    cyclic["self"] = cyclic;
    expect(() => parseHookConfiguration(cyclic)).toThrow("must not contain a cycle");
    expect(ZHILOOP_HOOK_CONFIGURATION.hooks["SessionEnd"]?.[0]?.hooks[0]?.timeout).toBe(3);
  });
});
