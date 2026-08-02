import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_CONFIGURATION } from "../packages/config/dist/index.js";
import { createMvpVerifierRegistry } from "../packages/evidence-engine/dist/index.js";
import { evaluateEvidencePolicy } from "../packages/evidence-policy/dist/index.js";
import { createKnowledgeFingerprint, evaluateInvalidation } from "../packages/invalidation-engine/dist/index.js";
import { resolveKnowledgeScope } from "../packages/scope-resolver/dist/index.js";

const expected = JSON.parse(await readFile("fixtures/p3/v1/expected.json", "utf8"));
const at = "2026-08-02T00:00:00.000Z";
const projectA = { projectId: "project-a", repositoryRoot: "/fixture/project-a", repositoryRemote: "example.com/team/project-a", portable: true };
const projectB = { projectId: "project-b", repositoryRoot: "/fixture/project-b", repositoryRemote: "example.com/team/project-b", portable: true };

test("P3 Gate: code and related test Evidence reach only their allowed lifecycle states", async () => {
  const symbol = assertion("candidate-implementation", "SYMBOL_EXISTS", { projectId: projectA.projectId, symbol: "OrderService" });
  const implementation = candidate("candidate-implementation", "IMPLEMENTATION", [symbol], projectA, { symbols: ["OrderService"] });
  const implementationScope = resolveKnowledgeScope({ candidate: implementation, projectContext: projectA });
  const implementationResults = await verify(implementation, projectA, {
    symbol: probe(`symbol:${projectA.projectId}:OrderService`, "SUPPORTED", "event-code-order-service"),
  });
  const implemented = policy(implementation, implementationScope, implementationResults, projectA);
  assert.equal(implemented.targetStatus, expected.implementationStatus);
  assert.deepEqual(implemented.transitionPath, ["IMPLEMENTED"]);
  assert.ok(implementationResults[0].evidence?.sourceRef.startsWith("event-code"));

  const experienceSymbol = assertion("candidate-experience", "SYMBOL_EXISTS", { projectId: projectA.projectId, symbol: "OrderService" });
  const relatedTest = assertion("candidate-experience", "TEST_PASSED", { testId: "OrderService.test" });
  const experience = candidate("candidate-experience", "EXPERIENCE", [experienceSymbol, relatedTest], projectA, { symbols: ["OrderService"] });
  const experienceScope = resolveKnowledgeScope({ candidate: experience, projectContext: projectA });
  const experienceResults = await verify(experience, projectA, {
    symbol: probe(`symbol:${projectA.projectId}:OrderService`, "SUPPORTED", "event-code-order-service"),
    test: probe("test:OrderService.test", "SUPPORTED", "event-test-order-service"),
  });
  const verified = policy(experience, experienceScope, experienceResults, projectA);
  assert.equal(verified.targetStatus, expected.experienceStatus);
  assert.deepEqual(verified.transitionPath, ["IMPLEMENTED", "VERIFIED"]);

  const failedResults = await verify(implementation, projectA, {
    symbol: { observe: async () => { throw new Error("fixture adapter unavailable"); } },
  });
  const failed = policy(implementation, implementationScope, failedResults, projectA);
  assert.equal(failed.targetStatus, expected.modelErrorStatus);
  assert.equal(failed.shouldPublish, false);
  assert.ok(failed.reasonCodes.includes("VERIFIER_ERROR_NOT_EVIDENCE"));
});

