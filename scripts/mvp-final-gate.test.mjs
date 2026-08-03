import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteCandidateRepository } from "../packages/candidate-repository/dist/index.js";
import {
  InjectionRolloutController,
  UserPromptInjectionService,
  serializeUserPromptHookResult,
} from "../packages/codex-context-injection/dist/index.js";
import { DEFAULT_CONFIGURATION } from "../packages/config/dist/index.js";
import { ContextOrchestrator } from "../packages/context-orchestrator/dist/index.js";
import { normalizeConversations } from "../packages/conversation-normalizer/dist/index.js";
import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";
import { ClosureVerifier } from "../packages/closure-verifier/dist/index.js";
import { buildEpisodes } from "../packages/episode-builder/dist/index.js";
import { createMvpVerifierRegistry } from "../packages/evidence-engine/dist/index.js";
import { evaluateEvidencePolicy } from "../packages/evidence-policy/dist/index.js";
import { adaptCodexHook } from "../packages/ingestion-codex/dist/index.js";
import { KnowledgeMcpService } from "../packages/knowledge-mcp/dist/index.js";
import { SqliteKnowledgeRegistryProjection } from "../packages/knowledge-registry/dist/index.js";
import { KnowledgeReranker } from "../packages/knowledge-reranker/dist/index.js";
import {
  DEFAULT_MVP_COMPILER_VERSION,
  DEFAULT_MVP_PROMPT_VERSION,
  MvpKnowledgeCompiler,
  runKnowledgeExtraction,
  toKnowledgeExtractionInput,
} from "../packages/knowledge-compiler/dist/index.js";
import {
  calculateKnowledgeContentHash,
  MarkdownKnowledgeRepository,
} from "../packages/markdown-repository/dist/index.js";
import { resolveQueryContext } from "../packages/query-context/dist/index.js";
import {
  buildRetrievalTrace,
  fingerprintRetrievalConfiguration,
} from "../packages/retrieval-evaluation/dist/index.js";
import {
  MultiChannelRetrievalEngine,
  SqliteKnowledgeRetrievalSource,
} from "../packages/retrieval-engine/dist/index.js";
import { resolveKnowledgeScope } from "../packages/scope-resolver/dist/index.js";
import {
  InMemoryContinuationCounter,
  StopContinuationService,
} from "../packages/stop-continuation/dist/index.js";

const at = "2026-08-02T22:00:00.000Z";
const taskId = "mvp-final-turn";
const prompt = "traceable compiler";
const project = {
  projectId: "project-mvp-final",
  repositoryRoot: "/fixture/zhiloop",
  repositoryRemote: "github.com/smarteacup/zhiloop",
  branch: "main",
  portable: true,
};
const otherProject = {
  projectId: "project-mvp-other",
  repositoryRoot: "/fixture/other",
  repositoryRemote: "github.com/example/other",
  branch: "main",
  portable: true,
};
const projectScope = {
  level: "PROJECT",
  projectId: project.projectId,
  repositoryRemote: project.repositoryRemote,
};

async function capturedEpisode() {
  const rows = (await readFile("fixtures/p2/v1/codex-hook-knowledge-session.jsonl", "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const events = rows.map((row, index) => {
    const adapted = adaptCodexHook(row.hook, { observedAt: row.observedAt });
    assert.equal(adapted.ok, true, `Hook row ${index + 1} must adapt`);
    return adapted.value;
  });
  const ledger = new SqliteEventLedger(":memory:", { clock: () => new Date(at) });
  ledger.appendBatch(events);
  const records = ledger.readAfter(0, 100);
  const normalized = normalizeConversations(records, { asOf: at });
  const episode = buildEpisodes(records, normalized.sessions, { projectResolver: () => project }).episodes[0];
  assert.ok(episode);
  assert.equal(episode.status, "COMPLETED");
  return { ledger, records, normalized, episode };
}

