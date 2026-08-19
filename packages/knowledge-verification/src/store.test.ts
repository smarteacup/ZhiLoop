import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { KnowledgeAssertion } from "@zhiloop/domain";

import { KnowledgeVerificationConflictError, KnowledgeVerificationCorruptionError, SqliteKnowledgeVerificationStore } from "./store.js";
import type { KnowledgeVerificationRunSummary } from "./types.js";

const cleanup: string[] = [];
const time = "2026-08-19T00:00:00.000Z";

function temporary(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zhiloop-verification-store-"));
  cleanup.push(root);
  return path.join(root, "knowledge-verification.sqlite");
}

afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });

const assertion: KnowledgeAssertion = { assertionId: "assertion-1", candidateId: "candidate-1", kind: "SYMBOL_EXISTS",
  parameters: { projectId: "project-1", symbol: "Runtime" }, createdAt: time };

function run(overrides: Partial<KnowledgeVerificationRunSummary> = {}): KnowledgeVerificationRunSummary {
  return { schemaVersion: 1, runId: "run-1", requestId: "request-1", purpose: "FRESHNESS", projectId: "project-1",
    subjectKey: "design.runtime.verification", candidateId: "candidate-1", knowledgeVersion: { assetId: "asset-1", assetVersion: 1 },
    codeRevision: `git:${"a".repeat(40)}:${"b".repeat(64)}`, codeRevisionCapability: "READY", graphRevision: `cg_${"c".repeat(64)}`,
    status: "COMPLETED", qualifyingProof: true, results: [{ assertionId: "assertion-1", assertionKind: "SYMBOL_EXISTS",
      status: "SUPPORTED", reasonCodes: ["CODEGRAPH_SYMBOL_FOUND"], evidenceId: "evidence-1" }], startedAt: time, completedAt: time,
    ...overrides };
}

