import { describe, expect, it, vi } from "vitest";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";

import { classifyKnowledgeEvolution, decideKnowledgeEvolution } from "./evolution.js";
import type { EvolutionMatchInput, KnowledgeEvolutionSemanticPort } from "./types.js";

const at = "2026-08-18T01:00:00.000Z";
const project = { level: "PROJECT", projectId: "project-1" } as const;

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  const base = {
    schemaVersion: 1,
    candidateId: "candidate-1",
    compilerVersion: "compiler-v1",
    status: "PROPOSED",
    subjectKey: "design.worker.evolution",
    kind: "DESIGN",
    scopeHint: { projectId: "project-1", reasonCodes: [] },
    title: "Worker evolution",
    summary: "Evolution is decided before publication.",
    body: "The worker classifies a candidate before evidence policy.",
    sourceEpisodes: ["episode-1"],
    confidence: 0.9,
    assertions: [],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-1", correlationId: "correlation-1" }],
    createdAt: at,
    correlationId: "correlation-1",
  } as const;
  return { ...base, ...overrides } as KnowledgeCandidate;
}

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    schemaVersion: 1,
    id,
    subjectKey: "design.worker.evolution",
    kind: "DESIGN",
    scope: project,
    version: 2,
    status: "ACCEPTED",
    title: "Worker evolution",
    summary: "Evolution is decided before publication.",
    body: "The worker classifies a candidate before evidence policy.",
    aliases: [],
    keywords: ["evolution"],
    applicability: [],
    nonApplicability: [],
    symbols: [],
    relations: [],
    evidence: [],
    confidence: 0.9,
    sourceEpisodes: ["episode-old"],
    contentHash: `hash-${id}`,
    correlationId: `correlation-${id}`,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function input(overrides: Partial<EvolutionMatchInput> = {}): EvolutionMatchInput {
  return { candidate: candidate(), proposedScope: project, retrievedTargets: [], ...overrides };
}

