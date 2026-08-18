import { describe, expect, it, vi } from "vitest";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";
import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

import { SqliteKnowledgeFreshnessStore } from "./store.js";
import type { FreshnessProjectionInput } from "./types.js";
import { KnowledgeFreshnessWorker, selectAffectedAssertionIds, type FreshnessWorkerStorePort } from "./worker.js";

const at = "2026-08-19T00:00:00.000Z";

function projection(id = "one"): FreshnessProjectionInput {
  const candidate: KnowledgeCandidate = {
    schemaVersion: 1, candidateId: `candidate-${id}`, compilerVersion: "compiler-v1", status: "PROPOSED",
    subjectKey: `implementation.${id}`, kind: "IMPLEMENTATION", scopeHint: { projectId: "project-1", reasonCodes: [] },
    title: id, summary: "summary", body: "body", sourceEpisodes: [`episode-${id}`], confidence: 0.9,
    assertions: [{ assertionId: `assertion-${id}`, candidateId: `candidate-${id}`, kind: "SYMBOL_EXISTS",
      parameters: { projectId: "project-1", symbol: "Runtime", path: "src/runtime.ts" }, createdAt: at }],
    evidenceHints: [], createdAt: at, correlationId: `correlation-${id}`,
  };
  const asset: KnowledgeAsset = {
    schemaVersion: 1, id: `asset-${id}`, subjectKey: candidate.subjectKey, kind: candidate.kind,
    scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "IMPLEMENTED", title: id,
    summary: "summary", body: "body", aliases: [], keywords: [], applicability: [], nonApplicability: [],
    symbols: ["Runtime"], relations: [], evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }], confidence: 0.9,
    sourceEpisodes: [`episode-${id}`], contentHash: `content-${id}`, correlationId: `correlation-${id}`, createdAt: at, updatedAt: at,
  };
  return { asset, candidate, projectId: "project-1", observedAt: at, verificationResults: [result(id, "SUPPORTED")] };
}

function result(id: string, status: VerificationResult["status"]): VerificationResult {
  return {
    assertionId: `assertion-${id}`, assertionKind: "SYMBOL_EXISTS", verifierId: "codegraph-symbol-v1", status,
    target: "symbol:Runtime", observedAt: at, reasonCodes: [`CODEGRAPH_${status}`],
    ...(status === "ERROR" ? {} : { evidence: {
      evidenceId: `evidence-${id}-${status}`, assertionId: `assertion-${id}`, type: "CODE_SYMBOL" as const,
      verdict: status === "SUPPORTED" ? "SUPPORTS" as const : status === "REFUTED" ? "CONTRADICTS" as const : "INCONCLUSIVE" as const,
      sourceRef: "codegraph:head", projectId: "project-1", observedAt: at, correlationId: `correlation-${id}`,
    } }),
  };
}

function changes(sourceRef = "git:head-2"): KnowledgeChangeSet {
  return { projectId: "project-1", changedPaths: ["src/runtime.ts"], changedSymbols: ["Runtime"],
    changedConfigs: [], changedDependencies: [], sourceRef, observedAt: at };
}

