import { describe, expect, it, vi } from "vitest";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import type { EvolutionSemanticRequest } from "@zhiloop/knowledge-evolution";
import type { CodexExecJsonGenerationPort } from "@zhiloop/model-codex-exec";

import { CodexSemanticEvolutionJudge, semanticEvolutionInput } from "./judge.js";

const at = "2026-08-19T00:00:00.000Z";
const candidate: KnowledgeCandidate = {
  schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "compiler-v1", status: "PROPOSED",
  subjectKey: "design.semantic.evolution", kind: "DESIGN", scopeHint: { projectId: "project-1", reasonCodes: [] },
  title: "Semantic evolution", summary: "Resolve an ambiguous relation.", body: "SECRET CANDIDATE BODY",
  sourceEpisodes: ["episode-1"], confidence: 0.8,
  assertions: [{ assertionId: "assertion-1", candidateId: "candidate-1", kind: "SYMBOL_EXISTS",
    parameters: { projectId: "project-1", symbol: "EvolutionEngine" }, createdAt: at }],
  evidenceHints: [], createdAt: at, correlationId: "correlation-1",
};
const target: KnowledgeAsset = {
  schemaVersion: 1, id: "asset-1", subjectKey: candidate.subjectKey, kind: "DESIGN",
  scope: { level: "PROJECT", projectId: "project-1" }, version: 2, status: "VERIFIED",
  title: "Existing evolution", summary: "Existing relation summary.", body: "SECRET TARGET BODY",
  aliases: [], keywords: [], applicability: [], nonApplicability: [], symbols: ["EvolutionEngine"], relations: [],
  evidence: [{ evidenceId: "evidence-1", verdict: "SUPPORTS" }], confidence: 0.9, sourceEpisodes: ["episode-old"],
  contentHash: "hash-1", correlationId: "correlation-old", createdAt: at, updatedAt: at,
};
const request: EvolutionSemanticRequest = {
  candidate, proposedScope: target.scope, targets: [target], deterministicReasons: ["CONTENT_RELATION_UNRESOLVED"],
};

describe("CodexSemanticEvolutionJudge", () => {
  it("projects summaries without bodies and performs one bounded structured call", async () => {
    const generateStructured = vi.fn<CodexExecJsonGenerationPort["generateStructured"]>().mockResolvedValue({
      action: "SUPERSEDE", targetKnowledgeVersions: [{ id: "asset-1", version: 2 }], confidence: 0.8,
      reason: "The candidate replaces the existing decision.",
    });
    const judge = new CodexSemanticEvolutionJudge({ generateStructured });
    await expect(judge.arbitrate(request)).resolves.toMatchObject({ action: "SUPERSEDE" });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(generateStructured.mock.calls[0]?.[0]);
    expect(serialized).toContain("Resolve an ambiguous relation");
    expect(serialized).not.toMatch(/SECRET|episode-old/);
    expect(judge.capability()).toEqual({ status: "READY", reasonCode: "SEMANTIC_EVOLUTION_READY" });
    const projected = semanticEvolutionInput({ ...request, candidate: { ...candidate,
      evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-source", correlationId: "correlation-1" }] } });
    expect(JSON.stringify(projected)).toContain("event-source");
  });

  it("rejects malformed output and reports degraded health without retaining it", async () => {
    const judge = new CodexSemanticEvolutionJudge({ generateStructured: async () => ({ action: "STORE" }) });
    await expect(judge.arbitrate(request)).rejects.toThrow("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
    expect(judge.capability()).toEqual({ status: "DEGRADED", reasonCode: "SEMANTIC_EVOLUTION_INVALID_OUTPUT" });
  });

  it("reports model failure as unavailable and enforces target bounds", async () => {
    const judge = new CodexSemanticEvolutionJudge({ generateStructured: async () => { throw new Error("secret process output"); } });
    await expect(judge.arbitrate(request)).rejects.toThrow("secret process output");
    expect(judge.capability()).toEqual({ status: "DEGRADED", reasonCode: "SEMANTIC_EVOLUTION_UNAVAILABLE" });
    expect(() => semanticEvolutionInput({ ...request, targets: [] })).toThrow("SEMANTIC_EVOLUTION_TARGET_LIMIT");
    expect(JSON.stringify(judge.capability())).not.toContain("secret");
  });

  it("rejects duplicate target versions in model output", async () => {
    const judge = new CodexSemanticEvolutionJudge({ generateStructured: async () => ({
      action: "SKIP", targetKnowledgeVersions: [{ id: "asset-1", version: 2 }, { id: "asset-1", version: 2 }],
      confidence: 1, reason: "Equivalent.",
    }) });
    await expect(judge.arbitrate(request)).rejects.toThrow("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
  });

  it("strictly rejects extra fields, invalid target shapes, and adapter INVALID_OUTPUT classifications", async () => {
    for (const output of [
      null,
      { action: "SKIP", targetKnowledgeVersions: [{ id: "asset-1", version: 2 }], confidence: 1, reason: "same", extra: true },
      { action: "SKIP", targetKnowledgeVersions: [{ id: "", version: 2 }], confidence: 1, reason: "same" },
      { action: "SKIP", targetKnowledgeVersions: [{ id: "asset-1", version: 0 }], confidence: 1, reason: "same" },
      { action: "SKIP", targetKnowledgeVersions: [], confidence: 1, reason: "same" },
      { action: "SKIP", targetKnowledgeVersions: [{ id: "asset-1", version: 2 }], confidence: -1, reason: "same" },
    ]) {
      const judge = new CodexSemanticEvolutionJudge({ generateStructured: async () => output });
      await expect(judge.arbitrate(request)).rejects.toThrow("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
    }
    const judge = new CodexSemanticEvolutionJudge({ generateStructured: async () => {
      throw Object.assign(new Error("sanitized adapter error"), { code: "INVALID_OUTPUT" });
    } });
    await expect(judge.arbitrate(request)).rejects.toThrow("sanitized adapter error");
    expect(judge.capability().reasonCode).toBe("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
  });
});
