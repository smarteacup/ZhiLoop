import type { ContextEnvelope, ContextEnvelopeItem, KnowledgeAsset, KnowledgeScope } from "@zhiloop/domain";
import type { KnowledgeRerankResult, RerankedKnowledge } from "@zhiloop/knowledge-reranker";
import { resolveQueryContext } from "@zhiloop/query-context";
import type { RetrievalResult, RetrievedKnowledge } from "@zhiloop/retrieval-engine";
import { describe, expect, it } from "vitest";

import { fingerprintRetrievalConfiguration } from "./fingerprint.js";
import { GoldenDatasetRunner } from "./runner.js";
import { buildRetrievalTrace } from "./trace.js";
import type { GoldenDataset, GoldenDatasetCase, RetrievalTrace } from "./types.js";

const project = {
  projectId: "project-a", repositoryRoot: "/workspace/a", branch: "main", portable: true,
} as const;

const queryContext = resolveQueryContext({
  prompt: "fix ContextOrchestrator in packages/context-orchestrator/src/orchestrator.ts",
  project,
  taskId: "task-a",
});
const goldenQuery = { prompt: queryContext.prompt, project, taskId: "task-a" } as const;

function asset(id: string, scope: KnowledgeScope = { level: "PROJECT", projectId: project.projectId }): KnowledgeAsset {
  return {
    schemaVersion: 1, id, subjectKey: id, kind: "IMPLEMENTATION", scope, version: 1, status: "IMPLEMENTED",
    title: `${id} title`, summary: `${id} summary.`, body: `${id} body.`, aliases: [], keywords: [],
    applicability: ["project-a"], nonApplicability: ["outside project-a"], symbols: ["ContextOrchestrator"],
    relations: [], evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }], confidence: 0.9,
    sourceEpisodes: [`episode-${id}`], contentHash: `sha256_${id}`, correlationId: "correlation-evaluation",
    createdAt: "2026-08-02T18:00:00.000Z", updatedAt: "2026-08-02T18:00:00.000Z",
  };
}

function retrieved(value: KnowledgeAsset, rank: number): RetrievedKnowledge {
  return {
    asset: value, rank, score: 1 / (60 + rank), scopeMatched: true,
    contributions: [{ channel: "FTS", rank, contribution: 1 / (60 + rank), reason: `FTS rank ${rank}` }],
  };
}

function reranked(value: RetrievedKnowledge, rank: number): RerankedKnowledge {
  return {
    ...value, rank,
    rerank: { applied: true, originalRank: value.rank, score: 1 - rank / 100, reasonCodes: ["QUERY_RELEVANCE"] },
  };
}

function envelopeItem(value: RerankedKnowledge): ContextEnvelopeItem {
  return {
    id: value.asset.id, version: value.asset.version, subjectKey: value.asset.subjectKey,
    kind: value.asset.kind, status: value.asset.status, scope: value.asset.scope,
    authority: "REFERENCE", detailLevel: "L1_POINTER", title: value.asset.title,
    summary: value.asset.summary, retrievalRank: value.rank,
  };
}

