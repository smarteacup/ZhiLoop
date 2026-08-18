import { describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "@zhiloop/domain";

import { buildStableContextCatalog, ContextPrewarmService, contextPrewarmIdentity } from "./prewarm.js";
import { SqliteContextPrewarmStore } from "./store.js";
import type { ContextPrewarmInput, ContextPrewarmStorePort, StableContextCatalog } from "./types.js";

const now = "2026-08-19T00:00:00.000Z";

function input(overrides: Partial<ContextPrewarmInput> = {}): ContextPrewarmInput {
  return {
    sessionId: "session-1", projectId: "project-1", worktree: "/repo/worktree", branch: "main",
    knowledgeRegistryRevision: "registry-1", retrievalPolicyHash: "retrieval-1",
    injectionPolicyHash: "injection-1", scopeHash: "scope-1", observedAt: now, ...overrides,
  };
}

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    schemaVersion: 1, id, subjectKey: `rule.${id}`, kind: "RULE", scope: { level: "PROJECT", projectId: "project-1" },
    version: 1, status: "ACCEPTED", title: `Rule ${id}`, summary: "Keep the boundary explicit", body: "private body",
    aliases: [], keywords: [], applicability: [], nonApplicability: [], symbols: ["SecretSymbol"], relations: [],
    evidence: [{ evidenceId: "evidence-1", verdict: "SUPPORTS" }], confidence: 0.9, sourceEpisodes: ["episode-private"],
    contentHash: `hash-${id}`, correlationId: "correlation-1", createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("context prewarm", () => {
  it("builds a bounded L1-only catalog in authority order", () => {
    const catalog = buildStableContextCatalog(input(), { ttlMs: 60_000, maxItems: 2, maxTokens: 800 }, [
      asset("reference", { kind: "EXPERIENCE", status: "IMPLEMENTED" }),
      asset("binding"),
      asset("other", { scope: { level: "PROJECT", projectId: "other" } }),
    ]);
    expect(catalog.items.map((item) => item.assetId)).toEqual(["binding", "reference"]);
    expect(catalog.items[0]).toMatchObject({ authority: "BINDING_RULE", expansion: { tool: "ckl.get", assetId: "binding" } });
    expect(JSON.stringify(catalog)).not.toContain("private body");
    expect(JSON.stringify(catalog)).not.toContain("SecretSymbol");
    expect(JSON.stringify(catalog)).not.toContain("episode-private");

    const budgeted = buildStableContextCatalog(input(), { ttlMs: 60_000, maxItems: 2, maxTokens: 64 }, [
      asset("a", { title: "x".repeat(1_000) }), asset("b"), asset("b"),
    ]);
    expect(budgeted.items.map((item) => item.assetId)).toEqual(["b"]);
    expect(budgeted.truncated).toBe(true);
  });

  it("changes identity for every declared dependency", () => {
    const baseline = contextPrewarmIdentity(input()).cacheKey;
    for (const change of [
      { sessionId: "session-2" }, { projectId: "project-2" }, { worktree: "/repo/other" }, { branch: "feature" },
      { knowledgeRegistryRevision: "registry-2" }, { retrievalPolicyHash: "retrieval-2" },
      { injectionPolicyHash: "injection-2" }, { scopeHash: "scope-2" },
    ]) expect(contextPrewarmIdentity(input(change)).cacheKey).not.toBe(baseline);
  });

  it("validates inputs, policies, visibility and hard source bounds", () => {
    expect(() => contextPrewarmIdentity(input({ sessionId: "bad\nsession" }))).toThrow("CONTEXT_PREWARM_INPUT_INVALID");
    expect(() => contextPrewarmIdentity(input({ observedAt: "not-a-date" }))).toThrow("CONTEXT_PREWARM_INPUT_INVALID");
    for (const policy of [
      { ttlMs: 999, maxItems: 8, maxTokens: 800 },
      { ttlMs: 60_000, maxItems: 0, maxTokens: 800 },
      { ttlMs: 60_000, maxItems: 8, maxTokens: 63 },
    ]) expect(() => buildStableContextCatalog(input(), policy, [])).toThrow("CONTEXT_PREWARM_POLICY_INVALID");
    const catalog = buildStableContextCatalog(input(), { ttlMs: 60_000, maxItems: 3, maxTokens: 800 }, [
      asset("global", { scope: { level: "GLOBAL" }, kind: "DECISION", status: "ACCEPTED" }),
      asset("verified", { scope: { level: "MODULE", projectId: "project-1", modulePaths: ["src"] }, kind: "FACT", status: "VERIFIED" }),
      asset("reference", { scope: { level: "SYMBOL", projectId: "project-1", symbols: ["A"] }, kind: "FACT" }),
      asset("stale", { status: "STALE" }),
      asset("user", { scope: { level: "USER", userId: "user-1" } }),
    ]);
    expect(catalog.items.map((item) => item.authority)).toEqual(["ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE"]);
    expect(() => buildStableContextCatalog(input(), { ttlMs: 60_000, maxItems: 8, maxTokens: 800 },
      new Array<KnowledgeAsset>(100_001).fill(asset("many")))).toThrow("CONTEXT_PREWARM_ASSET_LIMIT_EXCEEDED");
  });

  it("hits, expires, and explicitly refreshes a session", async () => {
    using store = new SqliteContextPrewarmStore(":memory:");
    const service = new ContextPrewarmService(store, { ttlMs: 60_000, maxItems: 8, maxTokens: 800 });
    let loads = 0;
    const load = (): readonly KnowledgeAsset[] => { loads += 1; return [asset("one")]; };
    expect((await service.prepare(input(), load)).source).toBe("MISS");
    expect((await service.prepare(input({ observedAt: "2026-08-19T00:00:30.000Z" }), load)).source).toBe("HIT");
    expect(loads).toBe(1);
    expect(service.refresh("session-1")).toBe(1);
    expect(service.refresh("session-1")).toBe(0);
    expect((await service.prepare(input({ observedAt: "2026-08-19T00:00:31.000Z" }), load)).source).toBe("MISS");
    expect((await service.prepare(input({ observedAt: "2026-08-19T00:02:00.000Z" }), load)).source).toBe("MISS");
    expect(loads).toBe(3);
  });

  it("uses the winner of a concurrent cross-process fill", async () => {
    const winner = buildStableContextCatalog(input(), { ttlMs: 60_000, maxItems: 8, maxTokens: 800 }, [asset("winner")]);
    let reads = 0;
    const store: ContextPrewarmStorePort = {
      get: () => { reads += 1; return reads === 1 ? undefined : winner; },
      put: () => { throw new Error("CONTEXT_PREWARM_KEY_CONFLICT"); },
      invalidateSession: () => 0,
    };
    const result = await new ContextPrewarmService(store, { ttlMs: 60_000, maxItems: 8, maxTokens: 800 })
      .prepare(input(), () => [asset("loser")]);
    expect(result).toEqual({ source: "HIT", catalog: winner satisfies StableContextCatalog });
  });

  it("does not hide non-conflict store failures or a missing concurrent winner", async () => {
    const failing = (message: string): ContextPrewarmStorePort => ({
      get: () => undefined,
      put: () => { throw new Error(message); },
      invalidateSession: () => 0,
    });
    for (const message of ["disk offline", "CONTEXT_PREWARM_KEY_CONFLICT"]) {
      await expect(new ContextPrewarmService(failing(message), { ttlMs: 60_000, maxItems: 8, maxTokens: 800 })
        .prepare(input(), () => [])).rejects.toThrow(message);
    }
    expect(() => new ContextPrewarmService(failing("unused"), { ttlMs: 60_000, maxItems: 8, maxTokens: 800 })
      .refresh("bad\nsession")).toThrow("CONTEXT_PREWARM_SESSION_INVALID");
  });
});
