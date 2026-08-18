import { describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "@zhiloop/domain";
import type { KnowledgeFreshnessRecord } from "./types.js";

import { FreshnessGateService, ProjectionFreshnessGate } from "./gate.js";

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

function record(status: KnowledgeFreshnessRecord["freshnessStatus"], overrides: Partial<KnowledgeFreshnessRecord> = {}): KnowledgeFreshnessRecord {
  return {
    schemaVersion: 1, assetId: "asset-1", assetVersion: 1, assetContentHash: "hash-1", projectId: "project-1",
    lifecycleStatus: "IMPLEMENTED", freshnessStatus: status,
    candidate: {} as KnowledgeFreshnessRecord["candidate"], fingerprint: {} as KnowledgeFreshnessRecord["fingerprint"],
    anchors: [], updatedAt: "2026-08-18T00:00:00.000Z", ...overrides,
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

describe("FreshnessGateService", () => {
  const revision = { projectId: "project-1", codeRevision: "git:head:status", graphRevision: "graph-1" } as const;

  it("allows non-code knowledge and only exact current FRESH code facts", async () => {
    const service = new FreshnessGateService({
      records: { get: () => record("FRESH", { freshnessRevision: 2, codeRevision: revision.codeRevision,
        graphRevision: revision.graphRevision }) }, revisions: { read: () => revision },
    });
    const result = await service.ensureFresh({ projectId: "project-1", assets: [asset(),
      asset({ id: "decision-1", kind: "DECISION", symbols: [] })] });
    expect(result.eligibleAssetVersions).toEqual(["asset-1@1", "decision-1@1"]);
    expect(result.decisions.map((item) => item.reasonCode)).toEqual(["FRESHNESS_CONFIRMED", "FRESHNESS_NOT_REQUIRED"]);
  });

  it("does not require a graph revision for file-backed facts when the live project also has a graph", async () => {
    const service = new FreshnessGateService({ records: { get: () => record("FRESH", {
      freshnessRevision: 1, codeRevision: revision.codeRevision }) }, revisions: { read: () => revision } });
    expect((await service.ensureFresh({ projectId: "project-1", assets: [asset()] })).decisions[0])
      .toMatchObject({ eligible: true, reasonCode: "FRESHNESS_CONFIRMED" });
  });

  it.each([
    ["REVALIDATE", "FRESHNESS_REVALIDATION_REQUIRED"],
    ["CONFLICT", "FRESHNESS_CONFLICT"],
    ["UNKNOWN", "FRESHNESS_UNKNOWN"],
  ] as const)("excludes %s and schedules a stable compensation", async (status, reasonCode) => {
    const scheduled: unknown[] = [];
    const service = new FreshnessGateService({ records: { get: () => record(status, { codeRevision: revision.codeRevision,
      graphRevision: revision.graphRevision }) }, revisions: { read: () => revision },
    compensation: { schedule: (request) => { scheduled.push(request); return "job-1"; } } });
    const result = await service.ensureFresh({ projectId: "project-1", assets: [asset()] });
    expect(result.decisions[0]).toMatchObject({ eligible: false, reasonCode, compensationJobId: "job-1" });
    expect(scheduled).toHaveLength(1);
  });

  it("fails closed on code/graph/content mismatch while preserving non-code injection", async () => {
    const service = new FreshnessGateService({ records: { get: (_id, version) => record("FRESH", {
      assetVersion: version ?? 1, codeRevision: "git:old", graphRevision: "graph-old" }) },
    revisions: { read: () => revision } });
    const result = await service.ensureFresh({ projectId: "project-1", assets: [asset(),
      asset({ id: "decision-1", kind: "DECISION", symbols: [] })] });
    expect(result.eligibleAssetVersions).toEqual(["decision-1@1"]);
    expect(result.decisions[0]?.reasonCode).toBe("FRESHNESS_CODE_REVISION_MISMATCH");
    const graph = new FreshnessGateService({ records: { get: () => record("FRESH", {
      codeRevision: revision.codeRevision, graphRevision: "graph-old" }) }, revisions: { read: () => revision } });
    expect((await graph.ensureFresh({ projectId: "project-1", assets: [asset()] })).decisions[0]?.reasonCode)
      .toBe("FRESHNESS_GRAPH_REVISION_MISMATCH");
  });

  it("accepts one exact targeted Recipe verification within the bounded deadline", async () => {
    const calls: string[] = [];
    const service = new FreshnessGateService({ records: { get: () => record("REVALIDATE", {
      codeRevision: "git:old", graphRevision: "graph-old" }) }, revisions: { read: () => revision },
    targeted: { verify: async (request) => { calls.push(request.asset.id); return { assetId: request.asset.id,
      assetVersion: request.asset.version, status: "FRESH", codeRevision: request.codeRevision,
      ...(request.graphRevision === undefined ? {} : { graphRevision: request.graphRevision }) }; } } });
    const result = await service.ensureFresh({ projectId: "project-1", assets: [asset()] });
    expect(calls).toEqual(["asset-1"]);
    expect(result.decisions[0]).toMatchObject({ eligible: true, reasonCode: "FRESHNESS_TARGETED_CONFIRMED" });
  });

  it("times out a hanging targeted verifier without unsafe injection", async () => {
    const service = new FreshnessGateService({ records: { get: () => record("REVALIDATE", {
      codeRevision: "git:old", graphRevision: "graph-old" }) }, revisions: { read: () => revision }, deadlineMs: 10,
    targeted: { verify: async () => await new Promise<never>(() => undefined) } });
    const started = performance.now();
    const result = await service.ensureFresh({ projectId: "project-1", assets: [asset()] });
    expect(performance.now() - started).toBeLessThan(100);
    expect(result).toMatchObject({ eligibleAssetVersions: [], timedOut: true,
      decisions: [{ eligible: false, reasonCode: "FRESHNESS_TARGETED_TIMEOUT" }] });
  });

  it("degrades safely when revision/store/compensation ports fail", async () => {
    const service = new FreshnessGateService({ records: { get: () => { throw new Error("store down"); } },
      revisions: { read: () => { throw new Error("cache down"); } }, compensation: { schedule: () => { throw new Error("queue down"); } } });
    const result = await service.ensureFresh({ projectId: "project-1", assets: [asset(),
      asset({ id: "decision-1", kind: "DECISION", symbols: [] })] });
    expect(result.eligibleAssetVersions).toEqual(["decision-1@1"]);
    expect(result.decisions[0]).toMatchObject({ eligible: false, reasonCode: "FRESHNESS_GATE_DEGRADED" });
  });

  it("honors cancellation and insufficient budget without invoking targeted verification", async () => {
    let calls = 0;
    const service = new FreshnessGateService({ records: { get: () => record("REVALIDATE", {
      codeRevision: "git:old", graphRevision: "graph-old" }) }, revisions: { read: () => revision }, deadlineMs: 100,
    monotonicClock: () => 0, targeted: { verify: async () => { calls += 1; throw new Error("unexpected"); } } });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const result = await service.ensureFresh({ projectId: "project-1", assets: [asset()], signal: controller.signal });
    expect(calls).toBe(0);
    expect(result.decisions[0]).toMatchObject({ eligible: false, reasonCode: "FRESHNESS_REVALIDATION_REQUIRED" });
    const clockValues = [0, 200, 200];
    const exhausted = new FreshnessGateService({ records: { get: () => record("REVALIDATE", {
      codeRevision: "git:old", graphRevision: "graph-old" }) }, revisions: { read: () => revision }, deadlineMs: 100,
    monotonicClock: () => clockValues.shift() ?? 200, targeted: { verify: async () => { calls += 1; throw new Error("unexpected"); } } });
    expect((await exhausted.ensureFresh({ projectId: "project-1", assets: [asset()] })).decisions[0])
      .toMatchObject({ eligible: false, reasonCode: "FRESHNESS_TARGETED_TIMEOUT" });
    expect(calls).toBe(0);
  });

  it("uses stable compensation identity across repeated prompts and absorbs late verifier rejection", async () => {
    const jobs: string[] = [];
    const service = new FreshnessGateService({ records: { get: () => record("REVALIDATE", {
      codeRevision: "git:old", graphRevision: "graph-old" }) }, revisions: { read: () => revision }, deadlineMs: 5,
    targeted: { verify: async () => await new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late failure")), 20)) },
    compensation: { schedule: (request) => { const id = JSON.stringify(request); jobs.push(id); return id; } } });
    const first = await service.ensureFresh({ projectId: "project-1", assets: [asset()] });
    const second = await service.ensureFresh({ projectId: "project-1", assets: [asset()] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.decisions[0]?.compensationJobId).toBe(second.decisions[0]?.compensationJobId);
    expect(jobs).toHaveLength(2);
  });
});
