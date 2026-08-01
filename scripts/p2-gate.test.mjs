import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SqliteCandidateRepository } from "../packages/candidate-repository/dist/index.js";
import { normalizeConversations } from "../packages/conversation-normalizer/dist/index.js";
import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";
import { buildEpisodes } from "../packages/episode-builder/dist/index.js";
import { adaptCodexHook } from "../packages/ingestion-codex/dist/index.js";
import {
  DEFAULT_MVP_COMPILER_VERSION,
  DEFAULT_MVP_PROMPT_VERSION,
  MvpKnowledgeCompiler,
  detectUserCommitments,
  runKnowledgeExtraction,
  toKnowledgeExtractionInput,
} from "../packages/knowledge-compiler/dist/index.js";

const fixtureDirectory = path.resolve("fixtures/p2/v1");

async function loadGolden() {
  const [jsonl, expectedText] = await Promise.all([
    readFile(path.join(fixtureDirectory, "codex-hook-knowledge-session.jsonl"), "utf8"),
    readFile(path.join(fixtureDirectory, "expected.json"), "utf8"),
  ]);
  const rows = jsonl.trim().split("\n").map((line, index) => {
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed.observedAt, "string", `fixture line ${index + 1} observedAt`);
    assert.equal(typeof parsed.hook, "object", `fixture line ${index + 1} hook`);
    return parsed;
  });
  const expected = JSON.parse(expectedText);
  assert.equal(expected.schemaVersion, 1);
  assert.equal(expected.fixtureVersion, "p2-golden-v1");
  assert.equal(rows.length, expected.rows);
  return { rows, expected };
}

function adaptRows(rows) {
  return rows.map((row, index) => {
    const adapted = adaptCodexHook(row.hook, { observedAt: row.observedAt });
    assert.equal(adapted.ok, true, `fixture line ${index + 1} must adapt`);
    return adapted.value;
  });
}

async function setupGolden() {
  const { rows, expected } = await loadGolden();
  const events = adaptRows(rows);
  const ledger = new SqliteEventLedger(":memory:", { clock: () => new Date("2026-08-01T11:00:00.000Z") });
  ledger.appendBatch(events);
  const records = ledger.readAfter(0, 100);
  const normalized = normalizeConversations(records, { asOf: "2026-08-01T11:00:00.000Z" });
  const built = buildEpisodes(records, normalized.sessions, {
    projectResolver: () => ({
      projectId: "project-p2-golden",
      repositoryRemote: "git@github.com:smarteacup/ZhiLoop.git",
      branch: "main",
      portable: true,
    }),
  });
  assert.equal(events.length, expected.events);
  assert.equal(records.length, expected.events);
  assert.equal(normalized.sessions.length, expected.sessions);
  assert.equal(normalized.sessions[0].turns.length, expected.turns);
  assert.equal(built.episodes.length, expected.episodes);
  const episode = built.episodes[0];
  assert.equal(episode.builderVersion, expected.builderVersion);
  assert.equal(episode.goal, expected.goal);
  assert.equal(episode.status, "COMPLETED");
  assert.equal(episode.userStatements.find((item) => item.kind === "CONTINUATION")?.statement, expected.acceptanceStatement);
  assert.equal(episode.userCorrections[0]?.correctedStatement, expected.correctionStatement);
  return { ledger, records, normalized, episode, expected };
}

function extractionRequest(episode) {
  return {
    input: toKnowledgeExtractionInput(episode),
    compilerVersion: DEFAULT_MVP_COMPILER_VERSION,
    promptVersion: DEFAULT_MVP_PROMPT_VERSION,
    requestedAt: "2026-08-01T11:00:00.000Z",
    correlationId: "p2-golden-correlation",
  };
}

function goldenModel() {
  return {
    generate: async (generationRequest) => {
      const input = generationRequest.input;
      const correction = input.corrections[0];
      const actionRef = input.actions.flatMap((action) => action.sourceRefs)[0];
      const outcomeRef = input.outcomes.flatMap((outcome) => outcome.evidenceRefs).at(-1);
      assert.ok(correction, "Golden input must contain the correction");
      assert.ok(actionRef, "Golden input must contain an action ref");
      assert.ok(outcomeRef, "Golden input must contain an outcome ref");
      const projectId = input.projectContext.projectId;
      const drafts = [
        {
          subjectKey: "requirement.retrieval.proposed-hidden",
          kind: "REQUIREMENT",
          title: "Keep PROPOSED candidates out of formal retrieval",
          summary: "Unaccepted candidates are available only to explicit audit flows.",
          body: "Formal retrieval must not consume PROPOSED Candidate records.",
          sourceRef: correction.correctedRef,
        },
        {
          subjectKey: "design.compiler.episode-pipeline",
          kind: "DESIGN",
          title: "Use an Episode-based knowledge compilation pipeline",
          summary: "Compile typed knowledge from a terminal, traceable Episode.",
          body: "The compiler consumes the minimal Episode projection and emits an atomic Candidate batch.",
          sourceRef: input.goalRef,
        },
        {
          subjectKey: "decision.storage.candidate-repository",
          kind: "DECISION",
          title: "Persist candidates before formal publication",
          summary: "Use a local Candidate Repository as the pre-publication record.",
          body: "Candidate persistence is separate from Markdown publication and formal retrieval.",
          sourceRef: correction.correctedRef,
        },
        {
          subjectKey: "implementation.compiler.five-kinds",
          kind: "IMPLEMENTATION",
          title: "Implement five MVP knowledge kinds",
          summary: "The implementation emits Requirement, Design, Decision, Implementation, and Experience.",
          body: "The recorded file/tool action is the observable implementation source.",
          sourceRef: actionRef,
        },
        {
          subjectKey: "experience.compiler.traceable-gate",
          kind: "EXPERIENCE",
          title: "Verify knowledge compilation with a traceable Gate",
          summary: "A Golden conversation catches integration gaps across module boundaries.",
          body: "Trace every Candidate source ref back to a normalized Turn and retain retryable failures.",
          sourceRef: outcomeRef,
        },
      ];
      return {
        schemaVersion: 1,
        candidates: drafts.map((draft) => ({
          subjectKey: draft.subjectKey,
          kind: draft.kind,
          scopeHint: { level: "PROJECT", projectId, reasonCodes: ["P2_GOLDEN_EPISODE"] },
          title: draft.title,
          summary: draft.summary,
          body: draft.body,
          confidence: 0.9,
          assertions: [],
          evidenceHints: [{ type: "USER_STATEMENT", sourceRef: draft.sourceRef, projectId }],
        })),
      };
    },
  };
}

