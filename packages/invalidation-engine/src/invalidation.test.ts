import { describe, expect, it } from "vitest";

import type { KnowledgeAssertion, KnowledgeCandidate } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";

import { createKnowledgeFingerprint, deriveFingerprintTargets, evaluateInvalidation } from "./invalidation.js";

const at = "2026-08-01T13:00:00.000Z";
const assertions = [
  assertion("SYMBOL_EXISTS", { projectId: "project-1", symbol: "OrderService", path: "src/order.ts" }),
  assertion("CALL_PATH_EXISTS", { projectId: "project-1", from: "OrderService", to: "OrderRepository", maxDepth: 8 }),
  assertion("IMPACT_CONTAINS", { projectId: "project-1", symbol: "OrderService", impactedSymbol: "OrderController" }),
  assertion("FILE_CONTAINS", { path: "src/config.ts", expected: "enabled", matchMode: "EXACT" }),
  assertion("CONFIG_EQUALS", { key: "feature.enabled", expected: "true", path: "config/app.yml" }),
  assertion("DEPENDENCY_PRESENT", { name: "vitest", manifestPath: "package.json" }),
  assertion("TEST_PASSED", { testId: "order" }),
] as const;
const source = candidate(assertions);
const observations = [
  observed(assertions[0], "SYMBOL", "OrderService", "src/order.ts"),
  observed(assertions[1], "SYMBOL", "OrderService"),
  observed(assertions[1], "SYMBOL", "OrderRepository"),
  observed(assertions[2], "SYMBOL", "OrderService"),
  observed(assertions[2], "SYMBOL", "OrderController"),
  observed(assertions[3], "PATH", "src/config.ts", "src/config.ts"),
  observed(assertions[4], "CONFIG", "feature.enabled", "config/app.yml"),
  observed(assertions[5], "DEPENDENCY", "vitest", "package.json"),
] as const;
const fingerprint = createKnowledgeFingerprint(source, "project-1", observations);

function assertion(kind: string, parameters: unknown): KnowledgeAssertion {
  return { assertionId: `assertion-${kind.toLowerCase()}`, candidateId: "candidate-1", kind, parameters, createdAt: at } as KnowledgeAssertion;
}

function candidate(items: readonly KnowledgeAssertion[]): KnowledgeCandidate {
  return {
    schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "v1", status: "PROPOSED",
    subjectKey: "implementation.invalidation.engine", kind: "IMPLEMENTATION", scopeHint: { projectId: "project-1", reasonCodes: [] },
    title: "Invalidation", summary: "Targeted invalidation", body: "Preserve knowledge body.", sourceEpisodes: ["episode-1"],
    confidence: 0.9, assertions: items,
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-1", correlationId: "correlation-1" }],
    createdAt: at, correlationId: "correlation-1",
  } as KnowledgeCandidate;
}

function observed(item: KnowledgeAssertion, kind: "PATH" | "SYMBOL" | "CONFIG" | "DEPENDENCY", key: string, path?: string) {
  return { assertionId: item.assertionId, kind, key, ...(path === undefined ? {} : { path }), digest: `sha256_deadbeef_${kind}`,
    sourceRef: `event-${item.assertionId}`, observedAt: at };
}

function changes(overrides = {}) {
  return { projectId: "project-1", changedPaths: [], changedSymbols: [], changedConfigs: [], changedDependencies: [],
    sourceRef: "event-change", observedAt: at, ...overrides };
}

function supported(assertionId: string): VerificationResult {
  const assertionKind = assertions.find((item) => item.assertionId === assertionId)!.kind;
  return { assertionId, assertionKind, verifierId: "fixture-verifier-v1",
    status: "SUPPORTED", target: `assertion:${assertionId}`, observedAt: at, reasonCodes: ["SUPPORTED_BY_TEST"],
    evidence: { evidenceId: `evidence-${assertionId}`, assertionId, type: assertionKind === "FILE_CONTAINS" ? "FILE_CONTENT" : "DEPENDENCY",
      verdict: "SUPPORTS", sourceRef: `event-${assertionId}`, projectId: "project-1", observedAt: at,
      correlationId: "correlation-1", details: { target: `assertion:${assertionId}` } } } as VerificationResult;
}

