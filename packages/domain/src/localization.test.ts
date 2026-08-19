import { describe, expect, it } from "vitest";

import {
  calculateCodeGraphArtifactHash,
  deriveCodeGraphArtifactId,
  deriveScenarioId,
  evaluateCodeGraphArtifactReuse,
  isValidScenarioKey,
  locatorHasAuthoritativeRevision,
  validateKnowledgeLocator,
  type CodeGraphArtifact,
  type KnowledgeLocator,
} from "./index.js";

const locator: KnowledgeLocator = {
  schemaVersion: 1, projectId: "project-a", repositoryRemote: "github.com/example/a",
  observedRevision: { branch: "main", commit: "abcdef1234567", dirty: false, codegraphRevision: "graph-1" },
  branchApplicability: { mode: "BRANCH_LINEAGE", baseCommit: "abcdef1234567", observedBranch: "main" },
  scenarioId: deriveScenarioId("project-a", "order.create"), scenarioKey: "order.create",
  scenarioTitle: "创建订单", scenarioSummary: "校验并持久化订单。", modulePaths: ["src/order"],
  symbols: ["OrderService.create"], entryPoints: ["POST /orders"], taskIntents: ["新增订单"],
  applicability: ["HTTP 创建入口"], nonApplicability: ["批量导入"],
};

function artifact(): CodeGraphArtifact {
  const identity = { projectId: "project-a", codeRevision: "abcdef1234567", graphRevision: "graph-1",
    operation: "CALL_PATH" as const, query: "OrderController->OrderRepository" };
  const base = { schemaVersion: 1 as const, artifactId: deriveCodeGraphArtifactId(identity), ...identity,
    facts: [{ kind: "CALL_PATH" as const, from: "OrderController", to: "OrderRepository",
      symbols: ["OrderController", "OrderService", "OrderRepository"], paths: ["src/order.ts"] }],
    bounded: false, sourceRef: "codegraph:project-a:graph-1:trace", observedAt: "2026-08-19T00:00:00.000Z",
    reasonCodes: ["CODEGRAPH_READY"] };
  return { ...base, status: "ACTIVE", contentHash: calculateCodeGraphArtifactHash(base) };
}

