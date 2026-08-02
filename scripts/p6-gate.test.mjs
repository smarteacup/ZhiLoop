import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ClosureVerifier } from "../packages/closure-verifier/dist/index.js";
import { DEFAULT_CONFIGURATION } from "../packages/config/dist/index.js";
import { SqliteFeedbackStore } from "../packages/feedback-engine/dist/index.js";
import { evaluateInteractionPolicy, ruleOverrideTrigger } from "../packages/interaction-policy/dist/index.js";
import { resolveQueryContext } from "../packages/query-context/dist/index.js";
import { MultiChannelRetrievalEngine } from "../packages/retrieval-engine/dist/index.js";
import { InMemoryContinuationCounter, StopContinuationService } from "../packages/stop-continuation/dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/p6/v1/interaction-golden.json", import.meta.url), "utf8"));
const project = { projectId: "project-p6", repositoryRoot: "/workspace/p6", branch: "main", portable: true };
const projectScopeKey = JSON.stringify({ level: "PROJECT", projectId: project.projectId });

function envelope(taskId) {
  return {
    schemaVersion: 1, runId: `run-${taskId}`, projectId: project.projectId, taskId,
    complexity: { level: "L1_POINTER", breadth: 0, depth: "POINTER", authority: "NONE", evidence: "NONE", reasonCodes: ["REQUESTED_COMPLEXITY_LEVEL"] },
    budget: { maxTokens: 800, estimatedTokens: 100, truncated: false }, items: [],
  };
}

function closureInput(turn, { failed = false, boundary = false } = {}) {
  const taskId = `turn-${turn}`;
  return {
    verificationId: `verification-${turn}`,
    task: {
      taskId, objective: "Complete only the declared P6 fixture task.",
      gates: [{ gateId: "gate-test", description: "Declared test passes", type: "TEST_PASSED", testId: "test-a" }],
      boundaries: [{ boundaryId: "boundary-secret", type: "FORBID_PATH_PREFIX", pathPrefix: "secrets" }],
      requiredKnowledge: [],
    },
    contextEnvelope: envelope(taskId),
    diff: { changedPaths: boundary ? ["secrets/token.txt"] : ["packages/a.ts"], summary: "Fixture diff." },
    toolResults: [], tests: [{ testId: "test-a", status: failed ? "FAILED" : "PASSED", summary: "Fixture test." }],
    finalConclusion: { claimedComplete: true, summary: "Fixture conclusion.", openIssues: [] },
  };
}

