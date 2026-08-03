import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_CONFIGURATION, type InjectionPolicy, type RetrievalPolicy } from "@zhiloop/config";
import type { KnowledgeAsset } from "@zhiloop/domain";
import type { KnowledgeRetrievalSource, RetrievalSourceHit } from "@zhiloop/retrieval-engine";
import { afterEach, describe, expect, it } from "vitest";

import {
  fingerprintConsoleRetrievalPolicy,
  InMemoryRetrievalTraceStore,
  RetrievalQueryService,
  RetrievalRequestConflictError,
  SqliteRetrievalTraceStore,
  type ResolvedRetrievalPolicy,
  type RetrievalPolicyReference,
  type RetrievalPolicyResolver,
} from "./index.js";

const project = { projectId: "project-a", repositoryRoot: "/workspace/project-a", portable: true } as const;
const at = "2026-08-04T00:00:00.000Z";
type ProjectedKnowledgeAsset = RetrievalSourceHit["asset"];

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): ProjectedKnowledgeAsset {
  return {
    asset: {
      schemaVersion: 1,
      id,
      subjectKey: `test.retrieval.${id.replaceAll("_", "-")}`,
      kind: "IMPLEMENTATION",
      scope: { level: "PROJECT", projectId: "project-a" },
      version: 1,
      status: "VERIFIED",
      title: `Knowledge ${id}`,
      summary: `Summary for ${id}`,
      body: `Body for ${id}`,
      aliases: [],
      keywords: [],
      applicability: [],
      nonApplicability: [],
      symbols: [],
      relations: [],
      evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }],
      confidence: 1,
      sourceEpisodes: [`episode-${id}`],
      contentHash: `hash-${id}`,
      correlationId: `correlation-${id}`,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    },
    tombstone: false,
    indexVersion: 1,
  };
}

class Source implements KnowledgeRetrievalSource {
  calls = 0;
  constructor(
    readonly current: ProjectedKnowledgeAsset[],
    readonly fts: ProjectedKnowledgeAsset[] = current,
    readonly hangFts = false,
  ) {}

  listCurrent(): readonly ProjectedKnowledgeAsset[] {
    this.calls += 1;
    return this.current;
  }

  getCurrent(assetId: string): ProjectedKnowledgeAsset | undefined {
    return this.current.find((item) => item.asset.id === assetId);
  }

  searchFts(_query: string, limit: number): readonly RetrievalSourceHit[] | Promise<readonly RetrievalSourceHit[]> {
    this.calls += 1;
    if (this.hangFts) return new Promise(() => undefined);
    return this.fts.slice(0, limit).map((item, index) => ({
      asset: item, rank: index + 1, rawScore: 1 / (index + 1), reason: `FTS rank ${index + 1}`,
    }));
  }

  related(): readonly RetrievalSourceHit[] {
    return [];
  }
}

function policies(injection: InjectionPolicy = DEFAULT_CONFIGURATION.injection): {
  resolver: RetrievalPolicyResolver;
  reference: (source: RetrievalPolicyReference["source"], id?: string) => RetrievalPolicyReference;
} {
  const retrieval: RetrievalPolicy = structuredClone(DEFAULT_CONFIGURATION.retrieval);
  const resolvedInjection = structuredClone(injection);
  const fingerprint = fingerprintConsoleRetrievalPolicy(retrieval, resolvedInjection);
  const reference = (source: RetrievalPolicyReference["source"], id = `policy-${source.toLowerCase()}`): RetrievalPolicyReference => ({
    policyId: id, revision: 1, fingerprint, source,
  });
  return {
    reference,
    resolver: {
      resolve(requested): ResolvedRetrievalPolicy {
        return { reference: requested, retrieval, injection: resolvedInjection };
      },
    },
  };
}

