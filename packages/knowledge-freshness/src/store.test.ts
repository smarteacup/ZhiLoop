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
  it("projects idempotently and resolves affected knowledge through anchors", () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:");
    expect(store.project(projection())).toMatchObject({ status: "PROJECTED", anchorCount: 1 });
    expect(store.project(projection())).toMatchObject({ status: "IDEMPOTENT" });
    expect(store.affected(changes())).toEqual({ items: [{ assetId: "asset-1", assetVersion: 1 }], bounded: false });
    expect(store.affected(changes({ changedSymbols: [], changedPaths: ["src/runtime.ts"] })).items).toHaveLength(1);
    expect(store.affected(changes({ changedSymbols: ["Other"] })).items).toHaveLength(0);
    expect(store.get("asset-1")).toEqual(buildFreshnessRecord(projection()));
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
});
