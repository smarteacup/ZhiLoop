import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  codexKnowledgeAnswerSchema,
  naturalLanguageSearchRequestSchema,
  retrievalSimulationRequestSchema,
  retrievalTraceSchema,
} from "./p3-contracts.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const policy = (source: "CURRENT" | "DRAFT" | "REPLAY" = "CURRENT") => ({
  policyId: "policy.project-a", revision: 1, fingerprint: sha(`policy-${source}`), source,
});
const context = {
  prompt: "how does ConfigService activate?",
  promptFingerprint: sha("query"),
  projectId: "project-a",
  repositoryRoot: "/workspace/project-a",
  paths: ["src/config.ts"], symbols: ["ConfigService"], errorCodes: [], configKeys: [],
  allowProjectKnowledge: true, allowGlobalKnowledge: true,
  reasonCodes: ["PROJECT_RESOLVED"],
};
const envelope = {
  detailLevel: "L2_COMPACT" as const,
  maxTokens: 1_000,
  estimatedTokens: 120,
  truncated: false,
  selected: [{ knowledgeId: "knowledge.config", version: 2, estimatedTokens: 120 }],
  omitted: [],
  reasonCodes: ["RISK_LOW", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT", "BUDGET_WITHIN_LIMIT"],
};

describe("P3 retrieval and answer contracts", () => {
  it("accepts a bounded natural-language search request and rejects unknown fields", () => {
    const request = {
      schemaVersion: 1, requestId: "req-search-1", type: "knowledge.search", mode: "SEARCH_ONLY",
      query: "find ConfigService activation", projectId: "project-a", policy: policy(),
      maxResults: 20, maxContextTokens: 2_000, timeoutMs: 5_000,
    };
    expect(naturalLanguageSearchRequestSchema.parse(request)).toEqual(request);
    expect(naturalLanguageSearchRequestSchema.safeParse({ ...request, hidden: true }).success).toBe(false);
    expect(naturalLanguageSearchRequestSchema.safeParse({ ...request, query: "x".repeat(20_001) }).success).toBe(false);
  });

  it("accepts a complete SHADOW trace with channel and evidence explanations", () => {
    const trace = {
      schemaVersion: 1, traceId: "trace-search-1", runId: "run-search-1", queryContext: context,
      policy: policy(), outcome: "SUCCEEDED", filters: [],
      results: [{
        knowledgeId: "knowledge.config", version: 2, title: "Config activation", summary: "Uses prepare/apply.",
        scope: "PROJECT", status: "VERIFIED", authority: "NORMATIVE",
        evidenceIds: ["evidence-config"], sourceEpisodeIds: ["episode-config"],
        retrievalRank: 1, finalRank: 1, rrfScore: 0.1,
        contributions: [{ channel: "EXACT", rank: 1, rawScore: 1, contribution: 0.1, reason: "symbol exact match" }],
        rerankReasonCodes: ["QUERY_RELEVANCE"],
      }],
      envelope, injectionResult: "SHADOWED", durationMs: 10, createdAt: "2026-08-03T00:00:00.000Z",
    };
    expect(retrievalTraceSchema.parse(trace)).toEqual(trace);
  });

  it("rejects discontinuous ranks, duplicate channel explanations, ACTIVE injection and invalid timestamps", () => {
    const result = {
      knowledgeId: "knowledge.config", version: 2, title: "Config activation", summary: "Uses prepare/apply.",
      scope: "PROJECT", status: "VERIFIED", authority: "NORMATIVE",
      evidenceIds: [], sourceEpisodeIds: ["episode-config"], retrievalRank: 1, finalRank: 2, rrfScore: 0.1,
      contributions: [
        { channel: "EXACT", rank: 1, rawScore: 1, contribution: 0.1, reason: "one" },
        { channel: "EXACT", rank: 2, rawScore: 0.5, contribution: 0.05, reason: "two" },
      ],
      rerankReasonCodes: ["QUERY_RELEVANCE"],
    };
    const invalid = {
      schemaVersion: 1, traceId: "trace-search-1", runId: "run-search-1", queryContext: context,
      policy: policy(), outcome: "SUCCEEDED", filters: [], results: [result], envelope,
      injectionResult: "INJECTED", durationMs: 10, createdAt: "2026-08-03 00:00:00",
    };
    const parsed = retrievalTraceSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "channel contributions must be unique", "final ranks must be contiguous", "P3 retrieval is SHADOW/read-only",
      "expected a canonical ISO timestamp",
    ]));
  });

  it("requires all four context-complexity axes and a non-overlapping token budget", () => {
    const invalidEnvelope = {
      ...envelope,
      estimatedTokens: 1_001,
      reasonCodes: ["RISK_LOW"],
      omitted: [{ knowledgeId: "knowledge.config", version: 2, reason: "TOKEN_BUDGET" }],
    };
    const base = {
      schemaVersion: 1, traceId: "trace-search-1", runId: "run-search-1", queryContext: context,
      policy: policy(), outcome: "SUCCEEDED", filters: [], results: [],
      injectionResult: "SHADOWED", durationMs: 10, createdAt: "2026-08-03T00:00:00.000Z",
    };
    const parsed = retrievalTraceSchema.safeParse({ ...base, envelope: invalidEnvelope });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "context envelope exceeds token budget", "an item cannot be selected and omitted",
      "missing AMBIGUITY_ explanation", "missing CONFLICT_ explanation", "missing BUDGET_ explanation",
    ]));
  });

  it("requires every factual answer span to be covered by an eligible knowledge version citation", () => {
    const answer = "Activation uses prepare then apply.";
    const response = {
      schemaVersion: 1, queryId: "query-1", retrievalTraceId: "trace-search-1", modelRunId: "model-run-1",
      outcome: "SUCCEEDED", model: "gpt-safe", answer,
      factualSpans: [{ start: 0, end: answer.length }],
      citations: [{
        knowledgeId: "knowledge.config", version: 2,
        answerSpans: [{ start: 0, end: answer.length }], evidenceIds: ["evidence-config"],
      }],
      unknowns: [], conflicts: [], latencyMs: 100,
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    expect(codexKnowledgeAnswerSchema.parse(response)).toEqual(response);
    expect(codexKnowledgeAnswerSchema.safeParse({ ...response, citations: [] }).success).toBe(false);
    expect(codexKnowledgeAnswerSchema.safeParse({
      ...response, citations: [{ ...response.citations[0], answerSpans: [{ start: 0, end: answer.length + 1 }] }],
    }).success).toBe(false);
  });

  it("forbids factual model content in deterministic fallback and requires modelRunId on success", () => {
    const base = {
      schemaVersion: 1, queryId: "query-1", retrievalTraceId: "trace-search-1", answer: "fallback",
      factualSpans: [{ start: 0, end: 8 }], citations: [{
        knowledgeId: "knowledge.config", version: 2, answerSpans: [{ start: 0, end: 8 }], evidenceIds: [],
      }], unknowns: [], conflicts: [], latencyMs: 1, usage: {},
    };
    expect(codexKnowledgeAnswerSchema.safeParse({ ...base, outcome: "FALLBACK_SEARCH" }).success).toBe(false);
    expect(codexKnowledgeAnswerSchema.safeParse({ ...base, outcome: "SUCCEEDED" }).success).toBe(false);
  });

  it("binds draft comparison and fixed-input replay to explicit policy sources", () => {
    const base = {
      schemaVersion: 1, requestId: "req-simulate-1", type: "retrieval.simulate",
      query: "simulate config", projectId: "project-a", currentPolicy: policy(), maxContextTokens: 1_000,
    };
    expect(retrievalSimulationRequestSchema.safeParse({ ...base, draftPolicy: policy("DRAFT") }).success).toBe(true);
    expect(retrievalSimulationRequestSchema.safeParse({ ...base, draftPolicy: policy() }).success).toBe(false);
    expect(retrievalSimulationRequestSchema.safeParse({ ...base, fixedInputTraceId: "trace-old" }).success).toBe(false);
    expect(retrievalSimulationRequestSchema.safeParse({
      ...base, currentPolicy: policy("REPLAY"), fixedInputTraceId: "trace-old",
    }).success).toBe(true);
  });
});
