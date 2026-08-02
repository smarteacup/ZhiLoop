import { resolveQueryContext } from "@zhiloop/query-context";
import type { RetrievedKnowledge } from "@zhiloop/retrieval-engine";
import { describe, expect, it, vi } from "vitest";

import type { RerankPort, RerankPortResult } from "./types.js";
import { KnowledgeReranker } from "./reranker.js";

type KnowledgeAsset = RetrievedKnowledge["asset"];

const project = { projectId: "project-a", repositoryRoot: "/workspace/a", portable: true } as const;

function item(id: string, rank: number, overrides: Partial<KnowledgeAsset> = {}): RetrievedKnowledge {
  const asset: KnowledgeAsset = {
    schemaVersion: 1, id, subjectKey: id, kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: project.projectId }, version: 1, status: "IMPLEMENTED",
    title: `${id} title`, summary: `${id} summary`, body: `secret body ${id}`,
    aliases: [], keywords: [], applicability: ["project-a"], nonApplicability: [], symbols: ["RerankSymbol"],
    relations: [], evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }], confidence: 0.9,
    sourceEpisodes: ["episode-rerank"], contentHash: `sha256_${id}`, correlationId: "correlation-rerank",
    createdAt: "2026-08-02T16:00:00.000Z", updatedAt: "2026-08-02T16:00:00.000Z", ...overrides,
  };
  return {
    asset, rank, score: 1 / (60 + rank), scopeMatched: true,
    contributions: [{ channel: "FTS", rank, contribution: 1 / (60 + rank), reason: `FTS rank ${rank}` }],
  };
}

function context(prompt = "symbol RerankSymbol") {
  return resolveQueryContext({ prompt, project });
}

function port(handler: RerankPort["rerank"], available = true): RerankPort {
  return { available, rerank: vi.fn(handler) };
}

function rankings(values: readonly RetrievedKnowledge[], scores: readonly number[]): RerankPortResult {
  return {
    schemaVersion: 1,
    rankings: values.map((value, index) => ({
      assetId: value.asset.id,
      score: scores[index] ?? 0,
      reasonCodes: ["QUERY_RELEVANCE"],
    })),
  };
}

