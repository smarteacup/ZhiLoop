import { mkdtempSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SqliteLegacyKnowledgeMigrationStore } from "./store.js";
import { migrationHash } from "./identity.js";
import type { CreateLegacyMigrationPreviewInput, LegacyMigrationItemSnapshot } from "./types.js";

const at = "2026-08-19T00:00:00.000Z";
function item(ordinal: number, classification: LegacyMigrationItemSnapshot["classification"] = "MIGRATABLE"):
LegacyMigrationItemSnapshot {
  return { schemaVersion: 1, ordinal, assetId: `asset-${ordinal}`, assetVersion: 1,
    assetContentHash: String(ordinal).padStart(64, "a").slice(-64), assetIndexVersion: ordinal + 1, classification,
    source: classification === "MIGRATABLE" ? "SYMBOL_ANCHOR" : "NONE",
    ...(classification === "MIGRATABLE" ? { candidateId: `candidate-${ordinal}`, assertionsHash: "b".repeat(64),
      assertionKinds: ["SYMBOL_EXISTS" as const] } : { assertionKinds: [] }),
    reasonCodes: [classification === "MIGRATABLE" ? "EXPLICIT_SYMBOL_ANCHOR_TRANSLATED" : "RECIPE_MISSING"] };
}
function input(items = [item(0), item(1, "SKIPPED")]): CreateLegacyMigrationPreviewInput {
  return { migrationVersion: "legacy-code-knowledge-v1", projectId: "project-1", sourceRegistryRevision: 7, items, createdAt: at };
}

