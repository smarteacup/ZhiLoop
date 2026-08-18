import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";
import type { FreshnessProjectionInput } from "./types.js";

import { buildFreshnessRecord } from "./freshness.js";
import { SqliteKnowledgeFreshnessStore } from "./store.js";

const at = "2026-08-18T02:00:00.000Z";

function projection(overrides: Partial<FreshnessProjectionInput> = {}): FreshnessProjectionInput {
  const candidate: KnowledgeCandidate = {
    schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "compiler-v1", status: "PROPOSED",
    subjectKey: "implementation.runtime.freshness", kind: "IMPLEMENTATION",
    scopeHint: { projectId: "project-1", reasonCodes: [] }, title: "Freshness", summary: "Track anchors", body: "Runtime exists",
    sourceEpisodes: ["episode-1"], confidence: 0.9,
    assertions: [{ assertionId: "assertion-symbol", candidateId: "candidate-1", kind: "SYMBOL_EXISTS",
      parameters: { projectId: "project-1", symbol: "Runtime", path: "src/runtime.ts" }, createdAt: at }],
    evidenceHints: [], createdAt: at, correlationId: "correlation-1",
  };
  const asset: KnowledgeAsset = {
    schemaVersion: 1, id: "asset-1", subjectKey: candidate.subjectKey, kind: candidate.kind,
    scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "IMPLEMENTED",
    title: candidate.title, summary: candidate.summary, body: candidate.body, aliases: [], keywords: [], applicability: [],
    nonApplicability: [], symbols: ["Runtime"], relations: [], evidence: [{ evidenceId: "evidence-symbol", verdict: "SUPPORTS" }],
    confidence: 0.9, sourceEpisodes: ["episode-1"], contentHash: "content-v1", correlationId: "correlation-1", createdAt: at, updatedAt: at,
  };
  return {
    asset, candidate,
    verificationResults: [{ assertionId: "assertion-symbol", assertionKind: "SYMBOL_EXISTS", status: "SUPPORTED",
      target: "symbol:Runtime", observedAt: at, reasonCodes: ["SUPPORTED"], evidence: {
        evidenceId: "evidence-symbol", assertionId: "assertion-symbol", type: "CODE_SYMBOL", verdict: "SUPPORTS",
        sourceRef: "codegraph:head:src/runtime.ts:1", projectId: "project-1", observedAt: at, correlationId: "correlation-1",
      } }],
    projectId: "project-1", observedAt: at, ...overrides,
  };
}

function changes(overrides: Partial<KnowledgeChangeSet> = {}): KnowledgeChangeSet {
  return {
    projectId: "project-1",
    changedPaths: [],
    changedSymbols: ["Runtime"],
    changedConfigs: [],
    changedDependencies: [],
    sourceRef: "git:head-2",
    observedAt: at,
    ...overrides,
  };
}