describe("SqliteKnowledgeVerificationStore", () => {
  it("owns migration recipes transactionally and rolls back only the exact owner", () => {
    using store = new SqliteKnowledgeVerificationStore(":memory:");
    const value = { assetId: "asset-migration", assetVersion: 1, recipeVersion: "evidence-recipe-v1",
      assertions: [assertion], createdAt: time };
    const created = store.saveRecipeForMigration("migration-1", value);
    expect(created.status).toBe("CREATED");
    expect(store.saveRecipeForMigration("migration-1", value).status).toBe("IDEMPOTENT");
    expect(() => store.saveRecipeForMigration("migration-2", value)).toThrow(KnowledgeVerificationConflictError);
    expect(store.rollbackRecipeForMigration({ migrationId: "migration-1", assetId: value.assetId,
      assetVersion: 1, recipeVersion: value.recipeVersion, assertionsHash: created.recipe.assertionsHash,
      updatedAt: "2026-08-19T00:02:00.000Z" })).toEqual({ status: "ROLLED_BACK" });
    expect(store.getRecipe(value.assetId, 1, value.recipeVersion)).toBeUndefined();
    expect(store.rollbackRecipeForMigration({ migrationId: "migration-1", assetId: value.assetId,
      assetVersion: 1, recipeVersion: value.recipeVersion, assertionsHash: created.recipe.assertionsHash,
      updatedAt: "2026-08-19T00:02:00.000Z" })).toEqual({ status: "IDEMPOTENT" });
    expect(() => store.saveRecipeForMigration("migration-1", value)).toThrow(KnowledgeVerificationConflictError);
  });

  it("does not claim or delete a preexisting recipe for a migration", () => {
    using store = new SqliteKnowledgeVerificationStore(":memory:");
    const value = { assetId: "asset-existing", assetVersion: 1, recipeVersion: "evidence-recipe-v1",
      assertions: [assertion], createdAt: time };
    const existing = store.saveRecipe(value);
    expect(store.saveRecipeForMigration("migration-1", value).status).toBe("PREEXISTING");
    expect(store.rollbackRecipeForMigration({ migrationId: "migration-1", assetId: value.assetId,
      assetVersion: 1, recipeVersion: value.recipeVersion, assertionsHash: existing.assertionsHash,
      updatedAt: "2026-08-19T00:02:00.000Z" })).toEqual({ status: "NOT_OWNED" });
    expect(store.getRecipe(value.assetId, 1, value.recipeVersion)).toEqual(existing);
  });
  it("persists 0600 recipes and runs across restart with idempotent identical writes", () => {
    const filename = temporary();
    let store = new SqliteKnowledgeVerificationStore(filename);
    const recipe = { assetId: "asset-1", assetVersion: 1, recipeVersion: "recipe-v1", assertions: [assertion], createdAt: time };
    const first = store.saveRecipe(recipe);
    expect(store.saveRecipe({ ...recipe, createdAt: "2026-08-19T00:01:00.000Z" })).toEqual(first);
    expect(store.appendRun(run())).toEqual(run());
    expect(store.appendRun(run())).toEqual(run());
    store.close();
    store = new SqliteKnowledgeVerificationStore(filename);
    expect(store.getRecipe("asset-1", 1, "recipe-v1")).toEqual(first);
    expect(store.getRun("run-1")).toEqual(run());
    expect(store.listRuns("asset-1", 1, 10)).toEqual([run()]);
    expect(store.listSupportingProofs("design.runtime.verification", 10)).toEqual([{
      runId: "run-1", canonicalProjectId: "project-1", knowledgeVersion: { assetId: "asset-1", assetVersion: 1 }, completedAt: time,
    }]);
    store.close();
    if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
    const pragmas = new DatabaseSync(filename, { readOnly: true });
    expect(pragmas.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(pragmas.prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
    pragmas.close();
  });

  it("rejects recipe and request identity reuse with different payloads", () => {
    const store = new SqliteKnowledgeVerificationStore(temporary());
    store.saveRecipe({ assetId: "asset-1", assetVersion: 1, recipeVersion: "recipe-v1", assertions: [assertion], createdAt: time });
    expect(() => store.saveRecipe({ assetId: "asset-1", assetVersion: 1, recipeVersion: "recipe-v1",
      assertions: [{ ...assertion, parameters: { projectId: "project-1", symbol: "Other" } }], createdAt: time }))
      .toThrow(KnowledgeVerificationConflictError);
    store.appendRun(run());
    expect(() => store.appendRun(run({ runId: "run-2", requestId: "request-1", projectId: "project-2" })))
      .toThrow(KnowledgeVerificationConflictError);
    store.close();
  });

  it("detects persisted run corruption and keeps run summaries content-free", () => {
    const filename = temporary();
    const store = new SqliteKnowledgeVerificationStore(filename);
    store.appendRun(run());
    const database = new DatabaseSync(filename);
    const row = database.prepare("SELECT result_summary_json FROM code_verification_runs WHERE run_id='run-1'").get() as { result_summary_json: string };
    expect(row.result_summary_json).not.toMatch(/conversation|commandOutput|knowledgeBody|TOP SECRET/iu);
    database.prepare("UPDATE code_verification_runs SET result_hash=? WHERE run_id=?").run("0".repeat(64), "run-1");
    database.close();
    expect(() => store.getRun("run-1")).toThrow(KnowledgeVerificationCorruptionError);
    store.close();
  });

  it("validates absent queries, malformed inputs, recipe corruption, and idempotent close", () => {
    const filename = temporary();
    const store = new SqliteKnowledgeVerificationStore(filename);
    expect(store.getRecipe("asset-1", 1, "recipe-v1")).toBeUndefined();
    expect(store.getRun("run-missing")).toBeUndefined();
    expect(store.listSupportingProofs("design.runtime.verification", 10)).toEqual([]);
    expect(() => store.getRecipe("asset-1", 0, "recipe-v1")).toThrow("assetVersion is invalid");
    expect(() => store.listSupportingProofs("bad", 0)).toThrow("supporting proof query is invalid");
    expect(() => store.saveRecipe({ assetId: "asset-1", assetVersion: 1, recipeVersion: "recipe-v1", assertions: [], createdAt: time }))
      .toThrow("verification recipe is invalid");
    expect(() => store.appendRun(run({ subjectKey: "bad" }))).toThrow("verification run summary is invalid");
    expect(() => store.appendRun(run({ knowledgeVersion: { assetId: "asset-1", assetVersion: 0 } })))
      .toThrow("verification run assetVersion is invalid");
    store.appendRun(run());
    store.saveRecipe({ assetId: "asset-1", assetVersion: 1, recipeVersion: "recipe-v1", assertions: [assertion], createdAt: time });
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE verification_recipes SET assertions_hash=?").run("0".repeat(64));
    database.prepare("UPDATE code_verification_runs SET code_revision=?").run("git:tampered");
    database.close();
    expect(() => store.getRecipe("asset-1", 1, "recipe-v1")).toThrow(KnowledgeVerificationCorruptionError);
    expect(() => store.getRun("run-1")).toThrow(KnowledgeVerificationCorruptionError);
    store.close();
    store.close();
    store[Symbol.dispose]();
  });

  it("rejects an unsupported verification database schema", () => {
    const filename = temporary();
    const database = new DatabaseSync(filename);
    database.exec("CREATE TABLE verification_schema(version INTEGER PRIMARY KEY NOT NULL) STRICT; INSERT INTO verification_schema VALUES(2);");
    database.close();
    expect(() => new SqliteKnowledgeVerificationStore(filename)).toThrow("verification database schema is unsupported");
  });
});
