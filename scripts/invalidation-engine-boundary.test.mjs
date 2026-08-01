import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createKnowledgeFingerprint, evaluateInvalidation } from "../packages/invalidation-engine/dist/index.js";

test("Invalidation Engine is deterministic and has no model, storage, filesystem, or process access", async () => {
  const source = await readFile("packages/invalidation-engine/src/invalidation.ts", "utf8");
  assert.doesNotMatch(source, /node:|openai|anthropic|sqlite|child_process|readFile\(|writeFile\(|spawn\(/i);
  assert.match(source, /transitionKnowledgeStatus/);
});

test("CKL-305: only related target changes can mark published knowledge STALE while preserving its body", () => {
  const at = "2026-08-01T14:00:00.000Z";
  const assertion = { assertionId: "assertion-file", candidateId: "candidate-1", kind: "FILE_CONTAINS",
    parameters: { path: "src/policy.ts", expected: "evaluate", matchMode: "EXACT" }, createdAt: at };
  const candidate = { schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "v1", status: "PROPOSED",
    subjectKey: "implementation.policy.invalidation", kind: "IMPLEMENTATION", scopeHint: { projectId: "project-1", reasonCodes: [] },
    title: "Invalidation", summary: "Targeted", body: "This body must survive.", sourceEpisodes: ["episode-1"], confidence: 0.9,
    assertions: [assertion], evidenceHints: [], createdAt: at, correlationId: "correlation-1" };
  const fingerprint = createKnowledgeFingerprint(candidate, "project-1", [{ ...assertionTarget(assertion), digest: "sha256_deadbeef",
    sourceRef: "event-fingerprint", observedAt: at }]);
  const base = { projectId: "project-1", changedSymbols: [], changedConfigs: [], changedDependencies: [], sourceRef: "event-change", observedAt: at };
  const unrelated = evaluateInvalidation({ candidate, currentStatus: "VERIFIED", fingerprint,
    changes: { ...base, changedPaths: ["src/unrelated.ts"] } });
  assert.equal(unrelated.action, "UNCHANGED");
  const related = evaluateInvalidation({ candidate, currentStatus: "VERIFIED", fingerprint,
    changes: { ...base, changedPaths: ["src/policy.ts"] } });
  assert.deepEqual(related, { currentStatus: "VERIFIED", preserveBody: true, action: "MARK_STALE", targetStatus: "STALE",
    affectedAssertionIds: ["assertion-file"], reasonCodes: ["AFFECTED_TARGET_REVALIDATION_INCOMPLETE", "BODY_PRESERVED"] });
  assert.equal(candidate.body, "This body must survive.");
});

function assertionTarget(assertion) {
  return { assertionId: assertion.assertionId, kind: "PATH", key: assertion.parameters.path, path: assertion.parameters.path };
}
