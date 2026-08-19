import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import { loadInjectionPolicy } from "@zhiloop/config";
import { estimateAdditionalContextTokens, renderAdditionalContext } from "@zhiloop/context-renderer";
import { readFileSync } from "node:fs";
import { deriveScenarioId, type KnowledgeAsset } from "@zhiloop/domain";
import type { RerankedKnowledge } from "@zhiloop/knowledge-reranker";
import { resolveQueryContext } from "@zhiloop/query-context";
import { parseContextEnvelope } from "@zhiloop/schemas";
import { describe, expect, it } from "vitest";

import { ContextOrchestrator } from "./orchestrator.js";

const project = { projectId: "project-a", repositoryRoot: "/workspace/a", branch: "main", portable: true } as const;

function candidate(
  id: string,
  rank: number,
  overrides: Partial<KnowledgeAsset> = {},
): RerankedKnowledge {
  const asset: KnowledgeAsset = {
    schemaVersion: 1, id, subjectKey: id, kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: project.projectId }, version: 1, status: "IMPLEMENTED",
    title: `${id} title`, summary: `${id} compact summary. Extra sentence is not needed for pointer output.`,
    body: `${id} evidence-backed body and failure handling.`, aliases: [], keywords: [],
    applicability: ["project-a"], nonApplicability: ["other projects"], symbols: ["ContextOrchestrator"],
    relations: [], evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }], confidence: 0.9,
    sourceEpisodes: [`episode-${id}`], contentHash: `sha256_${id}`, correlationId: "correlation-context",
    createdAt: "2026-08-02T17:00:00.000Z", updatedAt: "2026-08-02T17:00:00.000Z", ...overrides,
  };
  return {
    asset,
    rank,
    score: 1 / (60 + rank),
    scopeMatched: true,
    contributions: [{ channel: "FTS", rank, contribution: 1 / (60 + rank), reason: `FTS rank ${rank}` }],
    rerank: { applied: true, originalRank: rank, score: 0.5, reasonCodes: ["QUERY_RELEVANCE"] },
  };
}

function request(candidates: readonly RerankedKnowledge[], overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-context-1",
    traceId: "trace-context-1",
    queryContext: resolveQueryContext({
      prompt: "symbol ContextOrchestrator in packages/context-orchestrator/src/orchestrator.ts",
      project,
      taskId: "task-context",
    }),
    candidates,
    policy: DEFAULT_CONFIGURATION.injection,
    ...overrides,
  };
}

