import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  runKnowledgeExtraction,
  toKnowledgeExtractionInput,
} from "../packages/knowledge-compiler/dist/index.js";

test("Knowledge Extraction Port has no model SDK, storage, filesystem, or process runtime dependency", async () => {
  const source = await readFile("packages/knowledge-compiler/src/runner.ts", "utf8");
  assert.doesNotMatch(source, /openai|anthropic|gemini|node:sqlite|node:fs|child_process/i);
  assert.match(source, /from\s+["']@zhiloop\/domain["']/);
  assert.match(source, /from\s+["']@zhiloop\/schemas["']/);
});

function episode() {
  return {
    episodeId: "boundary-episode",
    builderVersion: "episode-builder-v1",
    sessionIds: ["session-1"],
    turnIds: ["turn-1"],
    projectContext: { projectId: "project-1", repositoryRoot: "/private/repo", portable: false },
    goal: "Build the extraction port",
    goalRef: "event-goal",
    subgoals: [],
    userCorrections: [],
    actions: [],
    artifacts: [],
    outcomes: [],
    evidenceRefs: ["event-start", "event-goal", "event-end"],
    status: "COMPLETED",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:01.000Z",
  };
}

function request() {
  return {
    input: toKnowledgeExtractionInput(episode()),
    compilerVersion: "compiler-v1",
    promptVersion: "prompt-v1",
    requestedAt: "2026-08-01T09:00:00.000Z",
    correlationId: "correlation-1",
  };
}

test("CKL-202: a valid structured batch is atomically materialized and stamped", async () => {
  const extractionRequest = request();
  assert.equal(Object.hasOwn(extractionRequest.input.projectContext, "repositoryRoot"), false);
  assert.deepEqual(extractionRequest.input.evidenceRefs, ["event-goal"]);

  const result = await runKnowledgeExtraction(extractionRequest, {
    extract: async () => ({
      schemaVersion: 1,
      candidates: [{
        subjectKey: "decision.knowledge.extraction-port",
        kind: "DECISION",
        scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["EPISODE_PROJECT"] },
        title: "Use an extraction port",
        summary: "Keep model vendors outside the compiler boundary.",
        body: "Validate a complete draft batch before materializing candidates.",
        confidence: 0.9,
        assertions: [],
        evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-goal" }],
      }],
    }),
  }, { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 });

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].compilerVersion, "compiler-v1");
  assert.deepEqual(result.candidates[0].sourceEpisodes, ["boundary-episode"]);
  assert.equal(result.promptVersion, "prompt-v1");
  assert.equal(typeof result.inputHash, "string");
});

test("CKL-202: adapter failure returns a retry identity and never partial candidates", async () => {
  const result = await runKnowledgeExtraction(request(), {
    extract: async () => { throw new Error("simulated outage"); },
  }, { maxAttempts: 2, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 });

  assert.equal(result.status, "RETRYABLE");
  assert.equal(result.reason, "ADAPTER_UNAVAILABLE");
  assert.equal(result.episodeId, "boundary-episode");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.candidates, []);
  assert.equal(typeof result.extractionKey, "string");
});