function extractionModel() {
  return {
    generate: async (request) => {
      const input = request.input;
      const acceptedRef = input.corrections[0]?.correctedRef;
      const codeRef = input.actions.find((action) => action.kind === "TOOL")?.sourceRefs[0];
      const testRef = input.actions.find((action) => action.kind === "COMMAND")?.sourceRefs[0];
      assert.ok(acceptedRef && codeRef && testRef);
      const accepted = [{ kind: "USER_ACCEPTED", parameters: { statementRef: acceptedRef } }];
      const code = {
        kind: "SYMBOL_EXISTS",
        parameters: {
          projectId: input.projectContext.projectId,
          symbol: "TraceableKnowledgeCompiler",
          path: "packages/compiler.ts",
        },
      };
      const relatedTest = { kind: "TEST_PASSED", parameters: { testId: "npm-test" } };
      const common = {
        scopeHint: {
          level: "PROJECT",
          projectId: input.projectContext.projectId,
          repositoryRemote: input.projectContext.repositoryRemote,
          reasonCodes: ["MVP_FINAL_SAME_EPISODE"],
        },
        confidence: 0.96,
      };
      return {
        schemaVersion: 1,
        candidates: [
          {
            ...common,
            subjectKey: "requirement.compiler.recall-gate",
            kind: "REQUIREMENT",
            title: "Recall gate",
            summary: "Accepted knowledge only.",
            body: "The traceable compiler gate excludes PROPOSED records from formal recall.",
            assertions: accepted,
            evidenceHints: [{ type: "USER_STATEMENT", sourceRef: acceptedRef, projectId: project.projectId }],
          },
          {
            ...common,
            subjectKey: "design.compiler.episode-pipeline",
            kind: "DESIGN",
            title: "Episode pipeline",
            summary: "One traceable Episode.",
            body: "The traceable compiler uses one Episode and preserves source references across the gate.",
            assertions: accepted,
            evidenceHints: [{ type: "USER_STATEMENT", sourceRef: acceptedRef, projectId: project.projectId }],
          },
          {
            ...common,
            subjectKey: "decision.compiler.markdown-authority",
            kind: "DECISION",
            title: "Markdown authority",
            summary: "SQLite is a projection.",
            body: "The traceable compiler decision publishes Markdown before projecting the retrieval gate.",
            assertions: accepted,
            evidenceHints: [{ type: "USER_STATEMENT", sourceRef: acceptedRef, projectId: project.projectId }],
          },
          {
            ...common,
            subjectKey: "implementation.compiler.five-kinds",
            kind: "IMPLEMENTATION",
            title: "Five-kind compiler",
            summary: "Code and test observed.",
            body: "The traceable compiler implementation records code and test evidence before the gate publishes it.",
            assertions: [code, relatedTest],
            evidenceHints: [
              { type: "CODE_SYMBOL", sourceRef: codeRef, projectId: project.projectId },
              { type: "TEST_RESULT", sourceRef: testRef, projectId: project.projectId },
            ],
          },
          {
            ...common,
            subjectKey: "experience.compiler.single-flow-gate",
            kind: "EXPERIENCE",
            title: "Single-flow Gate",
            summary: "One integration scenario.",
            body: "The traceable compiler experience requires both code and related test evidence in one gate.",
            assertions: [code, relatedTest],
            evidenceHints: [
              { type: "CODE_SYMBOL", sourceRef: codeRef, projectId: project.projectId },
              { type: "TEST_RESULT", sourceRef: testRef, projectId: project.projectId },
            ],
          },
        ],
      };
    },
  };
}

function assertionTarget(assertion) {
  if (assertion.kind === "USER_ACCEPTED") return `statement:${assertion.parameters.statementRef}`;
  if (assertion.kind === "SYMBOL_EXISTS") {
    return `symbol:${assertion.parameters.projectId}:${assertion.parameters.symbol}:${assertion.parameters.path}`;
  }
  if (assertion.kind === "TEST_PASSED") return `test:${assertion.parameters.testId}`;
  throw new Error(`Unexpected final Gate assertion ${assertion.kind}`);
}

function supportingProbe(sourceRef) {
  return {
    observe: async (assertion) => ({
      status: "SUPPORTED",
      sourceRef,
      observedAt: at,
      target: assertionTarget(assertion),
      reasonCode: "SUPPORTED_BY_MVP_FINAL_EPISODE",
      details: { gate: "MVP_FINAL", sameEpisode: true },
    }),
  };
}

