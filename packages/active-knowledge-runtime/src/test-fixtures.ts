import type { InjectionPolicy } from "@zhiloop/config";
import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { ContextEnvelope, KnowledgeAsset } from "@zhiloop/domain";
import type { RerankedKnowledge } from "@zhiloop/knowledge-reranker";
import { resolveQueryContext } from "@zhiloop/query-context";

export const fixedNow = "2026-08-04T00:00:00.000Z";

export function asset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    schemaVersion: 1,
    id: "knowledge-1",
    subjectKey: "symbol:ActiveKnowledgeRuntime",
    kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-a" },
    version: 3,
    status: "IMPLEMENTED",
    title: "Active knowledge runtime",
    summary: "Compose retrieval with bounded injection.",
    body: "Use current scoped knowledge only.",
    aliases: [],
    keywords: ["injection"],
    applicability: ["project-a"],
    nonApplicability: ["other projects"],
    symbols: ["ActiveKnowledgeRuntime"],
    relations: [],
    evidence: [{ evidenceId: "evidence-1", verdict: "SUPPORTS" }],
    confidence: 0.9,
    sourceEpisodes: ["episode-1"],
    contentHash: "sha256:knowledge-1-v3",
    correlationId: "correlation-1",
    createdAt: fixedNow,
    updatedAt: fixedNow,
    ...overrides,
  };
}

export function query(prompt = "How does ActiveKnowledgeRuntime work?", projectId = "project-a", taskId = "turn-1") {
  return resolveQueryContext({
    prompt,
    project: { projectId, repositoryRoot: `/workspace/${projectId}`, branch: "main", portable: true },
    cwd: `/workspace/${projectId}`,
    taskId,
  });
}

export function reranked(value = asset()): RerankedKnowledge {
  return {
    asset: value,
    rank: 1,
    score: 1,
    scopeMatched: true,
    contributions: [{ channel: "EXACT", rank: 1, contribution: 1, reason: "symbol match" }],
    rerank: { applied: false, originalRank: 1, reasonCodes: ["DETERMINISTIC_ORDER"] },
  };
}

export function injectionPolicy(): InjectionPolicy {
  return structuredClone(DEFAULT_CONFIGURATION.injection);
}

export function emptyEnvelope(runId = "run-1"): ContextEnvelope {
  return {
    schemaVersion: 1,
    runId,
    projectId: "project-a",
    taskId: "turn-1",
    complexity: {
      level: "L0_NONE",
      breadth: 0,
      depth: "NONE",
      authority: "NONE",
      evidence: "NONE",
      reasonCodes: ["NO_CONTEXT"],
    },
    budget: { maxTokens: 100, estimatedTokens: 1, truncated: false, disclosedItems: 0, omittedItems: 0 },
    items: [],
  };
}