describe("knowledge localization", () => {
  it("derives stable scenario identity and validates authoritative locator coordinates", () => {
    expect(locator.scenarioId).toBe("scenario:project-a:order.create");
    expect(validateKnowledgeLocator(locator)).toEqual({ valid: true, reasonCodes: [] });
    expect(validateKnowledgeLocator({ ...locator, scenarioId: "scenario:forged" }).reasonCodes)
      .toContain("LOCATOR_SCENARIO_INVALID");
    expect(isValidScenarioKey("order.create")).toBe(true);
    expect(isValidScenarioKey("Order")).toBe(false);
    expect(locatorHasAuthoritativeRevision(locator)).toBe(true);
    expect(locatorHasAuthoritativeRevision({ ...locator, observedRevision: { dirty: false } })).toBe(false);
    expect(() => deriveScenarioId("", "order.create")).toThrow("SCENARIO_ID_INPUT_INVALID");
    expect(() => deriveScenarioId("project-a", "invalid")).toThrow("SCENARIO_ID_INPUT_INVALID");

    const invalid = validateKnowledgeLocator({
      ...locator,
      schemaVersion: 2 as 1,
      projectId: "",
      repositoryRemote: "\n",
      scenarioId: "forged",
      scenarioKey: "INVALID",
      scenarioTitle: "",
      scenarioSummary: "",
      observedRevision: { branch: "\n", commit: "bad", dirty: undefined as unknown as boolean, codegraphRevision: "\n" },
      branchApplicability: { mode: "EXACT_BRANCH", branch: "" },
      modulePaths: [""], symbols: [], entryPoints: [], taskIntents: [], applicability: [], nonApplicability: [],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.reasonCodes).toEqual(expect.arrayContaining([
      "LOCATOR_SCHEMA_UNSUPPORTED", "LOCATOR_PROJECT_MISSING", "LOCATOR_REMOTE_INVALID",
      "LOCATOR_SCENARIO_INVALID", "LOCATOR_SCENARIO_DESCRIPTION_INVALID", "LOCATOR_BRANCH_INVALID",
      "LOCATOR_COMMIT_INVALID", "LOCATOR_DIRTY_INVALID", "LOCATOR_CODEGRAPH_REVISION_INVALID",
      "LOCATOR_EXACT_BRANCH_INVALID", "LOCATOR_MODULE_PATHS_INVALID",
    ]));
    expect(validateKnowledgeLocator({ ...locator,
      branchApplicability: { mode: "BRANCH_LINEAGE", baseCommit: "bad" } }).reasonCodes)
      .toContain("LOCATOR_LINEAGE_COMMIT_INVALID");
    expect(validateKnowledgeLocator({ ...locator,
      branchApplicability: { mode: "ALL_BRANCHES", reason: "" } }).reasonCodes)
      .toContain("LOCATOR_ALL_BRANCHES_REASON_INVALID");
  });

  it("reuses CodeGraph artifacts only on compatible revisions and unaffected dependencies", () => {
    const value = artifact();
    expect(evaluateCodeGraphArtifactReuse(value, { projectId: "project-a", codeRevision: "abcdef1234567",
      graphRevision: "graph-1", changedPaths: ["src/unrelated.ts"] })).toMatchObject({ reusable: true });
    expect(evaluateCodeGraphArtifactReuse(value, { projectId: "project-a", codeRevision: "fedcba7654321",
      graphRevision: "graph-2", changedPaths: ["src/order.ts"] })).toMatchObject({ reusable: false, markSuspect: true });
    expect(evaluateCodeGraphArtifactReuse(value, { projectId: "project-a", codeRevision: "abcdef1234567" }))
      .toMatchObject({ reusable: false, markSuspect: true,
        reasonCodes: expect.arrayContaining(["ARTIFACT_GRAPH_REVISION_MISMATCH"]) });
    const dependencyBound = { ...value, dependencyFingerprint: "deps-v1" };
    expect(evaluateCodeGraphArtifactReuse(dependencyBound, { projectId: "project-a", codeRevision: "abcdef1234567",
      graphRevision: "graph-1", dependencyFingerprint: "deps-v2" }).reasonCodes)
      .toContain("ARTIFACT_DEPENDENCY_FINGERPRINT_MISMATCH");
    const symbolFact = { ...value, status: "SUSPECT" as const, facts: [...value.facts, {
      kind: "SYMBOL" as const, symbol: "OrderValidator", qualifiedName: "orders.OrderValidator",
      path: "src/validator.ts", startLine: 1,
    }] };
    expect(evaluateCodeGraphArtifactReuse(symbolFact, {
      projectId: "project-b", codeRevision: "abcdef1234567", graphRevision: "graph-1",
      changedPaths: ["src/validator.ts"], changedSymbols: ["orders.OrderValidator"],
    })).toMatchObject({ reusable: false, markSuspect: true, reasonCodes: expect.arrayContaining([
      "ARTIFACT_ALREADY_SUSPECT", "ARTIFACT_PROJECT_MISMATCH", "ARTIFACT_REFERENCED_PATH_CHANGED",
      "ARTIFACT_REFERENCED_SYMBOL_CHANGED",
    ]) });
    expect(evaluateCodeGraphArtifactReuse({ ...value, status: "SUSPECT" }, {
      projectId: "project-a", codeRevision: "abcdef1234567", graphRevision: "graph-1",
    })).toMatchObject({ reusable: false, markSuspect: false, reasonCodes: ["ARTIFACT_ALREADY_SUSPECT"] });
    const plainSymbol = { ...value, dependencyFingerprint: "deps-v1", facts: [{
      kind: "SYMBOL" as const, symbol: "OrderService", path: "src/order.ts", startLine: 1,
    }] };
    expect(evaluateCodeGraphArtifactReuse(plainSymbol, {
      projectId: "project-a", codeRevision: "abcdef1234567", graphRevision: "graph-1",
      dependencyFingerprint: "deps-v1", changedSymbols: ["OtherService"],
    })).toMatchObject({ reusable: true, markSuspect: false, reasonCodes: ["ARTIFACT_COMPATIBLE"] });
  });
});
