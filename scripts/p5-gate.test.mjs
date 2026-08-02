import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { UserPromptInjectionService, InjectionRolloutController, serializeUserPromptHookResult } from "../packages/codex-context-injection/dist/index.js";
import { DEFAULT_CONFIGURATION } from "../packages/config/dist/index.js";
import { ContextOrchestrator } from "../packages/context-orchestrator/dist/index.js";
import { KnowledgeMcpService } from "../packages/knowledge-mcp/dist/index.js";
import { KnowledgeReranker } from "../packages/knowledge-reranker/dist/index.js";
import { resolveQueryContext } from "../packages/query-context/dist/index.js";
import { buildRetrievalTrace, GoldenDatasetRunner } from "../packages/retrieval-evaluation/dist/index.js";
import { MultiChannelRetrievalEngine } from "../packages/retrieval-engine/dist/index.js";

const at = "2026-08-02T20:00:00.000Z";
const project = { projectId: "project-a", repositoryRoot: "/workspace/a", branch: "main", portable: true };

function asset(id, scope = { level: "PROJECT", projectId: project.projectId }) {
  const kind = id.includes("rule") ? "RULE" : id.includes("decision") ? "DECISION" : "IMPLEMENTATION";
  const status = kind === "DECISION" ? "ACCEPTED" : "IMPLEMENTED";
  return {
    schemaVersion: 1, id, subjectKey: id, kind, scope, version: 1, status,
    title: id.replaceAll(".", " "), summary: `${id} is the relevant verified project context.`,
    body: `${id} implementation body with boundaries and failure handling.`, aliases: [], keywords: id.split("."),
    applicability: ["project-a"], nonApplicability: ["other projects"], symbols: [], relations: [],
    evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }], confidence: 0.95,
    sourceEpisodes: [`episode-${id}`], contentHash: `sha256_${id}`, correlationId: "p5-gate",
    createdAt: at, updatedAt: at,
  };
}

const projected = (value, index) => ({ asset: value, tombstone: false, indexVersion: index + 1 });

async function gateFixture() {
  const dataset = JSON.parse(await readFile("fixtures/p5/v1/retrieval-golden.json", "utf8"));
  const expectedIds = [...new Set(dataset.cases.flatMap((item) => item.expectedRelevantAssetIds))];
  const assets = expectedIds.map((id) => asset(id));
  assets.push(asset("knowledge.other.project", { level: "PROJECT", projectId: "project-b" }));
  const current = new Map(assets.map((value, index) => [value.id, projected(value, index)]));
  const expectedByPrompt = new Map(dataset.cases.map((item) => [
    item.query.prompt,
    item.expectedRelevantAssetIds.map((id) => current.get(id)),
  ]));
  const source = {
    listCurrent: () => [...current.values()],
    getCurrent: (id) => current.get(id),
    searchFts: (query, limit) => (expectedByPrompt.get(query) ?? []).slice(0, limit).map((value, index) => ({
      asset: value, rank: index + 1, rawScore: 1 / (index + 1), reason: `golden FTS rank ${index + 1}`,
    })),
    related: () => [],
  };
  const engine = new MultiChannelRetrievalEngine(source, undefined, {
    channels: { exact: false, fts: true, vector: false, relation: false },
  });
  const reranker = new KnowledgeReranker();
  const orchestrator = new ContextOrchestrator();
  const executions = new Map();
  const executor = {
    execute: async (testCase) => {
      const queryContext = resolveQueryContext(testCase.query);
      const retrieval = await engine.retrieve({ context: queryContext, policy: DEFAULT_CONFIGURATION.retrieval });
      const rerank = await reranker.rerank(queryContext, retrieval.items);
      const envelope = orchestrator.orchestrate({
        runId: `run-${testCase.caseId}`, queryContext, candidates: rerank.items,
        policy: DEFAULT_CONFIGURATION.injection, signals: { risk: "LOW", ambiguous: false, conflicting: false },
      });
      const trace = buildRetrievalTrace({
        traceId: `trace-${testCase.caseId}`, runId: envelope.runId, queryContext,
        retrieval, rerank, envelope,
        signals: { risk: "LOW", ambiguous: false, conflicting: false }, automatic: true,
      });
      executions.set(testCase.caseId, { queryContext, retrieval, rerank, envelope, trace });
      return trace;
    },
  };
  return { dataset, assets, executor, executions };
}