function trace(
  ids: readonly string[],
  options: {
    readonly traceId?: string;
    readonly scopes?: readonly KnowledgeScope[];
    readonly injected?: readonly string[];
    readonly level?: ContextEnvelope["complexity"]["level"];
    readonly automatic?: boolean;
    readonly truncated?: boolean;
    readonly estimatedTokens?: number;
    readonly maxTokens?: number;
  } = {},
): RetrievalTrace {
  const retrievedItems = ids.map((id, index) => retrieved(asset(id, options.scopes?.[index]), index + 1));
  const rerankItems = retrievedItems.map((item, index) => reranked(item, index + 1));
  const injected = new Set(options.injected ?? ids);
  const items = rerankItems.filter((item) => injected.has(item.asset.id)).map(envelopeItem);
  const level = options.level ?? (items.length === 0 ? "L0_NONE" : "L1_POINTER");
  const envelope: ContextEnvelope = {
    schemaVersion: 1, runId: "run-evaluation", projectId: project.projectId, taskId: "task-a",
    complexity: {
      level, breadth: items.length,
      depth: level === "L0_NONE" ? "NONE" : level === "L4_EPISODE" ? "EPISODE" : "POINTER",
      authority: items.length === 0 ? "NONE" : "REFERENCE",
      evidence: level === "L0_NONE" || level === "L1_POINTER" ? "NONE" : level === "L4_EPISODE" ? "EPISODE" : "SUMMARY",
      reasonCodes: ["REQUESTED_COMPLEXITY_LEVEL"],
    },
    budget: {
      maxTokens: options.maxTokens ?? 800,
      estimatedTokens: options.estimatedTokens ?? 200,
      truncated: options.truncated ?? false,
      disclosedItems: items.length,
      omittedItems: Math.max(0, retrievedItems.length - items.length),
    },
    items,
  };
  const retrieval: RetrievalResult = {
    items: retrievedItems,
    diagnostics: [{ code: "STATUS_FILTERED", channel: "FTS", assetId: "stale-id", message: "stale" }],
  };
  const rerankResult: KnowledgeRerankResult = { items: rerankItems, diagnostics: [] };
  return buildRetrievalTrace({
    traceId: options.traceId ?? `trace-${ids.join("-") || "empty"}`,
    runId: "run-evaluation", queryContext, retrieval, rerank: rerankResult, envelope,
    signals: { risk: "LOW", ambiguous: false, conflicting: false },
    ...(options.automatic === undefined ? {} : { automatic: options.automatic }),
  });
}

const dataset = (cases: readonly GoldenDatasetCase[]): GoldenDataset => ({
  schemaVersion: 1, datasetId: "retrieval-golden", version: 1, cases,
});

describe("Retrieval Trace", () => {
  it("explains filtering, channel rank, RRF, rerank, source, injection, and complexity", () => {
    const value = trace(["asset-a"]);
    expect(value).toMatchObject({
      schemaVersion: 1, traceId: "trace-asset-a",
      filters: [{ code: "STATUS_FILTERED", assetId: "stale-id" }],
      results: [{
        assetId: "asset-a", retrievalRank: 1, finalRank: 1, injected: true,
        contributions: [{ channel: "FTS", rank: 1 }],
        rerank: { applied: true, reasonCodes: ["QUERY_RELEVANCE"] },
        evidenceIds: ["evidence-asset-a"], sourceEpisodes: ["episode-asset-a"],
      }],
      complexity: {
        reasonCodes: expect.arrayContaining([
          "RISK_LOW", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT", "BUDGET_WITHIN_LIMIT",
        ]),
      },
    });
    expect(Object.isFrozen(value.results[0]?.scope)).toBe(true);
  });

  it("rejects identity, rank, candidate, injection, and version inconsistencies", () => {
    const base = trace(["asset-a"]);
    const retrievalItem = retrieved(asset("asset-a"), 1);
    const rerankItem = reranked(retrievalItem, 1);
    const envelope: ContextEnvelope = {
      schemaVersion: 1, runId: "wrong", projectId: project.projectId, taskId: "task-a",
      complexity: { level: "L0_NONE", breadth: 0, depth: "NONE", authority: "NONE", evidence: "NONE", reasonCodes: ["NO_RETRIEVED_KNOWLEDGE"] },
      budget: { maxTokens: 800, estimatedTokens: 100, truncated: false, disclosedItems: 0, omittedItems: 0 }, items: [],
    };
    const input = {
      traceId: "trace-invalid", runId: "run-evaluation", queryContext,
      retrieval: { items: [retrievalItem], diagnostics: [] },
      rerank: { items: [rerankItem], diagnostics: [] }, envelope,
    };
    expect(() => buildRetrievalTrace(input)).toThrow("runId");
    expect(() => buildRetrievalTrace({ ...input, traceId: "bad trace" })).toThrow("traceId");
    expect(() => buildRetrievalTrace({
      ...input, envelope: { ...envelope, runId: "run-evaluation", projectId: "project-b" },
    })).toThrow("query identity");
    expect(() => buildRetrievalTrace({
      ...input,
      envelope: { ...envelope, runId: "run-evaluation" },
      rerank: { items: [{ ...rerankItem, rank: 2 }], diagnostics: [] },
    })).toThrow("final ranks");
    expect(() => buildRetrievalTrace({
      ...input,
      envelope: { ...envelope, runId: "run-evaluation" },
      rerank: { items: [reranked(retrieved(asset("unknown"), 1), 1)], diagnostics: [] },
    })).toThrow("not a current retrieval candidate");
    const injectedItem = { ...envelopeItem(rerankItem), version: 2 };
    expect(() => buildRetrievalTrace({
      ...input,
      envelope: {
        ...envelope, runId: "run-evaluation", items: [injectedItem],
        complexity: { ...envelope.complexity, level: "L1_POINTER", breadth: 1, depth: "POINTER", authority: "REFERENCE" },
      },
    })).toThrow("injected version");
    expect(base.results).toHaveLength(1);
  });
});

