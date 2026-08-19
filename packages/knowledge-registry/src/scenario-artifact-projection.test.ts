import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  calculateCodeGraphArtifactHash,
  deriveCodeGraphArtifactId,
  deriveScenarioId,
  type CodeGraphArtifact,
  type ScenarioDefinition,
} from "@zhiloop/domain";

import { SqliteCodeGraphArtifactProjection, SqliteScenarioRegistryProjection } from "./index.js";

const at = "2026-08-19T00:00:00.000Z";

function scenario(version = 1, sources: readonly string[] = ["knowledge-a@1"]): ScenarioDefinition {
  return { schemaVersion: 1, scenarioId: deriveScenarioId("project-a", "order.create"), projectId: "project-a",
    scenarioKey: "order.create", version, title: "创建订单", summary: "校验并持久化订单。",
    taskIntents: ["新增订单"], entryPoints: ["POST /orders"], applicability: ["HTTP 请求"],
    nonApplicability: ["批量导入"], aliases: [], relations: [], sourceKnowledgeVersions: sources,
    createdAt: at, updatedAt: at };
}

function artifact(): CodeGraphArtifact {
  const identity = { projectId: "project-a", codeRevision: "abcdef1234567", graphRevision: "graph-1",
    operation: "SYMBOL" as const, query: "OrderService" };
  const base = { schemaVersion: 1 as const, artifactId: deriveCodeGraphArtifactId(identity), ...identity,
    facts: [{ kind: "SYMBOL" as const, symbol: "OrderService", path: "src/order.ts", startLine: 10 }],
    bounded: false, sourceRef: "codegraph:a:graph-1:query", observedAt: at, reasonCodes: ["CODEGRAPH_READY"] };
  return { ...base, status: "ACTIVE", contentHash: calculateCodeGraphArtifactHash(base) };
}

function rehashArtifact(overrides: Partial<CodeGraphArtifact>): CodeGraphArtifact {
  const merged = { ...artifact(), ...overrides };
  const artifactId = deriveCodeGraphArtifactId({ projectId: merged.projectId, codeRevision: merged.codeRevision,
    ...(merged.graphRevision === undefined ? {} : { graphRevision: merged.graphRevision }),
    ...(merged.dependencyFingerprint === undefined ? {} : { dependencyFingerprint: merged.dependencyFingerprint }),
    operation: merged.operation, query: merged.query });
  const withoutHash = Object.fromEntries(Object.entries({ ...merged, artifactId })
    .filter(([key]) => key !== "contentHash" && key !== "status")) as Omit<CodeGraphArtifact, "contentHash" | "status">;
  return { ...merged, artifactId, contentHash: calculateCodeGraphArtifactHash(withoutHash) };
}

