import type { KnowledgeAsset, KnowledgeScope } from "@zhiloop/domain";
import { resolveQueryContext } from "@zhiloop/query-context";
import { describe, expect, it, vi } from "vitest";

import { KnowledgeMcpService } from "./service.js";
import type { KnowledgeMcpBackend } from "./types.js";

const context = resolveQueryContext({
  prompt: "ContextEnvelope Task Contract",
  project: { projectId: "project-a", repositoryRoot: "/workspace/a", branch: "main", portable: true },
  taskId: "task-a",
});

function asset(
  id: string,
  overrides: Partial<KnowledgeAsset> = {},
  scope: KnowledgeScope = { level: "PROJECT", projectId: "project-a" },
): KnowledgeAsset {
  return {
    schemaVersion: 1, id, subjectKey: id, kind: "IMPLEMENTATION", scope,
    version: 1, status: "IMPLEMENTED", title: `${id} title`, summary: `${id} summary.`, body: `${id} body.`,
    aliases: [], keywords: [], applicability: ["project-a"], nonApplicability: ["outside project-a"],
    symbols: ["ContextEnvelope"], relations: [],
    evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }], confidence: 0.9,
    sourceEpisodes: [`episode-${id}`], contentHash: `sha256_${id}`, correlationId: "correlation-mcp",
    createdAt: "2026-08-02T19:00:00.000Z", updatedAt: "2026-08-02T19:00:00.000Z",
    ...overrides,
  };
}

function backend(
  currentAssets: readonly KnowledgeAsset[],
  searchAssets: readonly KnowledgeAsset[] = currentAssets,
  relatedAssets: readonly KnowledgeAsset[] = currentAssets,
): KnowledgeMcpBackend {
  const byId = new Map(currentAssets.map((value) => [value.id, value]));
  return {
    search: vi.fn(async () => ({ traceId: "trace-search", assets: searchAssets })),
    related: vi.fn(async () => ({ traceId: "trace-related", assets: relatedAssets })),
    current: vi.fn(async (request) => ({
      traceId: "trace-current",
      assets: request.assetIds.flatMap((id: string) => byId.get(id) ?? []),
    })),
  };
}

const signal = new AbortController().signal;