describe("GoldenDatasetRunner", () => {
  it("fingerprints canonical algorithm configuration independent of object key order", () => {
    const first = fingerprintRetrievalConfiguration({ rerank: true, topK: { vector: 30, exact: 30 } });
    const reordered = fingerprintRetrievalConfiguration({ topK: { exact: 30, vector: 30 }, rerank: true });
    expect(first).toBe(reordered);
    expect(fingerprintRetrievalConfiguration({ rerank: false })).not.toBe(first);
    expect(fingerprintRetrievalConfiguration([null, "x", true, 1])).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => fingerprintRetrievalConfiguration({ invalid: Number.NaN })).toThrow("non-finite");
    expect(() => fingerprintRetrievalConfiguration({ invalid: undefined })).toThrow("non-JSON");
    expect(() => fingerprintRetrievalConfiguration({ invalid: new Date(0) })).toThrow("non-plain");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => fingerprintRetrievalConfiguration(cyclic)).toThrow("cycle");
  });

  it("passes the default Recall@5/Precision@5 gate with complete traceability", async () => {
    const traces = new Map([
      ["case-a", trace(["asset-a"])],
      ["case-b", trace(["asset-b"])],
    ]);
    const runner = new GoldenDatasetRunner({ execute: async (testCase) => traces.get(testCase.caseId)! });
    const report = await runner.run(dataset([
      { caseId: "case-a", query: goldenQuery, expectedRelevantAssetIds: ["asset-a"] },
      { caseId: "case-b", query: goldenQuery, expectedRelevantAssetIds: ["asset-b"] },
    ]), "config-sha256-v1");
    expect(report).toMatchObject({
      totals: { cases: 2, errors: 0, relevant: 2, returned: 2, hits: 2, forbiddenHits: 0 },
      metrics: { recallAtK: 1, precisionAtK: 1, traceabilityRate: 1, scopeLeakCount: 0 },
      qualityThresholdsMet: true, defaultInjectionAllowed: true, gatePassed: true,
      complexity: { levelCounts: { L1_POINTER: 2 }, automaticL4Count: 0, missingReasonAxisCount: 0 },
    });
    expect(Object.isFrozen(report.cases)).toBe(true);
  });

  it("blocks default injection below quality thresholds and records errors without aborting", async () => {
    const runner = new GoldenDatasetRunner({
      execute: async (testCase) => {
        if (testCase.caseId === "case-error") throw "provider\nsecret detail";
        return trace(["asset-a", "noise"]);
      },
    });
    const report = await runner.run(dataset([
      {
        caseId: "case-low", query: goldenQuery,
        expectedRelevantAssetIds: ["asset-a", "asset-b"], forbiddenAssetIds: ["noise"],
      },
      { caseId: "case-error", query: goldenQuery, expectedRelevantAssetIds: ["asset-c"] },
    ]), "config-sha256-low");
    expect(report.metrics).toMatchObject({ recallAtK: 1 / 3, precisionAtK: 1 / 2 });
    expect(report).toMatchObject({ defaultInjectionAllowed: false, gatePassed: false, totals: { errors: 1 } });
    expect(report.cases).toEqual([
      expect.objectContaining({ status: "FAIL", forbiddenHits: ["noise"] }),
      expect.objectContaining({ status: "ERROR", error: "provider secret detail" }),
    ]);
  });

  it("audits automatic L4, over-budget envelopes, missing explanation axes, and scope leaks", async () => {
    const unsafeBase = trace(
      ["asset-a"],
      {
        scopes: [{ level: "PROJECT", projectId: "project-b" }],
        level: "L4_EPISODE", automatic: true, estimatedTokens: 900, maxTokens: 800, truncated: true,
      },
    );
    const unsafe: RetrievalTrace = {
      ...unsafeBase,
      complexity: { ...unsafeBase.complexity, reasonCodes: ["RISK_HIGH"] },
    };
    const runner = new GoldenDatasetRunner({ execute: async () => unsafe });
    const report = await runner.run(dataset([
      { caseId: "case-audit", query: goldenQuery, expectedRelevantAssetIds: ["asset-a"] },
    ]), "config-sha256-audit");
    expect(report.complexity).toMatchObject({
      p95Tokens: 900, maximumTokens: 900, truncatedCount: 1, overBudgetCount: 1,
      automaticL4Count: 1, missingReasonAxisCount: 1,
    });
    expect(report.metrics.scopeLeakCount).toBe(1);
    expect(report.gatePassed).toBe(false);
  });

  it("accepts permitted GLOBAL and matching TASK scopes but rejects USER injection", async () => {
    const scoped = trace(
      ["global", "task", "user"],
      {
        scopes: [
          { level: "GLOBAL" },
          { level: "TASK", taskId: "task-a", projectId: "project-a" },
          { level: "USER", userId: "user-a" },
        ],
      },
    );
    const runner = new GoldenDatasetRunner({ execute: async () => scoped });
    const report = await runner.run(dataset([{
      caseId: "case-scopes", query: goldenQuery,
      expectedRelevantAssetIds: ["global", "task", "user"],
    }]), "config-sha256-scopes");
    expect(report.metrics.scopeLeakCount).toBe(1);
  });

  it("validates thresholds, K, versioned dataset metadata, and expectation disjointness", async () => {
    expect(() => new GoldenDatasetRunner({ execute: async () => trace([]) }, { k: 0 })).toThrow("k");
    expect(() => new GoldenDatasetRunner(
      { execute: async () => trace([]) }, { recallThreshold: 2 },
    )).toThrow("recallThreshold");
    const runner = new GoldenDatasetRunner({ execute: async () => trace([]) });
    await expect(runner.run({ ...dataset([]), cases: [] }, "config-sha256-v1")).rejects.toThrow("metadata");
    await expect(runner.run({ ...dataset([]), version: 0, cases: [{
      caseId: "case-a", query: { prompt: "x" }, expectedRelevantAssetIds: ["asset-a"],
    }] }, "config-sha256-v1")).rejects.toThrow("metadata");
    await expect(runner.run(dataset([
      { caseId: "duplicate", query: { prompt: "x" }, expectedRelevantAssetIds: ["asset-a"] },
      { caseId: "duplicate", query: { prompt: "y" }, expectedRelevantAssetIds: ["asset-b"] },
    ]), "config-sha256-v1")).rejects.toThrow("case IDs");
    await expect(runner.run(dataset([{
      caseId: "case-overlap", query: { prompt: "x", project },
      expectedRelevantAssetIds: ["asset-a"], forbiddenAssetIds: ["asset-a"],
    }]), "config-sha256-v1")).rejects.toThrow("invalid expectations");
  });
});