function request(policy: RetrievalPolicyReference, requestId = "request-search-1") {
  return {
    schemaVersion: 1 as const,
    requestId,
    query: "Find ConfigService ERR_CONFIG_42 and service.retry.max-attempts",
    project,
    cwd: project.repositoryRoot,
    hints: { symbols: ["ConfigService"], errorCodes: ["ERR_CONFIG_42"], configKeys: ["service.retry.max-attempts"] },
    policy,
    maxResults: 20,
    maxContextTokens: 800,
    timeoutMs: 1_000,
  };
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RetrievalQueryService", () => {
  it("retrieves exact symbol, error and config terms while excluding cross-project and stale hits", async () => {
    const exact = asset("knowledge-config", {
      aliases: ["ERR_CONFIG_42"], keywords: ["service.retry.max-attempts"], symbols: ["ConfigService"],
    });
    const forbidden = asset("knowledge-forbidden", {
      scope: { level: "PROJECT", projectId: "project-b" },
      symbols: ["ConfigService"],
    });
    const stale = asset("knowledge-stale", { version: 1, title: "stale FTS hit" });
    const currentStale = asset("knowledge-stale", { version: 2, contentHash: "hash-current", title: "current version" });
    const source = new Source([exact, forbidden, currentStale], [stale]);
    const policy = policies();
    const service = new RetrievalQueryService({
      source, policies: policy.resolver, traces: new InMemoryRetrievalTraceStore(), now: () => new Date(at),
    });

    const response = await service.search(request(policy.reference("CURRENT")));

    expect(response.trace.results.map((item) => item.knowledgeId)).toEqual(["knowledge-config"]);
    expect(response.trace.results[0]?.contributions.map((item) => item.channel)).toContain("EXACT");
    expect(response.trace.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: "knowledge-forbidden", reasonCode: "SCOPE_FILTERED", decision: "EXCLUDED" }),
      expect.objectContaining({ assetId: "knowledge-stale", reasonCode: "STALE_VERSION", decision: "EXCLUDED" }),
    ]));
    expect(response.trace.results[0]).toMatchObject({
      evidence: [{ evidenceId: "evidence-knowledge-config", verdict: "SUPPORTS" }],
      sourceEpisodeIds: ["episode-knowledge-config"], retrievalRank: 1, finalRank: 1,
    });
    expect(response.trace.injection).toEqual({
      result: "SHADOWED", reasonCodes: ["P3_SHADOW_READ_ONLY", "NO_CODEX_DELIVERY_ATTEMPTED"],
    });
    expect(response.trace.evaluation?.results[0]).toMatchObject({ assetId: "knowledge-config", injected: true });
  });

  it("falls back from a timed-out channel and records budget omissions with all Trace axes", async () => {
    const values = Array.from({ length: 10 }, (_, index) => asset(`knowledge-${index}`, {
      symbols: ["ConfigService"], title: `Long knowledge ${index} ${"x".repeat(150)}`,
    }));
    const source = new Source(values, values, true);
    const policy = policies();
    const service = new RetrievalQueryService({
      source, policies: policy.resolver, traces: new InMemoryRetrievalTraceStore(), now: () => new Date(at),
    });
    const response = await service.search({
      ...request(policy.reference("CURRENT"), "request-timeout-budget"),
      query: "ConfigService",
      hints: { symbols: ["ConfigService"] },
      maxContextTokens: 800,
      timeoutMs: 80,
    });

    expect(response.trace.outcome).toBe("PARTIAL");
    expect(response.trace.filters).toContainEqual(expect.objectContaining({ reasonCode: "CHANNEL_TIMEOUT" }));
    expect(response.trace.envelope.truncated).toBe(true);
    expect(response.trace.envelope.omitted.length).toBeGreaterThan(0);
    expect(response.trace.envelope.omitted.every((item) => ["TOKEN_BUDGET", "POLICY_FILTERED"].includes(item.reason))).toBe(true);
    for (const prefix of ["RISK_", "AMBIGUITY_", "CONFLICT_", "BUDGET_"]) {
      expect(response.trace.envelope.reasonCodes.some((reason) => reason.startsWith(prefix))).toBe(true);
    }
  });

  it("compares a draft and replays the persisted fixed input without touching the changed source", async () => {
    const selected = asset("knowledge-replay", { symbols: ["ConfigService"] });
    const source = new Source([selected]);
    const policy = policies();
    const store = new InMemoryRetrievalTraceStore();
    const service = new RetrievalQueryService({ source, policies: policy.resolver, traces: store, now: () => new Date(at) });
    const original = await service.search(request(policy.reference("CURRENT"), "request-original"));
    const sourceCallsBeforeReplay = source.calls;
    source.current.splice(0);
    const replay = await service.simulate({
      ...request(policy.reference("REPLAY"), "request-replay"),
      currentPolicy: policy.reference("REPLAY"),
      draftPolicy: policy.reference("DRAFT"),
      fixedInputTraceId: original.trace.traceId,
    });

    expect(replay.current.replayOfTraceId).toBe(original.trace.traceId);
    expect(replay.current.results.map((item) => item.knowledgeId)).toEqual(["knowledge-replay"]);
    expect(replay.draft?.results.map((item) => item.knowledgeId)).toEqual(["knowledge-replay"]);
    expect(replay.comparison).toMatchObject({
      currentTraceId: replay.current.traceId, draftTraceId: replay.draft?.traceId,
    });
    expect(source.calls).toBe(sourceCallsBeforeReplay);
  });

  it("persists complete traces across restart and enforces semantic idempotency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-retrieval-query-"));
    temporaryRoots.push(root);
    const filename = path.join(root, "traces.sqlite");
    const selected = asset("knowledge-persisted", { symbols: ["ConfigService"] });
    const source = new Source([selected]);
    const policy = policies();
    let store = new SqliteRetrievalTraceStore(filename);
    let service = new RetrievalQueryService({ source, policies: policy.resolver, traces: store, now: () => new Date(at) });
    const input = request(policy.reference("CURRENT"), "request-persisted");
    const first = await service.search(input);
    const calls = source.calls;
    const duplicate = await service.search(input);
    expect(duplicate).toEqual(first);
    expect(source.calls).toBe(calls);
    await expect(service.search({ ...input, query: "different semantics" })).rejects.toBeInstanceOf(RetrievalRequestConflictError);
    store.close();

    store = new SqliteRetrievalTraceStore(filename);
    service = new RetrievalQueryService({ source, policies: policy.resolver, traces: store, now: () => new Date(at) });
    expect(service.getTrace(first.trace.traceId)).toEqual(first.trace);
    expect(await service.search(input)).toEqual(first);
    expect(source.calls).toBe(calls);
    store.close();
  });
});
