import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KnowledgeAsset } from "@zhiloop/domain";
import type { LegacyKnowledgeMigrationJobInput } from "@zhiloop/evolution-job-runtime";
import type { JobExecutionContext } from "@zhiloop/job-runtime";
import { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import { LegacyKnowledgeMigrationRollbackService, LegacyKnowledgeMigrationService,
  SqliteLegacyKnowledgeMigrationStore } from "@zhiloop/knowledge-legacy-migration";
import type { ProjectedKnowledgeAsset } from "@zhiloop/knowledge-registry";
import { SqliteKnowledgeVerificationStore, type KnowledgeVerificationBatch,
  type KnowledgeVerificationRequest } from "@zhiloop/knowledge-verification";
import { describe, expect, it, vi } from "vitest";

import { createLegacyKnowledgeMigrationHandler } from "./migration.js";

const NOW = "2026-08-19T06:00:00.000Z";
function projected(): ProjectedKnowledgeAsset {
  const asset: KnowledgeAsset = { schemaVersion: 1, id: "asset-legacy", subjectKey: "legacy.runtime.worker", kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-1" }, version: 3, status: "VERIFIED", title: "Legacy",
    summary: "Legacy worker", body: "Legacy body", aliases: [], keywords: [], applicability: [], nonApplicability: [],
    symbols: ["LegacyWorker"], relations: [], evidence: [], confidence: 1, sourceEpisodes: ["episode-1"],
    contentHash: "c".repeat(64), correlationId: "correlation-1", createdAt: NOW, updatedAt: NOW };
  return { asset, tombstone: false, indexVersion: 7 };
}
function context(input: LegacyKnowledgeMigrationJobInput, checkpointValue?: unknown) {
  let saved = checkpointValue;
  const value: JobExecutionContext = { jobId: "job-migration", jobType: "LEGACY_KNOWLEDGE_MIGRATION",
    attemptId: "attempt-1", attempt: 1, fencingToken: 1, idempotencyKey: "migration-job-key", input: input as never,
    signal: new AbortController().signal, getCheckpoint: () => saved === undefined ? undefined : ({ data: saved } as never),
    saveCheckpoint: (data, progress) => { saved = data; return { data, progress } as never; },
    heartbeat: () => ({ leaseExpiresAt: NOW, cancellationRequested: false }), isCancellationRequested: () => false,
    throwIfCancellationRequested: () => undefined,
    effectKey: (label) => createHash("sha256").update(label).digest("hex") };
  return { value, saved: () => saved };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "zhiloop-migration-handler-")); const current = projected();
  const registry = { activeIndexVersion: 7, listAssets: () => [current], getAsset: () => current };
  const recipes = new SqliteKnowledgeVerificationStore(join(root, "verification.sqlite"));
  const freshness = new SqliteKnowledgeFreshnessStore(join(root, "freshness.sqlite"));
  const migrations = new SqliteLegacyKnowledgeMigrationStore(join(root, "migrations.sqlite"));
  const service = new LegacyKnowledgeMigrationService({ registry, recipes, freshness, store: migrations });
  const preview = service.dryRun({ projectId: "project-1", createdAt: NOW });
  const committing = migrations.transition({ migrationId: preview.migrationId, expectedRevision: 0,
    effectKey: "begin-commit", status: "COMMITTING", jobId: "job-migration", updatedAt: NOW });
  const input: LegacyKnowledgeMigrationJobInput = { schemaVersion: 1, jobType: "LEGACY_KNOWLEDGE_MIGRATION",
    migrationVersion: preview.migrationVersion, projectId: preview.projectId, migrationId: preview.migrationId,
    previewRevision: committing.revision };
  const verifier = { verifyBatch: vi.fn(async (request: KnowledgeVerificationRequest): Promise<KnowledgeVerificationBatch> => ({
    schemaVersion: 1, runId: "vrun-migration",
    requestId: "vreq-migration", purpose: "FRESHNESS", projectId: "project-1", codeRevision: "git:current",
    codeRevisionCapability: "READY", graphRevision: "graph-current", observedAt: NOW,
    results: request.candidate.assertions.map((assertion) => ({ assertionId: assertion.assertionId,
      assertionKind: assertion.kind, verifierId: "symbol-v1", status: "SUPPORTED", target: "LegacyWorker",
      observedAt: NOW, reasonCodes: ["CODEGRAPH_SYMBOL_FOUND"] })) })) };
  return { root, current, registry, recipes, freshness, migrations, service, preview, committing, input, verifier };
}

