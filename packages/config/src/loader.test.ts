import { describe, expect, it } from "vitest";

import {
  loadClosurePolicy,
  loadConfiguration,
  loadInjectionPolicy,
  loadRetentionPolicy,
  loadRetrievalPolicy,
  loadScopePolicy,
  loadVerificationPolicy,
} from "./loader.js";
import { DEFAULT_CONFIGURATION } from "./policies.js";

describe("configuration loading", () => {
  it("loads deeply frozen safety defaults when configuration is missing", () => {
    const result = loadConfiguration();
    expect(result).toEqual({ ok: true, value: DEFAULT_CONFIGURATION });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.injection.levels)).toBe(true);
      expect(result.value.scope.allowCrossProjectFallback).toBe(false);
      expect(result.value.injection.levels.L4_EPISODE.automatic).toBe(false);
    }
  });

  it("deep-merges a partial YAML document without changing unrelated defaults", () => {
    const result = loadConfiguration(`
version: 1
retrieval:
  topK:
    exact: 10
injection:
  defaultMaxTokens: 600
`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.retrieval.topK).toEqual({ exact: 10, fts: 30, vector: 30, relation: 20 });
      expect(result.value.injection.defaultMaxTokens).toBe(600);
      expect(result.value.closure).toEqual(DEFAULT_CONFIGURATION.closure);
    }
  });

  it("returns a specific diagnostic for an unsupported version", () => {
    const result = loadConfiguration({ version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_CONFIG_VERSION");
  });

  it("rejects malformed and aliased YAML", () => {
    const duplicate = loadConfiguration("version: 1\nversion: 1");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("CONFIG_PARSE_FAILED");

    const aliased = loadConfiguration("version: 1\nx: &shared {a: 1}\ny: *shared");
    expect(aliased.ok).toBe(false);
  });

  it("rejects unknown keys instead of silently ignoring them", () => {
    const result = loadConfiguration({ futureUnsafeFlag: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_VALIDATION_FAILED");
      expect(result.error.issues.some((issue) => issue.path === "$.futureUnsafeFlag")).toBe(true);
    }
  });

  it.each([
    ["verification", loadVerificationPolicy, { globalPromotion: { minVerifiedProjects: 1 } }],
    ["interaction question rate", loadVerificationPolicy, { interaction: { questionWindowTurns: 1 } }],
    ["interaction review queue", loadVerificationPolicy, { interaction: { createReviewTasks: true } }],
    ["interaction unanswered expansion", loadVerificationPolicy, { interaction: { unansweredBehavior: "ASK_USER" } }],
    [
      "implementation status escalation",
      loadVerificationPolicy,
      { autoPublish: { IMPLEMENTATION: { maxStatus: "VERIFIED" } } },
    ],
    [
      "implementation evidence weakening",
      loadVerificationPolicy,
      { autoPublish: { IMPLEMENTATION: { requiredAssertions: ["TEST_PASSED"] } } },
    ],
    [
      "experience evidence weakening",
      loadVerificationPolicy,
      { autoPublish: { EXPERIENCE: { requiredAssertions: ["SYMBOL_EXISTS"] } } },
    ],
    ["retrieval", loadRetrievalPolicy, { output: { maxItems: 10 }, rerank: { candidates: 5 } }],
    ["injection fail-closed", loadInjectionPolicy, { failOpenOnTimeout: false }],
    ["automatic L4", loadInjectionPolicy, { levels: { L4_EPISODE: { automatic: true } } }],
    ["default L4", loadInjectionPolicy, { defaultLevel: "L4_EPISODE" }],
    ["closure loops", loadClosurePolicy, { highRiskMaxContinuations: 3 }],
    ["closure fail-closed", loadClosurePolicy, { failOpenOnTimeout: false }],
    ["global default scope", loadScopePolicy, { defaultLevel: "GLOBAL" }],
    ["cross-project fallback", loadScopePolicy, { allowCrossProjectFallback: true }],
    ["raw retention expansion", loadRetentionPolicy, { rawEventDays: 31 }],
    ["transcript body retention", loadRetentionPolicy, { storeTranscriptBody: true }],
  ] as const)("rejects safety invariant: %s", (_name, loader, input) => {
    expect(loader(input).ok).toBe(false);
  });

  it.each([
    ["retrieval output range", loadRetrievalPolicy, { output: { minItems: 9, maxItems: 8 } }],
    [
      "injection item ordering",
      loadInjectionPolicy,
      { levels: { L1_POINTER: { maxItems: 6 }, L2_COMPACT: { maxItems: 5 } } },
    ],
    [
      "L1 evidence detail",
      loadInjectionPolicy,
      { levels: { L1_POINTER: { evidence: "POINTER" } } },
    ],
    [
      "L2 evidence detail",
      loadInjectionPolicy,
      { levels: { L2_COMPACT: { evidence: "SUMMARY" } } },
    ],
    [
      "L3 evidence detail",
      loadInjectionPolicy,
      { levels: { L3_EVIDENCED: { evidence: "POINTER" } } },
    ],
    [
      "authority completeness",
      loadInjectionPolicy,
      { authorityOrder: ["BINDING_RULE", "BINDING_RULE", "VERIFIED_FACT", "REFERENCE"] },
    ],
    [
      "unique expansion tools",
      loadInjectionPolicy,
      { expansion: { tools: ["ckl.search", "ckl.search"] } },
    ],
    [
      "closure continuation ordering",
      loadClosurePolicy,
      { defaultMaxContinuations: 1, highRiskMaxContinuations: 0 },
    ],
    [
      "closure deadline ordering",
      loadClosurePolicy,
      { deterministicDeadlineMs: 500, semanticVerificationDeadlineMs: 100 },
    ],
    ["unique closure decisions", loadClosurePolicy, { decisions: ["PASS", "ASK_USER", "PASS"] }],
    ["mandatory PASS decision", loadClosurePolicy, { decisions: ["ASK_USER", "RETRY_WITH_CONTEXT"] }],
    ["mandatory ASK_USER decision", loadClosurePolicy, { decisions: ["PASS", "RETRY_WITH_CONTEXT"] }],
  ] as const)("rejects cross-field invariant: %s", (_name, loader, input) => {
    expect(loader(input).ok).toBe(false);
  });

  it("loads all six policy sections independently", () => {
    expect(loadVerificationPolicy().ok).toBe(true);
    expect(loadRetrievalPolicy().ok).toBe(true);
    expect(loadInjectionPolicy().ok).toBe(true);
    expect(loadClosurePolicy().ok).toBe(true);
    expect(loadScopePolicy().ok).toBe(true);
    expect(loadRetentionPolicy().ok).toBe(true);
  });

  it("rejects cyclic objects and prototype-style keys safely", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(loadConfiguration(cyclic).ok).toBe(false);

    const suspicious = Object.fromEntries([["__proto__", { polluted: true }]]);
    expect(loadConfiguration(suspicious).ok).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