test("P6 Gate: interaction, closure, continuation, and feedback metrics meet fixed thresholds", async () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.confirmationTriggerTurns.length, fixture.turns);
  assert.equal(new Set(fixture.confirmationTriggerTurns).size, fixture.confirmationTriggerTurns.length);
  assert.equal(new Set(fixture.continuationTurns).size, fixture.continuationTurns.length);
  assert.equal(new Set(fixture.declaredViolationTurns).size, fixture.declaredViolationTurns.length);
  const history = [];
  const questionTurns = [];
  for (const turn of fixture.confirmationTriggerTurns) {
    const identity = { sessionId: "session-p6", turnId: `turn-${turn}`, turnOrdinal: turn };
    const decision = evaluateInteractionPolicy({
      ...identity, now: `2026-08-02T05:${String(Math.floor((turn - 1) / 60)).padStart(2, "0")}:${String((turn - 1) % 60).padStart(2, "0")}.000Z`,
      triggers: [ruleOverrideTrigger(identity, `rule-${turn}`, `fixture override ${turn}`)],
      history, policy: DEFAULT_CONFIGURATION.verification.interaction,
    });
    if (decision.request !== undefined) {
      questionTurns.push(turn);
      history.push({
        confirmationId: decision.request.confirmationId, triggerId: decision.request.triggerId,
        sessionId: identity.sessionId, turnId: identity.turnId, turnOrdinal: turn,
      });
    }
  }
  let maxQuestions = 0;
  for (let start = 1; start <= fixture.turns - 19; start += 1) {
    maxQuestions = Math.max(maxQuestions, questionTurns.filter((turn) => turn >= start && turn < start + 20).length);
  }
  const noHumanRate = (fixture.turns - questionTurns.length) / fixture.turns;
  assert.deepEqual(questionTurns, [1, 21, 41, 61, 81]);

  const verifier = new ClosureVerifier();
  let violationSuccesses = 0;
  for (const turn of fixture.declaredViolationTurns) {
    const result = await verifier.verify(closureInput(turn, { boundary: true }), DEFAULT_CONFIGURATION.closure);
    if (result.decision === "PASS") violationSuccesses += 1;
  }
  const violationSuccessRate = violationSuccesses / fixture.declaredViolationTurns.length;

  const stop = new StopContinuationService(
    { verify: (input, policy) => verifier.verify(input, policy) }, undefined,
    { load: async () => ({ traceId: "unused", items: [] }) },
    new InMemoryContinuationCounter(), DEFAULT_CONFIGURATION.closure, { outerHookTimeoutMs: 5_000 },
  );
  let continuations = 0;
  let loops = 0;
  for (let turn = 1; turn <= fixture.turns; turn += 1) {
    const shouldContinue = fixture.continuationTurns.includes(turn);
    const input = closureInput(turn, { failed: shouldContinue });
    const hook = {
      hook_event_name: "Stop", session_id: "session-p6", turn_id: `turn-${turn}`, cwd: "/workspace/p6",
      stop_hook_active: false, last_assistant_message: "Fixture conclusion.",
    };
    const result = await stop.handle({ hook, closureInput: input });
    if (result.status === "CONTINUED_WITH_CORRECTION") {
      continuations += 1;
      const recursive = await stop.handle({ hook: { ...hook, stop_hook_active: true }, closureInput: input });
      if (recursive.status.startsWith("CONTINUED")) loops += 1;
    }
  }
  const averageContinuations = continuations / fixture.turns;

  const feedback = new SqliteFeedbackStore(":memory:");
  feedback.record({
    eventId: "feedback-suppress", assetId: "knowledge-suppressed", scopeKey: projectScopeKey,
    action: "SUPPRESS", traceId: "trace-suppress", actor: "user", occurredAt: "2026-08-02T06:00:00.000Z",
  });
  const projected = {
    asset: {
      schemaVersion: 1, id: "knowledge-suppressed", subjectKey: "knowledge-suppressed", kind: "IMPLEMENTATION",
      scope: { level: "PROJECT", projectId: project.projectId }, version: 1, status: "IMPLEMENTED",
      title: "Suppressed", summary: "Suppressed fixture.", body: "Suppressed fixture body.", aliases: [], keywords: [],
      applicability: [], nonApplicability: [], symbols: ["SuppressedSymbol"], relations: [], evidence: [], confidence: 0.9,
      sourceEpisodes: ["episode-p6"], contentHash: "sha256_suppressed", correlationId: "correlation-p6",
      createdAt: "2026-08-02T06:00:00.000Z", updatedAt: "2026-08-02T06:00:00.000Z",
    }, tombstone: false, indexVersion: 1,
  };
  const source = {
    listCurrent: () => [projected], getCurrent: () => projected, searchFts: () => [], related: () => [],
  };
  let repeats = 0;
  for (let index = 0; index < fixture.suppressionChecks; index += 1) {
    const profile = feedback.profile(projectScopeKey);
    const result = await new MultiChannelRetrievalEngine(source, undefined, {
      channels: { fts: false, vector: false, relation: false },
    }).retrieve({
      context: resolveQueryContext({ prompt: "symbol SuppressedSymbol", project }),
      policy: DEFAULT_CONFIGURATION.retrieval,
      feedback: profile,
    });
    if (result.items.some((item) => item.asset.id === projected.asset.id)) repeats += 1;
  }
  feedback.close();
  const suppressRepeatRate = repeats / fixture.suppressionChecks;

  assert.equal(noHumanRate, 0.95);
  assert.equal(suppressRepeatRate, 0);
  assert.equal(loops, 0);
  assert.equal(averageContinuations, 0.1);
  assert.equal(violationSuccessRate, 0);
  assert.ok(maxQuestions <= fixture.thresholds.maxQuestionsPerTwentyTurns);
  assert.ok(noHumanRate >= fixture.thresholds.minimumNoHumanRate);
  assert.ok(suppressRepeatRate < fixture.thresholds.maximumSuppressRepeatRate);
  assert.ok(loops <= fixture.thresholds.maximumLoops);
  assert.ok(averageContinuations <= fixture.thresholds.maximumAverageContinuations);
  assert.ok(violationSuccessRate < fixture.thresholds.maximumViolationSuccessRate);
});