describe("KnowledgeMcpService", () => {
  it("ckl.search returns current in-scope L2 increments with trace, version, and Authority", async () => {
    const rule = asset("knowledge.rule", { kind: "RULE" });
    const decision = asset("knowledge.decision", { kind: "DECISION", status: "ACCEPTED" });
    const known = asset("knowledge.known");
    const staleHit = asset("knowledge.stale", { version: 1, contentHash: "old" });
    const staleCurrent = asset("knowledge.stale", { version: 2, contentHash: "new" });
    const outside = asset("knowledge.outside", {}, { level: "PROJECT", projectId: "project-b" });
    const service = new KnowledgeMcpService(backend(
      [rule, decision, known, staleCurrent, outside],
      [rule, decision, known, staleHit, outside],
    ));
    const result = await service.search({
      query: "context rules", knownItems: [{ id: known.id, version: 1, detailLevel: "L2_COMPACT" }],
    }, context, signal);
    expect(result).toMatchObject({
      traceId: "trace-search", tool: "ckl.search", omittedKnown: 1,
      items: [
        { id: rule.id, version: 1, detailLevel: "L2_COMPACT", authority: "BINDING_RULE", evidencePointers: [`evidence-${rule.id}`] },
        { id: decision.id, authority: "ACCEPTED_DECISION" },
      ],
      diagnostics: [`STALE_OR_NON_CURRENT:${staleHit.id}`, `INELIGIBLE:${outside.id}`],
    });
    expect(result.items[0]).not.toHaveProperty("content");
    expect(Object.isFrozen(result.items[0]?.scope)).toBe(true);
  });

  it("ckl.get returns only the L1/L2 to L3 delta and never repeats compact fields", async () => {
    const value = asset("knowledge.expand");
    const service = new KnowledgeMcpService(backend([value]));
    const result = await service.get({ id: value.id, version: 1, fromDetailLevel: "L2_COMPACT" }, context, signal);
    expect(result).toMatchObject({
      traceId: "trace-current", tool: "ckl.get", diagnostics: [],
      items: [{
        id: value.id, version: 1, fromDetailLevel: "L2_COMPACT", toDetailLevel: "L3_EVIDENCED",
        content: `${value.id} body.`, evidenceSummary: [{ evidenceId: `evidence-${value.id}`, verdict: "SUPPORTS" }],
      }],
    });
    for (const repeated of ["title", "summary", "scope", "status", "authority", "applicability"]) {
      expect(result.items[0]).not.toHaveProperty(repeated);
    }
    expect((await service.get({ id: value.id, version: 2, fromDetailLevel: "L1_POINTER" }, context, signal)).diagnostics).toEqual(["VERSION_MISMATCH"]);
    expect((await service.get({ id: "missing", version: 1, fromDetailLevel: "L1_POINTER" }, context, signal)).diagnostics).toEqual(["NOT_FOUND"]);
  });

  it("ckl.get refuses stale and out-of-scope knowledge", async () => {
    const stale = asset("knowledge.stale", { status: "STALE" });
    const outside = asset("knowledge.outside", {}, { level: "PROJECT", projectId: "project-b" });
    const service = new KnowledgeMcpService(backend([stale, outside]));
    expect((await service.get({ id: stale.id, version: 1, fromDetailLevel: "L1_POINTER" }, context, signal)).diagnostics).toEqual(["INELIGIBLE"]);
    expect((await service.get({ id: outside.id, version: 1, fromDetailLevel: "L1_POINTER" }, context, signal)).diagnostics).toEqual(["INELIGIBLE"]);
  });

  it("ckl.related validates the seed and returns only unseen, non-seed increments", async () => {
    const seed = asset("knowledge.seed");
    const related = asset("knowledge.related");
    const known = asset("knowledge.known");
    const source = backend([seed, related, known], [seed], [seed, related, known]);
    const service = new KnowledgeMcpService(source);
    const result = await service.related({
      seedAssetIds: [seed.id], knownItems: [{ id: known.id, version: 1, detailLevel: "L1_POINTER" }],
    }, context, signal);
    expect(result).toMatchObject({
      traceId: "trace-related", tool: "ckl.related", items: [{ id: related.id }], omittedKnown: 2,
    });
    await expect(service.related({ seedAssetIds: ["missing"] }, context, signal)).rejects.toThrow("outside QueryContext");
  });

  it("ckl.check explains current version, status, scope, and missing assets", async () => {
    const good = asset("knowledge.good");
    const stale = asset("knowledge.stale", { status: "SUPERSEDED", version: 2 });
    const outside = asset("knowledge.outside", {}, { level: "PROJECT", projectId: "project-b" });
    const service = new KnowledgeMcpService(backend([good, stale, outside]));
    const result = await service.check({ items: [
      { id: good.id, version: 1 }, { id: stale.id, version: 1 }, { id: outside.id }, { id: "missing" },
    ] }, context, signal);
    expect(result.checks).toEqual([
      expect.objectContaining({ id: good.id, currentVersion: 1, eligible: true, reasonCodes: ["CURRENT_VERSION", "STATUS_ELIGIBLE", "SCOPE_MATCHED"] }),
      expect.objectContaining({ id: stale.id, currentVersion: 2, eligible: false, reasonCodes: ["VERSION_MISMATCH", "STATUS_INELIGIBLE", "SCOPE_MATCHED"] }),
      expect.objectContaining({ id: outside.id, eligible: false, reasonCodes: ["CURRENT_VERSION", "STATUS_ELIGIBLE", "SCOPE_MISMATCH"] }),
      { id: "missing", eligible: false, reasonCodes: ["NOT_FOUND"] },
    ]);
  });

  it("validates all public tool boundaries and backend trace/current consistency", async () => {
    const value = asset("knowledge.a");
    const service = new KnowledgeMcpService(backend([value]));
    await expect(service.search({ query: "" }, context, signal)).rejects.toThrow("query");
    await expect(service.search({ query: "x", limit: 9 }, context, signal)).rejects.toThrow("limit");
    await expect(service.search({ query: "x", knownItems: [{ id: "bad id", version: 1, detailLevel: "L1_POINTER" }] }, context, signal)).rejects.toThrow("knownItems");
    await expect(service.related({ seedAssetIds: [] }, context, signal)).rejects.toThrow("seedAssetIds");
    await expect(service.get({ id: value.id, version: 0, fromDetailLevel: "L1_POINTER" }, context, signal)).rejects.toThrow("get input");
    await expect(service.check({ items: [] }, context, signal)).rejects.toThrow("check items");

    const badTrace: KnowledgeMcpBackend = {
      search: async () => ({ traceId: "bad trace", assets: [] }),
      related: async () => ({ traceId: "bad trace", assets: [] }),
      current: async () => ({ traceId: "bad trace", assets: [] }),
    };
    await expect(new KnowledgeMcpService(badTrace).search({ query: "x" }, context, signal)).rejects.toThrow("traceId");

    const conflict = backend([value]);
    conflict.current = vi.fn(async () => ({ traceId: "trace-current", assets: [value, { ...value, version: 2 }] }));
    await expect(new KnowledgeMcpService(conflict).check({ items: [{ id: value.id }] }, context, signal)).rejects.toThrow("conflicting");

    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    const untouched = backend([value]);
    await expect(new KnowledgeMcpService(untouched).search({ query: "x" }, context, aborted.signal)).rejects.toThrow("cancelled");
    expect(untouched.search).not.toHaveBeenCalled();
  });
});