describe("scenario and CodeGraph projections", () => {
  it("stores immutable scenario versions, bindings, Markdown, and deterministic rebuilds", () => {
    const projection = new SqliteScenarioRegistryProjection(":memory:");
    expect(projection.project(scenario()).status).toBe("PROJECTED");
    expect(projection.project(scenario()).status).toBe("IDEMPOTENT");
    expect(projection.project(scenario(2, ["knowledge-a@1", "knowledge-b@1"]))).toMatchObject({ version: 2 });
    expect(projection.get(scenario().scenarioId)?.knowledgeVersions).toEqual(["knowledge-a@1", "knowledge-b@1"]);
    expect(projection.renderMarkdown(scenario().scenarioId)).toContain("## 关联知识");
    expect(projection.rebuild([scenario(), scenario(2, ["knowledge-a@1", "knowledge-b@1"])]))
      .toMatchObject({ scenarios: 1, versions: 2, bindings: 3 });
    expect(() => projection.project({ ...scenario(2), title: "collision" })).toThrow("COLLISION");
    expect(projection.rollbackCurrent(scenario().scenarioId, 2).definition.version).toBe(1);
    expect(() => projection.rollbackCurrent(scenario().scenarioId, 2)).toThrow("REVISION_CONFLICT");
    projection.close();
  });

  it("upgrades legacy scenario payload hashes without losing immutable versions", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "zhiloop-scenario-")), "scenario.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE scenario_projection_meta(component TEXT PRIMARY KEY, migration_version INTEGER NOT NULL);
      CREATE TABLE scenarios(scenario_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scenario_key TEXT NOT NULL,
        current_version INTEGER NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        UNIQUE(project_id, scenario_key));
      CREATE TABLE scenario_versions(scenario_id TEXT NOT NULL, version INTEGER NOT NULL,
        payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(scenario_id, version));
      CREATE TABLE scenario_bindings(scenario_id TEXT NOT NULL, scenario_version INTEGER NOT NULL,
        knowledge_version TEXT NOT NULL, PRIMARY KEY(scenario_id, scenario_version, knowledge_version),
        FOREIGN KEY(scenario_id, scenario_version) REFERENCES scenario_versions(scenario_id, version) ON DELETE CASCADE);
      CREATE TABLE scenario_relations(scenario_id TEXT NOT NULL, scenario_version INTEGER NOT NULL,
        ordinal INTEGER NOT NULL, relation_type TEXT NOT NULL, target_scenario_id TEXT NOT NULL,
        reason_codes_json TEXT NOT NULL, PRIMARY KEY(scenario_id, scenario_version, ordinal),
        FOREIGN KEY(scenario_id, scenario_version) REFERENCES scenario_versions(scenario_id, version) ON DELETE CASCADE);
      INSERT INTO scenario_projection_meta VALUES ('scenario-registry', 1);
    `);
    const payload = JSON.stringify(scenario());
    legacy.prepare("INSERT INTO scenario_versions VALUES (?, 1, ?, ?)").run(scenario().scenarioId, payload, payload);
    legacy.prepare("INSERT INTO scenarios VALUES (?, ?, ?, 1, ?, ?)")
      .run(scenario().scenarioId, "project-a", "order.create", payload, payload);
    legacy.close();
    const projection = new SqliteScenarioRegistryProjection(filename);
    expect(projection.get(scenario().scenarioId)?.definition.title).toBe("创建订单");
    expect(projection.project(scenario()).status).toBe("IDEMPOTENT");
    projection.close();
    const reopened = new SqliteScenarioRegistryProjection(filename);
    expect(reopened.get(scenario().scenarioId, 1)?.definition.version).toBe(1);
    reopened.close();
  });

  it("rejects a projection schema created by a newer runtime", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "zhiloop-scenario-newer-")), "scenario.sqlite");
    const database = new DatabaseSync(filename);
    database.exec(`CREATE TABLE scenario_projection_meta(component TEXT PRIMARY KEY, migration_version INTEGER NOT NULL);
      INSERT INTO scenario_projection_meta VALUES ('scenario-registry', 999);`);
    database.close();
    expect(() => new SqliteScenarioRegistryProjection(filename)).toThrow("VERSION_UNSUPPORTED");
  });

  it("detects corrupt current payloads and missing immutable rollback targets", () => {
    const corruptFile = path.join(mkdtempSync(path.join(tmpdir(), "zhiloop-scenario-corrupt-")), "scenario.sqlite");
    const corrupt = new SqliteScenarioRegistryProjection(corruptFile);
    corrupt.project(scenario());
    corrupt.close();
    const corruptDatabase = new DatabaseSync(corruptFile);
    corruptDatabase.prepare("UPDATE scenarios SET payload_hash='forged' WHERE scenario_id=?").run(scenario().scenarioId);
    corruptDatabase.close();
    const corruptReader = new SqliteScenarioRegistryProjection(corruptFile);
    expect(() => corruptReader.get(scenario().scenarioId)).toThrow("PROJECTION_CORRUPT");
    corruptReader.close();

    const rollbackFile = path.join(mkdtempSync(path.join(tmpdir(), "zhiloop-scenario-rollback-")), "scenario.sqlite");
    const rollback = new SqliteScenarioRegistryProjection(rollbackFile);
    rollback.project(scenario());
    rollback.project(scenario(2));
    rollback.close();
    const rollbackDatabase = new DatabaseSync(rollbackFile);
    rollbackDatabase.prepare("DELETE FROM scenario_versions WHERE scenario_id=? AND version=1").run(scenario().scenarioId);
    rollbackDatabase.close();
    const rollbackReader = new SqliteScenarioRegistryProjection(rollbackFile);
    expect(() => rollbackReader.rollbackCurrent(scenario().scenarioId, 2)).toThrow("ROLLBACK_TARGET_INVALID");
    rollbackReader.close();
  });

  it("detects artifact collisions, preserves bindings, and marks incompatible reuse suspect", () => {
    const projection = new SqliteCodeGraphArtifactProjection(":memory:");
    const value = artifact();
    expect(projection.project(value, ["knowledge-a@1"]).status).toBe("PROJECTED");
    expect(projection.project(value, ["knowledge-a@1", "knowledge-b@1"]).status).toBe("IDEMPOTENT");
    expect(projection.forKnowledge("knowledge-b@1")[0]?.artifact.artifactId).toBe(value.artifactId);
    expect(projection.reuse(value.artifactId, { projectId: "project-a", codeRevision: "fedcba7654321",
      changedSymbols: ["OrderService"] })).toMatchObject({ reusable: false, markSuspect: true });
    expect(projection.get(value.artifactId)?.artifact.status).toBe("SUSPECT");
    expect(projection.project(value, ["knowledge-c@1"])).toMatchObject({ status: "IDEMPOTENT" });
    expect(projection.get(value.artifactId)?.artifact.status).toBe("SUSPECT");
    expect(() => projection.project({ ...value, query: "Forged" })).toThrow();
    projection.close();
  });

  it("fails closed for invalid artifacts, bindings, lookups and closed projections", () => {
    const projection = new SqliteCodeGraphArtifactProjection(":memory:");
    const value = artifact();
    const invalid = [
      { ...value, schemaVersion: 2 as 1 },
      { ...value, artifactId: "" },
      { ...value, projectId: "" },
      { ...value, codeRevision: "" },
      { ...value, query: "" },
      { ...value, sourceRef: "" },
      { ...value, observedAt: "invalid" },
      { ...value, bounded: undefined as unknown as boolean },
      { ...value, reasonCodes: ["bad"] },
      { ...value, graphRevision: "" },
      { ...value, dependencyFingerprint: "" },
      { ...value, status: "INVALID" as "ACTIVE" },
      rehashArtifact({ graphRevision: "" }),
      rehashArtifact({ dependencyFingerprint: "" }),
      rehashArtifact({ facts: Array.from({ length: 51 }, (_, index) => ({ kind: "SYMBOL" as const,
        symbol: `S${index}`, path: "a.ts", startLine: 1 })) }),
      rehashArtifact({ reasonCodes: Array.from({ length: 101 }, () => "READY") }),
      rehashArtifact({ facts: [{ kind: "SYMBOL" as const, symbol: "", path: "a.ts", startLine: 1 }] }),
      rehashArtifact({ facts: [{ kind: "SYMBOL" as const, symbol: "A", path: "", startLine: 1 }] }),
      rehashArtifact({ facts: [{ kind: "SYMBOL" as const, symbol: "A", path: "a.ts", startLine: 0 }] }),
      rehashArtifact({ facts: [{ kind: "SYMBOL" as const, symbol: "A", path: "a.ts", startLine: 2, endLine: 1 }] }),
      rehashArtifact({ facts: [{ kind: "CALL_PATH" as const, from: "", to: "B", symbols: [], paths: [] }] }),
      rehashArtifact({ facts: [{ kind: "CALL_PATH" as const, from: "A", to: "", symbols: [], paths: [] }] }),
      rehashArtifact({ facts: [{ kind: "CALL_PATH" as const, from: "A", to: "B", symbols: [""], paths: [] }] }),
      rehashArtifact({ facts: [{ kind: "CALL_PATH" as const, from: "A", to: "B", symbols: [], paths: [""] }] }),
      { ...value, contentHash: "forged" },
    ];
    for (const item of invalid) expect(() => projection.project(item)).toThrow("CODEGRAPH_ARTIFACT_INVALID");
    expect(() => projection.project(value, ["knowledge-a@1", "knowledge-a@1"]))
      .toThrow("CODEGRAPH_ARTIFACT_BINDING_INVALID");
    expect(() => projection.project(value, [""])).toThrow("CODEGRAPH_ARTIFACT_BINDING_INVALID");
    expect(projection.get("")).toBeUndefined();
    expect(projection.get("missing-artifact")).toBeUndefined();
    expect(projection.forKnowledge("")).toEqual([]);
    expect(projection.forKnowledge("missing@1")).toEqual([]);
    expect(projection.reuse("missing-artifact", { projectId: "project-a", codeRevision: "abc" }))
      .toMatchObject({ reusable: false, markSuspect: false, reasonCodes: ["ARTIFACT_NOT_FOUND"] });
    projection.close();
    projection.close();
    expect(() => projection.get(value.artifactId)).toThrow("closed");
  });

  it("rejects invalid scenarios and supports bounded missing/versioned reads", () => {
    const projection = new SqliteScenarioRegistryProjection(":memory:");
    const value = scenario();
    const invalid = [
      { ...value, schemaVersion: 2 as 1 }, { ...value, scenarioId: "forged" }, { ...value, version: 0 },
      { ...value, version: Number.NaN },
      { ...value, title: "" }, { ...value, summary: "" }, { ...value, createdAt: "invalid" },
      { ...value, updatedAt: "invalid" },
      { ...value, sourceKnowledgeVersions: Array.from({ length: 10_001 }, (_, index) => `knowledge-${index}@1`) },
      { ...value, relations: Array.from({ length: 1_001 }, (_, index) => ({ type: "OVERLAPS" as const,
        targetScenarioId: `scenario:project-a:related.${index}`, reasonCodes: ["RELATED"] })) },
      { ...value, taskIntents: Array.from({ length: 101 }, (_, index) => `intent-${index}`) },
      { ...value, taskIntents: ["same", "same"] },
      { ...value, sourceKnowledgeVersions: ["x", "x"] },
      { ...value, sourceKnowledgeVersions: [""] },
      { ...value, relations: [{ type: "OVERLAPS" as const, targetScenarioId: "", reasonCodes: [] }] },
      { ...value, relations: [{ type: "OVERLAPS" as const, targetScenarioId: "scenario:x:y.z", reasonCodes: ["bad"] }] },
      { ...value, relations: [{ type: "OVERLAPS" as const, targetScenarioId: "scenario:x:y.z",
        reasonCodes: Array.from({ length: 101 }, () => "RELATED") }] },
      { ...value, taskIntents: [""] },
    ];
    for (const item of invalid) expect(() => projection.project(item)).toThrow(/SCENARIO_/u);
    expect(projection.get("")).toBeUndefined();
    expect(projection.get("scenario:project-a:missing")).toBeUndefined();
    expect(projection.list("", 1)).toEqual([]);
    expect(projection.list("x".repeat(501), 1)).toEqual([]);
    expect(projection.list("project-a\n", 1)).toEqual([]);
    expect(projection.list("project-a", 0)).toEqual([]);
    expect(projection.list("project-a", 1_001)).toEqual([]);
    expect(projection.renderMarkdown("scenario:project-a:missing")).toBeUndefined();
    const empty = { ...value, scenarioId: deriveScenarioId("project-a", "empty.case"), scenarioKey: "empty.case",
      taskIntents: [], entryPoints: [], applicability: [], nonApplicability: [], sourceKnowledgeVersions: [] };
    projection.project(empty);
    expect(projection.renderMarkdown(empty.scenarioId)).toContain("- 暂无");
    expect(projection.renderMarkdown(empty.scenarioId)?.match(/未声明/gu)).toHaveLength(4);
    expect(projection.rebuild([])).toEqual({ scenarios: 0, versions: 0, bindings: 0, relations: 0 });
    expect(() => projection.project(scenario(2))).toThrow("NON_MONOTONIC");
    expect(() => projection.rollbackCurrent(value.scenarioId, 2)).toThrow("REVISION_CONFLICT");
    expect(() => projection.rollbackCurrent(value.scenarioId, 1)).toThrow("ROLLBACK_INVALID");
    projection.close();
    projection.close();
    expect(() => projection.list("project-a")).toThrow("closed");
  });
});