describe("fingerprints", () => {
  it("derives path, relation endpoint, impact endpoint, config, and dependency targets", () => {
    expect(deriveFingerprintTargets(source).map((item) => item.kind)).toEqual([
      "SYMBOL", "SYMBOL", "CONFIG", "DEPENDENCY", "PATH", "SYMBOL", "SYMBOL", "SYMBOL",
    ]);
    expect(deriveFingerprintTargets(source).filter((item) => item.assertionId === assertions[1].assertionId)
      .map((item) => item.key)).toEqual(["OrderRepository", "OrderService"]);
    expect(deriveFingerprintTargets(source)).toEqual(deriveFingerprintTargets(source));
  });

  it("creates a deterministic frozen fingerprint independent of observation order", () => {
    const replay = createKnowledgeFingerprint(source, "project-1", [...observations].reverse());
    expect(replay.fingerprint).toBe(fingerprint.fingerprint);
    expect(Object.isFrozen(replay.entries)).toBe(true);
  });

  it("rejects missing, duplicate, forged, or unsafe observations", () => {
    expect(() => createKnowledgeFingerprint(source, "project-1", observations.slice(1))).toThrow("incomplete");
    expect(() => createKnowledgeFingerprint(source, "project-1", [...observations.slice(0, -1), observations[0]])).toThrow("unique");
    expect(() => createKnowledgeFingerprint(source, "project-1", [{ ...observations[0], key: "Other" }, ...observations.slice(1)])).toThrow("does not match");
    const unsafe = candidate([{ ...assertions[3], parameters: { ...assertions[3].parameters, path: "../secret" } } as KnowledgeAssertion]);
    expect(() => deriveFingerprintTargets(unsafe)).toThrow("invalid");
  });
});

describe("evaluateInvalidation", () => {
  it("does not invalidate knowledge for unrelated file changes", () => {
    const result = evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
      changes: changes({ changedPaths: ["src/unrelated.ts"] }) });
    expect(result).toMatchObject({ action: "UNCHANGED", targetStatus: "VERIFIED", reasonCodes: ["NO_RELEVANT_CHANGE"] });
  });

  it.each([
    ["changedPaths", "src/config.ts", [assertions[3].assertionId]],
    ["changedSymbols", "OrderService", [assertions[1].assertionId, assertions[2].assertionId, assertions[0].assertionId].sort()],
    ["changedSymbols", "OrderRepository", [assertions[1].assertionId]],
    ["changedSymbols", "OrderController", [assertions[2].assertionId]],
    ["changedConfigs", "feature.enabled", [assertions[4].assertionId]],
    ["changedDependencies", "vitest", [assertions[5].assertionId]],
  ] as const)("marks related %s changes STALE when revalidation is unavailable", (field, value, assertionIds) => {
    const result = evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
      changes: changes({ [field]: [value] }) });
    expect(result).toMatchObject({ action: "MARK_STALE", targetStatus: "STALE", preserveBody: true, affectedAssertionIds: assertionIds });
  });

  it("refreshes the fingerprint when every affected target remains supported", () => {
    const result = evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
      changes: changes({ changedPaths: ["src/config.ts"], changedDependencies: ["vitest"] }),
      revalidationResults: [supported(assertions[3].assertionId), supported(assertions[5].assertionId)] });
    expect(result).toMatchObject({ action: "REFRESH_FINGERPRINT", targetStatus: "VERIFIED" });
  });

  it("requires revalidation without illegal STALE transitions from PROPOSED/ACCEPTED", () => {
    for (const status of ["PROPOSED", "ACCEPTED"] as const) {
      expect(evaluateInvalidation({ candidate: source, currentStatus: status, fingerprint,
        changes: changes({ changedSymbols: ["OrderService"] }) })).toMatchObject({ action: "REVALIDATE", targetStatus: status });
    }
  });

  it("fails closed without marking unrelated knowledge when project or change metadata is invalid", () => {
    const wrong = evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
      changes: changes({ projectId: "other", changedPaths: ["src/config.ts"] }) });
    expect(wrong).toMatchObject({ action: "UNCHANGED", reasonCodes: ["INVALID_CHANGESET_OR_FINGERPRINT"] });
    const unsafe = evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
      changes: changes({ changedPaths: ["../secret"] }) });
    expect(unsafe.action).toBe("UNCHANGED");
    const forged = { ...fingerprint, fingerprint: "fp_forged" };
    expect(evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint: forged,
      changes: changes({ changedPaths: ["src/config.ts"] }) }).reasonCodes).toContain("INVALID_CHANGESET_OR_FINGERPRINT");
  });

  it("does not refresh on forged, duplicate, or cross-project SUPPORT results", () => {
    const valid = supported(assertions[3].assertionId);
    const withoutEvidence = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "evidence")) as unknown as VerificationResult;
    for (const revalidationResults of [
      [withoutEvidence as VerificationResult],
      [valid, valid],
      [{ ...valid, evidence: { ...valid.evidence!, projectId: "other" } }],
    ]) {
      expect(evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
        changes: changes({ changedPaths: ["src/config.ts"] }), revalidationResults }).action).toBe("MARK_STALE");
    }
  });
});
