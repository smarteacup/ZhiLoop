import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import { performance } from "node:perf_hooks";
import { deriveScenarioId, type KnowledgeAsset, type KnowledgeLocator, type KnowledgeStatus } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset } from "@zhiloop/knowledge-registry";
import { resolveQueryContext } from "@zhiloop/query-context";
import { describe, expect, it, vi } from "vitest";

import type { KnowledgeRetrievalSource, RetrievalSourceHit } from "./types.js";
import { MultiChannelRetrievalEngine } from "./engine.js";

const project = { projectId: "project-a", repositoryRoot: "/workspace/a", branch: "main", portable: true } as const;

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): ProjectedKnowledgeAsset {
  const value: KnowledgeAsset = {
    schemaVersion: 1, id, subjectKey: id, kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: project.projectId }, version: 1, status: "IMPLEMENTED",
    title: id, summary: `${id} summary`, body: `${id} body`, aliases: [], keywords: [],
    applicability: [], nonApplicability: [], symbols: [], relations: [], evidence: [], confidence: 0.9,
    sourceEpisodes: ["episode-retrieval"], contentHash: `sha256_${id}-v${overrides.version ?? 1}`,
    correlationId: "correlation-retrieval", createdAt: "2026-08-02T15:00:00.000Z",
    updatedAt: "2026-08-02T15:00:00.000Z", ...overrides,
  };
  return Object.freeze({ asset: Object.freeze(value), tombstone: false, indexVersion: 1 });
}

function hit(value: ProjectedKnowledgeAsset, rank: number, rawScore = 1): RetrievalSourceHit {
  return { asset: value, rank, rawScore, reason: `source rank ${rank} raw ${rawScore}` };
}

function source(
  values: readonly ProjectedKnowledgeAsset[],
  options: { fts?: readonly RetrievalSourceHit[]; related?: readonly RetrievalSourceHit[]; ftsError?: Error } = {},
): KnowledgeRetrievalSource {
  const byId = new Map(values.map((item) => [item.asset.id, item]));
  return {
    listCurrent: vi.fn(() => values),
    getCurrent: vi.fn((id: string) => byId.get(id)),
    searchFts: vi.fn(() => {
      if (options.ftsError !== undefined) throw options.ftsError;
      return options.fts ?? [];
    }),
    related: vi.fn(() => options.related ?? []),
  };
}

function request(prompt: string, overrides: Partial<typeof DEFAULT_CONFIGURATION.retrieval> = {}) {
  return {
    context: resolveQueryContext({ prompt, project }),
    policy: {
      ...DEFAULT_CONFIGURATION.retrieval,
      ...overrides,
      topK: { ...DEFAULT_CONFIGURATION.retrieval.topK, ...overrides.topK },
      fusion: { ...DEFAULT_CONFIGURATION.retrieval.fusion, ...overrides.fusion },
      rerank: { ...DEFAULT_CONFIGURATION.retrieval.rerank, ...overrides.rerank },
      eligibility: { ...DEFAULT_CONFIGURATION.retrieval.eligibility, ...overrides.eligibility },
    },
  };
}