describe("KnowledgeFreshnessWorker", () => {
  it("batch verifies, transitions, replays idempotently and records conflicts", async () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:"); store.project(projection());
    let status: VerificationResult["status"] = "SUPPORTED";
    const verifyBatch = vi.fn(async (input: Parameters<ConstructorParameters<typeof KnowledgeFreshnessWorker>[1]["verifyBatch"]>[0]) => ({
      projectId: input.projectId, codeRevision: input.changes.sourceRef, graphRevision: "graph-2", observedAt: at,
      results: { "asset-one": [result("one", status)] },
    }));
    const worker = new KnowledgeFreshnessWorker(store, { verifyBatch });
    const first = await worker.run(changes());
    expect(first.items[0]).toMatchObject({ writeStatus: "TRANSITIONED", plan: { action: "REFRESH_FINGERPRINT" }, state: { status: "FRESH", revision: 1 } });
    expect((await worker.run(changes())).items[0]).toMatchObject({ writeStatus: "IDEMPOTENT", state: { revision: 1 } });
    status = "REFUTED";
    const conflict = await worker.run(changes("git:head-3"));
    expect(conflict.items[0]).toMatchObject({ plan: { action: "MARK_STALE", preserveBody: true }, state: { status: "CONFLICT", revision: 2 } });
    expect(store.listStateEvents("asset-one", 1)).toHaveLength(2);
  });

  it("bounds affected assets and rejects invalid batch output before writing", async () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:"); store.project(projection("one")); store.project(projection("two"));
    const bounded = await new KnowledgeFreshnessWorker(store, { verifyBatch: async (input) => ({
      projectId: input.projectId, codeRevision: input.changes.sourceRef, observedAt: at,
      results: Object.fromEntries(input.items.map((item) => [item.assetId, [result(item.assetId.slice(6), "UNKNOWN")]])),
    }) }).run(changes(), 1);
    expect(bounded).toMatchObject({ bounded: true, affectedCount: 1, items: [{ state: { status: "UNKNOWN" } }] });

    const before = store.getState("asset-one")?.revision;
    const cases: Array<[string, readonly VerificationResult[], string]> = [
      ["unrequested", [{ ...result("one", "SUPPORTED"), assertionId: "unrequested" }], "FRESHNESS_BATCH_RESULT_UNREQUESTED"],
      ["duplicate", [result("one", "SUPPORTED"), result("one", "SUPPORTED")], "FRESHNESS_BATCH_RESULT_DUPLICATE"],
      ["incomplete", [], "FRESHNESS_BATCH_RESULT_INCOMPLETE"],
      ["cross-project", [{ ...result("one", "SUPPORTED"), evidence: { ...result("one", "SUPPORTED").evidence!, projectId: "other" } }],
        "FRESHNESS_BATCH_RESULT_IDENTITY_INVALID"],
    ];
    for (const [name, results, error] of cases) {
      const invalid = new KnowledgeFreshnessWorker(store, { verifyBatch: async (input) => ({
        projectId: input.projectId, codeRevision: input.changes.sourceRef, observedAt: at, results: { "asset-one": results },
      }) });
      await expect(invalid.run(changes(`git:head-${name}`))).rejects.toThrow(error);
      expect(store.getState("asset-one")?.revision).toBe(before);
    }

    const identityCases: Array<[string, (base: ReturnType<typeof result>) => object, string]> = [
      ["wrong-project", () => ({ projectId: "other" }), "FRESHNESS_BATCH_IDENTITY_INVALID"],
      ["wrong-revision", () => ({ codeRevision: "git:other-head" }), "FRESHNESS_BATCH_IDENTITY_INVALID"],
      ["bad-graph", () => ({ graphRevision: "bad\ngraph" }), "FRESHNESS_BATCH_IDENTITY_INVALID"],
      ["bad-time", () => ({ observedAt: "not-a-date" }), "FRESHNESS_BATCH_IDENTITY_INVALID"],
      ["wrong-kind", (base) => ({ results: { "asset-one": [{ ...base, assertionKind: "FILE_CONTAINS" }] } }),
        "FRESHNESS_BATCH_RESULT_IDENTITY_INVALID"],
      ["wrong-time", (base) => ({ results: { "asset-one": [{ ...base, observedAt: "2026-08-19T00:00:01.000Z" }] } }),
        "FRESHNESS_BATCH_RESULT_IDENTITY_INVALID"],
      ["missing-asset", () => ({ results: {} }), "FRESHNESS_BATCH_RESULT_INCOMPLETE"],
      ["unknown-asset", () => ({ results: { unknown: [] } }), "FRESHNESS_BATCH_RESULT_UNREQUESTED"],
    ];
    for (const [name, mutate, error] of identityCases) {
      const invalid = new KnowledgeFreshnessWorker(store, { verifyBatch: async (input) => {
        const base = result("one", "SUPPORTED");
        return { projectId: input.projectId, codeRevision: input.changes.sourceRef, observedAt: at,
          results: { "asset-one": [base] }, ...mutate(base) };
      } });
      await expect(invalid.run(changes(`git:identity-${name}`))).rejects.toThrow(error);
      expect(store.getState("asset-one")?.revision).toBe(before);
    }
    for (const limit of [0, 10_001, 1.5]) await expect(new KnowledgeFreshnessWorker(store, {
      verifyBatch: async () => { throw new Error("unused"); },
    }).run(changes(), limit)).rejects.toThrow("FRESHNESS_WORKER_LIMIT_INVALID");
  });

  it("selects all supported anchor kinds and honors cancellation", async () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:"); store.project(projection());
    const base = store.get("asset-one")!;
    expect(selectAffectedAssertionIds({ ...base, anchors: [
      { assertionId: "path", kind: "PATH", key: "src/a.ts", path: "src/a.ts" },
      { assertionId: "symbol", kind: "SYMBOL", key: "Runtime" },
      { assertionId: "config", kind: "CONFIG", key: "mode" },
      { assertionId: "dependency", kind: "DEPENDENCY", key: "sqlite" },
      { assertionId: "other", kind: "SYMBOL", key: "Other" },
    ] }, { ...changes(), changedPaths: ["src/a.ts"], changedConfigs: ["mode"], changedDependencies: ["sqlite"] }))
      .toEqual(["config", "dependency", "path", "symbol"]);
    const aborted = new AbortController(); aborted.abort("cancelled");
    await expect(new KnowledgeFreshnessWorker(store, { verifyBatch: async () => { throw new Error("unused"); } })
      .run(changes(), 500, aborted.signal)).rejects.toThrow("FRESHNESS_WORKER_ABORTED");
  });

  it("handles empty derived work, missing records and cancellation after verification", async () => {
    using store = new SqliteKnowledgeFreshnessStore(":memory:"); store.project(projection());
    const record = store.get("asset-one")!;
    const emptyStore: FreshnessWorkerStorePort = {
      affected: () => ({ items: [{ assetId: "asset-one", assetVersion: 1 }], bounded: false }),
      get: () => ({ ...record, anchors: [] }), getState: () => store.getState("asset-one"),
      transition: (value) => store.transition(value),
    };
    const verifyBatch = vi.fn(async () => { throw new Error("unused"); });
    await expect(new KnowledgeFreshnessWorker(emptyStore, { verifyBatch }).run(changes())).resolves
      .toMatchObject({ affectedCount: 1, items: [] });
    expect(verifyBatch).not.toHaveBeenCalled();

    const missingStore: FreshnessWorkerStorePort = {
      ...emptyStore, get: () => undefined,
    };
    await expect(new KnowledgeFreshnessWorker(missingStore, { verifyBatch }).run(changes()))
      .rejects.toThrow("FRESHNESS_WORKER_RECORD_MISSING");

    const controller = new AbortController();
    const lateAbort = new KnowledgeFreshnessWorker(store, { verifyBatch: async (input) => {
      controller.abort("late cancellation");
      return { projectId: input.projectId, codeRevision: input.changes.sourceRef, observedAt: at,
        results: { "asset-one": [result("one", "SUPPORTED")] } };
    } });
    await expect(lateAbort.run(changes(), 500, controller.signal)).rejects.toThrow("FRESHNESS_WORKER_ABORTED");
    expect(store.getState("asset-one")?.revision).toBe(0);
  });
});
