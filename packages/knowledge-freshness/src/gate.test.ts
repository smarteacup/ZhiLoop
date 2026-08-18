import { describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "@zhiloop/domain";
import type { KnowledgeFreshnessRecord } from "./types.js";

import { ProjectionFreshnessGate } from "./gate.js";

function asset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    schemaVersion: 1, id: "asset-1", subjectKey: "implementation.runtime", kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "IMPLEMENTED",
    title: "Runtime", summary: "Runtime exists", body: "details", aliases: [], keywords: [], applicability: [],
    nonApplicability: [], symbols: ["Runtime"], relations: [], evidence: [], confidence: 0.9,
    sourceEpisodes: ["episode-1"], contentHash: "hash-1", correlationId: "correlation-1",
    createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z", ...overrides,
  };
}

function record(status: KnowledgeFreshnessRecord["freshnessStatus"]): KnowledgeFreshnessRecord {
  return {
    schemaVersion: 1, assetId: "asset-1", assetVersion: 1, assetContentHash: "hash-1", projectId: "project-1",
    lifecycleStatus: "IMPLEMENTED", freshnessStatus: status,
    candidate: {} as KnowledgeFreshnessRecord["candidate"], fingerprint: {} as KnowledgeFreshnessRecord["fingerprint"],
    anchors: [], updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

describe("ProjectionFreshnessGate", () => {
  it("allows matching fresh code and non-code knowledge", () => {
    const gate = new ProjectionFreshnessGate({ get: () => record("FRESH") });
    const result = gate.inspect("project-1", [asset(), asset({ id: "decision-1", kind: "DECISION", symbols: [] })]);
    expect(result.eligibleAssetIds).toEqual(["asset-1", "decision-1"]);
    expect(result.eligibleAssetVersions).toEqual(["asset-1@1", "decision-1@1"]);
    expect(result.decisions.map((item) => item.reasonCode)).toEqual(["FRESHNESS_CONFIRMED", "FRESHNESS_NOT_REQUIRED"]);
  });

  it.each(["REVALIDATE", "CONFLICT", "UNKNOWN"] as const)("excludes %s code knowledge", (status) => {
    const result = new ProjectionFreshnessGate({ get: () => record(status) }).inspect("project-1", [asset()]);
    expect(result.eligibleAssetIds).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ eligible: false, freshness: status });
  });

  it("fails closed for missing or mismatched projections", () => {
    expect(new ProjectionFreshnessGate({ get: () => undefined }).inspect("project-1", [asset()]).decisions[0]?.reasonCode)
      .toBe("FRESHNESS_PROJECTION_MISSING");
    expect(new ProjectionFreshnessGate({ get: () => record("FRESH") }).inspect("project-2", [asset()]).decisions[0]?.reasonCode)
      .toBe("FRESHNESS_PROJECTION_MISMATCH");
    expect(new ProjectionFreshnessGate({ get: () => record("FRESH") })
      .inspect("project-1", [asset(), asset({ version: 2 })]).eligibleAssetVersions).toEqual(["asset-1@1"]);
  });
});