test("P5 Gate: fixed Golden Dataset meets retrieval, explainability, complexity, and injection gates", async () => {
  const fixture = await gateFixture();
  const configuration = {
    retrieval: DEFAULT_CONFIGURATION.retrieval,
    injection: DEFAULT_CONFIGURATION.injection,
    channels: { exact: false, fts: true, vector: false, relation: false },
    rerank: "RRF_FALLBACK",
  };
  const report = await new GoldenDatasetRunner(fixture.executor).run(fixture.dataset, configuration);
  assert.equal(report.metrics.recallAtK, 1);
  assert.equal(report.metrics.precisionAtK, 1);
  assert.equal(report.metrics.traceabilityRate, 1);
  assert.equal(report.metrics.scopeLeakCount, 0);
  assert.equal(report.complexity.p95Tokens <= 800, true);
  assert.equal(report.complexity.overBudgetCount, 0);
  assert.equal(report.complexity.automaticL4Count, 0);
  assert.equal(report.complexity.missingReasonAxisCount, 0);
  assert.equal(report.totals.forbiddenHits, 0);
  assert.equal(report.defaultInjectionAllowed, true);
  assert.equal(report.gatePassed, true);
  assert.match(report.configFingerprint, /^sha256:[a-f0-9]{64}$/u);

  const firstCase = fixture.dataset.cases[0];
  const first = fixture.executions.get(firstCase.caseId);
  const rollout = new InjectionRolloutController();
  rollout.activate(1, "ACTIVE", {
    datasetId: report.datasetId,
    datasetVersion: report.datasetVersion,
    configFingerprint: report.configFingerprint,
    defaultInjectionAllowed: true,
  });
  const hookInput = {
    hook_event_name: "UserPromptSubmit", session_id: "p5-session", turn_id: "p5-turn",
    cwd: project.repositoryRoot, prompt: firstCase.query.prompt,
  };
  const injection = await new UserPromptInjectionService({ retrieve: async () => ({ envelope: first.envelope, trace: first.trace }) }, rollout).handle(hookInput);
  assert.equal(injection.status, "INJECTED");
  assert.match(serializeUserPromptHookResult(injection), /"hookEventName":"UserPromptSubmit"/u);
  assert.match(injection.output.hookSpecificOutput.additionalContext, new RegExp(first.trace.traceId, "u"));

  const timeout = await new UserPromptInjectionService({
    retrieve: async () => await new Promise(() => undefined),
  }, rollout, { deadlineMs: 10 }).handle(hookInput);
  assert.equal(timeout.status, "TIMEOUT");
  assert.equal(timeout.output, undefined);
  assert.equal(serializeUserPromptHookResult(timeout), "");
});

test("P5 Gate: MCP expansion is incremental and preserves the same project Scope", async () => {
  const fixture = await gateFixture();
  const firstCase = fixture.dataset.cases[0];
  await fixture.executor.execute(firstCase);
  const first = fixture.executions.get(firstCase.caseId);
  const byId = new Map(fixture.assets.map((value) => [value.id, value]));
  const backend = {
    search: async () => ({ traceId: "trace-mcp-search", assets: [byId.get(firstCase.expectedRelevantAssetIds[0]), byId.get("knowledge.other.project")] }),
    related: async () => ({ traceId: "trace-mcp-related", assets: [] }),
    current: async (request) => ({
      traceId: "trace-mcp-current",
      assets: request.assetIds.flatMap((id) => byId.get(id) ?? []),
    }),
  };
  const service = new KnowledgeMcpService(backend);
  const signal = new AbortController().signal;
  const searched = await service.search({ query: firstCase.query.prompt }, first.queryContext, signal);
  assert.equal(searched.items.length, 1);
  assert.equal(searched.items[0].detailLevel, "L2_COMPACT");
  assert.equal(searched.items[0].scope.projectId, project.projectId);
  assert.equal(searched.items.some((item) => item.id === "knowledge.other.project"), false);

  const fromPointer = await service.get({
    id: searched.items[0].id, version: searched.items[0].version, fromDetailLevel: "L1_POINTER",
  }, first.queryContext, signal);
  const fromCompact = await service.get({
    id: searched.items[0].id, version: searched.items[0].version, fromDetailLevel: "L2_COMPACT",
  }, first.queryContext, signal);
  for (const expanded of [fromPointer, fromCompact]) {
    assert.equal(expanded.items[0].toDetailLevel, "L3_EVIDENCED");
    assert.equal("title" in expanded.items[0], false);
    assert.equal("scope" in expanded.items[0], false);
    assert.equal(expanded.items[0].version, searched.items[0].version);
  }
  assert.equal(first.trace.complexity.level, "L2_COMPACT");
});