function eventToTurn(normalized) {
  return new Map(normalized.sessions.flatMap((session) => session.turns.flatMap((turn) => (
    turn.events.map((event) => [event.eventId, turn.turnId])
  ))));
}

test("P2 Gate: Golden Codex conversation produces five persisted and Turn-traceable MVP kinds", async () => {
  const golden = await setupGolden();
  const repository = new SqliteCandidateRepository(":memory:", {
    clock: () => new Date("2026-08-01T11:00:00.000Z"),
    tokenFactory: () => "p2-golden-entropy",
  });
  try {
    const request = extractionRequest(golden.episode);
    const claim = repository.claim(request);
    assert.equal(claim.status, "ACQUIRED");
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    const result = await runKnowledgeExtraction(
      request,
      new MvpKnowledgeCompiler({ model: goldenModel() }),
      { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 },
    );
    assert.equal(result.status, "SUCCEEDED");
    assert.deepEqual(result.candidates.map((candidate) => candidate.kind), golden.expected.knowledgeKinds);
    const stored = repository.saveResult(claim.claimToken, result);
    assert.equal(stored.status, "SUCCEEDED");
    assert.equal(repository.claim(request).status, "ALREADY_SUCCEEDED");
    assert.deepEqual(repository.listCandidates(), [], "PROPOSED must be absent from default retrieval");

    const turnByEvent = eventToTurn(golden.normalized);
    for (const candidate of stored.candidates) {
      assert.equal(candidate.status, "PROPOSED");
      assert.deepEqual(candidate.sourceEpisodes, [golden.episode.episodeId]);
      assert.ok(candidate.evidenceHints.length > 0);
      for (const hint of candidate.evidenceHints) {
        const turnId = turnByEvent.get(hint.sourceRef);
        assert.ok(turnId, `${candidate.candidateId} source ${hint.sourceRef} must resolve to a Turn`);
        assert.ok(golden.episode.turnIds.includes(turnId));
        assert.ok(golden.episode.evidenceRefs.includes(hint.sourceRef));
      }
    }

    const commitments = detectUserCommitments(golden.episode, stored.candidates);
    assert.ok(commitments.signals.some((signal) => signal.kind === "CORRECTION" && signal.turnId === "p2-turn-3"));
    assert.ok(commitments.ambiguities.some((item) => item.kind === "USER_ACCEPTED"), "generic multi-target acceptance must stay gated");
  } finally {
    repository.close();
    golden.ledger.close();
  }
});

test("P2 Gate: model failure keeps Ledger/Episode intact and a persisted RETRYABLE batch recovers", async () => {
  const golden = await setupGolden();
  const repository = new SqliteCandidateRepository(":memory:", {
    clock: () => new Date("2026-08-01T11:00:00.000Z"),
    tokenFactory: () => "p2-retry-entropy",
  });
  try {
    const request = extractionRequest(golden.episode);
    const originalEpisodeJson = JSON.stringify(golden.episode);
    const originalEventCount = golden.ledger.count();
    const firstClaim = repository.claim(request);
    if (firstClaim.status !== "ACQUIRED") throw new Error("expected first claim");
    const failed = await runKnowledgeExtraction(
      request,
      new MvpKnowledgeCompiler({ model: { generate: async () => { throw new Error("simulated model outage"); } } }),
      { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 },
    );
    assert.equal(failed.status, "RETRYABLE");
    const retryable = repository.saveResult(firstClaim.claimToken, failed);
    assert.equal(retryable.status, "RETRYABLE");
    assert.equal(retryable.candidates.length, 0);
    assert.equal(golden.ledger.count(), originalEventCount);

    const rebuiltRecords = golden.ledger.readAfter(0, 100);
    const rebuiltNormalized = normalizeConversations(rebuiltRecords, { asOf: "2026-08-01T11:00:00.000Z" });
    const rebuiltEpisode = buildEpisodes(rebuiltRecords, rebuiltNormalized.sessions, {
      projectResolver: () => golden.episode.projectContext,
    }).episodes[0];
    assert.equal(JSON.stringify(rebuiltEpisode), originalEpisodeJson);

    const retryClaim = repository.claim(request);
    assert.equal(retryClaim.status, "ACQUIRED");
    if (retryClaim.status !== "ACQUIRED") throw new Error("expected retry claim");
    const recovered = await runKnowledgeExtraction(
      request,
      new MvpKnowledgeCompiler({ model: goldenModel() }),
      { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 },
    );
    assert.equal(recovered.status, "SUCCEEDED");
    const stored = repository.saveResult(retryClaim.claimToken, recovered);
    assert.equal(stored.status, "SUCCEEDED");
    assert.equal(stored.runCount, 2);
    assert.equal(stored.candidates.length, golden.expected.knowledgeKinds.length);
    assert.equal(golden.ledger.count(), originalEventCount);
  } finally {
    repository.close();
    golden.ledger.close();
  }
});