describe("ContextOrchestrator", () => {
  it("keeps unselected located scenarios at pointer level and expands only the selected scenario", () => {
    const located = (id: string, key: string) => candidate(id, key === "order.create" ? 1 : 2, {
      schemaVersion: 2, claimMode: "CURRENT_STATE",
      locator: { schemaVersion: 1, projectId: project.projectId,
        observedRevision: { branch: "main", commit: "abcdef1234567", dirty: false },
        branchApplicability: { mode: "BRANCH_LINEAGE", baseCommit: "abcdef1234567", observedBranch: "main" },
        scenarioId: deriveScenarioId(project.projectId, key), scenarioKey: key, scenarioTitle: key,
        scenarioSummary: `${key} summary`, modulePaths: [], symbols: ["ContextOrchestrator"], entryPoints: [],
        taskIntents: [key], applicability: [], nonApplicability: [] },
    });
    const selectedId = deriveScenarioId(project.projectId, "order.create");
    const envelope = new ContextOrchestrator().orchestrate(request([
      located("knowledge.scene.create", "order.create"), located("knowledge.scene.cancel", "order.cancel"),
    ], { requestedLevel: "L3_EVIDENCED", automatic: false, selectedScenarioIds: [selectedId] }));
    expect(envelope.items.find((item) => item.scenarioId === selectedId)?.detailLevel).toBe("L3_EVIDENCED");
    expect(envelope.items.find((item) => item.scenarioId !== selectedId)?.detailLevel).toBe("L1_POINTER");
    expect(envelope.complexity.reasonCodes).toContain("SCENARIO_SELECTION_REQUIRED_FOR_EXPANSION");
  });

  it("loads the checked-in injection policy as the executable default contract", () => {
    const source = readFileSync(new URL("../../../config/injection-policy.yaml", import.meta.url), "utf8");
    const result = loadInjectionPolicy(source);
    expect(result).toEqual({ ok: true, value: DEFAULT_CONFIGURATION.injection });
  });

  it("uses mixed binding L2 and reference L1 items by default while keeping Task Contract separate", () => {
    const values = [
      candidate("knowledge.context.rule", 1, { kind: "RULE" }),
      candidate("knowledge.context.decision", 2, { kind: "DECISION", status: "ACCEPTED" }),
      candidate("knowledge.context.fact", 3, { kind: "FACT", status: "VERIFIED" }),
      candidate("knowledge.context.reference", 4),
    ];
    const envelope = new ContextOrchestrator().orchestrate(request(values, {
      policy: { ...DEFAULT_CONFIGURATION.injection, defaultMaxTokens: 1_600 },
      taskContract: {
        contractId: "contract-1",
        objective: "Implement CKL-504 without expanding scope.",
        gates: ["tests pass"],
        boundaries: ["do not modify user config"],
      },
    }));
    expect(envelope.complexity).toMatchObject({
      level: "L2_COMPACT", depth: "COMPACT", evidence: "POINTER", authority: "MIXED", breadth: 4,
    });
    expect(envelope.items.map((item) => item.authority)).toEqual([
      "BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE",
    ]);
    expect(envelope.items[0]).toHaveProperty("evidencePointers");
    expect(envelope.items[0]).not.toHaveProperty("content");
    expect(envelope.items.map((item) => item.detailLevel)).toEqual([
      "L2_COMPACT", "L1_POINTER", "L1_POINTER", "L1_POINTER",
    ]);
    expect(envelope.items[1]).not.toHaveProperty("evidencePointers");
    expect(envelope.taskContract).toEqual(expect.objectContaining({ contractId: "contract-1" }));
    expect(envelope.budget.estimatedTokens).toBeLessThanOrEqual(envelope.budget.maxTokens);
    expect(parseContextEnvelope(envelope).ok).toBe(true);
    expect(Object.isFrozen(envelope.items[0]?.scope)).toBe(true);
  });

  it("emits minimal L1 pointers with one-sentence summaries", () => {
    const envelope = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.pointer", 1),
    ], { requestedLevel: "L1_POINTER" }));
    expect(envelope.items[0]).toEqual(expect.objectContaining({
      detailLevel: "L1_POINTER", summary: "knowledge.context.pointer compact summary.",
    }));
    for (const field of ["applicability", "failurePaths", "symbols", "content", "evidencePointers", "evidenceSummary", "sourceEpisodes"]) {
      expect(envelope.items[0]).not.toHaveProperty(field);
    }
  });

  it("keeps high-risk reference context as a pointer for explicit progressive expansion", () => {
    const envelope = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.evidenced", 1),
    ], { requestedLevel: "L1_POINTER", signals: { risk: "HIGH" } }));
    expect(envelope.complexity).toMatchObject({ level: "L1_POINTER", depth: "POINTER", evidence: "NONE" });
    expect(envelope.complexity.reasonCodes).toContain("RISK_REQUIRES_PROGRESSIVE_EXPANSION");
    expect(envelope.items[0]).not.toHaveProperty("content");
    expect(envelope.items[0]).not.toHaveProperty("evidenceSummary");
  });

  it("uses exact-Scope feedback for L1-L3 depth without overriding explicit requests", () => {
    const value = candidate("knowledge.context.feedback", 1);
    const feedback = {
      scopeKey: JSON.stringify({ level: "TASK", projectId: "project-a", taskId: "task-context" }),
      preferredLevel: "L1_POINTER" as const,
      sampleCount: 2,
      reasonCodes: ["IRRELEVANT_FEEDBACK_REDUCED_DEPTH"],
    };
    const learned = new ContextOrchestrator().orchestrate(request([value], { feedback }));
    expect(learned.complexity).toMatchObject({
      level: "L1_POINTER", reasonCodes: ["FEEDBACK_COMPLEXITY_LEVEL", "IRRELEVANT_FEEDBACK_REDUCED_DEPTH"],
    });
    expect(new ContextOrchestrator().orchestrate(request([value], { feedback, requestedLevel: "L2_COMPACT" })).complexity.level).toBe("L2_COMPACT");
    const risky = new ContextOrchestrator().orchestrate(request([value], { feedback, signals: { risk: "HIGH" } }));
    expect(risky.complexity.level).toBe("L1_POINTER");
    expect(risky.complexity.reasonCodes).toContain("RISK_REQUIRES_PROGRESSIVE_EXPANSION");
    expect(() => new ContextOrchestrator().orchestrate(request([value], {
      feedback: { ...feedback, scopeKey: JSON.stringify({ level: "PROJECT", projectId: "project-b" }) },
    }))).toThrow("feedback hint");
    expect(() => new ContextOrchestrator().orchestrate(request([value], {
      feedback: { ...feedback, preferredLevel: "L3_EVIDENCED", sampleCount: 0 },
    }))).toThrow("feedback hint");
  });

  it("caps learned L3 feedback to progressive disclosure during automatic UserPrompt injection", () => {
    const feedback = {
      scopeKey: JSON.stringify({ level: "TASK", projectId: "project-a", taskId: "task-context" }),
      preferredLevel: "L3_EVIDENCED" as const,
      sampleCount: 3,
      reasonCodes: ["RELEVANT_AND_USED_FEEDBACK_INCREASED_DEPTH"],
    };
    const envelope = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.feedback-rule", 2, { kind: "RULE", status: "ACCEPTED" }),
      candidate("knowledge.context.feedback-reference", 1),
    ], { feedback, policy: { ...DEFAULT_CONFIGURATION.injection, defaultMaxTokens: 1_600 } }));
    expect(envelope.items.map((item) => item.detailLevel)).toEqual(["L2_COMPACT", "L1_POINTER"]);
    expect(envelope.complexity.reasonCodes).toContain("AUTOMATIC_PROGRESSIVE_DISCLOSURE");
    expect(envelope.items.every((item) => !("content" in item))).toBe(true);
  });

  it("forbids automatic L4 and allows only explicit non-automatic Episode expansion", () => {
    const values = [candidate("knowledge.context.episode", 1)];
    const automatic = new ContextOrchestrator().orchestrate(request(values, { requestedLevel: "L4_EPISODE" }));
    expect(automatic.complexity.level).toBe("L3_EVIDENCED");
    expect(automatic.complexity.reasonCodes).toContain("L4_AUTOMATIC_FORBIDDEN");
    expect(automatic.items[0]).not.toHaveProperty("sourceEpisodes");
    const explicit = new ContextOrchestrator().orchestrate(request(values, {
      requestedLevel: "L4_EPISODE", automatic: false, explicitEpisodeExpansion: true,
    }));
    expect(explicit.complexity).toMatchObject({ level: "L4_EPISODE", depth: "EPISODE", evidence: "EPISODE" });
    expect(explicit.items[0]?.sourceEpisodes).toEqual(["episode-knowledge.context.episode"]);
  });

  it("uses L0 for no knowledge while allowing an optional standalone contract", () => {
    const envelope = new ContextOrchestrator().orchestrate(request([], {
      taskContract: { contractId: "contract-empty", objective: "Keep the task bounded.", gates: [], boundaries: [] },
    }));
    expect(envelope).toMatchObject({
      complexity: { level: "L0_NONE", breadth: 0, depth: "NONE", authority: "NONE", evidence: "NONE" },
      items: [], taskContract: { contractId: "contract-empty" },
    });
  });

  it("prioritizes closer Scope before status for non-binding knowledge under a token budget", () => {
    const values = [
      candidate("knowledge.context.global-reference", 1, { status: "VERIFIED", scope: { level: "GLOBAL" } }),
      candidate("knowledge.context.project-fact", 2, { kind: "FACT", status: "VERIFIED" }),
      candidate("knowledge.context.symbol", 3, {
        status: "ACCEPTED", scope: { level: "SYMBOL", projectId: project.projectId, symbols: ["ContextOrchestrator"] },
      }),
      candidate("knowledge.context.task", 8, {
        status: "ACCEPTED", scope: { level: "TASK", taskId: "task-context", projectId: project.projectId },
      }),
    ];
    const expandedPolicy = { ...DEFAULT_CONFIGURATION.injection, defaultMaxTokens: 1_600 };
    const full = new ContextOrchestrator().orchestrate(request(values, {
      requestedLevel: "L1_POINTER", policy: expandedPolicy,
    }));
    expect(full.items.map((item) => item.id)).toEqual([
      "knowledge.context.task", "knowledge.context.symbol", "knowledge.context.project-fact", "knowledge.context.global-reference",
    ]);
    const budgeted = new ContextOrchestrator().orchestrate(request(values, {
      requestedLevel: "L1_POINTER", maxTokens: Math.max(180, full.budget.estimatedTokens - 80),
      policy: expandedPolicy,
    }));
    expect(budgeted.items[0]?.id).toBe("knowledge.context.task");
    expect(budgeted.budget.truncated).toBe(true);
    expect(budgeted.budget.disclosedItems).toBe(budgeted.items.length);
    expect(budgeted.budget.omittedItems).toBe(values.length - budgeted.items.length);
    expect(estimateAdditionalContextTokens(budgeted, "trace-context-1")).toBe(budgeted.budget.estimatedTokens);
    expect(budgeted.budget.estimatedTokens).toBeLessThanOrEqual(budgeted.budget.maxTokens);
  });

  it("reserves the first automatic slot for a binding rule and discloses other candidates as pointers", () => {
    const policy = {
      ...DEFAULT_CONFIGURATION.injection,
      defaultMaxTokens: 1_600,
      levels: {
        ...DEFAULT_CONFIGURATION.injection.levels,
        L1_POINTER: { maxItems: 2, evidence: "NONE" as const },
        L2_COMPACT: { maxItems: 2, evidence: "POINTER" as const },
        L3_EVIDENCED: { maxItems: 2, evidence: "SUMMARY" as const },
      },
    };
    const envelope = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.symbol-reference", 1, {
        scope: { level: "SYMBOL", projectId: project.projectId, symbols: ["ContextOrchestrator"] },
      }),
      candidate("knowledge.context.project-rule", 8, { kind: "REQUIREMENT", status: "ACCEPTED" }),
      candidate("knowledge.context.other-reference", 2),
    ], { policy }));
    expect(envelope.items.map((item) => [item.id, item.detailLevel])).toEqual([
      ["knowledge.context.project-rule", "L2_COMPACT"],
      ["knowledge.context.symbol-reference", "L1_POINTER"],
    ]);
    expect(envelope.complexity).toMatchObject({ level: "L2_COMPACT", breadth: 2, evidence: "POINTER" });

    const constrained = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.large-reference-one", 1, { summary: "reference ".repeat(100) }),
      candidate("knowledge.context.required-rule", 8, { kind: "REQUIREMENT", status: "ACCEPTED" }),
      candidate("knowledge.context.large-reference-two", 2, { summary: "reference ".repeat(100) }),
    ]));
    expect(constrained.items[0]).toMatchObject({
      id: "knowledge.context.required-rule", authority: "BINDING_RULE", detailLevel: "L2_COMPACT",
    });
    expect(constrained.budget.omittedItems).toBeGreaterThan(0);
    expect(constrained.budget.estimatedTokens).toBeLessThanOrEqual(constrained.budget.maxTokens);
  });

  it("orders module, user, team, and global scopes without widening the query", () => {
    const values = [
      candidate("knowledge.context.global", 1, { scope: { level: "GLOBAL" } }),
      candidate("knowledge.context.team", 2, { scope: { level: "TEAM", teamId: "team-a" } }),
      candidate("knowledge.context.user", 3, { scope: { level: "USER", userId: "user-a" } }),
      candidate("knowledge.context.module", 4, {
        scope: { level: "MODULE", projectId: project.projectId, modulePaths: ["packages/context-orchestrator"] },
      }),
    ];
    const envelope = new ContextOrchestrator().orchestrate(request(values, {
      requestedLevel: "L1_POINTER",
      policy: { ...DEFAULT_CONFIGURATION.injection, defaultMaxTokens: 1_600 },
    }));
    expect(envelope.items.map((item) => item.id)).toEqual([
      "knowledge.context.module", "knowledge.context.user", "knowledge.context.team", "knowledge.context.global",
    ]);
  });

  it("downgrades evidenced content to a pointer before exhausting the budget", () => {
    const envelope = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.large", 1, { body: "evidence ".repeat(5_000) }),
    ], { requestedLevel: "L3_EVIDENCED", maxTokens: 700 }));
    expect(envelope.complexity).toMatchObject({
      level: "L1_POINTER",
      reasonCodes: ["REQUESTED_COMPLEXITY_LEVEL", "TOKEN_BUDGET_LEVEL_DOWNGRADE"],
    });
    expect(envelope.items).toHaveLength(1);
    expect(renderAdditionalContext(envelope, "trace-context-1").length).toBeGreaterThan(0);
  });

  it("omits Task Contract before displacing dynamic knowledge", () => {
    const value = candidate("knowledge.context.dynamic", 1);
    const without = new ContextOrchestrator().orchestrate(request([value], { requestedLevel: "L1_POINTER" }));
    const envelope = new ContextOrchestrator().orchestrate(request([value], {
      requestedLevel: "L1_POINTER",
      maxTokens: without.budget.estimatedTokens + 10,
      taskContract: {
        contractId: "contract-large", objective: "x".repeat(500),
        gates: ["g".repeat(500)], boundaries: ["b".repeat(500)],
      },
    }));
    expect(envelope.items).toHaveLength(1);
    expect(envelope.taskContract).toBeUndefined();
    expect(envelope.complexity.reasonCodes).toContain("TASK_CONTRACT_OMITTED_BY_BUDGET");
  });

  it("ignores ineligible candidates and validates request boundaries", () => {
    const envelope = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.stale", 1, { status: "STALE" }),
      candidate("knowledge.context.valid", 2),
    ]));
    expect(envelope.items.map((item) => item.id)).toEqual(["knowledge.context.valid"]);
    expect(envelope.complexity.reasonCodes).toContain("INELIGIBLE_CANDIDATE_IGNORED");
    expect(() => new ContextOrchestrator().orchestrate(request([], { runId: "bad\nrun" }))).toThrow("runId");
    expect(() => new ContextOrchestrator().orchestrate(request([], { traceId: "bad trace" }))).toThrow("traceId");
    expect(() => new ContextOrchestrator().orchestrate(request([], { maxTokens: 0 }))).toThrow("maxTokens");
    expect(() => new ContextOrchestrator().orchestrate(request([], {
      requestedLevel: "L9_UNKNOWN",
    }) as never)).toThrow("requestedLevel");
    expect(() => new ContextOrchestrator().orchestrate(request([], {
      taskContract: { contractId: "", objective: "x", gates: [], boundaries: [] },
    }))).toThrow("taskContract");
  });

  it("falls back to L0 when every candidate is stale or outside the resolved Scope", () => {
    const outside = candidate("knowledge.context.outside", 2);
    const envelope = new ContextOrchestrator().orchestrate(request([
      candidate("knowledge.context.stale-only", 1, { status: "SUPERSEDED" }),
      { ...outside, scopeMatched: false } as unknown as RerankedKnowledge,
    ]));
    expect(envelope).toMatchObject({
      complexity: {
        level: "L0_NONE",
        breadth: 0,
        reasonCodes: ["NO_RETRIEVED_KNOWLEDGE", "INELIGIBLE_CANDIDATE_IGNORED"],
      },
      items: [],
    });
  });

  it("fails explicitly when metadata alone cannot fit the requested budget", () => {
    expect(() => new ContextOrchestrator().orchestrate(request([], { maxTokens: 1 }))).toThrow("metadata exceeds");
  });
});
