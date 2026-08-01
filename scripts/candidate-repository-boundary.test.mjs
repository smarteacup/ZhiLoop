import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteCandidateRepository } from "../packages/candidate-repository/dist/index.js";
import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";
import {
  runKnowledgeExtraction,
  toKnowledgeExtractionInput,
} from "../packages/knowledge-compiler/dist/index.js";

test("Candidate Repository is a storage adapter without model, retrieval, or publishing runtime", async () => {
  const source = await readFile("packages/candidate-repository/src/repository.ts", "utf8");
  assert.match(source, /from\s+["']node:sqlite["']/);
  assert.doesNotMatch(source, /openai|anthropic|gemini|vector|fts5|publisher|markdown/i);
  assert.doesNotMatch(source, /runKnowledgeExtraction|StructuredGenerationModel/);
});

test("CKL-205: claim, compile, and atomic save coexist with the immutable Event Ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhiloop-candidate-boundary-"));
  const filename = join(directory, "knowledge.db");
  const ledger = new SqliteEventLedger(filename, { clock: () => new Date("2026-08-01T09:00:00.000Z") });
  const repository = new SqliteCandidateRepository(filename, {
    clock: () => new Date("2026-08-01T09:00:00.000Z"),
    tokenFactory: () => "boundary-entropy",
  });
  try {
    ledger.append({
      schemaVersion: 1,
      eventId: "event-goal",
      source: "codex-hook",
      eventType: "user.prompted",
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: "2026-08-01T08:00:00.000Z",
      contentHash: "event-content-hash",
      correlationId: "correlation-1",
      payload: { kind: "user-prompt", prompt: "Persist candidates" },
    });
    const extractionRequest = request();
    const claim = repository.claim(extractionRequest);
    assert.equal(claim.status, "ACQUIRED");
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");

    const result = await runKnowledgeExtraction(extractionRequest, {
      extract: async () => ({
        schemaVersion: 1,
        candidates: [{
          subjectKey: "design.candidate.repository",
          kind: "DESIGN",
          scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["BOUNDARY_TEST"] },
          title: "Use an atomic Candidate Repository",
          summary: "Claim compilation work before invoking a model.",
          body: "Save the complete validated batch in one transaction.",
          confidence: 0.9,
          assertions: [],
          evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-goal" }],
        }],
      }),
    }, { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 });
    assert.equal(result.status, "SUCCEEDED");
    const stored = repository.saveResult(claim.claimToken, result);

    assert.equal(stored.status, "SUCCEEDED");
    assert.equal(stored.candidates.length, 1);
    assert.equal(repository.claim(extractionRequest).status, "ALREADY_SUCCEEDED");
    assert.deepEqual(repository.listCandidates(), []);
    assert.equal(repository.listCandidates({ includeProposed: true }).length, 1);
    assert.equal(ledger.count(), 1);
    assert.equal(ledger.readAfter(0)[0].event.eventId, "event-goal");
  } finally {
    repository.close();
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function request() {
  return {
    input: toKnowledgeExtractionInput({
      episodeId: "episode-1",
      builderVersion: "episode-builder-v2",
      sessionIds: ["session-1"],
      turnIds: ["turn-1"],
      projectContext: { projectId: "project-1", repositoryRoot: "/private/repo", portable: false },
      goal: "Persist candidates",
      goalRef: "event-goal",
      subgoals: [],
      userStatements: [{
        turnId: "turn-1",
        sourceEventId: "event-goal",
        kind: "GOAL",
        statement: "Persist candidates",
        occurredAt: "2026-08-01T08:00:00.000Z",
      }],
      userCorrections: [],
      actions: [],
      artifacts: [],
      outcomes: [],
      evidenceRefs: ["event-goal"],
      status: "COMPLETED",
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T08:01:00.000Z",
    }),
    compilerVersion: "compiler-v1",
    promptVersion: "prompt-v1",
    requestedAt: "2026-08-01T09:00:00.000Z",
    correlationId: "correlation-1",
  };
}
