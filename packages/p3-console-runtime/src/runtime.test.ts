import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { KnowledgeAsset, KnowledgeRelation } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset } from "@zhiloop/knowledge-registry";
import type {
  CodexKnowledgeQueryAnswer,
  CodexKnowledgeQueryModel,
  CodexKnowledgeQueryRequest,
} from "@zhiloop/model-codex-exec";
import {
  fingerprintConsoleRetrievalPolicy,
  InMemoryRetrievalTraceStore,
  type RetrievalPolicyReference,
} from "@zhiloop/retrieval-query-service";
import { describe, expect, it, vi } from "vitest";

import {
  ExplicitP3PolicyResolver,
  InMemoryP3ConsoleOperationStore,
  P3ConsoleRuntime,
  P3PolicyConsumerUnavailableError,
  P3RequestCancelledError,
  P3SemanticConflictError,
  P3TraceUnavailableError,
  RegistryRetrievalSourceError,
  SqliteRegistryKnowledgeRetrievalSource,
  SqliteP3ConsoleOperationStore,
  p3SimulationResponseSchema,
  type ExplicitP3PolicyRevision,
  type RegistryProjectionReadPort,
} from "./index.js";

const at = "2026-08-04T00:00:00.000Z";
const retrieval = structuredClone(DEFAULT_CONFIGURATION.retrieval);
const injection = structuredClone(DEFAULT_CONFIGURATION.injection);
const fingerprint = fingerprintConsoleRetrievalPolicy(retrieval, injection);

function reference(source: RetrievalPolicyReference["source"], policyId = `policy-${source.toLowerCase()}`): RetrievalPolicyReference {
  return { policyId, revision: 7, fingerprint, source };
}

function policy(
  source: RetrievalPolicyReference["source"],
  codexState: "READY" | "NOT_CONFIGURED" = "READY",
): ExplicitP3PolicyRevision {
  return {
    reference: reference(source), retrieval, injection,
    consumers: {
      RETRIEVAL: { state: "READY", reasonCode: "RETRIEVAL_COMPOSED", evidenceRefs: ["cap-retrieval"] },
      CODEX_QUERY: {
        state: codexState,
        reasonCode: codexState === "READY" ? "CODEX_QUERY_COMPOSED" : "CODEX_QUERY_NOT_CONFIGURED",
        evidenceRefs: ["cap-codex-query"],
      },
    },
  };
}

function projected(id: string, overrides: Partial<KnowledgeAsset> = {}, tombstone = false): ProjectedKnowledgeAsset {
  return {
    asset: {
      schemaVersion: 1,
      id,
      subjectKey: `test.p3.${id.replaceAll("_", "-")}`,
      kind: "IMPLEMENTATION",
      scope: { level: "PROJECT", projectId: "project-a" },
      version: 1,
      status: "VERIFIED",
      title: `Title ${id}`,
      summary: `Summary ${id}`,
      body: `Body ${id}`,
      aliases: [],
      keywords: [],
      applicability: [],
      nonApplicability: [],
      symbols: ["ConfigService"],
      relations: [],
      evidence: [{ evidenceId: `ev-${id}`, verdict: "SUPPORTS" }],
      confidence: 1,
      sourceEpisodes: [`episode-${id}`],
      contentHash: `hash-${id}`,
      correlationId: `correlation-${id}`,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    },
    tombstone,
    ...(tombstone ? { tombstoneReason: "suppressed" } : {}),
    indexVersion: 1,
  };
}

class Projection implements RegistryProjectionReadPort {
  readonly values = new Map<string, ProjectedKnowledgeAsset>();
  readonly fts: KnowledgeAsset[] = [];
  readonly relations = new Map<string, readonly KnowledgeRelation[]>();
  calls = 0;
  fail = false;

  constructor(values: readonly ProjectedKnowledgeAsset[]) {
    for (const value of values) this.values.set(value.asset.id, value);
    this.fts.push(...values.map((item) => item.asset));
  }