describe("SqliteKnowledgeFreshnessStore", () => {
  it("owns legacy migration projections transactionally and restores the prior active version", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    store.project(projection());
    const third = projection({ asset: { ...projection().asset, version: 3, contentHash: "content-v3" } });
    const migrated = { ...third, migrationId: "migration-1", status: "FRESH" as const, codeRevision: "git:head-3",
      graphRevision: "graph-3", verificationRunId: "run-migration-1", reasonCodes: ["MIGRATION_VERIFIED"] };
    expect(store.projectForMigration(migrated)).toMatchObject({ status: "PROJECTED", assetVersion: 3, freshnessStatus: "FRESH" });
    expect(store.getMigrationProjectionOwner("asset-1", 3)).toMatchObject({ migrationId: "migration-1", status: "OWNED" });
    expect(store.projectForMigration(migrated)).toMatchObject({ status: "IDEMPOTENT" });
    expect(store.get("asset-1")?.assetVersion).toBe(3);
    expect(store.rollbackMigrationProjection({ migrationId: "migration-1", assetId: "asset-1", assetVersion: 3,
      updatedAt: "2026-08-19T00:03:00.000Z" })).toEqual({ status: "ROLLED_BACK" });
    expect(store.getMigrationProjectionOwner("asset-1", 3)).toMatchObject({ migrationId: "migration-1", status: "ROLLED_BACK" });
    expect(store.get("asset-1")?.assetVersion).toBe(1);
    expect(store.rollbackMigrationProjection({ migrationId: "migration-1", assetId: "asset-1", assetVersion: 3,
      updatedAt: "2026-08-19T00:03:00.000Z" })).toEqual({ status: "IDEMPOTENT" });
  });

  it("does not claim preexisting projections and preserves migrated data after later freshness activity", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    store.project(projection());
    expect(store.projectForMigration({ ...projection(), migrationId: "migration-1", status: "FRESH",
      codeRevision: "git:head-1", verificationRunId: "run-1", reasonCodes: [] })).toMatchObject({ status: "PREEXISTING" });
    expect(store.rollbackMigrationProjection({ migrationId: "migration-1", assetId: "asset-1", assetVersion: 1,
      updatedAt: "2026-08-19T00:03:00.000Z" })).toEqual({ status: "NOT_OWNED" });

    const second = projection({ asset: { ...projection().asset, id: "asset-2", version: 2, contentHash: "content-v2" } });
    store.projectForMigration({ ...second, migrationId: "migration-2", status: "UNKNOWN", codeRevision: "git:head-2",
      verificationRunId: "run-2", reasonCodes: ["MIGRATION_VERIFICATION_UNKNOWN"] });
    store.transition({ assetId: "asset-2", assetVersion: 2, expectedRevision: 0, projectId: "project-1",
      status: "REVALIDATE", codeRevision: "git:head-3", reasonCodes: ["RELATED_TARGET_CHANGED"],
      affectedAssertionIds: ["assertion-symbol"], updatedAt: "2026-08-19T00:04:00.000Z" });
    expect(store.rollbackMigrationProjection({ migrationId: "migration-2", assetId: "asset-2", assetVersion: 2,
      updatedAt: "2026-08-19T00:05:00.000Z" })).toEqual({ status: "CONFLICT", reasonCode: "FRESHNESS_CHANGED" });
    expect(store.get("asset-2", 2)).toBeDefined();
  });
  it("projects idempotently and resolves affected knowledge through anchors", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    expect(store.project(projection())).toMatchObject({ status: "PROJECTED", anchorCount: 1 });
    expect(store.project(projection())).toMatchObject({ status: "IDEMPOTENT" });
    expect(store.affected(changes())).toEqual({ items: [{ assetId: "asset-1", assetVersion: 1 }], bounded: false });
    expect(store.affected(changes({ changedSymbols: [], changedPaths: ["src/runtime.ts"] })).items).toHaveLength(1);
    expect(store.affected(changes({ changedSymbols: ["Other"] })).items).toHaveLength(0);
    expect(store.get("asset-1")).toEqual({ ...buildFreshnessRecord(projection()),
      freshnessRevision: 0, codeRevision: "publication:content-v1" });
    expect(Object.isFrozen(store.get("asset-1")?.candidate)).toBe(true);

    const second = projection({ asset: { ...projection().asset, version: 2, contentHash: "content-v2" } });
    expect(store.project(second)).toMatchObject({ status: "PROJECTED", assetVersion: 2 });
    expect(store.get("asset-1")?.assetVersion).toBe(2);
    expect(store.get("asset-1", 1)?.assetContentHash).toBe("content-v1");
    expect(store.affected(changes())).toEqual({ items: [{ assetId: "asset-1", assetVersion: 2 }], bounded: false });
  });

  it("rejects non-contiguous or conflicting versions and invalid bounds", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    store.project(projection());
    expect(() => store.project(projection({ asset: { ...projection().asset, version: 3, contentHash: "content-v3" } })))
      .toThrow("FRESHNESS_PROJECTION_VERSION_CONFLICT");
    expect(() => store.affected(changes(), 0)).toThrow("FRESHNESS_AFFECTED_LIMIT_INVALID");
    expect(() => store.affected(changes({ changedPaths: ["../secret"], changedSymbols: [] })))
      .toThrow("FRESHNESS_CHANGESET_INVALID");
  });

  it("keeps version-bound freshness state with CAS, replay and immutable events", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    store.project(projection());
    expect(store.getState("asset-1")).toMatchObject({ status: "FRESH", revision: 0, codeRevision: "publication:content-v1" });
    const transition = {
      assetId: "asset-1", assetVersion: 1, expectedRevision: 0, projectId: "project-1", status: "REVALIDATE" as const,
      codeRevision: "git:head-2", graphRevision: "graph-2", reasonCodes: ["RELATED_TARGET_CHANGED"],
      affectedAssertionIds: ["assertion-symbol"], updatedAt: "2026-08-19T00:00:00.000Z",
    };
    expect(store.transition(transition)).toMatchObject({ status: "TRANSITIONED", state: { revision: 1, status: "REVALIDATE" } });
    expect(store.transition(transition)).toMatchObject({ status: "IDEMPOTENT", state: { revision: 1 } });
    expect(store.affected(changes()).items).toHaveLength(0);
    expect(store.get("asset-1")?.freshnessStatus).toBe("REVALIDATE");
    expect(store.listStateEvents("asset-1", 1)).toMatchObject([{ revision: 1, previousStatus: "FRESH", status: "REVALIDATE" }]);
    expect(() => store.transition({ ...transition, status: "CONFLICT", codeRevision: "git:head-3" }))
      .toThrow("FRESHNESS_STATE_REVISION_CONFLICT");
  });

  it("records stable transition effects and recognizes a completed effect after later state advances", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    store.project(projection());
    const first = {
      assetId: "asset-1", assetVersion: 1, expectedRevision: 0, projectId: "project-1", status: "REVALIDATE" as const,
      codeRevision: "git:head-2", reasonCodes: ["RELATED_TARGET_CHANGED"], affectedAssertionIds: ["assertion-symbol"],
      updatedAt: "2026-08-19T00:00:00.000Z",
    };
    expect(store.transition(first)).toMatchObject({ status: "TRANSITIONED", state: { revision: 1 } });
    expect(store.transition({ ...first, expectedRevision: 1, status: "FRESH", codeRevision: "git:head-3",
      reasonCodes: ["REVALIDATION_SUPPORTED"] })).toMatchObject({ state: { revision: 2 } });
    const replay = store.transitionWithEffect("a".repeat(64), first);
    expect(replay).toMatchObject({ status: "IDEMPOTENT", state: { revision: 1, status: "REVALIDATE" } });
    expect(store.transitionWithEffect("a".repeat(64), { ...first, expectedRevision: 99 })).toEqual(replay);
    expect(() => store.transitionWithEffect("a".repeat(64), { ...first, status: "CONFLICT" }))
      .toThrow("FRESHNESS_EFFECT_CONFLICT");
    expect(store.getState("asset-1")).toMatchObject({ revision: 2, status: "FRESH" });
  });

  it("backfills freshness state for projections created before the state table", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-freshness-state-"));
    const filename = path.join(directory, "freshness.sqlite");
    try {
      const first = new SqliteKnowledgeFreshnessStore(filename); first.project(projection()); first.close();
      const database = new DatabaseSync(filename); database.exec("DELETE FROM knowledge_freshness_state"); database.close();
      using reopened = new SqliteKnowledgeFreshnessStore(filename);
      expect(reopened.getState("asset-1")).toMatchObject({ status: "FRESH", revision: 0, codeRevision: "publication:content-v1" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("freezes exact affected versions and pages them independently of later active versions", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    store.project(projection());
    const assetTwo = { ...projection().asset, id: "asset-2", version: 1, contentHash: "asset-two" };
    store.project(projection({ asset: assetTwo }));
    const frozen = store.freezeAffectedSnapshot({
      changes: changes(), changeSetHash: "a".repeat(64), recipeSelectionHash: "b".repeat(64), maxTargets: 10,
    });
    expect(frozen).toMatchObject({ targetCount: 2, targetHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(store.readAffectedSnapshotPage({ snapshotId: frozen.snapshotId, limit: 1 })).toMatchObject({
      items: [{ assetId: "asset-1", assetVersion: 1 }], nextCursor: { assetId: "asset-1", assetVersion: 1 },
    });
    expect(store.readAffectedSnapshotPage({ snapshotId: frozen.snapshotId, limit: 10,
      after: { assetId: "asset-1", assetVersion: 1 } }).items).toEqual([{ assetId: "asset-2", assetVersion: 1 }]);
    store.project(projection({ asset: { ...projection().asset, version: 2, contentHash: "content-v2" } }));
    expect(store.readAffectedSnapshotPage({ snapshotId: frozen.snapshotId, limit: 10 }).items).toEqual([
      { assetId: "asset-1", assetVersion: 1 }, { assetId: "asset-2", assetVersion: 1 },
    ]);
    expect(store.freezeAffectedSnapshot({ changes: changes(), changeSetHash: "a".repeat(64),
      recipeSelectionHash: "b".repeat(64) })).toEqual(frozen);
  });

  it("fails closed when an affected snapshot is corrupted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-freshness-snapshot-corrupt-"));
    const filename = path.join(directory, "freshness.sqlite");
    try {
      const first = new SqliteKnowledgeFreshnessStore(filename);
      first.project(projection());
      const frozen = first.freezeAffectedSnapshot({ changes: changes(), changeSetHash: "a".repeat(64),
        recipeSelectionHash: "b".repeat(64) });
      first.close();
      const database = new DatabaseSync(filename);
      database.prepare("UPDATE knowledge_freshness_affected_snapshots SET target_hash=? WHERE snapshot_id=?")
        .run("c".repeat(64), frozen.snapshotId);
      database.close();
      using reopened = new SqliteKnowledgeFreshnessStore(filename);
      expect(() => reopened.getAffectedSnapshot(frozen.snapshotId)).toThrow("SNAPSHOT_CORRUPT");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("freezes every current code Recipe for the production exact-revision selection", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    store.project(projection());
    store.project(projection({ asset: { ...projection().asset, id: "asset-2", contentHash: "content-2" } }));
    const recipeSelectionHash = createHash("sha256").update("all-current-recipes-v1").digest("hex");
    const frozen = store.freezeAffectedSnapshot({ changes: changes({ changedSymbols: ["Other"] }),
      changeSetHash: "d".repeat(64), recipeSelectionHash });
    expect(frozen.targetCount).toBe(2);
    expect(store.readAffectedSnapshotPage({ snapshotId: frozen.snapshotId, limit: 10 }).items)
      .toEqual([{ assetId: "asset-1", assetVersion: 1 }, { assetId: "asset-2", assetVersion: 1 }]);
  });
});
