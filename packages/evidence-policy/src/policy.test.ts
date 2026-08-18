import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { AssertionKind, EvidenceType, KnowledgeAssertion, KnowledgeCandidate } from "@zhiloop/domain";
import type { VerificationResult, VerificationStatus } from "@zhiloop/evidence-engine";

import { evaluateEvidencePolicy } from "./policy.js";
import type { EvidencePolicyInput } from "./types.js";

const at = "2026-08-01T11:00:00.000Z";
const projectScope = { level: "PROJECT", projectId: "project-1", repositoryRemote: "github.com/smarteacup/zhiloop" } as const;
const evidenceTypes: Partial<Record<AssertionKind, EvidenceType>> = {
  USER_ACCEPTED: "USER_STATEMENT",
  USER_REJECTED: "USER_STATEMENT",
  SYMBOL_EXISTS: "CODE_SYMBOL",
  CALL_PATH_EXISTS: "CODE_RELATION",
  IMPACT_CONTAINS: "CODE_IMPACT",
  FILE_CONTAINS: "FILE_CONTENT",
  DEPENDENCY_PRESENT: "DEPENDENCY",
  CONFIG_EQUALS: "CONFIGURATION",
  COMMAND_SUCCEEDED: "COMMAND_RESULT",
  TEST_PASSED: "TEST_RESULT",
  CROSS_PROJECT_VERIFIED: "CROSS_PROJECT",
};

function assertion(kind: AssertionKind, suffix = kind.toLowerCase()): KnowledgeAssertion {
  const parameters: Record<AssertionKind, unknown> = {
    USER_ACCEPTED: { statementRef: `event-${suffix}` },
    USER_REJECTED: { statementRef: `event-${suffix}` },
    SYMBOL_EXISTS: { projectId: "project-1", symbol: "KnowledgeCompiler" },
    CALL_PATH_EXISTS: { projectId: "project-1", from: "KnowledgeCompiler", to: "VerifierRegistry", maxDepth: 8 },
    IMPACT_CONTAINS: { projectId: "project-1", symbol: "KnowledgeCompiler", impactedSymbol: "VerifierRegistry" },
    FILE_CONTAINS: { path: "src/index.ts", expected: "export", matchMode: "EXACT" },
    DEPENDENCY_PRESENT: { name: "vitest" },
    CONFIG_EQUALS: { key: "enabled", expected: "true" },
    COMMAND_SUCCEEDED: { commandHash: "command-hash", expectedExitCode: 0 },
    TEST_PASSED: { testId: "knowledge-policy" },
    CROSS_PROJECT_VERIFIED: { subjectKey: "design.policy.global", minimumProjects: 2 },
  };
  return {
    assertionId: `assertion-${suffix}`,
    candidateId: "candidate-1",
    kind,
    parameters: parameters[kind],
    createdAt: at,
  } as KnowledgeAssertion;
}

function candidate(kind: KnowledgeCandidate["kind"], assertions: readonly KnowledgeAssertion[] = []): KnowledgeCandidate {
  return {
    schemaVersion: 1,
    candidateId: "candidate-1",
    compilerVersion: "compiler-v1",
    status: "PROPOSED",
    subjectKey: "design.evidence.policy",
    kind,
    scopeHint: { projectId: "project-1", reasonCodes: [] },
    title: "Evidence policy",
    summary: "Apply only evidence-backed transitions.",
    body: "Model output remains proposed without evidence.",
    sourceEpisodes: ["episode-1"],
    confidence: 0.9,
    assertions,
    evidenceHints: assertions.length === 0
      ? [{ type: "USER_STATEMENT", sourceRef: "event-1", correlationId: "correlation-1" }]
      : [],
    createdAt: at,
    correlationId: "correlation-1",
  } as KnowledgeCandidate;
}

function verification(source: KnowledgeAssertion, status: VerificationStatus): VerificationResult {
  const verdict = status === "SUPPORTED" ? "SUPPORTS" : status === "REFUTED" ? "CONTRADICTS" : "INCONCLUSIVE";
  return {
    assertionId: source.assertionId,
    assertionKind: source.kind,
    verifierId: "fixture-verifier-v1",
    status,
    target: `assertion:${source.assertionId}`,
    observedAt: at,
    reasonCodes: [`${status}_BY_FIXTURE`],
    ...(status === "ERROR" ? {} : {
      evidence: {
        evidenceId: `evidence-${source.assertionId}-${status}`,
        assertionId: source.assertionId,
        type: evidenceTypes[source.kind] ?? "CROSS_PROJECT",
        verdict,
        sourceRef: `event-${source.assertionId}`,
        projectId: "project-1",
        observedAt: at,
        correlationId: "correlation-1",
        details: { target: `assertion:${source.assertionId}` },
      },
    }),
  } as VerificationResult;
}

