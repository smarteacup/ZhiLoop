import { describe, expect, it } from "vitest";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";
import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

import { buildFreshnessRecord, planKnowledgeFreshness } from "./freshness.js";
import type { FreshnessProjectionInput } from "./types.js";

const at = "2026-08-18T02:00:00.000Z";
const candidate: KnowledgeCandidate = {
  schemaVersion: 1,
  candidateId: "candidate-1",
  compilerVersion: "compiler-v1",
  status: "PROPOSED",
  subjectKey: "implementation.runtime.freshness",
  kind: "IMPLEMENTATION",
  scopeHint: { projectId: "project-1", reasonCodes: [] },
  title: "Freshness",
  summary: "Track code anchors.",
  body: "Runtime exists.",
  sourceEpisodes: ["episode-1"],
  confidence: 0.9,
  assertions: [{
    assertionId: "assertion-symbol",
    candidateId: "candidate-1",
    kind: "SYMBOL_EXISTS",
    parameters: { projectId: "project-1", symbol: "Runtime", path: "src/runtime.ts" },
    createdAt: at,
  }],
  evidenceHints: [],
  createdAt: at,
  correlationId: "correlation-1",
};
const asset: KnowledgeAsset = {
  schemaVersion: 1,
  id: "asset-1",
  subjectKey: candidate.subjectKey,
  kind: candidate.kind,
  scope: { level: "PROJECT", projectId: "project-1" },
  version: 1,
  status: "VERIFIED",
  title: candidate.title,
  summary: candidate.summary,
  body: candidate.body,
  aliases: [], keywords: [], applicability: [], nonApplicability: [], symbols: ["Runtime"], relations: [],
  evidence: [{ evidenceId: "evidence-symbol", verdict: "SUPPORTS" }],
  confidence: 0.9,
  sourceEpisodes: ["episode-1"],
  contentHash: "content-hash-1",
  correlationId: "correlation-1",
  createdAt: at,
  updatedAt: at,
};

function verification(status: VerificationResult["status"]): VerificationResult {
  return {
    assertionId: "assertion-symbol",
    assertionKind: "SYMBOL_EXISTS",
    verifierId: "codegraph-symbol-v1",
    status,
    target: "symbol:Runtime",
    observedAt: at,
    reasonCodes: [`CODEGRAPH_${status}`],
    ...(status === "ERROR" ? {} : { evidence: {
      evidenceId: status === "SUPPORTED" ? "evidence-symbol" : `evidence-${status.toLowerCase()}`,
      assertionId: "assertion-symbol",
      type: "CODE_SYMBOL" as const,
      verdict: status === "SUPPORTED" ? "SUPPORTS" as const : status === "REFUTED" ? "CONTRADICTS" as const : "INCONCLUSIVE" as const,
      sourceRef: "codegraph:head:src/runtime.ts:1",
      projectId: "project-1",
      observedAt: at,
      correlationId: "correlation-1",
    } }),
  };
}

const projection: FreshnessProjectionInput = {
  asset,
  candidate,
  verificationResults: [verification("SUPPORTED")],
  projectId: "project-1",
  observedAt: at,
};
const changes: KnowledgeChangeSet = {
  projectId: "project-1",
  changedPaths: ["src/runtime.ts"],
  changedSymbols: ["Runtime"],
  changedConfigs: [],
  changedDependencies: [],
  sourceRef: "git:head-2",
  observedAt: at,
};

describe("knowledge freshness planning", () => {
  it("builds deterministic anchors and fingerprint from publication Evidence", () => {
    const first = buildFreshnessRecord(projection);
    const second = buildFreshnessRecord(projection);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ freshnessStatus: "FRESH", anchors: [{ kind: "SYMBOL", key: "Runtime", path: "src/runtime.ts" }] });
    expect(() => buildFreshnessRecord({ ...projection, asset: { ...asset, subjectKey: "other.subject.key" } }))
      .toThrow("FRESHNESS_PROJECTION_INPUT_INVALID");
  });

  it("keeps lifecycle separate across revalidation states", () => {
    const record = buildFreshnessRecord(projection);
    expect(planKnowledgeFreshness({ record, changes })).toMatchObject({
      freshnessStatus: "REVALIDATE", currentLifecycleStatus: "VERIFIED", targetLifecycleStatus: "VERIFIED", action: "REQUEST_REVALIDATION",
    });
    expect(planKnowledgeFreshness({ record, changes, revalidationResults: [verification("SUPPORTED")] })).toMatchObject({
      freshnessStatus: "FRESH", action: "REFRESH_FINGERPRINT", targetLifecycleStatus: "VERIFIED",
    });
    expect(planKnowledgeFreshness({ record, changes, revalidationResults: [verification("REFUTED")] })).toMatchObject({
      freshnessStatus: "CONFLICT", action: "MARK_STALE", targetLifecycleStatus: "STALE", preserveBody: true,
    });
    expect(planKnowledgeFreshness({ record, changes, revalidationResults: [verification("UNKNOWN")] })).toMatchObject({
      freshnessStatus: "UNKNOWN", action: "REQUEST_REVALIDATION", targetLifecycleStatus: "VERIFIED",
    });
  });

  it("reports unrelated changes as fresh and invalid changes as unknown", () => {
    const record = buildFreshnessRecord(projection);
    expect(planKnowledgeFreshness({ record, changes: { ...changes, changedPaths: ["src/other.ts"], changedSymbols: [] } }))
      .toMatchObject({ freshnessStatus: "FRESH", action: "NONE" });
    expect(planKnowledgeFreshness({ record, changes: { ...changes, projectId: "other" } }))
      .toMatchObject({ freshnessStatus: "UNKNOWN", action: "NONE" });
  });
});
