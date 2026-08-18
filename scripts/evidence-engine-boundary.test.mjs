import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMvpVerifierRegistry } from "../packages/evidence-engine/dist/index.js";
import { resolveProjectIdentity } from "../packages/project-identity/dist/index.js";

test("Evidence Engine keeps registry policy separate from model, storage, process, and filesystem adapters", async () => {
  const sources = await Promise.all([
    readFile("packages/evidence-engine/src/registry.ts", "utf8"),
    readFile("packages/evidence-engine/src/verifiers.ts", "utf8"),
  ]);
  const source = sources.join("\n");
  assert.doesNotMatch(source, /node:|openai|anthropic|sqlite|child_process|execFile|spawn\(|readFile\(|writeFile\(/i);
  assert.match(source, /from\s+["']@zhiloop\/domain["']/);
});

test("CKL-303: Project Identity, all Verifiers, Evidence traceability, and error isolation form one boundary", async () => {
  const project = (await resolveProjectIdentity(process.cwd())).context;
  const at = "2026-08-01T10:00:00.000Z";
  const targets = {
    user: "statement:event-user",
    symbol: `symbol:${project.projectId}:VerifierRegistry`,
    callPath: `call-path:${project.projectId}:VerifierRegistry->createMvpVerifierRegistry:8`,
    impact: `impact:${project.projectId}:VerifierRegistry->createMvpVerifierRegistry`,
    file: "file:packages/evidence-engine/src/registry.ts:STRUCTURAL",
    dependency: "dependency:vitest:package.json",
    config: "config:coverage.threshold:vitest.config.ts",
    command: "command:sha256-check:0",
    test: "test:evidence-engine:packages/evidence-engine",
    crossProject: "cross-project:design.verification.registry:2",
  };
  const observed = (target, status = "SUPPORTED") => ({
    status,
    sourceRef: `event-${target.split(":", 1)[0]}`,
    observedAt: at,
    target,
    reasonCode: `${status}_BY_BOUNDARY_FIXTURE`,
  });
  const context = {
    project,
    correlationId: "correlation-boundary",
    requestedAt: at,
    probes: {
      user: { observe: async () => observed(targets.user) },
      symbol: { observe: async () => observed(targets.symbol) },
      callPath: { observe: async () => observed(targets.callPath) },
      impact: { observe: async () => observed(targets.impact) },
      file: { observe: async () => observed(targets.file) },
      dependency: { observe: async () => observed(targets.dependency) },
      config: { observe: async () => observed(targets.config, "REFUTED") },
      command: { observe: async () => observed(targets.command) },
      test: { observe: async () => observed(targets.test, "UNKNOWN") },
      crossProject: { observe: async () => observed(targets.crossProject) },
    },
  };
  const assertions = [
    assertion("USER_ACCEPTED", { statementRef: "event-user" }),
    assertion("SYMBOL_EXISTS", { projectId: project.projectId, symbol: "VerifierRegistry" }),
    assertion("CALL_PATH_EXISTS", { projectId: project.projectId, from: "VerifierRegistry", to: "createMvpVerifierRegistry", maxDepth: 8 }),
    assertion("IMPACT_CONTAINS", { projectId: project.projectId, symbol: "VerifierRegistry", impactedSymbol: "createMvpVerifierRegistry" }),
    assertion("FILE_CONTAINS", { path: "packages/evidence-engine/src/registry.ts", expected: "class VerifierRegistry", matchMode: "STRUCTURAL" }),
    assertion("DEPENDENCY_PRESENT", { name: "vitest", manifestPath: "package.json" }),
    assertion("CONFIG_EQUALS", { key: "coverage.threshold", expected: "90", path: "vitest.config.ts" }),
    assertion("COMMAND_SUCCEEDED", { commandHash: "sha256-check", expectedExitCode: 0 }),
    assertion("TEST_PASSED", { testId: "evidence-engine", path: "packages/evidence-engine" }),
    assertion("CROSS_PROJECT_VERIFIED", { subjectKey: "design.verification.registry", minimumProjects: 2 }),
  ];
  const results = await createMvpVerifierRegistry().verifyAll(assertions, context);
  assert.deepEqual(results.map((result) => result.status), [
    "SUPPORTED", "SUPPORTED", "SUPPORTED", "SUPPORTED", "SUPPORTED", "SUPPORTED", "REFUTED", "SUPPORTED", "UNKNOWN", "SUPPORTED",
  ]);
  for (const result of results) {
    assert.equal(result.evidence?.assertionId, result.assertionId);
    assert.equal(result.evidence?.observedAt, at);
    assert.equal(result.evidence?.details?.target, result.target);
    assert.match(result.evidence?.sourceRef ?? "", /^event-/);
  }
  assert.equal(results[6].evidence?.verdict, "CONTRADICTS");
  assert.equal(results[8].evidence?.verdict, "INCONCLUSIVE");

  const failed = await createMvpVerifierRegistry().verify(assertions[4], {
    ...context,
    probes: { ...context.probes, file: { observe: async () => { throw new Error("adapter detail"); } } },
  });
  assert.equal(failed.status, "ERROR");
  assert.equal(failed.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(failed), /adapter detail/);
});

function assertion(kind, parameters) {
  return {
    assertionId: `assertion-${kind.toLowerCase()}`,
    candidateId: "candidate-boundary",
    kind,
    parameters,
    createdAt: "2026-08-01T09:59:00.000Z",
  };
}
