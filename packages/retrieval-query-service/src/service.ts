import { createHash } from "node:crypto";

import {
  injectionPolicySchema,
  retrievalPolicySchema,
  type InjectionPolicy,
  type RetrievalPolicy,
} from "@zhiloop/config";
import { ContextOrchestrator } from "@zhiloop/context-orchestrator";
import type { ContextEnvelope, ProjectContext } from "@zhiloop/domain";
import { KnowledgeReranker, type KnowledgeRerankResult, type RerankDiagnostic } from "@zhiloop/knowledge-reranker";
import { resolveQueryContext, type QueryContext } from "@zhiloop/query-context";
import {
  MultiChannelRetrievalEngine,
  type KnowledgeRetrievalSource,
  type RetrievalDiagnostic,
  type RetrievalResult,
} from "@zhiloop/retrieval-engine";
import { buildRetrievalTrace, fingerprintRetrievalConfiguration } from "@zhiloop/retrieval-evaluation";

import type {
  ConsoleKnowledgeSearchRequest,
  ConsoleKnowledgeSearchResponse,
  ConsoleRetrievalSimulationRequest,
  ConsoleRetrievalSimulationResponse,
  ConsoleRetrievalTrace,
  ResolvedRetrievalPolicy,
  RetrievalOmissionReason,
  RetrievalPolicyComparison,
  RetrievalPolicyReference,
  RetrievalQueryResponse,
  RetrievalQueryServiceDependencies,
  RetrievalReplayInput,
  RetrievalRunOutcome,
  ShadowDeliveryResult,
  StoredRetrievalOperation,
  TraceFilterDecision,
  TraceOmission,
  TraceResultItem,
} from "./types.js";
import {
  RetrievalPolicyMismatchError,
  RetrievalReplayError,
  RetrievalRequestConflictError,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_QUERY_CHARS = 20_000;
const MAX_RESULTS = 100;
const MAX_CONTEXT_TOKENS = 128_000;
const MAX_TIMEOUT_MS = 120_000;

class QueryDeadlineError extends Error {
  override readonly name = "QueryDeadlineError";
}

class ChannelTimeoutError extends Error {
  override readonly name = "ChannelTimeoutError";
}

interface RunArtifact {
  readonly trace: ConsoleRetrievalTrace;
  readonly replayInput?: RetrievalReplayInput;
}

interface RunIdentity {
  readonly traceId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly replayOfTraceId?: string;
}

interface RunLimits {
  readonly maxResults: number;
  readonly maxContextTokens: number;
  readonly timeoutMs: number;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function rawFingerprint(value: unknown): string {
  return fingerprintRetrievalConfiguration(value).replace(/^sha256:/u, "");
}

export function fingerprintConsoleRetrievalPolicy(
  retrieval: RetrievalPolicy,
  injection: InjectionPolicy,
): string {
  return rawFingerprint({ injection, retrieval });
}

function semanticHash(value: unknown): string {
  return rawFingerprint(value);
}

function derivedId(prefix: "trace" | "run", requestId: string, requestHash: string, lane: string): string {
  const digest = createHash("sha256").update(`${requestId}\0${requestHash}\0${lane}`, "utf8").digest("hex");
  return `${prefix}-${digest.slice(0, 40)}`;
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/[\0\r\n]/gu, " ").slice(0, 500);
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("clock returned an invalid date");
  return value.toISOString();
}

function validateReference(reference: RetrievalPolicyReference): void {
  if (!SAFE_ID.test(reference.policyId) || !Number.isSafeInteger(reference.revision) || reference.revision < 1
    || !HASH.test(reference.fingerprint) || !["CURRENT", "DRAFT", "REPLAY"].includes(reference.source)) {
    throw new Error("retrieval policy reference is invalid");
  }
}

function validateRequest(request: ConsoleKnowledgeSearchRequest | ConsoleRetrievalSimulationRequest): void {
  if (request.schemaVersion !== 1 || !SAFE_ID.test(request.requestId)
    || typeof request.query !== "string" || request.query.length < 1 || request.query.length > MAX_QUERY_CHARS
    || request.query.includes("\0") || !Number.isSafeInteger(request.maxResults)
    || request.maxResults < 1 || request.maxResults > MAX_RESULTS
    || !Number.isSafeInteger(request.maxContextTokens) || request.maxContextTokens < 64
    || request.maxContextTokens > MAX_CONTEXT_TOKENS || !Number.isSafeInteger(request.timeoutMs)
    || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("retrieval request is invalid or exceeds a bounded limit");
  }
}

function sameReference(left: RetrievalPolicyReference, right: RetrievalPolicyReference): boolean {
  return left.policyId === right.policyId && left.revision === right.revision
    && left.fingerprint === right.fingerprint && left.source === right.source;
}

function validateResolved(
  requested: RetrievalPolicyReference,
  value: ResolvedRetrievalPolicy,
): ResolvedRetrievalPolicy {
  validateReference(requested);
  if (!sameReference(requested, value.reference)) {
    throw new RetrievalPolicyMismatchError("policy resolver returned a different policy reference");
  }
  const retrieval = retrievalPolicySchema.parse(value.retrieval);
  const injection = injectionPolicySchema.parse(value.injection);
  if (fingerprintConsoleRetrievalPolicy(retrieval, injection) !== requested.fingerprint) {
    throw new RetrievalPolicyMismatchError("resolved policy content does not match its fingerprint");
  }
  return freeze({ reference: { ...requested }, retrieval, injection });
}

async function withTimeout<T>(operation: () => T | Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChannelTimeoutError(`${label} exceeded its bounded deadline`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class DeadlineBoundRetrievalSource implements KnowledgeRetrievalSource {
  readonly #deadlineAt: number;
  readonly #callTimeoutMs: number;

  constructor(private readonly delegate: KnowledgeRetrievalSource, timeoutMs: number) {
    this.#deadlineAt = performance.now() + timeoutMs;
    this.#callTimeoutMs = Math.max(1, Math.min(2_000, Math.floor(timeoutMs / 4)));
  }

  #remaining(label: string): number {
    const remaining = Math.floor(this.#deadlineAt - performance.now());
    if (remaining < 1) throw new ChannelTimeoutError(`${label} started after the query deadline`);
    return Math.min(remaining, this.#callTimeoutMs);
  }

  listCurrent(): ReturnType<KnowledgeRetrievalSource["listCurrent"]> {
    return withTimeout(() => this.delegate.listCurrent(), this.#remaining("listCurrent"), "listCurrent");
  }

  getCurrent(assetId: string): ReturnType<KnowledgeRetrievalSource["getCurrent"]> {
    return withTimeout(() => this.delegate.getCurrent(assetId), this.#remaining("getCurrent"), "getCurrent");
  }

  searchFts(query: string, limit: number): ReturnType<KnowledgeRetrievalSource["searchFts"]> {
    return withTimeout(() => this.delegate.searchFts(query, limit), this.#remaining("searchFts"), "searchFts");
  }

  related(seedAssetIds: readonly string[], limit: number): ReturnType<KnowledgeRetrievalSource["related"]> {
    return withTimeout(() => this.delegate.related(seedAssetIds, limit), this.#remaining("related"), "related");
  }
}

function queryContext(
  query: string,
  project: ProjectContext | undefined,
  cwd: string | undefined,
  taskId: string | undefined,
  hints: ConsoleKnowledgeSearchRequest["hints"],
): QueryContext {
  return resolveQueryContext({
    prompt: query,
    ...(project === undefined ? {} : { project }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(hints === undefined ? {} : { hints }),
  });
}

function diagnosticDecision(diagnostic: RetrievalDiagnostic): TraceFilterDecision {
  const timedOut = diagnostic.code === "CHANNEL_FAILED" && diagnostic.message.includes("ChannelTimeoutError");
  const reasonCode = timedOut ? "CHANNEL_TIMEOUT" : diagnostic.code === "TOMBSTONE_FILTERED"
    ? "SUPPRESSED" : ["STALE_SOURCE_HIT", "STALE_VECTOR_CHUNK", "VECTOR_VERSION_MISMATCH"].includes(diagnostic.code)
      ? "STALE_VERSION" : diagnostic.code;
  const decision = ["STATUS_FILTERED", "SCOPE_FILTERED", "TOMBSTONE_FILTERED", "STALE_SOURCE_HIT", "STALE_VECTOR_CHUNK"]
    .includes(diagnostic.code) ? "EXCLUDED" as const : "DEGRADED" as const;
  return {
    ...(diagnostic.assetId === undefined ? {} : { assetId: diagnostic.assetId }),
    channel: diagnostic.channel,
    decision,
    reasonCode,
    safeMessage: diagnostic.message,
  };
}

function rerankDecision(diagnostic: RerankDiagnostic): TraceFilterDecision {
  if (diagnostic.code === "DUPLICATE_SUBJECT_REMOVED") return {
    ...(diagnostic.assetId === undefined ? {} : { assetId: diagnostic.assetId }),
    decision: "EXCLUDED",
    reasonCode: "DUPLICATE_SUBJECT",
    safeMessage: diagnostic.message,
  };
  return {
    ...(diagnostic.assetId === undefined ? {} : { assetId: diagnostic.assetId }),
    decision: "DEGRADED",
    reasonCode: diagnostic.code === "TIMEOUT" ? "RERANK_TIMEOUT" : `RERANK_${diagnostic.code}`,
    safeMessage: diagnostic.message,
  };
}

function resultItems(rerank: KnowledgeRerankResult): TraceResultItem[] {
  return rerank.items.map((item) => {
    if (!(["ACCEPTED", "IMPLEMENTED", "VERIFIED"] as readonly string[]).includes(item.asset.status)) {
      throw new Error("rerank returned an ineligible knowledge status");
    }
    return {
      knowledgeId: item.asset.id,
      version: item.asset.version,
      subjectKey: item.asset.subjectKey,
      title: item.asset.title.slice(0, 300),
      summary: item.asset.summary.slice(0, 2_000),
      scope: structuredClone(item.asset.scope),
      status: item.asset.status as TraceResultItem["status"],
      retrievalRank: item.rerank.originalRank,
      finalRank: item.rank,
      rrfScore: item.score,
      contributions: structuredClone(item.contributions),
      rerankReasonCodes: [...item.rerank.reasonCodes],
      evidence: structuredClone(item.asset.evidence),
      sourceEpisodeIds: [...new Set(item.asset.sourceEpisodes)],
    };
  });
}

function detailLimit(level: ContextEnvelope["complexity"]["level"], policy: InjectionPolicy): number {
  switch (level) {
    case "L0_NONE": return 0;
    case "L1_POINTER": return policy.levels.L1_POINTER.maxItems;
    case "L2_COMPACT": return policy.levels.L2_COMPACT.maxItems;
    case "L3_EVIDENCED": return policy.levels.L3_EVIDENCED.maxItems;
    case "L4_EPISODE": return policy.levels.L3_EVIDENCED.maxItems;
  }
}

function allocateTokens(total: number, count: number): number[] {
  if (count === 0) return [];
  const base = Math.floor(total / count);
  let remainder = total - base * count;
  return Array.from({ length: count }, () => base + (remainder-- > 0 ? 1 : 0));
}

function budgetReason(
  envelope: ContextEnvelope,
  policy: InjectionPolicy,
  selectedCount: number,
): RetrievalOmissionReason {
  if (envelope.complexity.reasonCodes.some((reason) => reason.startsWith("TOKEN_BUDGET_"))) return "TOKEN_BUDGET";
  return selectedCount >= detailLimit(envelope.complexity.level, policy) ? "POLICY_FILTERED" : "TOKEN_BUDGET";
}

function envelopeReasonCodes(envelope: ContextEnvelope): string[] {
  return [...new Set([
    "RISK_UNSPECIFIED",
    "AMBIGUITY_ABSENT",
    "CONFLICT_ABSENT",
    envelope.budget.truncated ? "BUDGET_TRUNCATED" : "BUDGET_WITHIN_LIMIT",
    ...envelope.complexity.reasonCodes,
  ])];
}

function outcomeFor(retrieval: RetrievalResult, rerank: KnowledgeRerankResult, selected: number): RetrievalRunOutcome {
  const channelFailure = retrieval.diagnostics.some((item) => item.code === "CHANNEL_FAILED");
  const rerankFailure = rerank.diagnostics.some((item) => ["TIMEOUT", "PORT_ERROR", "INVALID_OUTPUT"].includes(item.code));
  const channelTimeout = retrieval.diagnostics.some((item) => (
    item.code === "CHANNEL_FAILED" && item.message.includes("ChannelTimeoutError")
  ));
  if (selected === 0 && channelTimeout) return "TIMEOUT";
  if (selected === 0) return "NO_CONTEXT";
  return channelFailure || rerankFailure ? "PARTIAL" : "SUCCEEDED";
}

function deliveryFor(outcome: RetrievalRunOutcome, selected: number): {
  readonly result: ShadowDeliveryResult;
  readonly reasonCodes: readonly string[];
} {
  if (outcome === "TIMEOUT") return { result: "TIMEOUT", reasonCodes: ["QUERY_DEADLINE_EXCEEDED", "NO_CODEX_DELIVERY_ATTEMPTED"] };
  if (outcome === "ERROR") return { result: "ERROR", reasonCodes: ["QUERY_PIPELINE_ERROR", "NO_CODEX_DELIVERY_ATTEMPTED"] };
  if (selected === 0) return { result: "NO_CONTEXT", reasonCodes: ["NO_ELIGIBLE_CONTEXT", "NO_CODEX_DELIVERY_ATTEMPTED"] };
  return { result: "SHADOWED", reasonCodes: ["P3_SHADOW_READ_ONLY", "NO_CODEX_DELIVERY_ATTEMPTED"] };
}

function traceOmissions(
  retrieval: RetrievalResult,
  rerank: KnowledgeRerankResult,
  discardedByLimit: KnowledgeRerankResult["items"],
  envelope: ContextEnvelope,
  injection: InjectionPolicy,
): TraceOmission[] {
  const selected = new Set(envelope.items.map((item) => `${item.id}@${item.version}`));
  const omissions = new Map<string, TraceOmission>();
  const omittedReason = budgetReason(envelope, injection, envelope.items.length);
  for (const item of rerank.items) {
    const key = `${item.asset.id}@${item.asset.version}`;
    if (!selected.has(key)) omissions.set(key, { knowledgeId: item.asset.id, version: item.asset.version, reason: omittedReason });
  }
  for (const item of discardedByLimit) {
    const key = `${item.asset.id}@${item.asset.version}`;
    omissions.set(key, { knowledgeId: item.asset.id, version: item.asset.version, reason: "POLICY_FILTERED" });
  }
  for (const diagnostic of rerank.diagnostics) {
    if (diagnostic.code !== "DUPLICATE_SUBJECT_REMOVED" || diagnostic.assetId === undefined) continue;
    const item = retrieval.items.find((candidate) => candidate.asset.id === diagnostic.assetId);
    if (item !== undefined) omissions.set(`${item.asset.id}@${item.asset.version}`, {
      knowledgeId: item.asset.id,
      version: item.asset.version,
      reason: "DUPLICATE_SUBJECT",
    });
  }
  return [...omissions.values()];
}

function failureTrace(
  identity: RunIdentity,
  context: QueryContext,
  policy: RetrievalPolicyReference,
  outcome: "TIMEOUT" | "ERROR",
  error: unknown,
  maxTokens: number,
  durationMs: number,
  createdAt: string,
): ConsoleRetrievalTrace {
  const safe = safeMessage(error);
  return freeze({
    schemaVersion: 1,
    traceId: identity.traceId,
    runId: identity.runId,
    requestId: identity.requestId,
    requestHash: identity.requestHash,
    ...(identity.replayOfTraceId === undefined ? {} : { replayOfTraceId: identity.replayOfTraceId }),
    queryContext: structuredClone(context),
    policy: { ...policy },
    outcome,
    filters: [{
      decision: "DEGRADED",
      reasonCode: outcome === "TIMEOUT" ? "CHANNEL_TIMEOUT" : "QUERY_PIPELINE_ERROR",
      safeMessage: safe,
    }],
    retrievalDiagnostics: [],
    rerankDiagnostics: [],
    results: [],
    envelope: {
      detailLevel: "L0_NONE",
      maxTokens,
      estimatedTokens: 0,
      truncated: outcome === "TIMEOUT",
      selected: [],
      omitted: [],
      reasonCodes: [
        "RISK_UNSPECIFIED", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT",
        outcome === "TIMEOUT" ? "BUDGET_TIMEOUT" : "BUDGET_NOT_EVALUATED",
      ],
    },
    injection: deliveryFor(outcome, 0),
    durationMs,
    createdAt,
  });
}

function compare(current: ConsoleRetrievalTrace, draft: ConsoleRetrievalTrace): RetrievalPolicyComparison {
  const currentSelected = new Set(current.envelope.selected.map((item) => `${item.knowledgeId}@${item.version}`));
  const draftSelected = new Set(draft.envelope.selected.map((item) => `${item.knowledgeId}@${item.version}`));
  return freeze({
    currentTraceId: current.traceId,
    draftTraceId: draft.traceId,
    selectedOnlyByCurrent: [...currentSelected].filter((item) => !draftSelected.has(item)),
    selectedOnlyByDraft: [...draftSelected].filter((item) => !currentSelected.has(item)),
    currentEstimatedTokens: current.envelope.estimatedTokens,
    draftEstimatedTokens: draft.envelope.estimatedTokens,
    tokenDelta: draft.envelope.estimatedTokens - current.envelope.estimatedTokens,
    currentTruncated: current.envelope.truncated,
    draftTruncated: draft.envelope.truncated,
  });
}

function sameReplayIdentity(
  input: RetrievalReplayInput,
  request: ConsoleRetrievalSimulationRequest,
): boolean {
  return input.queryContext.prompt === request.query
    && input.queryContext.project?.projectId === request.project?.projectId
    && input.queryContext.taskId === request.taskId;
}

export class RetrievalQueryService {
  readonly #dependencies: RetrievalQueryServiceDependencies;
  readonly #now: () => Date;

  constructor(dependencies: RetrievalQueryServiceDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date());
  }

  getTrace(traceId: string): ConsoleRetrievalTrace | undefined {
    if (!SAFE_ID.test(traceId)) throw new Error("traceId is invalid");
    return this.#dependencies.traces.getTrace(traceId);
  }

  async #resolve(reference: RetrievalPolicyReference): Promise<ResolvedRetrievalPolicy> {
    return validateResolved(reference, await this.#dependencies.policies.resolve(reference));
  }

  #existing(requestId: string, requestHash: string): RetrievalQueryResponse | undefined {
    const existing = this.#dependencies.traces.getOperation(requestId);
    if (existing === undefined) return undefined;
    if (existing.requestHash !== requestHash) {
      throw new RetrievalRequestConflictError("requestId was already used for different retrieval semantics");
    }
    return existing.response;
  }

  async #pipeline(
    identity: RunIdentity,
    context: QueryContext,
    policy: ResolvedRetrievalPolicy,
    limits: RunLimits,
    fixedRetrieval?: RetrievalResult,
  ): Promise<RunArtifact> {
    const started = performance.now();
    const createdAt = canonicalNow(this.#now);
    const maxTokens = Math.min(limits.maxContextTokens, policy.injection.defaultMaxTokens);
    const work = async (): Promise<RunArtifact> => {
      const retrieval = fixedRetrieval === undefined
        ? await new MultiChannelRetrievalEngine(
          new DeadlineBoundRetrievalSource(this.#dependencies.source, limits.timeoutMs),
          this.#dependencies.vector,
        ).retrieve({ context, policy: policy.retrieval })
        : structuredClone(fixedRetrieval);
      const reranked = await new KnowledgeReranker(this.#dependencies.rerankPort, {
        timeoutMs: Math.min(10_000, limits.timeoutMs),
      }).rerank(context, retrieval.items);
      const kept = reranked.items.slice(0, limits.maxResults).map((item, index) => ({ ...item, rank: index + 1 }));
      const discardedByLimit = reranked.items.slice(limits.maxResults);
      const limitedRerank: KnowledgeRerankResult = { items: kept, diagnostics: reranked.diagnostics };
      const envelope = new ContextOrchestrator().orchestrate({
        runId: identity.runId,
        traceId: identity.traceId,
        queryContext: context,
        candidates: limitedRerank.items,
        policy: policy.injection,
        automatic: false,
        maxTokens,
      });
      const evaluation = buildRetrievalTrace({
        traceId: identity.traceId,
        runId: identity.runId,
        queryContext: context,
        retrieval,
        rerank: limitedRerank,
        envelope,
        signals: { risk: "LOW", ambiguous: false, conflicting: false },
        automatic: false,
      });
      const results = resultItems(limitedRerank);
      const selectedTokens = allocateTokens(envelope.budget.estimatedTokens, envelope.items.length);
      const outcome = outcomeFor(retrieval, limitedRerank, envelope.items.length);
      const filters: TraceFilterDecision[] = [
        ...retrieval.diagnostics.map(diagnosticDecision),
        ...limitedRerank.diagnostics.map(rerankDecision),
        ...discardedByLimit.map((item): TraceFilterDecision => ({
          assetId: item.asset.id,
          decision: "EXCLUDED",
          reasonCode: "POLICY_FILTERED",
          safeMessage: "candidate exceeded the bounded Console result limit",
        })),
        ...results.map((item): TraceFilterDecision => ({
          assetId: item.knowledgeId,
          decision: "INCLUDED",
          reasonCode: "ELIGIBLE_CURRENT_VERSION",
          safeMessage: "candidate passed Scope, status, current-version and rerank checks",
        })),
      ];
      const trace: ConsoleRetrievalTrace = {
        schemaVersion: 1,
        traceId: identity.traceId,
        runId: identity.runId,
        requestId: identity.requestId,
        requestHash: identity.requestHash,
        ...(identity.replayOfTraceId === undefined ? {} : { replayOfTraceId: identity.replayOfTraceId }),
        queryContext: structuredClone(context),
        policy: { ...policy.reference },
        outcome,
        filters,
        retrievalDiagnostics: structuredClone(retrieval.diagnostics),
        rerankDiagnostics: structuredClone(limitedRerank.diagnostics),
        results,
        envelope: {
          detailLevel: envelope.complexity.level === "L4_EPISODE" ? "L3_EVIDENCED" : envelope.complexity.level,
          maxTokens: envelope.budget.maxTokens,
          estimatedTokens: envelope.budget.estimatedTokens,
          truncated: envelope.budget.truncated,
          selected: envelope.items.map((item, index) => ({
            knowledgeId: item.id,
            version: item.version,
            estimatedTokens: selectedTokens[index] ?? 0,
          })),
          omitted: traceOmissions(retrieval, limitedRerank, discardedByLimit, envelope, policy.injection),
          reasonCodes: envelopeReasonCodes(envelope),
        },
        injection: deliveryFor(outcome, envelope.items.length),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        createdAt,
        evaluation,
      };
      return freeze({
        trace,
        replayInput: { schemaVersion: 1, queryContext: structuredClone(context), retrieval: structuredClone(retrieval) },
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new QueryDeadlineError(`query exceeded ${limits.timeoutMs}ms`)), limits.timeoutMs);
        }),
      ]);
    } catch (error) {
      const timedOut = error instanceof QueryDeadlineError || error instanceof ChannelTimeoutError;
      return {
        trace: failureTrace(
          identity,
          context,
          policy.reference,
          timedOut ? "TIMEOUT" : "ERROR",
          error,
          maxTokens,
          Math.max(0, Math.round(performance.now() - started)),
          createdAt,
        ),
        ...(fixedRetrieval === undefined ? {} : {
          replayInput: { schemaVersion: 1, queryContext: structuredClone(context), retrieval: structuredClone(fixedRetrieval) },
        }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #identity(requestId: string, requestHash: string, lane: string, replayOfTraceId?: string): RunIdentity {
    return {
      traceId: derivedId("trace", requestId, requestHash, lane),
      runId: derivedId("run", requestId, requestHash, lane),
      requestId,
      requestHash,
      ...(replayOfTraceId === undefined ? {} : { replayOfTraceId }),
    };
  }

  #commit(operation: StoredRetrievalOperation): RetrievalQueryResponse {
    const status = this.#dependencies.traces.commit(operation);
    if (status === "STORED") return operation.response;
    const stored = this.#dependencies.traces.getOperation(operation.requestId);
    if (stored === undefined || stored.requestHash !== operation.requestHash) {
      throw new RetrievalRequestConflictError("idempotent retrieval operation could not be reloaded");
    }
    return stored.response;
  }

  async search(request: ConsoleKnowledgeSearchRequest): Promise<ConsoleKnowledgeSearchResponse> {
    validateRequest(request);
    validateReference(request.policy);
    if (request.policy.source !== "CURRENT") throw new Error("knowledge search requires a CURRENT policy");
    const requestHash = semanticHash(request);
    const existing = this.#existing(request.requestId, requestHash);
    if (existing !== undefined) {
      if (existing.kind !== "SEARCH") throw new RetrievalRequestConflictError("requestId belongs to a simulation");
      return existing;
    }
    const policy = await this.#resolve(request.policy);
    const context = queryContext(request.query, request.project, request.cwd, request.taskId, request.hints);
    const artifact = await this.#pipeline(
      this.#identity(request.requestId, requestHash, "search"),
      context,
      policy,
      request,
    );
    const response: ConsoleKnowledgeSearchResponse = { schemaVersion: 1, kind: "SEARCH", trace: artifact.trace };
    return this.#commit({
      schemaVersion: 1,
      requestId: request.requestId,
      requestHash,
      response,
      traces: [{ trace: artifact.trace, ...(artifact.replayInput === undefined ? {} : { replayInput: artifact.replayInput }) }],
      createdAt: artifact.trace.createdAt,
    }) as ConsoleKnowledgeSearchResponse;
  }

  async simulate(request: ConsoleRetrievalSimulationRequest): Promise<ConsoleRetrievalSimulationResponse> {
    validateRequest(request);
    validateReference(request.currentPolicy);
    if (request.draftPolicy !== undefined) validateReference(request.draftPolicy);
    if (request.fixedInputTraceId === undefined && request.currentPolicy.source !== "CURRENT") {
      throw new Error("fresh simulation requires a CURRENT policy");
    }
    if (request.fixedInputTraceId !== undefined && request.currentPolicy.source !== "REPLAY") {
      throw new Error("fixed-input replay requires a REPLAY policy");
    }
    if (request.draftPolicy !== undefined && request.draftPolicy.source !== "DRAFT") {
      throw new Error("comparison policy must be DRAFT");
    }
    const requestHash = semanticHash(request);
    const existing = this.#existing(request.requestId, requestHash);
    if (existing !== undefined) {
      if (existing.kind !== "SIMULATION") throw new RetrievalRequestConflictError("requestId belongs to a search");
      return existing;
    }
    const currentPolicy = await this.#resolve(request.currentPolicy);
    const draftPolicy = request.draftPolicy === undefined ? undefined : await this.#resolve(request.draftPolicy);
    let context: QueryContext;
    let fixedInput: RetrievalReplayInput | undefined;
    if (request.fixedInputTraceId !== undefined) {
      if (!SAFE_ID.test(request.fixedInputTraceId)) throw new RetrievalReplayError("fixedInputTraceId is invalid");
      fixedInput = this.#dependencies.traces.getReplayInput(request.fixedInputTraceId);
      if (fixedInput === undefined) throw new RetrievalReplayError("fixed input trace is unavailable or not replayable");
      if (!sameReplayIdentity(fixedInput, request)) {
        throw new RetrievalReplayError("fixed input identity does not match the replay request");
      }
      context = fixedInput.queryContext;
    } else {
      context = queryContext(request.query, request.project, request.cwd, request.taskId, request.hints);
    }
    const current = await this.#pipeline(
      this.#identity(request.requestId, requestHash, "current", request.fixedInputTraceId),
      context,
      currentPolicy,
      request,
      fixedInput?.retrieval,
    );
    const draft = draftPolicy === undefined ? undefined : await this.#pipeline(
      this.#identity(request.requestId, requestHash, "draft", request.fixedInputTraceId),
      context,
      draftPolicy,
      request,
      fixedInput?.retrieval,
    );
    const response: ConsoleRetrievalSimulationResponse = {
      schemaVersion: 1,
      kind: "SIMULATION",
      current: current.trace,
      ...(draft === undefined ? {} : { draft: draft.trace, comparison: compare(current.trace, draft.trace) }),
    };
    const traces: StoredRetrievalOperation["traces"] = [
      { trace: current.trace, ...(current.replayInput === undefined ? {} : { replayInput: current.replayInput }) },
      ...(draft === undefined ? [] : [{
        trace: draft.trace,
        ...(draft.replayInput === undefined ? {} : { replayInput: draft.replayInput }),
      }]),
    ];
    return this.#commit({
      schemaVersion: 1,
      requestId: request.requestId,
      requestHash,
      response,
      traces,
      createdAt: current.trace.createdAt,
    }) as ConsoleRetrievalSimulationResponse;
  }
}