function input(
  source: KnowledgeCandidate,
  verificationResults: readonly VerificationResult[] = [],
  overrides: Partial<EvidencePolicyInput> = {},
): EvidencePolicyInput {
  return {
    candidate: source,
    currentStatus: "PROPOSED",
    resolvedScope: projectScope,
    projectScope,
    projectSpecificSignals: [],
    verificationResults,
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
    ...overrides,
  };
}

function verifiedProject(projectId: string, subjectKey = "design.evidence.policy") {
  return {
    projectId,
    subjectKey,
    evidenceId: `evidence-cross-${projectId}`,
    sourceRef: `event-cross-${projectId}`,
    observedAt: at,
  };
}

describe("evaluateEvidencePolicy", () => {
  it("keeps model-only output PROPOSED and unpublished", () => {
    const result = evaluateEvidencePolicy(input(candidate("DESIGN")));
    expect(result).toMatchObject({
      action: "KEEP",
      interaction: "NONE",
      targetStatus: "PROPOSED",
      shouldPublish: false,
      reasonCodes: ["MODEL_ONLY_REMAINS_PROPOSED"],
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("moves supported user acceptance or rejection through legal transitions", () => {
    const accepted = assertion("USER_ACCEPTED");
    expect(evaluateEvidencePolicy(input(candidate("DECISION", [accepted]), [verification(accepted, "SUPPORTED")]))).toMatchObject({
      action: "APPLY", targetStatus: "ACCEPTED", transitionPath: ["ACCEPTED"], shouldPublish: true,
    });
    const rejected = assertion("USER_REJECTED");
    expect(evaluateEvidencePolicy(input(candidate("DECISION", [rejected]), [verification(rejected, "SUPPORTED")]))).toMatchObject({
      action: "APPLY", targetStatus: "REJECTED", transitionPath: ["REJECTED"], shouldPublish: false,
    });
    expect(evaluateEvidencePolicy(input(
      candidate("DECISION", [accepted]), [verification(accepted, "SUPPORTED")], { currentStatus: "ACCEPTED" },
    ))).toMatchObject({ action: "KEEP", transitionPath: [], shouldPublish: false });
  });

  it("publishes a same-status content revision only with fresh supporting Evidence", () => {
    const accepted = assertion("USER_ACCEPTED");
    const supportedRevision = evaluateEvidencePolicy(input(
      candidate("DECISION", [accepted]),
      [verification(accepted, "SUPPORTED")],
      { currentStatus: "ACCEPTED", contentRevisionRequested: true },
    ));
    expect(supportedRevision).toMatchObject({ action: "APPLY", targetStatus: "ACCEPTED", shouldPublish: true });
    expect(supportedRevision.reasonCodes).toContain("CONTENT_REVISION_EVIDENCE_SUPPORTED");

    const unsupportedRevision = evaluateEvidencePolicy(input(
      candidate("DECISION"),
      [],
      { currentStatus: "ACCEPTED", contentRevisionRequested: true },
    ));
    expect(unsupportedRevision).toMatchObject({ action: "KEEP", targetStatus: "ACCEPTED", shouldPublish: false });
    expect(unsupportedRevision.reasonCodes).toContain("CONTENT_REVISION_EVIDENCE_INCOMPLETE");
  });

  it("asks once when supported user decisions conflict", () => {
    const accepted = assertion("USER_ACCEPTED", "accept");
    const rejected = assertion("USER_REJECTED", "reject");
    const result = evaluateEvidencePolicy(input(
      candidate("DECISION", [accepted, rejected]),
      [verification(accepted, "SUPPORTED"), verification(rejected, "SUPPORTED")],
    ));
    expect(result).toMatchObject({ action: "ASK_USER", interaction: "ASK_USER", targetStatus: "PROPOSED" });
    expect(result.reasonCodes).toContain("CONFLICTING_USER_DECISIONS");
  });

  it("caps IMPLEMENTATION auto-publication at IMPLEMENTED even with a passing test", () => {
    const symbol = assertion("SYMBOL_EXISTS");
    const test = assertion("TEST_PASSED");
    const result = evaluateEvidencePolicy(input(
      candidate("IMPLEMENTATION", [symbol, test]),
      [verification(symbol, "SUPPORTED"), verification(test, "SUPPORTED")],
    ));
    expect(result).toMatchObject({ targetStatus: "IMPLEMENTED", transitionPath: ["IMPLEMENTED"], shouldPublish: true });
    expect(result.reasonCodes).toContain("CODE_EVIDENCE_CAPPED_IMPLEMENTED");
  });

  it("moves EXPERIENCE with related test Evidence to VERIFIED via legal intermediate state", () => {
    const test = assertion("TEST_PASSED");
    const proposed = evaluateEvidencePolicy(input(candidate("EXPERIENCE", [test]), [verification(test, "SUPPORTED")]));
    expect(proposed).toMatchObject({ targetStatus: "VERIFIED", transitionPath: ["IMPLEMENTED", "VERIFIED"] });
    const accepted = evaluateEvidencePolicy(input(
      candidate("EXPERIENCE", [test]),
      [verification(test, "SUPPORTED")],
      { currentStatus: "ACCEPTED" },
    ));
    expect(accepted.transitionPath).toEqual(["IMPLEMENTED", "VERIFIED"]);
  });

  it.each(["UNKNOWN", "ERROR"] as const)("does not treat %s as required Evidence", (status) => {
    const symbol = assertion("SYMBOL_EXISTS");
    const result = evaluateEvidencePolicy(input(candidate("IMPLEMENTATION", [symbol]), [verification(symbol, status)]));
    expect(result).toMatchObject({ action: "KEEP", targetStatus: "PROPOSED", shouldPublish: false });
    expect(result.reasonCodes).toContain("AUTO_PUBLISH_ASSERTIONS_INCOMPLETE");
    if (status === "ERROR") expect(result.reasonCodes).toContain("VERIFIER_ERROR_NOT_EVIDENCE");
  });

  it("keeps a refuted proposal and asks before contradicting published state", () => {
    const symbol = assertion("SYMBOL_EXISTS");
    const result = verification(symbol, "REFUTED");
    expect(evaluateEvidencePolicy(input(candidate("IMPLEMENTATION", [symbol]), [result])).action).toBe("KEEP");
    expect(evaluateEvidencePolicy(input(
      candidate("IMPLEMENTATION", [symbol]), [result], { currentStatus: "ACCEPTED" },
    )).action).toBe("ASK_USER");
  });

  it("automatically retains GLOBAL only with configured cross-project Evidence", () => {
    const accepted = assertion("USER_ACCEPTED");
    const source = candidate("EXPERIENCE", [accepted]);
    const global = { level: "GLOBAL" } as const;
    const allowed = evaluateEvidencePolicy(input(source, [verification(accepted, "SUPPORTED")], {
      resolvedScope: global,
      verifiedProjects: [verifiedProject("project-1"), verifiedProject("project-2")],
    }));
    expect(allowed).toMatchObject({ effectiveScope: global, interaction: "NONE" });
    expect(allowed.reasonCodes).toContain("GLOBAL_CROSS_PROJECT_VERIFIED");

    const strictPolicy = {
      ...DEFAULT_CONFIGURATION.verification,
      globalPromotion: { minVerifiedProjects: 3 },
    };
    const denied = evaluateEvidencePolicy(input(source, [verification(accepted, "SUPPORTED")], {
      resolvedScope: global,
      verifiedProjects: [verifiedProject("project-1"), verifiedProject("project-2")],
      verificationPolicy: strictPolicy,
    }));
    expect(denied).toMatchObject({ effectiveScope: projectScope, interaction: "ASK_USER" });
    expect(denied.reasonCodes).toContain("GLOBAL_INSUFFICIENT_VERIFIED_PROJECTS");
  });

  it("allows explicit GLOBAL approval but blocks implicit project-specific expansion", () => {
    const accepted = assertion("USER_ACCEPTED");
    const source = candidate("RULE", [accepted]);
    const global = { level: "GLOBAL" } as const;
    const explicit = evaluateEvidencePolicy(input(source, [verification(accepted, "SUPPORTED")], {
      resolvedScope: global,
      userExplicitlyApprovedGlobal: true,
      projectSpecificSignals: ["PROJECT_TERM"],
    }));
    expect(explicit.effectiveScope).toEqual(global);
    expect(explicit.reasonCodes).toContain("GLOBAL_USER_EXPLICITLY_APPROVED");
    const implicit = evaluateEvidencePolicy(input(source, [verification(accepted, "SUPPORTED")], {
      resolvedScope: global,
      verifiedProjects: [verifiedProject("project-1"), verifiedProject("project-2")],
      projectSpecificSignals: ["PROJECT_TERM"],
    }));
    expect(implicit).toMatchObject({ effectiveScope: projectScope, interaction: "ASK_USER" });
  });

  it("does not ask about GLOBAL before knowledge is otherwise publishable", () => {
    const result = evaluateEvidencePolicy(input(candidate("DESIGN"), [], { resolvedScope: { level: "GLOBAL" } }));
    expect(result).toMatchObject({
      action: "KEEP",
      interaction: "NONE",
      targetStatus: "PROPOSED",
      effectiveScope: projectScope,
    });
    expect(result.reasonCodes).toContain("GLOBAL_FALLBACK_PROJECT");
  });

  it("retains terminal states and requires fresh Evidence to recover STALE", () => {
    for (const status of ["REJECTED", "SUPERSEDED"] as const) {
      const result = evaluateEvidencePolicy(input(candidate("DESIGN"), [], { currentStatus: status }));
      expect(result).toMatchObject({ action: "KEEP", interaction: "NONE", targetStatus: status, shouldPublish: false });
      expect(result.reasonCodes).toContain("TERMINAL_STATUS_RETAINED");
    }
    const stale = evaluateEvidencePolicy(input(candidate("EXPERIENCE"), [], { currentStatus: "STALE" }));
    expect(stale).toMatchObject({ action: "KEEP", targetStatus: "STALE", shouldPublish: false });
    expect(stale.reasonCodes).toContain("STALE_REQUIRES_REVERIFICATION");
    const test = assertion("TEST_PASSED");
    const recovered = evaluateEvidencePolicy(input(
      candidate("EXPERIENCE", [test]), [verification(test, "SUPPORTED")], { currentStatus: "STALE" },
    ));
    expect(recovered).toMatchObject({ action: "APPLY", targetStatus: "VERIFIED", transitionPath: ["VERIFIED"] });
  });

  it("fails closed on malformed, duplicate, extra, or mismatched verification input", () => {
    const symbol = assertion("SYMBOL_EXISTS");
    const source = candidate("IMPLEMENTATION", [symbol]);
    const valid = verification(symbol, "SUPPORTED");
    const cases: EvidencePolicyInput[] = [
      input(source, [valid, valid]),
      input(source, [{ ...valid, assertionId: "extra" }]),
      input(source, [{ ...valid, assertionKind: "TEST_PASSED" }]),
      input({ ...source, assertions: [{ ...symbol, candidateId: "other" } as KnowledgeAssertion] } as KnowledgeCandidate, [valid]),
      input(source, [{ ...valid, evidence: { ...valid.evidence!, projectId: "other-project" } }]),
      input(source, [valid], {
        verificationPolicy: {
          ...DEFAULT_CONFIGURATION.verification,
          autoPublish: {
            ...DEFAULT_CONFIGURATION.verification.autoPublish,
            IMPLEMENTATION: { requiredAssertions: ["FILE_CONTAINS"], maxStatus: "IMPLEMENTED" },
          },
        },
      }),
      input(source, [valid], { resolvedScope: { level: "PROJECT", projectId: "other-project" } }),
      input(source, [valid], { verifiedProjects: [verifiedProject("project-2", "other.subject.key")] }),
    ];
    for (const item of cases) {
      expect(evaluateEvidencePolicy(item)).toMatchObject({
        action: "KEEP", effectiveScope: projectScope, shouldPublish: false,
        reasonCodes: ["INVALID_EVIDENCE_POLICY_INPUT", "SAFE_PROJECT_FALLBACK"],
      });
    }
    const runtimeMalformed = input(source, [{
      ...valid,
      evidence: { ...valid.evidence!, evidenceId: null },
    } as unknown as VerificationResult]);
    expect(() => evaluateEvidencePolicy(runtimeMalformed)).not.toThrow();
    expect(evaluateEvidencePolicy(runtimeMalformed).reasonCodes).toContain("INVALID_EVIDENCE_POLICY_INPUT");
  });

  it("uses ASK_USER for explicit conflicts, ambiguous adoption, and impossible terminal transitions", () => {
    const plain = candidate("DECISION");
    expect(evaluateEvidencePolicy(input(plain, [], { conflictIds: ["knowledge-2"] })).action).toBe("ASK_USER");
    expect(evaluateEvidencePolicy(input(plain, [], { adoptionAmbiguous: true })).reasonCodes)
      .toContain("ADOPTION_REQUIRES_CONFIRMATION");
    const rejected = assertion("USER_REJECTED");
    const terminal = evaluateEvidencePolicy(input(
      candidate("DECISION", [rejected]), [verification(rejected, "SUPPORTED")], { currentStatus: "VERIFIED" },
    ));
    expect(terminal).toMatchObject({ action: "KEEP", interaction: "ASK_USER", targetStatus: "VERIFIED" });
    expect(terminal.reasonCodes).toContain("INVALID_POLICY_STATUS_TRANSITION");
  });

  it("deduplicates and sorts Evidence IDs deterministically", () => {
    const first = assertion("USER_ACCEPTED", "first");
    const second = assertion("COMMAND_SUCCEEDED", "second");
    const firstResult = verification(first, "SUPPORTED");
    const secondResult = verification(second, "SUPPORTED");
    const result = evaluateEvidencePolicy(input(
      candidate("DECISION", [first, second]),
      [secondResult, firstResult],
    ));
    expect(result.evidenceIds).toEqual([...result.evidenceIds].sort());
  });
});
