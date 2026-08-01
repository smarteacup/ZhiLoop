import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_CONFIGURATION } from "../packages/config/dist/index.js";
import { createMvpVerifierRegistry } from "../packages/evidence-engine/dist/index.js";
import { evaluateEvidencePolicy } from "../packages/evidence-policy/dist/index.js";
import { resolveProjectIdentity } from "../packages/project-identity/dist/index.js";
import { resolveKnowledgeScope } from "../packages/scope-resolver/dist/index.js";

test("Evidence Policy is a deterministic decision layer without model, persistence, filesystem, or process access", async () => {
  const source = await readFile("packages/evidence-policy/src/policy.ts", "utf8");
  assert.doesNotMatch(source, /node:|openai|anthropic|sqlite|child_process|execFile|spawn\(|readFile\(|writeFile\(|fetch\(/i);
  assert.match(source, /transitionKnowledgeStatus/);
  assert.match(source, /evaluateGlobalPromotion/);
});

test("CKL-304: Scope, Verifier, and Evidence Policy preserve model/code/test/global gates end to end", async () => {
  const project = (await resolveProjectIdentity(process.cwd())).context;
  const projectScope = { level: "PROJECT", projectId: project.projectId, ...(project.repositoryRemote === undefined ? {} : { repositoryRemote: project.repositoryRemote }) };
  const at = "2026-08-01T12:00:00.000Z";
  const symbolAssertion = assertion("SYMBOL_EXISTS", { projectId: project.projectId, symbol: "VerifierRegistry" });
  const implementation = candidate(project, "IMPLEMENTATION", [symbolAssertion], {
    symbols: ["VerifierRegistry"], reasonCodes: ["MODEL_HINT"],
  });
  const implementationScope = resolveKnowledgeScope({ candidate: implementation, projectContext: project });
  const symbolTarget = `symbol:${project.projectId}:VerifierRegistry`;
  const implementationResults = await createMvpVerifierRegistry().verifyAll(implementation.assertions, verificationContext(project, at, {
    symbol: { observe: async () => observed(symbolTarget, at, "SUPPORTED") },
  }));
  const implemented = evaluateEvidencePolicy({
    candidate: implementation,
    currentStatus: "PROPOSED",
    resolvedScope: implementationScope.scope,
    projectScope,
    projectSpecificSignals: implementationScope.projectSpecificSignals,
    verificationResults: implementationResults,
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
  });
  assert.equal(implemented.targetStatus, "IMPLEMENTED");
  assert.deepEqual(implemented.transitionPath, ["IMPLEMENTED"]);

  const testAssertion = assertion("TEST_PASSED", { testId: "evidence-policy" });
  const experience = candidate(project, "EXPERIENCE", [testAssertion], { reasonCodes: ["MODEL_HINT"] });
  const testResults = await createMvpVerifierRegistry().verifyAll(experience.assertions, verificationContext(project, at, {
    test: { observe: async () => observed("test:evidence-policy", at, "SUPPORTED") },
  }));
  const verified = evaluateEvidencePolicy({
    candidate: experience,
    currentStatus: "PROPOSED",
    resolvedScope: projectScope,
    projectScope,
    projectSpecificSignals: [],
    verificationResults: testResults,
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
  });
  assert.equal(verified.targetStatus, "VERIFIED");
  assert.deepEqual(verified.transitionPath, ["IMPLEMENTED", "VERIFIED"]);

  const modelOnly = evaluateEvidencePolicy({
    candidate: candidate(project, "DESIGN", [], { reasonCodes: ["MODEL_HINT"] }),
    currentStatus: "PROPOSED",
    resolvedScope: projectScope,
    projectScope,
    projectSpecificSignals: [],
    verificationResults: [],
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
  });
  assert.equal(modelOnly.targetStatus, "PROPOSED");
  assert.equal(modelOnly.shouldPublish, false);

  const userAssertion = assertion("USER_ACCEPTED", { statementRef: "event-user-accepted" });
  const generic = candidate(project, "DECISION", [userAssertion], { level: "GLOBAL", reasonCodes: ["MODEL_GLOBAL"] });
  const globalScope = resolveKnowledgeScope({ candidate: generic, projectContext: project, allowGlobal: true });
  assert.equal(globalScope.scope.level, "GLOBAL");
  const userResults = await createMvpVerifierRegistry().verifyAll(generic.assertions, verificationContext(project, at, {
    user: { observe: async () => observed("statement:event-user-accepted", at, "SUPPORTED") },
  }));
  const global = evaluateEvidencePolicy({
    candidate: generic,
    currentStatus: "PROPOSED",
    resolvedScope: globalScope.scope,
    projectScope,
    projectSpecificSignals: globalScope.projectSpecificSignals,
    verificationResults: userResults,
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
    verifiedProjects: [project.projectId, "project-independent-2"].map((projectId) => ({
      projectId,
      subjectKey: generic.subjectKey,
      evidenceId: `evidence-cross-${projectId}`,
      sourceRef: `event-cross-${projectId}`,
      observedAt: at,
    })),
  });
  assert.equal(global.effectiveScope.level, "GLOBAL");
  assert.equal(global.targetStatus, "ACCEPTED");
});

function verificationContext(project, at, probes) {
  return { project, correlationId: "correlation-boundary", requestedAt: at, probes };
}

function observed(target, at, status) {
  return { status, sourceRef: `event-${target.split(":", 1)[0]}`, observedAt: at, target, reasonCode: `${status}_BY_BOUNDARY` };
}

function assertion(kind, parameters) {
  return { assertionId: `assertion-${kind.toLowerCase()}`, candidateId: "candidate-boundary", kind, parameters, createdAt: "2026-08-01T11:59:00.000Z" };
}

function candidate(project, kind, assertions, scopeHint) {
  return {
    schemaVersion: 1,
    candidateId: "candidate-boundary",
    compilerVersion: "compiler-v1",
    status: "PROPOSED",
    subjectKey: "design.evidence.policy",
    kind,
    scopeHint: { projectId: project.projectId, repositoryRemote: project.repositoryRemote, ...scopeHint },
    title: "Evidence policy boundary",
    summary: "Only evidence-backed knowledge can become active.",
    body: "Model output alone stays proposed.",
    sourceEpisodes: ["episode-boundary"],
    confidence: 0.9,
    assertions,
    evidenceHints: assertions.length === 0 ? [{ type: "USER_STATEMENT", sourceRef: "event-user", correlationId: "correlation-boundary" }] : [],
    createdAt: "2026-08-01T11:59:00.000Z",
    correlationId: "correlation-boundary",
  };
}