test("P3 Gate: project boundaries and GLOBAL promotion remain evidence-backed", async () => {
  const user = assertion("candidate-global", "USER_ACCEPTED", { statementRef: "event-user-global" });
  const generic = candidate("candidate-global", "DECISION", [user], projectA, { level: "GLOBAL" });
  const scope = resolveKnowledgeScope({ candidate: generic, projectContext: projectA, allowGlobal: true });
  const results = await verify(generic, projectA, {
    user: probe("statement:event-user-global", "SUPPORTED", "event-user-global"),
  });
  const verifiedProjects = [projectA.projectId, projectB.projectId].map((projectId) => ({
    projectId,
    subjectKey: generic.subjectKey,
    evidenceId: `evidence-cross-${projectId}`,
    sourceRef: `event-cross-${projectId}`,
    observedAt: at,
  }));
  const global = policy(generic, scope, results, projectA, { verifiedProjects });
  assert.equal(global.effectiveScope.level, expected.globalScope);
  assert.ok(global.evidenceIds.includes("evidence-cross-project-b"));

  const insufficient = policy(generic, scope, results, projectA, { verifiedProjects: verifiedProjects.slice(0, 1) });
  assert.equal(insufficient.effectiveScope.level, expected.insufficientGlobalScope);
  assert.equal(insufficient.interaction, "ASK_USER");

  const specific = policy(generic, { ...scope, projectSpecificSignals: ["PROJECT_TERM"] }, results, projectA, { verifiedProjects });
  assert.equal(specific.effectiveScope.level, "PROJECT");

  assert.throws(() => resolveKnowledgeScope({ candidate: generic, projectContext: projectB }), /projectId conflicts/);
  const crossBound = policy(generic, scope, results, projectB, { verifiedProjects });
  assert.deepEqual(crossBound.reasonCodes, ["INVALID_EVIDENCE_POLICY_INPUT", "SAFE_PROJECT_FALLBACK"]);
  assert.equal(crossBound.shouldPublish, false);
});

test("P3 Gate: only related fingerprint changes make verified knowledge STALE and body is retained", () => {
  const file = assertion("candidate-fingerprint", "FILE_CONTAINS", { path: "src/order.ts", expected: "OrderService", matchMode: "EXACT" });
  const source = candidate("candidate-fingerprint", "IMPLEMENTATION", [file], projectA, {});
  const fingerprint = createKnowledgeFingerprint(source, projectA.projectId, [{
    assertionId: file.assertionId, kind: "PATH", key: "src/order.ts", path: "src/order.ts",
    digest: "sha256_deadbeef_order", sourceRef: "event-fingerprint-order", observedAt: at,
  }]);
  const base = { projectId: projectA.projectId, changedSymbols: [], changedConfigs: [], changedDependencies: [], sourceRef: "event-change", observedAt: at };
  const unrelated = evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
    changes: { ...base, changedPaths: ["src/unrelated.ts"] } });
  assert.equal(unrelated.action, expected.unrelatedChangeAction);
  const related = evaluateInvalidation({ candidate: source, currentStatus: "VERIFIED", fingerprint,
    changes: { ...base, changedPaths: ["src/order.ts"] } });
  assert.equal(related.targetStatus, expected.relatedChangeStatus);
  assert.equal(related.preserveBody, expected.preserveBody);
  assert.equal(source.body, "Golden candidate body remains immutable.");
});

function assertion(candidateId, kind, parameters) {
  return { assertionId: `${candidateId}-${kind.toLowerCase()}`, candidateId, kind, parameters, createdAt: at };
}

function candidate(candidateId, kind, assertions, project, scope = {}) {
  return { schemaVersion: 1, candidateId, compilerVersion: "compiler-v1", status: "PROPOSED",
    subjectKey: `knowledge.p3.${candidateId.replaceAll("candidate-", "")}`, kind,
    scopeHint: { projectId: project.projectId, repositoryRemote: project.repositoryRemote, reasonCodes: ["P3_GOLDEN"], ...scope },
    title: "P3 Golden Candidate", summary: "Cross-module lifecycle fixture.", body: "Golden candidate body remains immutable.",
    sourceEpisodes: ["episode-p3"], confidence: 0.9, assertions,
    evidenceHints: assertions.length === 0 ? [{ type: "USER_STATEMENT", sourceRef: "event-p3", correlationId: "correlation-p3" }] : [],
    createdAt: at, correlationId: "correlation-p3" };
}

function probe(target, status, sourceRef) {
  return { observe: async () => ({ status, sourceRef, observedAt: at, target, reasonCode: `${status}_BY_P3_FIXTURE` }) };
}

async function verify(source, project, probes) {
  return createMvpVerifierRegistry().verifyAll(source.assertions, {
    project, correlationId: source.correlationId, requestedAt: at, probes,
  });
}

function projectScope(project) {
  return { level: "PROJECT", projectId: project.projectId, repositoryRemote: project.repositoryRemote };
}

function policy(source, scope, results, project, overrides = {}) {
  return evaluateEvidencePolicy({ candidate: source, currentStatus: "PROPOSED", resolvedScope: scope.scope,
    projectScope: projectScope(project), projectSpecificSignals: scope.projectSpecificSignals,
    verificationResults: results, verificationPolicy: DEFAULT_CONFIGURATION.verification, ...overrides });
}
