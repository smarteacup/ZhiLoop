import type { RetrievalTraceContract } from "@zhiloop/control-api";
import { describe, expect, it } from "vitest";

import { toRetrievalTraceView } from "./p3.js";

function trace(): RetrievalTraceContract {
  return {
    schemaVersion: 1, traceId: "trace-view", runId: "run-view",
    queryContext: { prompt: "ConfigService", promptFingerprint: "a".repeat(64), projectId: "project-a",
      repositoryRoot: "/workspace/a", branch: "main", commit: "abcdef1234567", dirty: true,
      paths: [], symbols: ["ConfigService"], errorCodes: [], configKeys: [], allowProjectKnowledge: true,
      allowGlobalKnowledge: true, reasonCodes: ["PROJECT_RESOLVED"] },
    scenarios: [{ scenarioId: "scenario:project-a:config.change", title: "配置变更", summary: "处理配置。",
      score: 1, selected: true, knowledgePointers: ["knowledge-a@1"], taskIntents: ["修改配置"], entryPoints: ["ConfigService"] }],
    policy: { policyId: "policy-a", revision: 1, fingerprint: "b".repeat(64), source: "CURRENT" },
    outcome: "SUCCEEDED", filters: [{ decision: "INCLUDED", reasonCode: "ELIGIBLE", safeMessage: "eligible" }],
    results: [{ knowledgeId: "knowledge-a", version: 1, title: "配置", summary: "配置摘要", scope: "PROJECT",
      status: "VERIFIED", authority: "INFORMATIVE", evidenceIds: ["evidence-a"], sourceEpisodeIds: ["episode-a"],
      retrievalRank: 1, finalRank: 1, rrfScore: 0.1,
      contributions: [{ channel: "EXACT", rank: 1, rawScore: 1, contribution: 0.1, reason: "symbol" }],
      rerankReasonCodes: ["QUERY_RELEVANCE"] }],
    envelope: { detailLevel: "L2_COMPACT", maxTokens: 1000, estimatedTokens: 100, truncated: false,
      selected: [{ knowledgeId: "knowledge-a", version: 1, estimatedTokens: 100 }],
      omitted: [{ knowledgeId: "knowledge-b", version: 1, reason: "TOKEN_BUDGET" }],
      reasonCodes: ["RISK_LOW", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT", "BUDGET_WITHIN_LIMIT"] },
    injectionResult: "SHADOWED", durationMs: 1, createdAt: "2026-08-20T00:00:00.000Z",
  };
}

describe("toRetrievalTraceView", () => {
  it("projects location, scenarios and explanations into immutable UI data", () => {
    const value = toRetrievalTraceView(trace());
    expect(value.context).toEqual({ projectId: "project-a", repositoryRoot: "/workspace/a", branch: "main",
      commit: "abcdef1234567", dirty: true });
    expect(value.scenarios[0]).toMatchObject({ title: "配置变更", selected: true });
    expect(value.results[0]).toMatchObject({ injected: false, evidenceIds: ["evidence-a"] });
    expect(value.reasonCodes).toContain("BUDGET_WITHIN_LIMIT");
    expect(Object.isFrozen(value.scenarios[0]?.knowledgePointers)).toBe(true);
  });

  it("omits unavailable location fields and rejects impossible active delivery", () => {
    const base = trace();
    const queryContext: RetrievalTraceContract["queryContext"] = {
      prompt: base.queryContext.prompt, promptFingerprint: base.queryContext.promptFingerprint,
      paths: [], symbols: [], errorCodes: [], configKeys: [], allowProjectKnowledge: false,
      allowGlobalKnowledge: false, reasonCodes: [],
    };
    expect(toRetrievalTraceView({ ...base, queryContext, scenarios: [], results: [], filters: [],
      envelope: { ...base.envelope, omitted: [] } }).context).toEqual({});
    expect(() => toRetrievalTraceView({ ...base, injectionResult: "INJECTED" })).toThrow("actual injection");
  });
});
