import { describe, expect, it } from "vitest";

import { deriveScenarioId, type KnowledgeCandidate, type KnowledgeLocator, type ScenarioDefinition } from "@zhiloop/domain";

import { reconcileScenario } from "./scenario-evolution.js";

const at = "2026-08-19T00:00:00.000Z";

function locator(key = "order.create", branch = "main", exclusions: readonly string[] = ["批量导入"]): KnowledgeLocator {
  return { schemaVersion: 1, projectId: "project-a", observedRevision: { branch, commit: "abcdef1234567", dirty: false },
    branchApplicability: { mode: "EXACT_BRANCH", branch }, scenarioId: deriveScenarioId("project-a", key),
    scenarioKey: key, scenarioTitle: "创建订单", scenarioSummary: "校验并持久化订单。", modulePaths: ["src/order"],
    symbols: ["OrderService.create"], entryPoints: ["POST /orders"], taskIntents: ["新增订单"],
    applicability: ["HTTP 请求"], nonApplicability: exclusions };
}

function candidate(value = locator()): KnowledgeCandidate {
  return { schemaVersion: 2, candidateId: "candidate-a", compilerVersion: "v2", status: "PROPOSED",
    subjectKey: "implementation.order.create", kind: "IMPLEMENTATION", claimMode: "CURRENT_STATE", locator: value,
    scopeHint: { projectId: "project-a", reasonCodes: [] }, title: "创建订单", summary: "创建流程", body: "流程正文",
    sourceEpisodes: ["episode-a"], confidence: 0.9, assertions: [],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-a", correlationId: "correlation-a" }],
    createdAt: at, correlationId: "correlation-a" };
}

function definition(value = locator(), version = 1, sources: readonly string[] = ["knowledge-a@1"]): ScenarioDefinition {
  return { schemaVersion: 1, scenarioId: value.scenarioId, projectId: value.projectId, scenarioKey: value.scenarioKey,
    version, title: value.scenarioTitle, summary: value.scenarioSummary, taskIntents: value.taskIntents,
    entryPoints: value.entryPoints, applicability: value.applicability, nonApplicability: value.nonApplicability,
    aliases: [], relations: [], sourceKnowledgeVersions: sources, createdAt: at, updatedAt: at };
}

describe("reconcileScenario", () => {
  it("creates a scenario and updates the stable identity with a new immutable version", () => {
    const created = reconcileScenario({ candidate: candidate(), knowledgeVersion: "knowledge-a@1", related: [], now: at });
    expect(created.decision).toMatchObject({ status: "DECIDED", action: "CREATE" });
    expect(created.next).toMatchObject({ version: 1, sourceKnowledgeVersions: ["knowledge-a@1"] });
    const current = { definition: definition(), locators: [locator()] };
    const updated = reconcileScenario({ candidate: candidate(), knowledgeVersion: "knowledge-b@1", current, related: [], now: at });
    expect(updated.decision).toMatchObject({ status: "DECIDED", action: "UPDATE_VERSION" });
    expect(updated.next).toMatchObject({ version: 2, sourceKnowledgeVersions: ["knowledge-a@1", "knowledge-b@1"] });
  });

  it("keeps overlapping branch-specific scenarios separate and records provenance", () => {
    const feature = locator("order.create-v2", "feature/v2", ["legacy API"]);
    const related = { definition: definition(locator("order.create", "main")), locators: [locator("order.create", "main")] };
    const result = reconcileScenario({ candidate: candidate(feature), knowledgeVersion: "knowledge-feature@1",
      related: [related], now: at });
    expect(result.decision).toMatchObject({ status: "DECIDED", action: "KEEP_SEPARATE" });
    expect(result.next?.relations).toContainEqual(expect.objectContaining({ type: "OVERLAPS",
      targetScenarioId: related.definition.scenarioId }));
  });

  it("fails closed when one stable key carries conflicting branch boundaries", () => {
    const current = { definition: definition(), locators: [locator("order.create", "main")] };
    const result = reconcileScenario({ candidate: candidate(locator("order.create", "feature/v2")),
      knowledgeVersion: "knowledge-feature@1", current, related: [], now: at });
    expect(result.decision).toMatchObject({ status: "PENDING" });
    expect(result.next).toBeUndefined();
  });

  it("skips an existing binding and rejects malformed or mismatched inputs", () => {
    const current = { definition: definition(), locators: [locator()] };
    expect(reconcileScenario({ candidate: candidate(), knowledgeVersion: "knowledge-a@1", current,
      related: [], now: at }).decision).toMatchObject({ action: "SKIP" });
    expect(() => reconcileScenario({ candidate: { ...candidate(), schemaVersion: 1 }, knowledgeVersion: "x",
      related: [], now: at })).toThrow("REQUIRES_LOCATED_CANDIDATE");
    expect(() => reconcileScenario({ candidate: candidate(), knowledgeVersion: "", related: [], now: at }))
      .toThrow("INPUT_INVALID");
    expect(() => reconcileScenario({ candidate: candidate(), knowledgeVersion: "x", related: [], now: "invalid" }))
      .toThrow("INPUT_INVALID");
    expect(() => reconcileScenario({ candidate: candidate(), knowledgeVersion: "x",
      current: { definition: { ...definition(), projectId: "project-b" }, locators: [] }, related: [], now: at }))
      .toThrow("CURRENT_MISMATCH");
    expect(() => reconcileScenario({ candidate: candidate({ ...locator(), scenarioId: "forged" }),
      knowledgeVersion: "x", related: [], now: at })).toThrow("LOCATOR_INVALID");
  });

  it("keeps ambiguous matches pending and requires confirmation for a possible alias", () => {
    const alias = { definition: definition(locator("order.submit")), locators: [locator("order.submit")] };
    const aliasResult = reconcileScenario({ candidate: candidate(), knowledgeVersion: "knowledge-new@1",
      related: [alias], now: at });
    expect(aliasResult.decision).toMatchObject({ status: "PENDING",
      reasonCodes: ["MERGE_REQUIRES_CONFIRMATION", "POSSIBLE_SCENARIO_ALIAS"] });

    const second = { definition: definition(locator("order.persist")), locators: [locator("order.persist")] };
    const ambiguous = reconcileScenario({ candidate: candidate(), knowledgeVersion: "knowledge-new@1",
      related: [second, alias], now: at });
    expect(ambiguous.decision).toMatchObject({ status: "PENDING", reasonCodes: ["AMBIGUOUS_SCENARIO_MATCH"] });
  });

  it("compares lineage and all-branch identities and ignores unrelated projects", () => {
    const lineage = { ...locator("order.lineage"),
      branchApplicability: { mode: "BRANCH_LINEAGE" as const, baseCommit: "abcdef1234567", observedBranch: "main" } };
    const all = { ...locator("order.all"),
      branchApplicability: { mode: "ALL_BRANCHES" as const, reason: "portable contract" } };
    const unrelated = { definition: { ...definition(locator("order.other")), projectId: "project-b" },
      locators: [locator("order.other")] };
    expect(reconcileScenario({ candidate: candidate(lineage), knowledgeVersion: "lineage@1",
      related: [{ definition: definition({ ...lineage, scenarioId: deriveScenarioId("project-a", "order.old"), scenarioKey: "order.old" }), locators: [lineage] }], now: at }).decision.status).toBe("PENDING");
    expect(reconcileScenario({ candidate: candidate(all), knowledgeVersion: "all@1",
      related: [unrelated], now: at }).decision).toMatchObject({ action: "CREATE" });
  });
});