async function verifyAndDecide(candidates, extractionInput) {
  const codeRef = extractionInput.actions.find((action) => action.kind === "TOOL")?.sourceRefs[0];
  const testRef = extractionInput.actions.find((action) => action.kind === "COMMAND")?.sourceRefs[0];
  const acceptedRef = extractionInput.corrections[0]?.correctedRef;
  assert.ok(codeRef && testRef && acceptedRef);
  const registry = createMvpVerifierRegistry();
  const output = [];
  for (const candidate of candidates) {
    const resolved = resolveKnowledgeScope({ candidate, projectContext: project });
    const verificationResults = await registry.verifyAll(candidate.assertions, {
      project,
      correlationId: candidate.correlationId,
      requestedAt: at,
      probes: {
        user: supportingProbe(acceptedRef),
        symbol: supportingProbe(codeRef),
        test: supportingProbe(testRef),
      },
    });
    const decision = evaluateEvidencePolicy({
      candidate,
      currentStatus: "PROPOSED",
      resolvedScope: resolved.scope,
      projectScope,
      projectSpecificSignals: resolved.projectSpecificSignals,
      verificationResults,
      verificationPolicy: DEFAULT_CONFIGURATION.verification,
    });
    output.push({ candidate, verificationResults, decision });
  }
  return output;
}