describe("SqliteLegacyKnowledgeMigrationStore", () => {
  it("persists an immutable preview and resumes it after restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-legacy-migration-")); const filename = path.join(directory, "migration.sqlite");
    const first = new SqliteLegacyKnowledgeMigrationStore(filename); const preview = first.createPreview(input());
    expect(preview).toMatchObject({ status: "READY", scannedCount: 2, migratableCount: 1, skippedCount: 1 });
    expect(first.createPreview(input())).toEqual(preview); first.close();
    const reopened = new SqliteLegacyKnowledgeMigrationStore(filename);
    expect(reopened.get(preview.migrationId)).toEqual(preview);
    expect(reopened.items({ migrationId: preview.migrationId, limit: 1 })).toMatchObject({ items: [{ status: "PENDING" }], nextOrdinal: 0 });
    expect(statSync(filename).mode & 0o777).toBe(0o600); reopened.close();
  });

  it("creates a new immutable run for a later preview and pages rollback items in reverse order", () => {
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    const first = store.createPreview(input([item(0), item(1), item(2)]));
    const later = store.createPreview({ ...input([item(0), item(1), item(2)]), createdAt: "2026-08-19T00:05:00.000Z" });
    expect(later.migrationId).not.toBe(first.migrationId);
    const page = store.itemsReverse({ migrationId: first.migrationId, limit: 2 });
    expect(page.items.map((value) => value.ordinal)).toEqual([2, 1]);
    expect(store.itemsReverse({ migrationId: first.migrationId, limit: 2, beforeOrdinal: page.nextOrdinal! }))
      .toMatchObject({ items: [{ ordinal: 0 }] });
  });

  it("uses revision CAS and effect receipts for status and item replay", () => {
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:"); const preview = store.createPreview(input());
    const committing = store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "commit-effect",
      status: "COMMITTING", jobId: "job-1", updatedAt: "2026-08-19T00:01:00.000Z" });
    expect(store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "commit-effect",
      status: "COMMITTING", jobId: "job-1", updatedAt: "2026-08-19T00:01:00.000Z" })).toEqual(committing);
    expect(() => store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "other-effect",
      status: "FAILED", updatedAt: "2026-08-19T00:02:00.000Z" })).toThrow("LEGACY_MIGRATION_REVISION_CONFLICT");
    const result = store.recordItem({ migrationId: preview.migrationId, ordinal: 0, effectKey: "item-effect", status: "MIGRATED",
      updatedAt: "2026-08-19T00:02:00.000Z", verificationRunId: "run-1", freshnessStatus: "FRESH",
      createdRecipe: true, createdFreshness: true, reasonCodes: ["MIGRATION_VERIFIED"] });
    expect(result).toMatchObject({ status: "MIGRATED", verificationRunId: "run-1" });
    expect(store.recordItem({ migrationId: preview.migrationId, ordinal: 0, effectKey: "item-effect", status: "MIGRATED",
      updatedAt: "2026-08-19T00:02:00.000Z", verificationRunId: "run-1", freshnessStatus: "FRESH",
      createdRecipe: true, createdFreshness: true, reasonCodes: ["MIGRATION_VERIFIED"] })).toEqual(result);
    expect(() => store.recordItem({ migrationId: preview.migrationId, ordinal: 0, effectKey: "invalid-item-effect",
      status: "FAILED", updatedAt: "2026-08-19T00:03:00.000Z" })).toThrow("LEGACY_MIGRATION_ITEM_STATE_CONFLICT");
  });

  it("rejects duplicate, malformed, conflicting and closed operations", () => {
    const store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    expect(() => store.createPreview(input([item(0), { ...item(1), assetId: "asset-0" }]))).toThrow("LEGACY_MIGRATION_ITEM_DUPLICATE");
    const malformed = { ...item(0) } as Omit<LegacyMigrationItemSnapshot, "assertionsHash"> & { assertionsHash?: string };
    delete malformed.assertionsHash;
    expect(() => store.createPreview(input([malformed]))).toThrow("LEGACY_MIGRATION_ITEM_SOURCE_INVALID");
    const preview = store.createPreview(input());
    expect(store.createPreview(input())).toEqual(preview);
    expect(() => store.items({ migrationId: preview.migrationId, limit: 0 })).toThrow("LEGACY_MIGRATION_PAGE_INVALID");
    expect(() => store.items({ migrationId: preview.migrationId, limit: 1, afterOrdinal: -1 })).toThrow("LEGACY_MIGRATION_PAGE_INVALID");
    expect(() => store.itemsReverse({ migrationId: preview.migrationId, limit: 1, beforeOrdinal: -1 }))
      .toThrow("LEGACY_MIGRATION_PAGE_INVALID");
    expect(store.list("project-1", 1)).toEqual([preview]);
    expect(() => store.list("project-1", 0)).toThrow("LEGACY_MIGRATION_LIST_LIMIT_INVALID");
    expect(() => store.get("bad id")).toThrow("LEGACY_MIGRATION_ID_INVALID");
    store.close(); expect(() => store.get(preview.migrationId)).toThrow("LEGACY_MIGRATION_STORE_CLOSED");
  });

  it("rejects invalid preview, transition and item-result matrices", () => {
    using store = new SqliteLegacyKnowledgeMigrationStore(":memory:");
    for (const invalid of [
      { ...input(), migrationVersion: "bad version" }, { ...input(), sourceRegistryRevision: -1 },
      { ...input(), projectId: "bad id" }, { ...input(), createdAt: "invalid" },
    ]) expect(() => store.createPreview(invalid)).toThrow();
    expect(() => store.createPreview(input([{ ...item(0), schemaVersion: 2 as 1 }]))).toThrow("LEGACY_MIGRATION_ITEM_INVALID");
    expect(() => store.createPreview(input([{ ...item(0), assetContentHash: "bad" }]))).toThrow("LEGACY_MIGRATION_ITEM_INVALID");
    expect(() => store.createPreview(input([{ ...item(0), assertionsHash: "bad" }]))).toThrow("LEGACY_MIGRATION_ASSERTIONS_HASH_INVALID");
    expect(() => store.createPreview(input([{ ...item(0), classification: "SKIPPED", source: "NONE" }])))
      .toThrow("LEGACY_MIGRATION_ITEM_SOURCE_INVALID");
    const preview = store.createPreview(input());
    expect(() => store.transition({ migrationId: "missing", expectedRevision: 0, effectKey: "missing-effect", status: "COMMITTING",
      updatedAt: at })).toThrow("LEGACY_MIGRATION_NOT_FOUND");
    expect(() => store.transition({ migrationId: preview.migrationId, expectedRevision: -1, effectKey: "invalid-transition",
      status: "COMMITTING", updatedAt: at })).toThrow("LEGACY_MIGRATION_TRANSITION_INVALID");
    expect(() => store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "invalid-failure-code",
      status: "FAILED", failureCode: "bad-code", updatedAt: at })).toThrow("LEGACY_MIGRATION_TRANSITION_INVALID");
    const committing = store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "commit-effect",
      status: "COMMITTING", jobId: "job-1", updatedAt: at });
    expect(committing).toMatchObject({ status: "COMMITTING", jobId: "job-1" });
    expect(() => store.transition({ migrationId: preview.migrationId, expectedRevision: 0, effectKey: "commit-effect",
      status: "COMMITTING", jobId: "job-1", updatedAt: "2026-08-19T00:01:00.000Z" }))
      .toThrow("LEGACY_MIGRATION_EFFECT_CONFLICT");
    expect(() => store.transition({ migrationId: preview.migrationId, expectedRevision: 1, effectKey: "illegal-status",
      status: "READY", updatedAt: at })).toThrow("LEGACY_MIGRATION_STATUS_CONFLICT");
    expect(() => store.recordItem({ migrationId: preview.migrationId, ordinal: -1, effectKey: "invalid-item", status: "FAILED",
      updatedAt: at })).toThrow("LEGACY_MIGRATION_ITEM_RESULT_INVALID");
    expect(() => store.recordItem({ migrationId: preview.migrationId, ordinal: 99, effectKey: "missing-item", status: "FAILED",
      updatedAt: at })).toThrow("LEGACY_MIGRATION_ITEM_NOT_FOUND");
    const recorded = store.recordItem({ migrationId: preview.migrationId, ordinal: 0, effectKey: "record-item", status: "MIGRATED",
      updatedAt: at, reasonCodes: ["MIGRATION_VERIFIED"] });
    expect(recorded.status).toBe("MIGRATED");
    expect(() => store.recordItem({ migrationId: preview.migrationId, ordinal: 0, effectKey: "record-item", status: "MIGRATED",
      updatedAt: at, reasonCodes: ["DIFFERENT_REASON"] })).toThrow("LEGACY_MIGRATION_EFFECT_CONFLICT");
  });

  it("fails closed when persisted migration or item payloads are corrupted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-legacy-migration-corrupt-"));
    const filename = path.join(directory, "migration.sqlite");
    const store = new SqliteLegacyKnowledgeMigrationStore(filename); const preview = store.createPreview(input()); store.close();
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE legacy_knowledge_migrations SET payload_hash=? WHERE migration_id=?")
      .run("0".repeat(64), preview.migrationId); database.close();
    const corruptHash = new SqliteLegacyKnowledgeMigrationStore(filename);
    expect(() => corruptHash.get(preview.migrationId)).toThrow("LEGACY_MIGRATION_CORRUPT"); corruptHash.close();

    const filename2 = path.join(directory, "item.sqlite");
    const second = new SqliteLegacyKnowledgeMigrationStore(filename2); const secondPreview = second.createPreview(input()); second.close();
    const itemDatabase = new DatabaseSync(filename2);
    itemDatabase.prepare("UPDATE legacy_knowledge_migration_items SET payload_json=?,payload_hash=? WHERE migration_id=? AND ordinal=0")
      .run("{", migrationHash("{"), secondPreview.migrationId); itemDatabase.close();
    const corruptItem = new SqliteLegacyKnowledgeMigrationStore(filename2);
    expect(() => corruptItem.items({ migrationId: secondPreview.migrationId, limit: 10 }))
      .toThrow("LEGACY_MIGRATION_ITEM_CORRUPT"); corruptItem.close();

    const mutate = (name: string, statement: string, values: readonly string[], operation: (value: SqliteLegacyKnowledgeMigrationStore,
      preview: ReturnType<SqliteLegacyKnowledgeMigrationStore["createPreview"]>) => void) => {
      const target = path.join(directory, `${name}.sqlite`); const initial = new SqliteLegacyKnowledgeMigrationStore(target);
      const created = initial.createPreview(input()); initial.close(); const raw = new DatabaseSync(target);
      raw.prepare(statement).run(...values.map((value) => value === "$id" ? created.migrationId : value)); raw.close();
      const reopened = new SqliteLegacyKnowledgeMigrationStore(target);
      expect(() => operation(reopened, created)).toThrow(); reopened.close();
    };
    mutate("migration-json", "UPDATE legacy_knowledge_migrations SET payload_json=?,payload_hash=? WHERE migration_id=?",
      ["{", migrationHash("{"), "$id"], (value, created) => value.get(created.migrationId));

    const structuralTarget = path.join(directory, "migration-structural.sqlite");
    const structural = new SqliteLegacyKnowledgeMigrationStore(structuralTarget); const structuralPreview = structural.createPreview(input()); structural.close();
    const altered = JSON.stringify({ ...structuralPreview, updatedAt: "2026-08-19T00:09:00.000Z" });
    const structuralDb = new DatabaseSync(structuralTarget);
    structuralDb.prepare("UPDATE legacy_knowledge_migrations SET payload_json=?,payload_hash=? WHERE migration_id=?")
      .run(altered, migrationHash(altered), structuralPreview.migrationId); structuralDb.close();
    const structuralRead = new SqliteLegacyKnowledgeMigrationStore(structuralTarget);
    expect(() => structuralRead.get(structuralPreview.migrationId)).toThrow("LEGACY_MIGRATION_CORRUPT"); structuralRead.close();

    mutate("item-hash", "UPDATE legacy_knowledge_migration_items SET payload_hash=? WHERE migration_id=? AND ordinal=0",
      ["0".repeat(64), "$id"], (value, created) => value.items({ migrationId: created.migrationId, limit: 1 }));

    const conflictTarget = path.join(directory, "preview-conflict.sqlite");
    const conflictStore = new SqliteLegacyKnowledgeMigrationStore(conflictTarget); const conflictPreview = conflictStore.createPreview(input()); conflictStore.close();
    const conflicting = JSON.stringify({ ...conflictPreview, failedCount: 1 }); const conflictDb = new DatabaseSync(conflictTarget);
    conflictDb.prepare("UPDATE legacy_knowledge_migrations SET payload_json=?,payload_hash=? WHERE migration_id=?")
      .run(conflicting, migrationHash(conflicting), conflictPreview.migrationId); conflictDb.close();
    const conflictRead = new SqliteLegacyKnowledgeMigrationStore(conflictTarget);
    expect(() => conflictRead.createPreview(input())).toThrow("LEGACY_MIGRATION_IDEMPOTENCY_CONFLICT"); conflictRead.close();
  });
});