  listAssets(options: { readonly limit?: number; readonly offset?: number; readonly includeTombstones?: boolean } = {}): readonly ProjectedKnowledgeAsset[] {
    this.calls += 1;
    if (this.fail) throw new Error("secret-hidden-asset-id");
    const values = [...this.values.values()].filter((item) => options.includeTombstones === true || !item.tombstone);
    return values.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  getAsset(assetId: string, includeTombstone = false): ProjectedKnowledgeAsset | undefined {
    this.calls += 1;
    if (this.fail) throw new Error(`secret-${assetId}`);
    const value = this.values.get(assetId);
    return value?.tombstone === true && !includeTombstone ? undefined : value;
  }

  search(_query: string, options: { readonly limit?: number } = {}) {
    this.calls += 1;
    if (this.fail) throw new Error("secret-search-id");
    return this.fts.filter((asset) => {
      const current = this.values.get(asset.id);
      return current?.tombstone !== true && ["ACCEPTED", "IMPLEMENTED", "VERIFIED"].includes(asset.status);
    }).slice(0, options.limit ?? 20).map((asset, index) => ({
      asset, rank: index + 1, score: 10 - index, indexVersion: 1,
    }));
  }

  getRelations(assetId: string, version: number) {
    this.calls += 1;
    if (this.fail) throw new Error(`secret-relation-${assetId}`);
    return { assetId, assetVersion: version, relations: this.relations.get(assetId) ?? [] };
  }
}

function request(requestId = "request-search-001", policyReference = reference("CURRENT")) {
  return {
    schemaVersion: 1,
    requestId,
    type: "knowledge.search",
    mode: "SEARCH_ONLY",
    query: "Find symbol ConfigService",
    projectId: "project-a",
    taskId: "task-a",
    repositoryRoot: "/workspace/project-a",
    cwd: "/workspace/project-a",
    hints: { symbols: ["ConfigService"] },
    policy: policyReference,
    maxResults: 20,
    maxContextTokens: 800,
    timeoutMs: 1_000,
  } as const;
}

function runtime(
  projection: Projection,
  model?: CodexKnowledgeQueryModel,
  revisions: readonly ExplicitP3PolicyRevision[] = [policy("CURRENT"), policy("DRAFT"), policy("REPLAY")],
) {
  return new P3ConsoleRuntime({
    projection,
    policies: new ExplicitP3PolicyResolver(revisions),
    traces: new InMemoryRetrievalTraceStore(),
    ...(model === undefined ? {} : { model }),
    operations: new InMemoryP3ConsoleOperationStore(),
    now: () => new Date(at),
  });
}

class Model implements CodexKnowledgeQueryModel {
  calls = 0;
  last?: CodexKnowledgeQueryRequest;
  constructor(private readonly answerer: (request: CodexKnowledgeQueryRequest) => Promise<CodexKnowledgeQueryAnswer>) {}
  async answer(input: CodexKnowledgeQueryRequest): Promise<CodexKnowledgeQueryAnswer> {
    this.calls += 1;
    this.last = input;
    return await this.answerer(input);
  }
}

function cited(input: CodexKnowledgeQueryRequest): CodexKnowledgeQueryAnswer {
  const text = "ConfigService is verified.";
  const knowledge = input.retrievedKnowledge[0] as NonNullable<(typeof input.retrievedKnowledge)[number]>;
  return {
    schemaVersion: 1,
    queryId: input.queryId,
    retrievalTraceId: input.retrievalTraceId,
    modelRunId: "model-run-cited",
    outcome: "SUCCEEDED",
    model: "codex-test",
    answer: text,
    factualSpans: [{ start: 0, end: text.length }],
    citations: [{
      knowledgeId: knowledge.knowledgeId,
      version: knowledge.version,
      answerSpans: [{ start: 0, end: text.length }],
      evidenceIds: [knowledge.evidenceIds[0] as string],
    }],
    unknowns: [], conflicts: [], latencyMs: 3, usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe("SqliteRegistryKnowledgeRetrievalSource", () => {
  it("enforces current status and Scope before exposing any asset identity", () => {
    const visible = projected("visible");
    const otherProject = projected("other-project", { scope: { level: "PROJECT", projectId: "project-b" } });
    const wrongTask = projected("other-task", { scope: { level: "TASK", projectId: "project-a", taskId: "task-b" } });
    const user = projected("user-private", { scope: { level: "USER", userId: "user-a" } });
    const stale = projected("stale", { status: "STALE" });
    const tombstone = projected("suppressed", {}, true);
    const projection = new Projection([visible, otherProject, wrongTask, user, stale, tombstone]);
    const source = new SqliteRegistryKnowledgeRetrievalSource(projection, {
      projectId: "project-a", taskId: "task-a", allowGlobalKnowledge: true,
    });

    expect(source.listCurrent().map((item) => item.asset.id)).toEqual(["visible"]);
    expect(source.searchFts("ConfigService", 20).map((item) => item.asset.asset.id)).toEqual(["visible"]);
    for (const id of ["other-project", "other-task", "user-private", "stale", "suppressed"]) {
      expect(source.getCurrent(id)).toBeUndefined();
    }
  });

  it("returns only visible current relation targets and hides underlying error details", () => {
    const seed = projected("seed");
    const related = projected("related");
    const hidden = projected("hidden", { scope: { level: "PROJECT", projectId: "project-b" } });
    const projection = new Projection([seed, related, hidden]);
    projection.relations.set("seed", [
      { type: "RELATED_TO", targetId: "hidden" },
      { type: "RELATED_TO", targetId: "related", targetVersion: 1 },
    ]);
    const source = new SqliteRegistryKnowledgeRetrievalSource(projection, {
      projectId: "project-a", allowGlobalKnowledge: true,
    });
    expect(source.related(["seed"], 10).map((item) => item.asset.asset.id)).toEqual(["related"]);
    projection.fail = true;
    expect(() => source.listCurrent()).toThrowError(RegistryRetrievalSourceError);
    expect(() => source.listCurrent()).toThrowError("registry current listing failed");
  });

  it("rejects unanchored global/task boundaries and invalid bounds", () => {
    const projection = new Projection([]);
    expect(() => new SqliteRegistryKnowledgeRetrievalSource(projection, { taskId: "task-a", allowGlobalKnowledge: false })).toThrow();
    expect(() => new SqliteRegistryKnowledgeRetrievalSource(projection, { allowGlobalKnowledge: true })).toThrow();
    const source = new SqliteRegistryKnowledgeRetrievalSource(projection, { allowGlobalKnowledge: false });
    expect(() => source.searchFts("query", 0)).toThrow();
    expect(() => source.related(Array.from({ length: 101 }, (_, i) => `seed-${i}`), 10)).toThrow();
    expect(source.getCurrent("")).toBeUndefined();
  });

  it("covers anchored GLOBAL, TASK, MODULE and SYMBOL visibility and stale relation versions", () => {
    const values = [
      projected("global", { scope: { level: "GLOBAL" } }),
      projected("task", { scope: { level: "TASK", projectId: "project-a", taskId: "task-a" } }),
      projected("module", { scope: { level: "MODULE", projectId: "project-a", modulePaths: ["src"] } }),
      projected("symbol", { scope: { level: "SYMBOL", projectId: "project-a", symbols: ["ConfigService"] } }),
      projected("wrong-version"),
    ];
    const projection = new Projection(values);
    projection.relations.set("task", [
      { type: "RELATED_TO", targetId: "wrong-version", targetVersion: 2 },
      { type: "RELATED_TO", targetId: "global" },
    ]);
    const source = new SqliteRegistryKnowledgeRetrievalSource(projection, {
      projectId: "project-a", taskId: "task-a", allowGlobalKnowledge: true,
    });
    expect(source.listCurrent().map((item) => item.asset.id)).toEqual(["global", "task", "module", "symbol", "wrong-version"]);
    expect(source.related(["missing-seed", "task"], 5).map((item) => item.asset.asset.id)).toEqual(["global"]);
  });
});

describe("ExplicitP3PolicyResolver", () => {
  it("binds explicit revisions, fingerprints, consumer states and duplicate identities", () => {
    const resolver = new ExplicitP3PolicyResolver([policy("CURRENT", "NOT_CONFIGURED")]);
    expect(resolver.resolve(reference("CURRENT")).reference).toEqual(reference("CURRENT"));
    expect(() => resolver.requireReady(reference("CURRENT"), "CODEX_QUERY")).toThrowError(P3PolicyConsumerUnavailableError);
    expect(() => new ExplicitP3PolicyResolver([{ ...policy("CURRENT"), reference: { ...reference("CURRENT"), fingerprint: "0".repeat(64) } }])).toThrow("fingerprint");
    expect(() => new ExplicitP3PolicyResolver([policy("CURRENT"), policy("CURRENT")])).toThrow("duplicate");
    expect(() => new ExplicitP3PolicyResolver([])).toThrow("required");
    expect(() => new ExplicitP3PolicyResolver([{ ...policy("CURRENT"), consumers: {
      ...policy("CURRENT").consumers,
      RETRIEVAL: { state: "READY", reasonCode: "bad", evidenceRefs: [] },
    } }])).toThrow("capability");
    expect(() => resolver.capability(reference("DRAFT"), "RETRIEVAL")).toThrow("unavailable");
  });
});

describe("P3ConsoleRuntime", () => {
  it("strictly parses search and maps a complete SHADOW control-api trace", async () => {
    const projection = new Projection([projected("knowledge-search")]);
    const service = runtime(projection);
    const response = await service.search(request());
    expect(response.trace.results[0]).toMatchObject({
      knowledgeId: "knowledge-search", scope: "PROJECT", status: "VERIFIED", authority: "ADVISORY",
    });
    expect(response.trace.injectionResult).toBe("SHADOWED");
    expect(response.trace.queryContext.promptFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await expect(service.search({ ...request("request-invalid-001"), unexpected: true })).rejects.toThrow();
    await expect(service.search({ ...request("request-invalid-policy"), policy: reference("DRAFT") })).rejects.toThrow();
  });

  it("simulates current/draft policy and returns comparable strict traces", async () => {
    const service = runtime(new Projection([projected("knowledge-simulate")]));
    const base = request("request-simulate-001");
    const response = await service.simulate({
      schemaVersion: base.schemaVersion,
      requestId: base.requestId,
      type: "retrieval.simulate",
      query: base.query,
      projectId: base.projectId,
      taskId: base.taskId,
      repositoryRoot: base.repositoryRoot,
      cwd: base.cwd,
      hints: base.hints,
      currentPolicy: reference("CURRENT"),
      draftPolicy: reference("DRAFT"),
      maxResults: base.maxResults,
      maxContextTokens: base.maxContextTokens,
      timeoutMs: base.timeoutMs,
    });
    expect(response.kind).toBe("SIMULATION");
    expect(response.draft?.policy.source).toBe("DRAFT");
    expect(response.comparison?.currentTraceId).toBe(response.current.traceId);
    expect(() => p3SimulationResponseSchema.parse({ ...response, comparison: undefined })).toThrow();
  });

  it("supports a current-only simulation and a projectless no-context search", async () => {
    const service = runtime(new Projection([projected("knowledge-current-only")]));
    const base = request("request-simulate-current");
    const simulation = await service.simulate({
      schemaVersion: 1,
      requestId: base.requestId,
      type: "retrieval.simulate",
      query: base.query,
      projectId: base.projectId,
      currentPolicy: reference("CURRENT"),
      maxResults: base.maxResults,
      maxContextTokens: base.maxContextTokens,
      timeoutMs: base.timeoutMs,
    });
    expect(simulation.draft).toBeUndefined();
    expect(simulation.comparison).toBeUndefined();

    const noProject = await service.search({
      schemaVersion: 1,
      requestId: "request-no-project",
      type: "knowledge.search",
      mode: "SEARCH_ONLY",
      query: "unanchored query",
      policy: reference("CURRENT"),
      maxResults: 10,
      maxContextTokens: 200,
      timeoutMs: 100,
    });
    expect(noProject.trace.results).toEqual([]);
    expect(noProject.trace.queryContext.projectId).toBeUndefined();
  });

  it("protects trace lookup with the original project and task boundary", async () => {
    const service = runtime(new Projection([projected("knowledge-trace") ]));
    const search = await service.search(request("request-trace-001"));
    expect(service.trace({ schemaVersion: 1, type: "retrieval.trace", traceId: search.trace.traceId, projectId: "project-a", taskId: "task-a" })).toEqual(search.trace);
    expect(() => service.trace({ schemaVersion: 1, type: "retrieval.trace", traceId: search.trace.traceId, projectId: "project-b", taskId: "task-a" })).toThrowError(P3TraceUnavailableError);
    expect(() => service.trace({ schemaVersion: 1, type: "retrieval.trace", traceId: search.trace.traceId, projectId: "project-a" })).toThrowError(P3TraceUnavailableError);
    expect(() => service.trace({ schemaVersion: 1, type: "retrieval.trace", traceId: "trace-does-not-exist", projectId: "project-a" })).toThrowError(P3TraceUnavailableError);
  });

  it("asks Codex with only selected eligible current knowledge and accepts fully cited facts", async () => {
    const visible = projected("knowledge-cited");
    const hidden = projected("knowledge-hidden", { scope: { level: "PROJECT", projectId: "project-b" } });
    const model = new Model(async (input) => cited(input));
    const service = runtime(new Projection([visible, hidden]), model);
    const response = await service.ask({
      ...request("request-ask-cited"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
    });
    expect(response.answer.outcome).toBe("SUCCEEDED");
    expect(response.answer.citations).toEqual([expect.objectContaining({ knowledgeId: "knowledge-cited", version: 1 })]);
    expect(model.last?.retrievedKnowledge).toEqual([expect.objectContaining({
      knowledgeId: "knowledge-cited", content: "Body knowledge-cited", eligible: true,
    })]);
  });

  it("maps all supported Scope and authority categories without creating an ACTIVE result", async () => {
    const projection = new Projection([
      projected("rule", { kind: "RULE", scope: { level: "GLOBAL" } }),
      projected("decision", { kind: "DECISION", scope: { level: "TASK", projectId: "project-a", taskId: "task-a" } }),
      projected("fact", { kind: "FACT", scope: { level: "SYMBOL", projectId: "project-a", symbols: ["ConfigService"] } }),
      projected("requirement", { kind: "REQUIREMENT", scope: { level: "MODULE", projectId: "project-a", modulePaths: ["src"] } }),
    ]);
    const response = await runtime(projection).search(request("request-authorities"));
    expect(new Map(response.trace.results.map((item) => [item.knowledgeId, item.authority]))).toEqual(new Map([
      ["rule", "NORMATIVE"], ["decision", "INFORMATIVE"], ["fact", "INFORMATIVE"], ["requirement", "NORMATIVE"],
    ]));
    expect(response.trace.injectionResult).not.toBe("INJECTED");
  });

  it("deterministically falls back for invalid citations, absent model and non-ready capability", async () => {
    const invalid = new Model(async (input) => ({
      ...cited(input), citations: [{ knowledgeId: "forbidden", version: 1, answerSpans: [{ start: 0, end: 26 }], evidenceIds: [] }],
    }));
    const first = await runtime(new Projection([projected("knowledge-invalid")]), invalid).ask({
      ...request("request-ask-invalid"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
    });
    expect(first.answer).toMatchObject({ outcome: "FALLBACK_SEARCH", answer: "", factualSpans: [], citations: [] });

    const badEvidence = new Model(async (input) => {
      const result = cited(input);
      return { ...result, citations: result.citations.map((citation) => ({ ...citation, evidenceIds: ["ev-not-eligible"] })) };
    });
    const evidenceFallback = await runtime(new Projection([projected("knowledge-evidence")]), badEvidence).ask({
      ...request("request-ask-bad-evidence"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
    });
    expect(evidenceFallback.answer.outcome).toBe("FALLBACK_SEARCH");

    const modelFallback = new Model(async (input) => ({
      schemaVersion: 1, queryId: input.queryId, retrievalTraceId: input.retrievalTraceId,
      modelRunId: "model-run-fallback", outcome: "FALLBACK_SEARCH", answer: "", factualSpans: [], citations: [],
      unknowns: ["unavailable"], conflicts: [], latencyMs: 1, usage: {},
    }));
    const explicitFallback = await runtime(new Projection([projected("knowledge-model-fallback")]), modelFallback).ask({
      ...request("request-ask-model-fallback"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
    });
    expect(explicitFallback.answer.outcome).toBe("FALLBACK_SEARCH");

    const undeclaredFact = new Model(async (input) => ({
      ...cited(input), answer: "Undeclared factual content.", factualSpans: [], citations: [],
    }));
    const undeclaredFallback = await runtime(new Projection([projected("knowledge-undeclared")]), undeclaredFact).ask({
      ...request("request-ask-undeclared"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
    });
    expect(undeclaredFallback.answer.outcome).toBe("FALLBACK_SEARCH");

    const absent = await runtime(new Projection([projected("knowledge-absent")])).ask({
      ...request("request-ask-absent"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
    });
    expect(absent.answer.unknowns).toEqual(["Codex query model is not configured."]);

    const neverCalled = new Model(async (input) => cited(input));
    const disabled = await runtime(
      new Projection([projected("knowledge-disabled")]), neverCalled, [policy("CURRENT", "NOT_CONFIGURED")],
    ).ask({ ...request("request-ask-disabled"), type: "knowledge.ask", mode: "CODEX_ASSISTED" });
    expect(disabled.answer.outcome).toBe("FALLBACK_SEARCH");
    expect(disabled.answer.unknowns[0]).toContain("NOT_CONFIGURED");
    expect(neverCalled.calls).toBe(0);
  });

  it("does not call Codex when all knowledge is stale, suppressed or out of Scope", async () => {
    const model = new Model(async (input) => cited(input));
    const projection = new Projection([
      projected("stale-only", { status: "STALE" }),
      projected("suppressed-only", {}, true),
      projected("other-project-only", { scope: { level: "PROJECT", projectId: "project-b" } }),
    ]);
    const response = await runtime(projection, model).ask({
      ...request("request-ask-no-context"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
    });
    expect(response.trace.results).toEqual([]);
    expect(response.answer.outcome).toBe("FALLBACK_SEARCH");
    expect(model.calls).toBe(0);
  });

  it("bounds a hung Codex call and exposes explicit cancellation", async () => {
    const hanging = new Model(async () => await new Promise<CodexKnowledgeQueryAnswer>(() => undefined));
    const timed = await runtime(new Projection([projected("knowledge-timeout")]), hanging).ask({
      ...request("request-ask-timeout"), type: "knowledge.ask", mode: "CODEX_ASSISTED", timeoutMs: 20,
    });
    expect(timed.answer.outcome).toBe("FALLBACK_SEARCH");
    expect(timed.answer.unknowns[0]).toContain("deadline");

    const controller = new AbortController();
    const cancelledPromise = runtime(new Projection([projected("knowledge-cancel")]), hanging).ask({
      ...request("request-ask-cancel"), type: "knowledge.ask", mode: "CODEX_ASSISTED", timeoutMs: 1_000,
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const cancelled = await cancelledPromise;
    expect(cancelled.answer.outcome).toBe("CANCELLED");

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(runtime(new Projection([projected("knowledge-pre-cancel")])).search(
      request("request-search-cancel"), { signal: alreadyCancelled.signal },
    )).rejects.toThrowError(P3RequestCancelledError);
  });

  it("deduplicates identical requests and rejects completed or in-flight semantic conflicts", async () => {
    let resolveAnswer: (() => void) | undefined;
    const deferred = new Model(async (input) => await new Promise<CodexKnowledgeQueryAnswer>((resolve) => {
      resolveAnswer = () => resolve(cited(input));
    }));
    const service = runtime(new Projection([projected("knowledge-idempotent")]), deferred);
    const ask = { ...request("request-idempotent"), type: "knowledge.ask" as const, mode: "CODEX_ASSISTED" as const };
    const first = service.ask(ask);
    await vi.waitFor(() => expect(deferred.calls).toBe(1));
    const duplicate = service.ask(ask);
    await expect(service.ask({ ...ask, query: "different semantics" })).rejects.toThrowError(P3SemanticConflictError);
    resolveAnswer?.();
    expect(await duplicate).toEqual(await first);
    expect(deferred.calls).toBe(1);
    expect(await service.ask(ask)).toEqual(await first);
    await expect(service.search({ ...request("request-idempotent"), query: "other kind" })).rejects.toThrowError(P3SemanticConflictError);
  });
});

describe("InMemoryP3ConsoleOperationStore", () => {
  it("returns immutable copies, handles idempotency and rejects hash conflicts", async () => {
    const response = await runtime(new Projection([projected("knowledge-store")])).search(request("request-store-source"));
    const store = new InMemoryP3ConsoleOperationStore();
    const operation = {
      schemaVersion: 1 as const,
      requestId: "request-store",
      requestHash: "a".repeat(64),
      response,
      createdAt: at,
    };
    expect(store.commit(operation)).toBe("STORED");
    expect(store.commit(operation)).toBe("IDEMPOTENT");
    expect(store.get(operation.requestId)).toEqual(operation);
    expect(() => store.commit({ ...operation, requestHash: "b".repeat(64) })).toThrowError(P3SemanticConflictError);
  });
});

describe("SqliteP3ConsoleOperationStore", () => {
  it("reopens and replays a completed ASK without invoking Codex again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-p3-operation-"));
    const filename = path.join(root, "operations.sqlite");
    try {
      const projection = new Projection([projected("knowledge-durable")]);
      const firstModel = new Model(async (input) => cited(input));
      let store = new SqliteP3ConsoleOperationStore(filename);
      const firstRuntime = new P3ConsoleRuntime({
        projection,
        policies: new ExplicitP3PolicyResolver([policy("CURRENT")]),
        traces: new InMemoryRetrievalTraceStore(),
        model: firstModel,
        operations: store,
        now: () => new Date(at),
      });
      const input = { ...request("request-durable-ask"), type: "knowledge.ask" as const, mode: "CODEX_ASSISTED" as const };
      const first = await firstRuntime.ask(input);
      expect(firstModel.calls).toBe(1);
      store.close();

      const secondModel = new Model(async () => { throw new Error("Codex must not run during durable replay"); });
      store = new SqliteP3ConsoleOperationStore(filename);
      const secondRuntime = new P3ConsoleRuntime({
        projection,
        policies: new ExplicitP3PolicyResolver([policy("CURRENT")]),
        traces: new InMemoryRetrievalTraceStore(),
        model: secondModel,
        operations: store,
        now: () => new Date(at),
      });
      expect(await secondRuntime.ask(input)).toEqual(first);
      expect(secondModel.calls).toBe(0);
      const persisted = store.get(input.requestId) as NonNullable<ReturnType<typeof store.get>>;
      expect(store.commit(persisted)).toBe("IDEMPOTENT");
      expect(() => store.commit({
        schemaVersion: 1,
        requestId: input.requestId,
        requestHash: "e".repeat(64),
        response: first,
        createdAt: at,
      })).toThrowError(P3SemanticConflictError);
      store.close();

      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      const database = new DatabaseSync(filename, { readOnly: true });
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(database.prepare("PRAGMA table_list('p3_console_operations')").get()).toMatchObject({ strict: 1 });
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid durable paths, metadata, ASK binding and use after close", async () => {
    expect(() => new SqliteP3ConsoleOperationStore(":memory:")).toThrow("durable");
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-p3-invalid-"));
    try {
      const filename = path.join(root, "operations.sqlite");
      const store = new SqliteP3ConsoleOperationStore(filename);
      const response = await runtime(new Projection([projected("knowledge-invalid-store")])).search(request("request-invalid-store-source"));
      expect(() => store.commit({
        schemaVersion: 1, requestId: "request-invalid-store", requestHash: "bad", response, createdAt: at,
      })).toThrow("metadata");
      const askResponse = await runtime(new Projection([projected("knowledge-ask-binding")]), new Model(async (input) => cited(input))).ask({
        ...request("request-binding-source"), type: "knowledge.ask", mode: "CODEX_ASSISTED",
      });
      expect(() => store.commit({
        schemaVersion: 1,
        requestId: "request-different-binding",
        requestHash: "a".repeat(64),
        response: askResponse,
        createdAt: at,
      })).toThrow("not bound");
      store.close();
      store.close();
      expect(() => store.get("request-invalid-store")).toThrow("closed");
      expect(() => store.commit({
        schemaVersion: 1, requestId: "request-invalid-store", requestHash: "a".repeat(64), response, createdAt: at,
      })).toThrow("closed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