describe("LEGACY_KNOWLEDGE_MIGRATION durable handler", () => {
  it("migrates an exact page, verifies it and preserves formal knowledge", async () => {
    const value = setup(); const before = structuredClone(value.current.asset); const direct = context(value.input);
    const handler = createLegacyKnowledgeMigrationHandler({ store: value.migrations, service: value.service,
      registryRevision: () => value.registry.activeIndexVersion, recipes: value.recipes, freshness: value.freshness,
      verifier: value.verifier, project: () => ({ projectId: "project-1", repositoryRoot: value.root, portable: false }) });
    await handler(direct.value);
    expect(value.migrations.get(value.preview.migrationId)).toMatchObject({ status: "COMPLETED" });
    expect(value.migrations.items({ migrationId: value.preview.migrationId, limit: 10 }).items[0]).toMatchObject({
      status: "MIGRATED", verificationRunId: "vrun-migration", freshnessStatus: "FRESH",
      createdRecipe: true, createdFreshness: true,
    });
    expect(value.recipes.getRecipe("asset-legacy", 3, "evidence-recipe-v1")).toBeDefined();
    expect(value.freshness.getState("asset-legacy", 3)).toMatchObject({ status: "FRESH", revision: 0,
      codeRevision: "git:current", graphRevision: "graph-current" });
    expect(value.current.asset).toEqual(before);
    expect(direct.saved()).toMatchObject({ phase: "COMPLETED", processedCount: 1 });
    let rebuilt = 0;
    const rolledBack = await new LegacyKnowledgeMigrationRollbackService({ store: value.migrations, recipes: value.recipes,
      freshness: value.freshness, rebuildIndex: () => { rebuilt += 1; } }).rollback({ migrationId: value.preview.migrationId,
      expectedRevision: 2, idempotencyKey: "rollback-1", updatedAt: "2026-08-19T06:10:00.000Z" });
    expect(rolledBack).toMatchObject({ status: "ROLLED_BACK", rollbackConflictCount: 0 });
    expect(value.recipes.getRecipe("asset-legacy", 3, "evidence-recipe-v1")).toBeUndefined();
    expect(value.freshness.get("asset-legacy", 3)).toBeUndefined();
    expect(value.current.asset).toEqual(before); expect(rebuilt).toBe(1);
    expect(await new LegacyKnowledgeMigrationRollbackService({ store: value.migrations, recipes: value.recipes,
      freshness: value.freshness }).rollback({ migrationId: value.preview.migrationId, expectedRevision: 2,
      idempotencyKey: "rollback-1", updatedAt: "2026-08-19T06:10:00.000Z" }))
      .toMatchObject({ status: "ROLLED_BACK" });
    await expect(new LegacyKnowledgeMigrationRollbackService({ store: value.migrations, recipes: value.recipes,
      freshness: value.freshness }).rollback({ migrationId: value.preview.migrationId, expectedRevision: 4,
      idempotencyKey: "rollback-different-command", updatedAt: "2026-08-19T06:11:00.000Z" }))
      .rejects.toThrow("LEGACY_MIGRATION_STATUS_CONFLICT");
    value.migrations.close(); value.recipes.close(); value.freshness.close();
  });

  it("replays migration-owned target writes after a crash before the item receipt", async () => {
    const value = setup(); let fail = true;
    const store = { get: value.migrations.get.bind(value.migrations), items: value.migrations.items.bind(value.migrations),
      transition: value.migrations.transition.bind(value.migrations),
      recordItem: (...args: Parameters<SqliteLegacyKnowledgeMigrationStore["recordItem"]>) => {
        if (fail) { fail = false; throw new Error("PROCESS_EXIT_AFTER_TARGET_WRITES"); }
        return value.migrations.recordItem(...args);
      } };
    const handler = createLegacyKnowledgeMigrationHandler({ store, service: value.service,
      registryRevision: () => value.registry.activeIndexVersion, recipes: value.recipes, freshness: value.freshness,
      verifier: value.verifier, project: () => ({ projectId: "project-1", repositoryRoot: value.root, portable: false }) });
    const first = context(value.input);
    await expect(handler(first.value)).rejects.toMatchObject({ code: "LEGACY_MIGRATION_TRANSIENT_FAILURE" });
    expect(value.recipes.getRecipe("asset-legacy", 3, "evidence-recipe-v1")).toBeDefined();
    expect(value.freshness.get("asset-legacy", 3)).toBeDefined();
    const second = context(value.input, first.saved()); await handler(second.value);
    expect(value.migrations.items({ migrationId: value.preview.migrationId, limit: 10 }).items[0]).toMatchObject({
      status: "MIGRATED", createdRecipe: false, createdFreshness: false,
    });
    expect(value.verifier.verifyBatch).toHaveBeenCalledTimes(2);
    value.migrations.close(); value.recipes.close(); value.freshness.close();
  });

  it("recovers a completion written before the final checkpoint without duplicating effects", async () => {
    const value = setup(); let fail = true;
    const store = { get: value.migrations.get.bind(value.migrations), items: value.migrations.items.bind(value.migrations),
      recordItem: value.migrations.recordItem.bind(value.migrations),
      transition: (...args: Parameters<SqliteLegacyKnowledgeMigrationStore["transition"]>) => {
        const result = value.migrations.transition(...args);
        if (args[0].status === "COMPLETED" && fail) { fail = false; throw new Error("PROCESS_EXIT_AFTER_COMPLETION"); }
        return result;
      } };
    const handler = createLegacyKnowledgeMigrationHandler({ store, service: value.service,
      registryRevision: () => value.registry.activeIndexVersion, recipes: value.recipes, freshness: value.freshness,
      verifier: value.verifier, project: () => ({ projectId: "project-1", repositoryRoot: value.root, portable: false }) });
    const execution = context(value.input);
    await expect(handler(execution.value)).rejects.toMatchObject({ code: "LEGACY_MIGRATION_TRANSIENT_FAILURE" });
    expect(value.migrations.get(value.preview.migrationId)).toMatchObject({ status: "COMPLETED" });
    await handler(execution.value);
    expect(execution.saved()).toMatchObject({ phase: "COMPLETED", processedCount: 1 });
    expect(value.verifier.verifyBatch).toHaveBeenCalledTimes(1);
    value.migrations.close(); value.recipes.close(); value.freshness.close();
  });

  it("fails closed before effects on preview or registry mismatch", async () => {
    const value = setup(); const handler = createLegacyKnowledgeMigrationHandler({ store: value.migrations, service: value.service,
      registryRevision: () => 8, recipes: value.recipes, freshness: value.freshness, verifier: value.verifier,
      project: () => ({ projectId: "project-1", repositoryRoot: value.root, portable: false }) });
    await expect(handler(context(value.input).value)).rejects.toMatchObject({ code: "LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT" });
    expect(value.recipes.getRecipe("asset-legacy", 3, "evidence-recipe-v1")).toBeUndefined();
    value.migrations.close(); value.recipes.close(); value.freshness.close();
  });

  it("fails closed on incomplete pages, missing sources, verification mismatch and late target drift", async () => {
    const project = (root: string) => ({ projectId: "project-1", repositoryRoot: root, portable: false as const });
    const incomplete = setup();
    await expect(createLegacyKnowledgeMigrationHandler({ store: { get: incomplete.migrations.get.bind(incomplete.migrations),
      items: () => ({ items: [] }), recordItem: incomplete.migrations.recordItem.bind(incomplete.migrations),
      transition: incomplete.migrations.transition.bind(incomplete.migrations) }, service: incomplete.service,
      registryRevision: () => 7, recipes: incomplete.recipes, freshness: incomplete.freshness, verifier: incomplete.verifier,
      project: () => project(incomplete.root) })(context(incomplete.input).value))
      .rejects.toMatchObject({ code: "LEGACY_MIGRATION_PAGE_INCOMPLETE" });
    incomplete.migrations.close(); incomplete.recipes.close(); incomplete.freshness.close();

    const missing = setup();
    await expect(createLegacyKnowledgeMigrationHandler({ store: missing.migrations,
      service: { ...missing.service, resolve: () => undefined } as never, registryRevision: () => 7,
      recipes: missing.recipes, freshness: missing.freshness, verifier: missing.verifier,
      project: () => project(missing.root) })(context(missing.input).value))
      .rejects.toMatchObject({ code: "LEGACY_MIGRATION_SOURCE_MISSING" });
    missing.migrations.close(); missing.recipes.close(); missing.freshness.close();

    const mismatch = setup();
    mismatch.verifier.verifyBatch.mockResolvedValue({ schemaVersion: 1, runId: "run-mismatch", requestId: "request-mismatch",
      purpose: "FRESHNESS", projectId: "other", codeRevision: "git:current", codeRevisionCapability: "READY",
      observedAt: NOW, results: [] });
    await expect(createLegacyKnowledgeMigrationHandler({ store: mismatch.migrations, service: mismatch.service,
      registryRevision: () => 7, recipes: mismatch.recipes, freshness: mismatch.freshness, verifier: mismatch.verifier,
      project: () => project(mismatch.root) })(context(mismatch.input).value))
      .rejects.toMatchObject({ code: "LEGACY_MIGRATION_VERIFICATION_MISMATCH" });
    mismatch.migrations.close(); mismatch.recipes.close(); mismatch.freshness.close();

    const drift = setup(); let reads = 0;
    drift.registry.getAsset = (() => { reads += 1; return reads === 1 ? drift.current : undefined; }) as never;
    await expect(createLegacyKnowledgeMigrationHandler({ store: drift.migrations, service: drift.service,
      registryRevision: () => 7, recipes: drift.recipes, freshness: drift.freshness, verifier: drift.verifier,
      project: () => project(drift.root) })(context(drift.input).value))
      .rejects.toMatchObject({ code: "LEGACY_MIGRATION_TARGET_DRIFT" });
    drift.migrations.close(); drift.recipes.close(); drift.freshness.close();
  });

  it("preserves migrated data and reports a rollback conflict after later Freshness activity", async () => {
    const value = setup(); const handler = createLegacyKnowledgeMigrationHandler({ store: value.migrations, service: value.service,
      registryRevision: () => value.registry.activeIndexVersion, recipes: value.recipes, freshness: value.freshness,
      verifier: value.verifier, project: () => ({ projectId: "project-1", repositoryRoot: value.root, portable: false }) });
    await handler(context(value.input).value);
    value.freshness.transition({ assetId: "asset-legacy", assetVersion: 3, expectedRevision: 0, projectId: "project-1",
      status: "REVALIDATE", codeRevision: "git:new", reasonCodes: ["RELATED_TARGET_CHANGED"], affectedAssertionIds: [],
      updatedAt: "2026-08-19T06:05:00.000Z" });
    const result = await new LegacyKnowledgeMigrationRollbackService({ store: value.migrations, recipes: value.recipes,
      freshness: value.freshness }).rollback({ migrationId: value.preview.migrationId, expectedRevision: 2,
      idempotencyKey: "rollback-conflict", updatedAt: "2026-08-19T06:10:00.000Z" });
    expect(result).toMatchObject({ status: "ROLLBACK_CONFLICT", rollbackConflictCount: 1 });
    expect(value.freshness.get("asset-legacy", 3)).toBeDefined();
    expect(value.recipes.getRecipe("asset-legacy", 3, "evidence-recipe-v1")).toBeDefined();
    value.migrations.close(); value.recipes.close(); value.freshness.close();
  });
});
