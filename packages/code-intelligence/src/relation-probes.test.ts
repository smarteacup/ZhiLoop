import { describe, expect, it } from "vitest";

import type { KnowledgeAssertion, ProjectContext } from "@zhiloop/domain";

import { createCodeIntelligenceCallPathProbe, createCodeIntelligenceImpactProbe } from "./relation-probes.js";
import type { CodeIntelligenceCapability, CodeIntelligencePort } from "./types.js";

const project: ProjectContext = { projectId: "project-1", repositoryRoot: "/workspace/repo", portable: false };
const context = { project, correlationId: "correlation-1", requestedAt: "2026-08-19T00:00:00.000Z" };
const capability: CodeIntelligenceCapability = { provider: "CODEGRAPH", status: "READY", reasonCode: "CODEGRAPH_READY",
  providerVersion: "0.9.4", indexRevision: `cg_${"a".repeat(64)}` };
const callPath = { assertionId: "call", candidateId: "candidate", kind: "CALL_PATH_EXISTS",
  parameters: { projectId: "project-1", from: "Start", to: "Target", maxDepth: 4 }, createdAt: context.requestedAt } as KnowledgeAssertion;
const impact = { assertionId: "impact", candidateId: "candidate", kind: "IMPACT_CONTAINS",
  parameters: { projectId: "project-1", symbol: "Start", impactedSymbol: "Consumer" }, createdAt: context.requestedAt } as KnowledgeAssertion;

function port(overrides: Partial<CodeIntelligencePort> = {}): CodeIntelligencePort {
  return {
    capabilities: async () => capability,
    findSymbols: async () => ({ capability, facts: [] }),
    callers: async () => ({ capability, facts: [] }),
    impact: async () => ({ capability, facts: [] }),
    trace: async () => ({ capability, facts: [] }),
    ...overrides,
  };
}

describe("Code intelligence relationship probes", () => {
  it("distinguishes supported, refuted, and bounded call paths", async () => {
    const supported = createCodeIntelligenceCallPathProbe(port({ trace: async () => ({ capability,
      facts: [{ from: "Start", to: "Target", symbols: ["Start", "Middle", "Target"], paths: ["src/middle.ts", "src/target.ts"] }] }) }),
    { fingerprintFor: () => "git-head" });
    expect(await supported.observe(callPath as never, context)).toMatchObject({ status: "SUPPORTED", reasonCode: "CODEGRAPH_CALL_PATH_FOUND", details: { hops: 2 } });
    const refuted = createCodeIntelligenceCallPathProbe(port(), { fingerprintFor: () => "git-head" });
    expect(await refuted.observe(callPath as never, context)).toMatchObject({ status: "REFUTED", reasonCode: "CODEGRAPH_CALL_PATH_NOT_FOUND" });
    const unavailable = { ...capability, status: "UNAVAILABLE" as const, reasonCode: "CODEGRAPH_TRACE_BOUNDED" };
    const bounded = createCodeIntelligenceCallPathProbe(port({ trace: async () => ({ capability: unavailable, facts: [], bounded: true }) }),
      { fingerprintFor: () => "git-head" });
    expect(await bounded.observe(callPath as never, context)).toMatchObject({ status: "UNKNOWN", reasonCode: "CODEGRAPH_CALL_PATH_BOUNDED" });
  });

  it("matches impact targets exactly and excludes provider internals", async () => {
    const probe = createCodeIntelligenceImpactProbe(port({ impact: async () => ({ capability,
      facts: [{ symbol: "Consumer", kind: "class", path: "src/consumer.ts", startLine: 20 }] }) }),
    { fingerprintFor: () => "git-head" });
    const result = await probe.observe(impact as never, context);
    expect(result).toMatchObject({ status: "SUPPORTED", reasonCode: "CODEGRAPH_IMPACT_TARGET_FOUND", details: { path: "src/consumer.ts" } });
    expect(JSON.stringify(result)).not.toContain("nodeId");
  });

  it("returns UNKNOWN without a trustworthy project fingerprint", async () => {
    const probe = createCodeIntelligenceImpactProbe(port(), { fingerprintFor: () => undefined });
    expect(await probe.observe(impact as never, context)).toMatchObject({ status: "UNKNOWN", reasonCode: "CODE_INTELLIGENCE_PROJECT_UNAVAILABLE" });
  });
});