function assetFrom(value) {
  const draft = {
    schemaVersion: 1,
    id: value.candidate.subjectKey,
    subjectKey: value.candidate.subjectKey,
    kind: value.candidate.kind,
    scope: value.decision.effectiveScope,
    version: 1,
    status: value.decision.targetStatus,
    title: value.candidate.title,
    summary: value.candidate.summary,
    body: value.candidate.body,
    aliases: ["traceable compiler"],
    keywords: ["traceable", "compiler", "gate"],
    applicability: [],
    nonApplicability: [],
    symbols: value.candidate.kind === "IMPLEMENTATION" || value.candidate.kind === "EXPERIENCE"
      ? ["TraceableKnowledgeCompiler"] : [],
    relations: value.candidate.kind === "DECISION" ? [] : [{
      type: "RELATED_TO",
      targetId: "decision.compiler.markdown-authority",
      targetVersion: 1,
      reason: "same compiled Episode",
    }],
    evidence: value.verificationResults.flatMap((result) => result.evidence === undefined ? [] : [{
      evidenceId: result.evidence.evidenceId,
      verdict: result.evidence.verdict,
    }]),
    confidence: value.candidate.confidence,
    sourceEpisodes: value.candidate.sourceEpisodes,
    contentHash: "",
    correlationId: value.candidate.correlationId,
    createdAt: value.candidate.createdAt,
    updatedAt: at,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

function otherProjectControl() {
  const draft = {
    schemaVersion: 1,
    id: "implementation.other.traceable-compiler",
    subjectKey: "implementation.other.traceable-compiler",
    kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: otherProject.projectId, repositoryRemote: otherProject.repositoryRemote },
    version: 1,
    status: "IMPLEMENTED",
    title: "Other project traceable compiler",
    summary: "Cross-project isolation control.",
    body: "This traceable compiler gate belongs only to the other project.",
    aliases: ["traceable compiler"],
    keywords: ["traceable", "compiler", "gate"],
    applicability: ["project-mvp-other"],
    nonApplicability: ["project-mvp-final"],
    symbols: ["OtherCompiler"],
    relations: [],
    evidence: [{ evidenceId: "evidence-other-control", verdict: "SUPPORTS" }],
    confidence: 0.9,
    sourceEpisodes: ["episode-other-control"],
    contentHash: "",
    correlationId: "mvp-final-control",
    createdAt: at,
    updatedAt: at,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

function taskContract() {
  return {
    contractId: "contract-mvp-final",
    objective: "Finish the traceable compiler without crossing project boundaries.",
    gates: ["code-change", "related-test", "release-gate"],
    boundaries: ["do-not-change-generated"],
  };
}

function activeContext(registry, requestedProject, requestedTaskId, runId) {
  const queryContext = resolveQueryContext({
    prompt,
    project: requestedProject,
    cwd: requestedProject.repositoryRoot,
    taskId: requestedTaskId,
  });
  const engine = new MultiChannelRetrievalEngine(
    new SqliteKnowledgeRetrievalSource(registry),
    undefined,
    { channels: { exact: true, fts: true, vector: false, relation: true } },
  );
  return {
    queryContext,
    execute: async () => {
      const retrieval = await engine.retrieve({ context: queryContext, policy: DEFAULT_CONFIGURATION.retrieval });
      const rerank = await new KnowledgeReranker().rerank(queryContext, retrieval.items);
      const envelope = new ContextOrchestrator().orchestrate({
        runId,
        queryContext,
        candidates: rerank.items,
        policy: DEFAULT_CONFIGURATION.injection,
        signals: { risk: "LOW", ambiguous: false, conflicting: false },
        taskContract: taskContract(),
      });
      const trace = buildRetrievalTrace({
        traceId: `trace-${runId}`,
        runId,
        queryContext,
        retrieval,
        rerank,
        envelope,
        signals: { risk: "LOW", ambiguous: false, conflicting: false },
        automatic: true,
      });
      return { retrieval, rerank, envelope, trace };
    },
  };
}

function mcpBackend(registry) {
  const current = (assetIds) => assetIds.flatMap((id) => {
    const value = registry.getAsset(id, true);
    return value === undefined || value.tombstone ? [] : [value.asset];
  });
  return {
    search: async ({ query, limit }) => ({
      traceId: "trace-mcp-search",
      assets: registry.search(query, { limit, includeInactive: true }).map((item) => item.asset),
    }),
    related: async () => ({ traceId: "trace-mcp-related", assets: [] }),
    current: async ({ assetIds }) => ({ traceId: "trace-mcp-current", assets: current(assetIds) }),
  };
}

test("MVP final Gate: one Codex task flows through capture, compile, verification, publication, recall, injection, expansion, and bounded closure", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-mvp-final-gate-"));
  const captured = await capturedEpisode();
  const candidateRepository = new SqliteCandidateRepository(":memory:", {
    clock: () => new Date(at),
    tokenFactory: () => "mvp-final-claim",
  });
  let registry;
  try {
    const extractionInput = toKnowledgeExtractionInput(captured.episode);
    assert.deepEqual(extractionInput.actions.map((action) => action.kind), ["TOOL", "COMMAND"]);
    assert.equal(extractionInput.outcomes.filter((outcome) => outcome.kind === "SUCCESS").length, 2);
    const extractionRequest = {
      input: extractionInput,
      compilerVersion: DEFAULT_MVP_COMPILER_VERSION,
      promptVersion: DEFAULT_MVP_PROMPT_VERSION,
      requestedAt: at,
      correlationId: "mvp-final-correlation",
    };
    const claim = candidateRepository.claim(extractionRequest);
    assert.equal(claim.status, "ACQUIRED");
    if (claim.status !== "ACQUIRED") throw new Error("final Gate extraction claim was not acquired");
    const compiled = await runKnowledgeExtraction(
      extractionRequest,
      new MvpKnowledgeCompiler({ model: extractionModel() }),
      { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 },
    );
    assert.equal(compiled.status, "SUCCEEDED");
    assert.deepEqual(compiled.candidates.map((candidate) => candidate.kind), [
      "REQUIREMENT", "DESIGN", "DECISION", "IMPLEMENTATION", "EXPERIENCE",
    ]);
    const stored = candidateRepository.saveResult(claim.claimToken, compiled);
    assert.equal(stored.status, "SUCCEEDED");
    assert.equal(stored.candidates.every((candidate) => candidate.sourceEpisodes[0] === captured.episode.episodeId), true);

    const eventToTurn = new Map(captured.normalized.sessions.flatMap((session) => session.turns.flatMap((turn) => (
      turn.events.map((event) => [event.eventId, turn.turnId])
    ))));
    for (const candidate of stored.candidates) {
      for (const hint of candidate.evidenceHints) {
        assert.equal(captured.episode.evidenceRefs.includes(hint.sourceRef), true);
        assert.equal(captured.episode.turnIds.includes(eventToTurn.get(hint.sourceRef)), true);
      }
    }

    const evaluated = await verifyAndDecide(stored.candidates, extractionInput);
    const byKind = new Map(evaluated.map((value) => [value.candidate.kind, value]));
    assert.equal(byKind.get("REQUIREMENT")?.decision.targetStatus, "ACCEPTED");
    assert.equal(byKind.get("DESIGN")?.decision.targetStatus, "ACCEPTED");
    assert.equal(byKind.get("DECISION")?.decision.targetStatus, "ACCEPTED");
    assert.equal(byKind.get("IMPLEMENTATION")?.decision.targetStatus, "IMPLEMENTED");
    assert.equal(byKind.get("EXPERIENCE")?.decision.targetStatus, "VERIFIED");
    assert.equal(byKind.get("IMPLEMENTATION")?.verificationResults.every((value) => value.status === "SUPPORTED"), true);
    assert.equal(byKind.get("EXPERIENCE")?.verificationResults.every((value) => value.status === "SUPPORTED"), true);
    assert.equal(evaluated.every((value) => value.decision.shouldPublish), true);
    assert.equal(evaluated.every((value) => value.decision.action !== "ASK_USER" && value.decision.interaction === "NONE"), true);
    assert.equal(DEFAULT_CONFIGURATION.verification.interaction.createReviewTasks, false);

    const assets = evaluated.map(assetFrom);
    const markdown = new MarkdownKnowledgeRepository(path.join(temporaryRoot, "knowledge"));
    const published = [];
    for (const asset of [...assets, otherProjectControl()]) {
      published.push((await markdown.publish(asset, { expectedCurrentVersion: 0 })).value);
    }
    const implementationDocument = published.find((value) => value.asset.id === "implementation.compiler.five-kinds");
    assert.ok(implementationDocument);
    const readable = await readFile(implementationDocument.documentPath, "utf8");
    assert.match(readable, /^---\n/u);
    assert.match(readable, /status: IMPLEMENTED/u);
    assert.match(readable, /traceable compiler implementation/u);

    registry = new SqliteKnowledgeRegistryProjection(path.join(temporaryRoot, "registry.sqlite"));
    for (const document of published) registry.projectCurrent(document);
    assert.equal(registry.search(prompt, { limit: 20 }).length, 6);

    const sameProject = activeContext(registry, project, taskId, "run-mvp-final");
    const same = await sameProject.execute();
    assert.equal(same.retrieval.items.length, 5);
    assert.equal(same.retrieval.items.every((item) => "projectId" in item.asset.scope
      && item.asset.scope.projectId === project.projectId), true);
    assert.equal(same.retrieval.diagnostics.some((item) => item.code === "SCOPE_FILTERED"
      && item.assetId === "implementation.other.traceable-compiler"), true);
    assert.equal(same.envelope.complexity.level, "L2_COMPACT");
    assert.equal(same.envelope.items.length, 4);
    assert.equal(same.envelope.budget.estimatedTokens <= DEFAULT_CONFIGURATION.injection.defaultMaxTokens, true);
    assert.equal(same.envelope.budget.truncated, true);
    assert.equal(same.envelope.items.filter((item) => item.authority === "BINDING_RULE")
      .every((item) => item.detailLevel === "L2_COMPACT"), true);
    assert.equal(same.envelope.items.filter((item) => item.authority !== "BINDING_RULE")
      .every((item) => item.detailLevel === "L1_POINTER"), true);
    assert.deepEqual(new Set(same.envelope.items.map((item) => item.authority)), new Set([
      "BINDING_RULE", "ACCEPTED_DECISION", "REFERENCE",
    ]));
    assert.equal(same.envelope.taskContract?.contractId, "contract-mvp-final");

    const other = await activeContext(registry, otherProject, taskId, "run-mvp-other").execute();
    assert.deepEqual(other.retrieval.items.map((item) => item.asset.id), ["implementation.other.traceable-compiler"]);
    assert.equal(other.retrieval.diagnostics.filter((item) => item.code === "SCOPE_FILTERED").length >= 5, true);

    assert.equal(same.trace.results.every((result) => result.contributions.length > 0
      && result.contributions.every((contribution) => contribution.reason.length > 0)
      && result.evidenceIds.length > 0 && result.sourceEpisodes.includes(captured.episode.episodeId)), true);
    assert.equal(same.trace.complexity.reasonCodes.includes("RISK_LOW"), true);
    assert.equal(same.trace.complexity.reasonCodes.includes("AMBIGUITY_ABSENT"), true);
    assert.equal(same.trace.complexity.reasonCodes.includes("CONFLICT_ABSENT"), true);
    assert.equal(same.trace.complexity.reasonCodes.some((reason) => reason.startsWith("BUDGET_")), true);

    const rollout = new InjectionRolloutController();
    rollout.activate(1, "ACTIVE", {
      datasetId: "mvp-final-single-flow",
      datasetVersion: 1,
      configFingerprint: fingerprintRetrievalConfiguration({
        retrieval: DEFAULT_CONFIGURATION.retrieval,
        injection: DEFAULT_CONFIGURATION.injection,
      }),
      defaultInjectionAllowed: true,
    });
    let liveContext;
    const injection = await new UserPromptInjectionService({
      retrieve: async (request) => {
        assert.equal(request.prompt, prompt);
        liveContext = await sameProject.execute();
        return { envelope: liveContext.envelope, trace: liveContext.trace };
      },
    }, rollout).handle({
      hook_event_name: "UserPromptSubmit",
      session_id: "mvp-final-session",
      turn_id: taskId,
      cwd: project.repositoryRoot,
      prompt,
    });
    assert.equal(injection.status, "INJECTED");
    assert.match(serializeUserPromptHookResult(injection), /L2_COMPACT/u);
    assert.match(injection.output.hookSpecificOutput.additionalContext, /BINDING_RULE/u);
    assert.doesNotMatch(injection.output.hookSpecificOutput.additionalContext, /implementation\.other\.traceable-compiler/u);

    const mcp = new KnowledgeMcpService(mcpBackend(registry));
    const mcpSearch = await mcp.search({ query: prompt, limit: 8 }, sameProject.queryContext, new AbortController().signal);
    assert.equal(mcpSearch.items.length, 5);
    assert.equal(mcpSearch.items.every((item) => item.detailLevel === "L1_POINTER"), true);
    assert.deepEqual(new Set(mcpSearch.items.map((item) => item.authority)), new Set([
      "BINDING_RULE", "ACCEPTED_DECISION", "REFERENCE",
    ]));
    const expandable = liveContext.envelope.items.find((item) => item.kind === "EXPERIENCE");
    assert.ok(expandable);
    const expanded = await mcp.get({
      id: expandable.id,
      version: expandable.version,
      fromDetailLevel: expandable.detailLevel,
      targetDetailLevel: "L3_EVIDENCED",
    }, sameProject.queryContext, new AbortController().signal);
    assert.equal(expanded.items[0]?.toDetailLevel, "L3_EVIDENCED");
    assert.match(expanded.items[0]?.content ?? "", /both code and related test evidence/u);
    assert.equal(expanded.items[0]?.evidenceSummary.length >= 2, true);

    const closureInput = {
      verificationId: "verification-mvp-final",
      task: {
        taskId,
        objective: taskContract().objective,
        gates: [
          { gateId: "code-change", description: "Compiler implementation changed", type: "PATH_CHANGED", path: "packages/compiler.ts" },
          { gateId: "related-test", description: "Related npm test passed", type: "TEST_PASSED", testId: "npm-test" },
          { gateId: "release-gate", description: "Final regression gate passed", type: "TEST_PASSED", testId: "mvp-final-regression" },
        ],
        boundaries: [{ boundaryId: "do-not-change-generated", type: "FORBID_PATH_PREFIX", pathPrefix: "generated" }],
        requiredKnowledge: [{ knowledgeId: expandable.id, minimumDetailLevel: "L2_COMPACT" }],
      },
      contextEnvelope: liveContext.envelope,
      diff: { changedPaths: ["packages/compiler.ts"], summary: "Implemented traceable compiler." },
      toolResults: [],
      tests: [
        { testId: "npm-test", status: "PASSED", summary: "Related session test passed." },
        { testId: "mvp-final-regression", status: "NOT_RUN", summary: "Missing final gate evidence." },
      ],
      finalConclusion: { claimedComplete: true, summary: "Implementation is complete.", openIssues: [] },
    };
    const closure = new ClosureVerifier();
    const counters = new InMemoryContinuationCounter();
    const stop = new StopContinuationService(
      { verify: (input, policy) => closure.verify(input, policy) },
      undefined,
      { load: async () => ({ traceId: "unused-context-delta", items: [] }) },
      counters,
      DEFAULT_CONFIGURATION.closure,
      { outerHookTimeoutMs: 5_000 },
    );
    const stopHook = {
      hook_event_name: "Stop",
      session_id: "mvp-final-session",
      turn_id: taskId,
      cwd: project.repositoryRoot,
      stop_hook_active: false,
      last_assistant_message: "Implementation is complete.",
    };
    const firstStop = await stop.handle({ hook: stopHook, closureInput });
    assert.equal(firstStop.status, "CONTINUED_WITH_CORRECTION");
    assert.equal(firstStop.continuationCount, 1);
    assert.match(firstStop.output.reason, /release-gate/u);
    assert.match(firstStop.output.reason, /Do not expand the original task/u);
    assert.doesNotMatch(firstStop.output.reason, /knowledgeDelta|traceable compiler experience/u);
    const recursiveStop = await stop.handle({
      hook: { ...stopHook, stop_hook_active: true },
      closureInput,
    });
    assert.deepEqual(recursiveStop, { status: "HOOK_ALREADY_ACTIVE", continuationCount: 1 });
    const thirdStop = await stop.handle({ hook: stopHook, closureInput });
    assert.equal(thirdStop.status, "LIMIT_REACHED");
    assert.equal(thirdStop.continuationCount, 1);
  } finally {
    registry?.close();
    candidateRepository.close();
    captured.ledger.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
