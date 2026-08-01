import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveProjectIdentity } from "../packages/project-identity/dist/index.js";
import { resolveKnowledgeScope } from "../packages/scope-resolver/dist/index.js";

test("Scope Resolver is deterministic Domain policy without model, storage, or runtime imports", async () => {
  const source = await readFile("packages/scope-resolver/src/resolver.ts", "utf8");
  assert.doesNotMatch(source, /node:|openai|anthropic|sqlite|child_process|fetch\(/i);
  assert.match(source, /import\s+type\s+\{[^}]*KnowledgeCandidate[^}]*\}\s+from\s+["']@zhiloop\/domain["']/s);
});

test("CKL-302: trusted Project Identity anchors narrow scope and blocks unsafe GLOBAL expansion", async () => {
  const project = (await resolveProjectIdentity(process.cwd())).context;
  const uncertain = resolveKnowledgeScope({
    candidate: candidate(project, { reasonCodes: ["P2_CANDIDATE"] }),
    projectContext: project,
  });
  assert.equal(uncertain.scope.level, "PROJECT");
  assert.equal(uncertain.scope.projectId, project.projectId);

  const implementation = resolveKnowledgeScope({
    candidate: candidate(project, {
      level: "GLOBAL",
      reasonCodes: ["MODEL_GLOBAL_HINT"],
    }, {
      kind: "IMPLEMENTATION",
      body: "Edit packages/scope-resolver/src/resolver.ts",
    }),
    projectContext: project,
    allowGlobal: true,
  });
  assert.equal(implementation.scope.level, "PROJECT");
  assert.ok(implementation.projectSpecificSignals.includes("IMPLEMENTATION_KIND"));
  assert.ok(implementation.reasonCodes.includes("GLOBAL_REJECTED_PROJECT_SPECIFIC"));

  const symbol = resolveKnowledgeScope({
    candidate: candidate(project, {
      level: "GLOBAL",
      symbols: ["ScopeResolver"],
      reasonCodes: ["MODEL_GLOBAL_HINT"],
    }),
    projectContext: project,
    allowGlobal: true,
  });
  assert.equal(symbol.scope.level, "SYMBOL");
  assert.deepEqual(symbol.scope.symbols, ["ScopeResolver"]);
});

function candidate(project, scopeHint, overrides = {}) {
  return {
    schemaVersion: 1,
    candidateId: "scope-boundary-candidate",
    compilerVersion: "compiler-v1",
    status: "PROPOSED",
    subjectKey: "experience.scope.boundary",
    kind: "EXPERIENCE",
    scopeHint: { projectId: project.projectId, repositoryRemote: project.repositoryRemote, ...scopeHint },
    title: "Resolve knowledge scope",
    summary: "Choose the narrowest provable scope.",
    body: "Unknown scope remains bound to its project.",
    sourceEpisodes: ["episode-1"],
    confidence: 0.9,
    assertions: [],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-1", correlationId: "correlation-1" }],
    createdAt: "2026-08-01T08:00:00.000Z",
    correlationId: "correlation-1",
    ...overrides,
  };
}
