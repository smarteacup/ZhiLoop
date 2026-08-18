import { describe, expect, it } from "vitest";

import type { KnowledgeAssertion, ProjectContext } from "@zhiloop/domain";

import { createCodeIntelligenceSymbolProbe } from "./symbol-probe.js";
import type { CodeIntelligenceCapabilityStatus, CodeIntelligencePort } from "./types.js";

const project: ProjectContext = { projectId: "project-1", repositoryRoot: "/workspace/repo", portable: false };
const assertion = {
  assertionId: "assertion-1",
  candidateId: "candidate-1",
  kind: "SYMBOL_EXISTS",
  parameters: { projectId: "project-1", symbol: "Runtime", path: "src/runtime.ts" },
  createdAt: "2026-08-18T00:00:00.000Z",
} as KnowledgeAssertion;
const context = { project, correlationId: "correlation-1", requestedAt: "2026-08-18T00:01:00.000Z" };

function port(status: CodeIntelligenceCapabilityStatus, facts: Awaited<ReturnType<CodeIntelligencePort["findSymbols"]>>["facts"] = []): CodeIntelligencePort {
  const capability = { provider: "CODEGRAPH" as const, status, reasonCode: `CODEGRAPH_${status}` };
  return {
    capabilities: async () => capability,
    findSymbols: async () => ({ capability, facts }),
    callers: async () => ({ capability, facts: [] }),
    impact: async () => ({ capability, facts: [] }),
  };
}

describe("Code intelligence symbol probe", () => {
  it("maps an exact normalized fact to supported Evidence without vendor IDs", async () => {
    const probe = createCodeIntelligenceSymbolProbe(port("READY", [{
      symbol: "Runtime",
      qualifiedName: "Runtime",
      kind: "class",
      path: "src/runtime.ts",
      startLine: 10,
      endLine: 40,
      language: "typescript",
      exported: true,
    }]), { fingerprintFor: () => "git-head-1" });
    const result = await probe.observe(assertion as never, context);
    expect(result).toMatchObject({
      status: "SUPPORTED",
      sourceRef: "codegraph:git-head-1:src/runtime.ts:10",
      reasonCode: "CODEGRAPH_SYMBOL_FOUND",
      details: { path: "src/runtime.ts", startLine: 10 },
    });
    expect(JSON.stringify(result)).not.toContain("node");
  });

  it("distinguishes healthy absence from unavailable capability", async () => {
    const absent = createCodeIntelligenceSymbolProbe(port("READY"), { fingerprintFor: () => "fingerprint" });
    expect(await absent.observe(assertion as never, context)).toMatchObject({ status: "REFUTED", reasonCode: "CODEGRAPH_SYMBOL_NOT_FOUND" });
    for (const status of ["NOT_CONFIGURED", "INCOMPATIBLE", "UNAVAILABLE"] as const) {
      const probe = createCodeIntelligenceSymbolProbe(port(status), { fingerprintFor: () => "fingerprint" });
      expect(await probe.observe(assertion as never, context)).toMatchObject({ status: "UNKNOWN", reasonCode: expect.stringContaining("CODEGRAPH") });
    }
  });

  it("stays unknown when repository identity is unavailable", async () => {
    const probe = createCodeIntelligenceSymbolProbe(port("READY"), { fingerprintFor: () => undefined });
    expect(await probe.observe(assertion as never, context)).toMatchObject({
      status: "UNKNOWN", reasonCode: "CODE_INTELLIGENCE_PROJECT_UNAVAILABLE",
    });
  });
});