describe("MultiChannelRetrievalEngine", () => {
  it("filters located knowledge by authoritative project, branch, commit, dirty state, and selected scenario", async () => {
    const locatedProject = { ...project, revision: { commit: "abcdef1234567", dirty: false } } as const;
    const located = (id: string, scenarioKey: string, taskIntent: string, overrides: Partial<KnowledgeLocator> = {}) => {
      const locator: KnowledgeLocator = {
        schemaVersion: 1, projectId: project.projectId,
        observedRevision: { branch: "main", commit: "abcdef1234567", dirty: false },
        branchApplicability: { mode: "BRANCH_LINEAGE", baseCommit: "abcdef1234567", observedBranch: "main" },
        scenarioId: deriveScenarioId(project.projectId, scenarioKey), scenarioKey,
        scenarioTitle: taskIntent, scenarioSummary: `${taskIntent} 场景`, modulePaths: ["src/order"], symbols: [],
        entryPoints: [], taskIntents: [taskIntent], applicability: ["当前项目"], nonApplicability: [], ...overrides,
      };
      return asset(id, { schemaVersion: 2, claimMode: "CURRENT_STATE", locator });
    };
    const selected = located("knowledge.located.create", "order.create", "新增订单");
    const otherScene = located("knowledge.located.cancel", "order.cancel", "取消订单");
    const otherBranch = located("knowledge.located.branch", "order.branch", "新增订单", {
      branchApplicability: { mode: "EXACT_BRANCH", branch: "feature/v2" },
    });
    const dirty = located("knowledge.located.dirty", "order.dirty", "新增订单", {
      observedRevision: { branch: "main", commit: "abcdef1234567", dirty: true },
    });
    const values = [selected, otherScene, otherBranch, dirty];
    const input = source(values, { fts: values.map((item, index) => hit(item, index + 1)) });
    const context = resolveQueryContext({ prompt: "如何新增订单", project: locatedProject,
      hints: { taskIntents: ["新增订单"] } });
    const result = await new MultiChannelRetrievalEngine(input, undefined,
      { channels: { exact: false, vector: false, relation: false } }).retrieve({ ...request("如何新增订单"), context });
    expect(result.items.map((item) => item.asset.id)).toEqual([selected.asset.id]);
    expect(result.scenarioDirectory).toContainEqual(expect.objectContaining({
      scenarioId: selected.asset.locator?.scenarioId, selected: true,
    }));
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "SCENARIO_FILTERED", "BRANCH_FILTERED", "DIRTY_REVISION_FILTERED",
    ]));
  });

  it("fails closed for legacy current-code facts once the query has an authoritative commit", async () => {
    const legacy = asset("knowledge.legacy.implementation", { symbols: ["LegacySymbol"] });
    const context = resolveQueryContext({ prompt: "symbol LegacySymbol",
      project: { ...project, revision: { commit: "abcdef1234567", dirty: false } } });
    const result = await new MultiChannelRetrievalEngine(source([legacy]), undefined,
      { channels: { fts: false, vector: false, relation: false } }).retrieve({ ...request("symbol LegacySymbol"), context });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "LOCATOR_LEGACY_FILTERED" }));
  });

  it("fuses Exact, FTS, and Relation by rank while retaining contributions", async () => {
    const exact = asset("knowledge.retrieval.exact", { symbols: ["ExactSymbol"] });
    const fts = asset("knowledge.retrieval.fts");
    const related = asset("knowledge.retrieval.related");
    const input = source([exact, fts, related], {
      fts: [hit(fts, 1, 1_000_000), hit(exact, 2, -999)],
      related: [hit(related, 1, 0.01)],
    });
    const result = await new MultiChannelRetrievalEngine(input, undefined, { channels: { vector: false } })
      .retrieve(request("symbol ExactSymbol"));
    expect(result.items.map((item) => item.asset.id)).toEqual([
      exact.asset.id, fts.asset.id, related.asset.id,
    ]);
    expect(result.items[0]?.contributions.map((item) => item.channel)).toEqual(["EXACT", "FTS"]);
    expect(result.items[0]?.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(result.items[1]?.score).toBeCloseTo(1 / 61);
    expect(result.items[2]?.contributions).toMatchObject([{ channel: "RELATION", rank: 1 }]);
  });

  it("does not add incomparable raw scores across channels", async () => {
    const first = asset("knowledge.retrieval.first", { symbols: ["RankSymbol"] });
    const second = asset("knowledge.retrieval.second");
    const input = source([first, second], { fts: [hit(second, 1, Number.MAX_VALUE), hit(first, 2, Number.MIN_VALUE)] });
    const result = await new MultiChannelRetrievalEngine(input, undefined, { channels: { vector: false, relation: false } })
      .retrieve(request("symbol RankSymbol"));
    expect(result.items[0]?.asset.id).toBe(first.asset.id);
    expect(result.items.flatMap((item) => item.contributions).every((item) => item.contribution <= 1 / 61)).toBe(true);
  });

  it("filters status, tombstone, project, USER, and GLOBAL according to the boundary", async () => {
    const eligible = asset("knowledge.retrieval.eligible", { symbols: ["SharedSymbol"] });
    const stale = asset("knowledge.retrieval.stale", { symbols: ["SharedSymbol"], status: "STALE" });
    const otherProject = asset("knowledge.retrieval.other", {
      symbols: ["SharedSymbol"], scope: { level: "PROJECT", projectId: "project-b" },
    });
    const user = asset("knowledge.retrieval.user", { symbols: ["SharedSymbol"], scope: { level: "USER", userId: "user-a" } });
    const global = asset("knowledge.retrieval.global", { symbols: ["SharedSymbol"], scope: { level: "GLOBAL" } });
    const tombstone = { ...asset("knowledge.retrieval.tomb", { symbols: ["SharedSymbol"] }), tombstone: true };
    const values = [eligible, stale, otherProject, user, global, tombstone];
    const engine = new MultiChannelRetrievalEngine(source(values), undefined, { channels: { fts: false, vector: false, relation: false } });
    const trusted = await engine.retrieve(request("symbol SharedSymbol"));
    expect(trusted.items.map((item) => item.asset.id)).toEqual([eligible.asset.id, global.asset.id]);
    expect(trusted.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "STATUS_FILTERED", "SCOPE_FILTERED", "TOMBSTONE_FILTERED",
    ]));
    const untrustedRequest = request("symbol SharedSymbol");
    untrustedRequest.context = resolveQueryContext({ prompt: "symbol SharedSymbol" });
    expect((await engine.retrieve(untrustedRequest)).items).toEqual([]);
  });

  it("keeps Exact available when FTS fails and other channels are disabled", async () => {
    const exact = asset("knowledge.retrieval.fallback", { symbols: ["FallbackSymbol"] });
    const result = await new MultiChannelRetrievalEngine(
      source([exact], { ftsError: new Error("fts unavailable") }), undefined,
      { channels: { vector: false, relation: false } },
    ).retrieve(request("symbol FallbackSymbol"));
    expect(result.items).toMatchObject([{ asset: { id: exact.asset.id } }]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CHANNEL_FAILED", channel: "FTS" }),
      expect.objectContaining({ code: "CHANNEL_DISABLED", channel: "VECTOR" }),
    ]));
  });

  it("drops old/duplicate vector chunks and returns only the current asset version", async () => {
    const current = asset("knowledge.retrieval.vector", { version: 2, contentHash: "sha256_current" });
    const vector = {
      embedding: { version: "embedding-v1", embed: vi.fn(async () => [[1, 0]]) },
      index: {
        enabled: true,
        embeddingVersion: "embedding-v1",
        replaceAssetChunks: vi.fn(), removeAsset: vi.fn(),
        search: vi.fn(() => [{
          chunk: { chunkId: "old", assetId: current.asset.id, assetVersion: 1, assetContentHash: "sha256_old", ordinal: 0, heading: "", content: "old", contentHash: "old" },
          score: 999, rank: 1,
        }, {
          chunk: { chunkId: "current", assetId: current.asset.id, assetVersion: 2, assetContentHash: "sha256_current", ordinal: 0, heading: "", content: "current", contentHash: "current" },
          score: 0.5, rank: 2,
        }, {
          chunk: { chunkId: "duplicate", assetId: current.asset.id, assetVersion: 2, assetContentHash: "sha256_current", ordinal: 1, heading: "", content: "duplicate", contentHash: "duplicate" },
          score: 0.4, rank: 3,
        }]),
      },
    };
    const result = await new MultiChannelRetrievalEngine(
      source([current]), vector, { channels: { exact: false, fts: false, relation: false } },
    ).retrieve(request("vector query"));
    expect(result.items).toMatchObject([{ asset: { id: current.asset.id, version: 2 }, contributions: [{ channel: "VECTOR", rank: 1 }] }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "STALE_VECTOR_CHUNK" }));
  });

  it("fails Vector open on version mismatch or embedding failure", async () => {
    const exact = asset("knowledge.retrieval.vector-fallback", { symbols: ["VectorFallback"] });
    const embedding = { version: "query-v2", embed: vi.fn(async () => { throw new Error("embedding failed"); }) };
    let embeddingVersion: string | undefined = "index-v1";
    const index = {
      enabled: true, get embeddingVersion() { return embeddingVersion; },
      replaceAssetChunks: vi.fn(), removeAsset: vi.fn(), search: vi.fn(() => []),
    };
    const mismatch = await new MultiChannelRetrievalEngine(
      source([exact]), { embedding, index }, { channels: { fts: false, relation: false } },
    ).retrieve(request("symbol VectorFallback"));
    expect(mismatch.items).toMatchObject([{ asset: { id: exact.asset.id } }]);
    expect(mismatch.diagnostics).toContainEqual(expect.objectContaining({ code: "VECTOR_VERSION_MISMATCH" }));
    expect(embedding.embed).not.toHaveBeenCalled();
    embeddingVersion = undefined;
    const failed = await new MultiChannelRetrievalEngine(
      source([exact]), { embedding, index }, { channels: { fts: false, relation: false } },
    ).retrieve(request("symbol VectorFallback"));
    expect(failed.items).toHaveLength(1);
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({ code: "CHANNEL_FAILED", channel: "VECTOR" }));
  });

  it("rejects stale source hits, cross-scope relation targets, and invalid runtime policy", async () => {
    const seed = asset("knowledge.retrieval.seed", { symbols: ["SeedSymbol"] });
    const target = asset("knowledge.retrieval.target", { scope: { level: "PROJECT", projectId: "project-b" } });
    const old = asset(seed.asset.id, { version: 1, contentHash: "sha256_old" });
    const current = asset(seed.asset.id, { version: 2, symbols: ["SeedSymbol"], contentHash: "sha256_new" });
    const input = source([current, target], { fts: [hit(old, 1)], related: [hit(target, 1)] });
    const result = await new MultiChannelRetrievalEngine(input, undefined, { channels: { vector: false } })
      .retrieve(request("symbol SeedSymbol"));
    expect(result.items.map((item) => item.asset.id)).toEqual([seed.asset.id]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STALE_SOURCE_HIT", channel: "FTS" }),
      expect.objectContaining({ code: "SCOPE_FILTERED", channel: "RELATION" }),
    ]));
    await expect(new MultiChannelRetrievalEngine(input).retrieve(request("x", {
      fusion: { algorithm: "rrf", rrfK: 0 },
    }))).rejects.toThrow("policy is invalid");
    const inconsistent = request("x");
    inconsistent.context = {
      ...inconsistent.context,
      retrievalBoundary: { ...inconsistent.context.retrievalBoundary, projectId: "project-b" },
    };
    await expect(new MultiChannelRetrievalEngine(input).retrieve(inconsistent)).rejects.toThrow("boundary is inconsistent");
  });

  it("honors custom eligibility statuses and output candidate cap", async () => {
    const values = Array.from({ length: 5 }, (_, index) => asset(`knowledge.retrieval.cap-${index}`, {
      symbols: ["CapSymbol"], status: "ACCEPTED" as KnowledgeStatus,
    }));
    const result = await new MultiChannelRetrievalEngine(
      source(values), undefined, { channels: { fts: false, vector: false, relation: false } },
    ).retrieve(request("symbol CapSymbol", {
      rerank: { candidates: 2 }, eligibility: { default: ["ACCEPTED"] },
    }));
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.asset.status).toBe("ACCEPTED");
    expect(Object.isFrozen(result.items[0]?.contributions)).toBe(true);
  });

  it("rejects invalid channel hits and skips oversized vector queries", async () => {
    const value = asset("knowledge.retrieval.invalid-hit");
    const invalid = source([value], { fts: [hit(value, 0, Number.NaN)] });
    const invalidResult = await new MultiChannelRetrievalEngine(
      invalid, undefined, { channels: { exact: false, vector: false, relation: false } },
    ).retrieve(request("invalid hit"));
    expect(invalidResult.items).toEqual([]);
    expect(invalidResult.diagnostics).toContainEqual(expect.objectContaining({ code: "CHANNEL_FAILED", channel: "FTS" }));

    const embedding = { version: "v1", embed: vi.fn(async () => [[1]]) };
    const index = {
      enabled: true, embeddingVersion: undefined, replaceAssetChunks: vi.fn(), removeAsset: vi.fn(), search: vi.fn(() => []),
    };
    const long = await new MultiChannelRetrievalEngine(
      source([value]), { embedding, index }, { channels: { exact: false, fts: false, relation: false } },
    ).retrieve(request("x".repeat(20_001)));
    expect(long.diagnostics).toContainEqual(expect.objectContaining({ code: "CHANNEL_FAILED", channel: "VECTOR" }));
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it("applies scope-bound pin/suppress feedback only after status and Scope eligibility", async () => {
    const first = asset("knowledge.feedback.first", { symbols: ["FeedbackSymbol"] });
    const second = asset("knowledge.feedback.second", { symbols: ["FeedbackSymbol"] });
    const proposed = asset("knowledge.feedback.proposed", { symbols: ["FeedbackSymbol"], status: "PROPOSED" });
    const input = { ...request("symbol FeedbackSymbol"), feedback: {
      scopeKey: JSON.stringify({ level: "PROJECT", projectId: "project-a" }),
      assets: [
        { assetId: first.asset.id, relevant: 0, irrelevant: 3, score: -3, pinned: false, suppressed: true },
        { assetId: second.asset.id, relevant: 3, irrelevant: 0, score: 3, pinned: true, suppressed: false },
        { assetId: proposed.asset.id, relevant: 999, irrelevant: 0, score: 999, pinned: true, suppressed: false },
      ],
    } };
    const result = await new MultiChannelRetrievalEngine(
      source([first, second, proposed]), undefined, { channels: { fts: false, vector: false, relation: false } },
    ).retrieve(input);
    expect(result.items.map((item) => item.asset.id)).toEqual([second.asset.id]);
    const wrongScope = { ...input, feedback: { ...input.feedback, scopeKey: JSON.stringify({ level: "PROJECT", projectId: "project-b" }) } };
    await expect(new MultiChannelRetrievalEngine(source([first])).retrieve(wrongScope)).rejects.toThrow("feedback profile");
  });

  it("retrieves from 1,000 current assets below the local P95 budget", async () => {
    const values = Array.from({ length: 1_000 }, (_, index) => asset(`knowledge.retrieval.perf-${index}`, {
      symbols: index === 777 ? ["PerformanceSymbol"] : [],
    }));
    const selected = values[777] as ProjectedKnowledgeAsset;
    const neighbor = values[778] as ProjectedKnowledgeAsset;
    const input = source(values, { fts: [hit(selected, 1)], related: [hit(neighbor, 1)] });
    const vector = {
      embedding: { version: "perf-v1", embed: async () => [[1, 0]] },
      index: {
        enabled: true, embeddingVersion: "perf-v1", replaceAssetChunks: vi.fn(), removeAsset: vi.fn(),
        search: () => [{
          chunk: {
            chunkId: "perf", assetId: selected.asset.id, assetVersion: selected.asset.version,
            assetContentHash: selected.asset.contentHash, ordinal: 0, heading: "", content: "perf", contentHash: "perf",
          },
          score: 0.9, rank: 1,
        }],
      },
    };
    const engine = new MultiChannelRetrievalEngine(input, vector);
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const result = await engine.retrieve(request("symbol PerformanceSymbol"));
      durations.push(performance.now() - started);
      expect(result.items[0]?.asset.id).toBe(selected.asset.id);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.ceil(durations.length * 0.95) - 1]).toBeLessThan(50);
  });
});
