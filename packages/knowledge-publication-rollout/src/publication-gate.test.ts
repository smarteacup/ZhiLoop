import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIGURATION, type CompilationPolicy } from "@zhiloop/config";

import { evaluateAutomaticPublication, type PublicationGateInput } from "./publication-gate.js";

const fingerprint = "a".repeat(64);

function policy(): CompilationPolicy {
  return {
    ...DEFAULT_CONFIGURATION.compilation,
    mode: "SAFE_AUTO_PUBLICATION",
    publication: {
      enabled: true,
      allowedKinds: ["IMPLEMENTATION"],
      allowedProjectIds: ["project-a"],
      requireFreshCodeEvidence: true,
      goldenDatasetId: "golden-a",
      goldenDatasetVersion: 3,
      goldenConfigFingerprint: fingerprint,
    },
  };
}

function input(overrides: Partial<PublicationGateInput> = {}): PublicationGateInput {
  return {
    candidateId: "candidate-a", projectId: "project-a", kind: "IMPLEMENTATION",
    sourceComplete: true, groundingComplete: true, deterministicScope: true,
    evolutionAction: "CREATE", freshnessStatus: "FRESH", protectedTarget: false, expectedVersionCurrent: true,
    evidence: { datasetId: "golden-a", datasetVersion: 3, configFingerprint: fingerprint },
    ...overrides,
  };
}

describe("automatic publication gate", () => {
  it("authorizes only a fully allowlisted, fresh and evidence-bound Candidate", () => {
    expect(evaluateAutomaticPublication(policy(), input())).toEqual({
      authorized: true, executionMode: "SAFE_AUTO_PUBLICATION", reasonCode: "ALL_PUBLICATION_GATES_PASSED",
    });
  });

  it.each([
    [{}, { evolutionAction: "UNRECOGNIZED" }, "PUBLICATION_INPUT_INVALID"],
    [{}, { evidence: { datasetId: "golden-a", datasetVersion: 0, configFingerprint: fingerprint } }, "PUBLICATION_INPUT_INVALID"],
    [{ publication: { ...policy().publication, enabled: false } }, {}, "PUBLICATION_DISABLED"],
    [{}, { projectId: "project-b" }, "PROJECT_NOT_ALLOWLISTED"],
    [{}, { freshnessStatus: "CONFLICT" }, "FRESH_CODE_EVIDENCE_REQUIRED"],
    [{}, { evolutionAction: "CONTRADICT" }, "EVOLUTION_UNRESOLVED"],
    [{}, { protectedTarget: true }, "PROTECTED_KNOWLEDGE_TARGET"],
    [{}, { evidence: { datasetId: "other", datasetVersion: 3, configFingerprint: fingerprint } }, "GOLDEN_EVIDENCE_MISMATCH"],
  ] as const)("retains preview on a failed gate %#", (policyOverride, inputOverride, reasonCode) => {
    const configured = { ...policy(), ...policyOverride } as CompilationPolicy;
    expect(evaluateAutomaticPublication(configured, input(inputOverride as Partial<PublicationGateInput>))).toEqual({
      authorized: false, executionMode: "PREVIEW_ONLY", reasonCode,
    });
  });
});
