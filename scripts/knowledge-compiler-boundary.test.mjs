import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyUserCommitments,
  detectUserCommitments,
  MvpKnowledgeCompiler,
  runKnowledgeExtraction,
  toKnowledgeExtractionInput,
} from "../packages/knowledge-compiler/dist/index.js";

test("Knowledge Extraction Port has no model SDK, storage, filesystem, or process runtime dependency", async () => {
  const source = `${await readFile("packages/knowledge-compiler/src/runner.ts", "utf8")}\n${await readFile("packages/knowledge-compiler/src/mvp-compiler.ts", "utf8")}\n${await readFile("packages/knowledge-compiler/src/commitment-detector.ts", "utf8")}`;
  assert.doesNotMatch(source, /openai|anthropic|gemini|node:sqlite|node:fs|child_process/i);
  assert.match(source, /from\s+["']@zhiloop\/domain["']/);
  assert.match(source, /from\s+["']@zhiloop\/schemas["']/);
});

test("CKL-204: explicit acceptance is traceably stamped without promoting Candidate status", () => {
  const source = {
    ...episode(),
    userStatements: [{
      turnId: "turn-1",
      sourceEventId: "event-goal",
      kind: "GOAL",
      statement: "Build the extraction port",
      occurredAt: "2026-08-01T08:00:00.000Z",
    }, {
      turnId: "turn-2",
      sourceEventId: "event-accept",
      kind: "CONTINUATION",
      statement: "按这个做",
      occurredAt: "2026-08-01T08:01:00.000Z",
    }],
    actions: [{
      actionId: "action-1",
      kind: "FILE_CHANGE",
      summary: "Implemented the extraction port",
      sourceEventIds: ["event-action"],
      occurredAt: "2026-08-01T08:02:00.000Z",
    }],
    evidenceRefs: ["event-goal", "event-accept", "event-action"],
  };
  const candidate = {
    schemaVersion: 1,
    candidateId: "candidate-1",
    compilerVersion: "compiler-v1",
    status: "PROPOSED",
    subjectKey: "design.knowledge.extraction-port",
    kind: "DESIGN",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["BOUNDARY_TEST"] },
    title: "Use an extraction port",
    summary: "Keep model providers behind a port.",
    body: "The port is the only model integration boundary.",
    sourceEpisodes: ["boundary-episode"],
    confidence: 0.9,
    assertions: [],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-goal", correlationId: "correlation-1" }],
    createdAt: "2026-08-01T08:00:30.000Z",
    correlationId: "correlation-1",
  };

  const detection = detectUserCommitments(source, [candidate]);
  const enriched = applyUserCommitments([candidate], detection);

  assert.equal(detection.signals[0].turnId, "turn-2");
  assert.deepEqual(detection.signals[0].reasonCodes, ["SINGLE_PROPOSAL", "FOLLOWED_BY_IMPLEMENTATION"]);
  assert.equal(enriched[0].status, "PROPOSED");
  assert.deepEqual(enriched[0].assertions[0].parameters, { statementRef: "event-accept" });
});

test("CKL-203: the MVP compiler emits five independently proposed knowledge kinds", async () => {
  const kinds = ["REQUIREMENT", "DESIGN", "DECISION", "IMPLEMENTATION", "EXPERIENCE"];
  const compiler = new MvpKnowledgeCompiler({
    compilerVersion: "compiler-v1",
    promptVersion: "prompt-v1",
    model: {
      generate: async () => ({
        schemaVersion: 1,
        candidates: kinds.map((kind, index) => ({
          subjectKey: `${kind.toLowerCase()}.boundary.topic-${index}`,
          kind,
          scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["BOUNDARY_TEST"] },
          title: `${kind} result`,
          summary: "A durable observable conclusion.",
          body: "No hidden reasoning is stored.",
          confidence: 0.8,
          assertions: [],
          evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-goal" }],
        })),
      }),
    },
  });
  const result = await runKnowledgeExtraction(request(), compiler, {
    maxAttempts: 1,
    retryDelayMs: 0,
    perAttemptTimeoutMs: 1_000,
  });

  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(result.candidates.map((candidate) => candidate.kind), kinds);
  assert.equal(result.candidates.every((candidate) => candidate.status === "PROPOSED"), true);
});

function episode() {
  return {
    episodeId: "boundary-episode",
    builderVersion: "episode-builder-v2",
    sessionIds: ["session-1"],
    turnIds: ["turn-1"],
    projectContext: { projectId: "project-1", repositoryRoot: "/private/repo", portable: false },
    goal: "Build the extraction port",
    goalRef: "event-goal",
    subgoals: [],
    userStatements: [{
      turnId: "turn-1",
      sourceEventId: "event-goal",
      kind: "GOAL",
      statement: "Build the extraction port",
      occurredAt: "2026-08-01T08:00:00.000Z",
    }],
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
  assert.equal(result.candidates[0].status, "PROPOSED");
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