describe("knowledge evolution", () => {
  it("stores a new topic and freezes the decision", () => {
    const result = classifyKnowledgeEvolution(input());
    expect(result).toMatchObject({ status: "DECIDED", action: "STORE", targetKnowledgeVersions: [] });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("skips normalized duplicate content by exact identity", () => {
    const exact = asset("asset-1", { title: " Worker evolution! " });
    expect(classifyKnowledgeEvolution(input({ exactTarget: exact }))).toMatchObject({
      status: "DECIDED", action: "SKIP", targetKnowledgeVersions: [{ id: "asset-1", version: 2 }],
    });
  });

  it("supplements content that strictly contains the exact current body", () => {
    const current = asset("asset-1", { body: "The worker classifies a candidate." });
    expect(classifyKnowledgeEvolution(input({ exactTarget: current }))).toMatchObject({
      status: "DECIDED", action: "SUPPLEMENT", requiresConfirmation: false,
    });
    expect(classifyKnowledgeEvolution(input({
      exactTarget: asset("asset-verified", { status: "VERIFIED", body: "The worker classifies a candidate." }),
    }))).toMatchObject({ action: "SUPPLEMENT", requiresConfirmation: true });
  });

  it("turns a trusted correction into a blocking contradiction", () => {
    const current = asset("asset-1", { body: "Old behavior." });
    expect(classifyKnowledgeEvolution(input({
      exactTarget: current,
      correctionRefs: [{ candidateId: "candidate-1", relationHint: "CONTRADICTS", originalRef: "event-old", correctedRef: "event-new" }],
    }))).toMatchObject({ status: "DECIDED", action: "CONTRADICT", requiresConfirmation: true });
  });

  it("classifies a trusted rejection of an existing target as a contradiction", () => {
    const rejectedCandidate = candidate({
      assertions: [{
        assertionId: "assertion-rejected",
        candidateId: "candidate-1",
        kind: "USER_REJECTED",
        parameters: { statementRef: "event-rejected" },
        createdAt: at,
      }],
      evidenceHints: [],
      body: "Do not use the current decision algorithm.",
    } as Partial<KnowledgeCandidate>);
    const result = classifyKnowledgeEvolution(input({
      candidate: rejectedCandidate,
      exactTarget: asset("asset-1", { body: "Use the current decision algorithm." }),
    }));
    expect(result).toMatchObject({ status: "DECIDED", action: "CONTRADICT" });
    expect(result.deterministicReasons).toContain("USER_REJECTED_TARGET");
  });

  it("supersedes accepted replacement but gates an authoritative target", () => {
    const acceptedCandidate = candidate({
      assertions: [{
        assertionId: "assertion-accepted",
        candidateId: "candidate-1",
        kind: "USER_ACCEPTED",
        parameters: { statementRef: "event-accepted" },
        createdAt: at,
      }],
      evidenceHints: [],
      body: "Use a replacement decision algorithm.",
    } as Partial<KnowledgeCandidate>);
    const result = classifyKnowledgeEvolution(input({
      candidate: acceptedCandidate,
      exactTarget: asset("asset-1", { status: "VERIFIED", body: "Use the old decision algorithm." }),
    }));
    expect(result).toMatchObject({ status: "DECIDED", action: "SUPERSEDE", requiresConfirmation: true });
    expect(result.deterministicReasons).toContain("AUTHORITATIVE_TARGET");
  });

  it("creates a scope split for related content in another scope", () => {
    const global = asset("asset-global", { scope: { level: "GLOBAL" }, body: "Global wording." });
    expect(classifyKnowledgeEvolution(input({ retrievedTargets: [global] }))).toMatchObject({
      status: "DECIDED", action: "SCOPE_SPLIT", targetKnowledgeVersions: [{ id: "asset-global", version: 2 }],
    });
    expect(classifyKnowledgeEvolution(input({
      proposedScope: { level: "GLOBAL" },
      retrievedTargets: [asset("asset-project")],
    }))).toMatchObject({ status: "PENDING", deterministicReasons: ["SCOPE_WIDENING_REQUIRES_CONFIRMATION"] });
    expect(classifyKnowledgeEvolution(input({
      proposedScope: { level: "SYMBOL", projectId: "project-1", symbols: ["Worker"] },
      retrievedTargets: [asset("asset-project")],
    }))).toMatchObject({ action: "SCOPE_SPLIT" });
    expect(classifyKnowledgeEvolution(input({
      proposedScope: { level: "USER", userId: "user-1" },
      retrievedTargets: [asset("asset-team", { scope: { level: "TEAM", teamId: "team-1" } })],
    }))).toMatchObject({ action: "SCOPE_SPLIT" });
  });

  it("uses alias and symbol overlap but still requires a deterministic content relation", () => {
    const aliasTarget = asset("asset-alias", {
      subjectKey: "design.worker.other",
      title: "Other",
      aliases: ["Worker evolution"],
      body: "Different content.",
    });
    expect(classifyKnowledgeEvolution(input({ retrievedTargets: [aliasTarget] }))).toMatchObject({ status: "PENDING" });

    const symbolCandidate = candidate({
      subjectKey: "design.worker.symbol",
      title: "Symbol policy",
      assertions: [{
        assertionId: "assertion-symbol",
        candidateId: "candidate-1",
        kind: "SYMBOL_EXISTS",
        parameters: { projectId: "project-1", symbol: "KnowledgeWorkerRuntime" },
        createdAt: at,
      }],
      evidenceHints: [],
    } as Partial<KnowledgeCandidate>);
    const symbolTarget = asset("asset-symbol", {
      subjectKey: "design.worker.unrelated",
      title: "Other symbol policy",
      symbols: ["KnowledgeWorkerRuntime"],
      body: "Different content.",
    });
    expect(classifyKnowledgeEvolution(input({ candidate: symbolCandidate, retrievedTargets: [symbolTarget] })))
      .toMatchObject({ status: "PENDING" });
  });

  it("classifies retrieved same-scope duplicates and corrections without exact identity", () => {
    const duplicate = asset("asset-duplicate", { subjectKey: "design.worker.other", aliases: ["Worker evolution"] });
    expect(classifyKnowledgeEvolution(input({ retrievedTargets: [duplicate] }))).toMatchObject({ action: "SKIP" });
    const different = asset("asset-correction", {
      subjectKey: "design.worker.other",
      aliases: ["Worker evolution"],
      body: "Different content.",
    });
    expect(classifyKnowledgeEvolution(input({
      retrievedTargets: [different],
      correctionRefs: [{ candidateId: "candidate-1", relationHint: "CONTRADICTS", originalRef: "old", correctedRef: "new" }],
    }))).toMatchObject({ action: "CONTRADICT" });
  });

  it("keeps an unresolved same-scope relation pending", () => {
    const related = asset("asset-related", { body: "A materially different statement." });
    expect(classifyKnowledgeEvolution(input({ retrievedTargets: [related] }))).toMatchObject({
      status: "PENDING", requiresConfirmation: true,
    });
  });

  it("uses a semantic arbiter once and confines it to supplied targets", async () => {
    const related = asset("asset-related", { body: "A materially different statement." });
    const arbitrate = vi.fn<KnowledgeEvolutionSemanticPort["arbitrate"]>().mockResolvedValue({
      action: "CONTRADICT",
      targetKnowledgeVersions: [{ id: related.id, version: related.version }],
      confidence: 0.8,
      reason: "The statements are mutually exclusive.",
    });
    const result = await decideKnowledgeEvolution(input({ retrievedTargets: [related] }), { arbitrate });
    expect(arbitrate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "DECIDED", action: "CONTRADICT", semanticReason: expect.any(String) });
  });

  it("fails semantic errors and invented targets closed as pending", async () => {
    const related = asset("asset-related", { body: "A materially different statement." });
    const failure = await decideKnowledgeEvolution(input({ retrievedTargets: [related] }), {
      arbitrate: async () => { throw new Error("secret adapter failure"); },
    });
    expect(failure).toMatchObject({ status: "PENDING" });
    expect(failure.deterministicReasons).toContain("SEMANTIC_ARBITRATION_FAILED");
    expect(failure).not.toHaveProperty("semanticReason");

    const invented = await decideKnowledgeEvolution(input({ retrievedTargets: [related] }), {
      arbitrate: async () => ({
        action: "SKIP",
        targetKnowledgeVersions: [{ id: "invented", version: 1 }],
        confidence: 1,
        reason: "invented",
      }),
    });
    expect(invented.deterministicReasons).toContain("SEMANTIC_JUDGMENT_INVALID");

    for (const judgment of [
      { action: "STORE", targetKnowledgeVersions: [{ id: related.id, version: related.version }], confidence: 1, reason: "store" },
      { action: "SKIP", targetKnowledgeVersions: [{ id: related.id, version: related.version }], confidence: 2, reason: "confidence" },
      { action: "SKIP", targetKnowledgeVersions: [{ id: related.id, version: related.version }], confidence: 1, reason: "bad\nreason" },
      { action: "SKIP", targetKnowledgeVersions: [{ id: related.id, version: related.version },
        { id: related.id, version: related.version }], confidence: 1, reason: "duplicate" },
    ]) {
      const invalid = await decideKnowledgeEvolution(input({ retrievedTargets: [related] }), {
        arbitrate: async () => judgment as never,
      });
      expect(invalid.deterministicReasons).toContain("SEMANTIC_JUDGMENT_INVALID");
    }
  });

  it("rejects unbounded, colliding, and mismatched target inputs", () => {
    expect(() => classifyKnowledgeEvolution(input({
      retrievedTargets: Array.from({ length: 6 }, (_, index) => asset(`asset-${index}`)),
    }))).toThrow("EVOLUTION_TARGET_LIMIT_EXCEEDED");
    expect(() => classifyKnowledgeEvolution(input({
      retrievedTargets: [asset("same"), asset("same", { version: 3 })],
    }))).toThrow("EVOLUTION_TARGET_COLLISION");
    expect(() => classifyKnowledgeEvolution(input({
      exactTarget: asset("wrong", { scope: { level: "GLOBAL" } }),
    }))).toThrow("EVOLUTION_EXACT_TARGET_MISMATCH");
    expect(() => classifyKnowledgeEvolution(input({ candidate: candidate({ candidateId: "" }) })))
      .toThrow("EVOLUTION_CANDIDATE_INVALID");
    expect(() => classifyKnowledgeEvolution(input({ retrievedTargets: [asset("", { version: 0 })] })))
      .toThrow("EVOLUTION_TARGET_INVALID");
    expect(() => classifyKnowledgeEvolution(input({
      correctionRefs: [{ candidateId: "other", relationHint: "CONTRADICTS", originalRef: "", correctedRef: "new" }],
    }))).toThrow("EVOLUTION_CORRECTION_INVALID");
  });

  it("does not let unrelated FTS hits prevent STORE", () => {
    const unrelated = asset("asset-unrelated", {
      subjectKey: "runtime.logging.format",
      kind: "FACT",
      title: "Logging",
      aliases: [],
      symbols: [],
    });
    expect(classifyKnowledgeEvolution(input({ retrievedTargets: [unrelated] }))).toMatchObject({
      status: "DECIDED", action: "STORE",
    });
  });
});