describe("KnowledgeReranker", () => {
  it("reorders valid output while retaining Scope, Status, Evidence, and channel contributions", async () => {
    const values = [item("knowledge.rerank.first", 1), item("knowledge.rerank.second", 2)];
    const adapter = port(async (request) => {
      expect(request.candidates).toHaveLength(2);
      expect(request.candidates[0]).not.toHaveProperty("body");
      expect(request.candidates[0]).toMatchObject({
        status: "IMPLEMENTED", scope: { projectId: project.projectId },
        evidenceIds: [`evidence-${values[0]?.asset.id}`], contributions: [{ channel: "FTS" }],
      });
      expect(Object.isFrozen(request.candidates)).toBe(true);
      expect(request.signal.aborted).toBe(false);
      return rankings(values, [0.1, 0.9]);
    });
    const result = await new KnowledgeReranker(adapter).rerank(context(), values);
    expect(result.items.map((value) => value.asset.id)).toEqual([values[1]?.asset.id, values[0]?.asset.id]);
    expect(result.items[0]).toMatchObject({
      rank: 1,
      asset: { status: "IMPLEMENTED", scope: { projectId: project.projectId }, evidence: [{ verdict: "SUPPORTS" }] },
      contributions: [{ channel: "FTS" }],
      rerank: { applied: true, originalRank: 2, score: 0.9, reasonCodes: ["QUERY_RELEVANCE"] },
    });
    expect(Object.isFrozen(result.items[0]?.asset)).toBe(true);
  });

  it("deduplicates the same subject after reranking and keeps the higher result", async () => {
    const values = [
      item("knowledge.rerank.old-id", 1, { subjectKey: "knowledge.shared.subject" }),
      item("knowledge.rerank.new-id", 2, { subjectKey: "knowledge.shared.subject" }),
    ];
    const result = await new KnowledgeReranker(port(async () => rankings(values, [0.1, 0.8])))
      .rerank(context(), values);
    expect(result.items).toMatchObject([{ asset: { id: "knowledge.rerank.new-id" }, rank: 1 }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_SUBJECT_REMOVED", assetId: "knowledge.rerank.old-id", keptAssetId: "knowledge.rerank.new-id",
    }));
  });

  it("preserves RRF order when unavailable and deduplicates without changing relative order", async () => {
    const values = [
      item("knowledge.rerank.first", 1, { subjectKey: "knowledge.shared.subject" }),
      item("knowledge.rerank.duplicate", 2, { subjectKey: "knowledge.shared.subject" }),
      item("knowledge.rerank.third", 3),
    ];
    const adapter = port(async () => rankings(values, [0, 0, 0]), false);
    const result = await new KnowledgeReranker(adapter).rerank(context(), values);
    expect(result.items.map((value) => value.asset.id)).toEqual([values[0]?.asset.id, values[2]?.asset.id]);
    expect(result.items.every((value) => !value.rerank.applied && value.rerank.reasonCodes[0] === "RRF_FALLBACK")).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "UNAVAILABLE" }));
    expect(adapter.rerank).not.toHaveBeenCalled();
  });

  it("falls back on port errors and sanitizes diagnostics", async () => {
    const values = [item("knowledge.rerank.error", 1)];
    const result = await new KnowledgeReranker(port(async () => { throw new Error("provider\nfailed"); }))
      .rerank(context(), values);
    expect(result.items[0]?.asset.id).toBe(values[0]?.asset.id);
    expect(result.diagnostics).toContainEqual({ code: "PORT_ERROR", message: "Error: provider failed" });
  });

  it("times out and preserves the RRF result", async () => {
    const values = [item("knowledge.rerank.timeout", 1)];
    let observedSignal: AbortSignal | undefined;
    const never = port(async (request) => {
      observedSignal = request.signal;
      return await new Promise<RerankPortResult>(() => undefined);
    });
    const result = await new KnowledgeReranker(never, { timeoutMs: 5 }).rerank(context(), values);
    expect(result.items[0]?.rerank.applied).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TIMEOUT" }));
    expect(observedSignal?.aborted).toBe(true);
  });

  it.each([
    ["schema", { schemaVersion: 2, rankings: [] }],
    ["missing ID", { schemaVersion: 1, rankings: [] }],
    ["unknown ID", { schemaVersion: 1, rankings: [{ assetId: "unknown", score: 0, reasonCodes: ["OK"] }] }],
    ["NaN score", { schemaVersion: 1, rankings: [{ assetId: "knowledge.rerank.invalid", score: Number.NaN, reasonCodes: ["OK"] }] }],
    ["bad reason", { schemaVersion: 1, rankings: [{ assetId: "knowledge.rerank.invalid", score: 0, reasonCodes: [] }] }],
  ])("falls back on invalid %s output", async (_label, output) => {
    const values = [item("knowledge.rerank.invalid", 1)];
    const result = await new KnowledgeReranker(port(async () => output as RerankPortResult)).rerank(context(), values);
    expect(result.items[0]?.rerank.applied).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_OUTPUT" }));
  });

  it("uses RRF rank and asset ID as deterministic score tie-breakers", async () => {
    const values = [item("knowledge.rerank.b", 1), item("knowledge.rerank.a", 1)];
    const result = await new KnowledgeReranker(port(async () => rankings(values, [0.5, 0.5])))
      .rerank(context(), values);
    expect(result.items.map((value) => value.asset.id)).toEqual(["knowledge.rerank.a", "knowledge.rerank.b"]);
  });

  it("caps Port input at 30 candidates and reports the truncation", async () => {
    const values = Array.from({ length: 31 }, (_, index) => item(`knowledge.rerank.cap-${index}`, index + 1));
    const adapter = port(async (request) => rankings(
      values.slice(0, request.candidates.length), request.candidates.map(() => 0),
    ));
    const result = await new KnowledgeReranker(adapter).rerank(context(), values);
    expect(result.items).toHaveLength(30);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CANDIDATE_LIMIT_APPLIED" }));
  });

  it("does not call Port for an oversized query or empty candidate set", async () => {
    const values = [item("knowledge.rerank.large-query", 1)];
    const adapter = port(async () => rankings(values, [1]));
    const oversized = await new KnowledgeReranker(adapter).rerank(context("x".repeat(20_001)), values);
    expect(oversized.diagnostics).toContainEqual(expect.objectContaining({ code: "QUERY_TOO_LARGE" }));
    expect(adapter.rerank).not.toHaveBeenCalled();
    expect(await new KnowledgeReranker(adapter).rerank(context(), [])).toEqual({ items: [], diagnostics: [] });
  });

  it("rejects unsafe timeout configuration", () => {
    expect(() => new KnowledgeReranker(undefined, { timeoutMs: 0 })).toThrow("between 1 and 10000");
    expect(() => new KnowledgeReranker(undefined, { timeoutMs: 10_001 })).toThrow("between 1 and 10000");
  });

  it("does not freeze caller-owned input objects", async () => {
    const value = item("knowledge.rerank.mutable", 1);
    const result = await new KnowledgeReranker(port(async () => rankings([value], [1]))).rerank(context(), [value]);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(value.asset)).toBe(false);
    expect(Object.isFrozen(result.items[0]?.asset)).toBe(true);
  });
});
