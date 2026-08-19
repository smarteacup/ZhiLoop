import { createHash } from "node:crypto";

import {
  codexKnowledgeAnswerSchema,
  retrievalTraceSchema,
  type CodexKnowledgeAnswerContract,
  type RetrievalTraceContract,
} from "@zhiloop/control-api";
import type { ProjectContext } from "@zhiloop/domain";
import type { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import type {
  CodexKnowledgeQueryAnswer,
  CodexKnowledgeQueryContext,
  CodexKnowledgeQueryModel,
  EligibleRetrievedKnowledge,
} from "@zhiloop/model-codex-exec";
import {
  RetrievalQueryService,
  type ConsoleRetrievalSimulationResponse,
  type ConsoleRetrievalTrace,
  type RetrievalPolicyReference,
  type RetrievalTraceStore,
  type TraceResultItem,
} from "@zhiloop/retrieval-query-service";

import {
  p3AskRequestSchema,
  p3AskResponseSchema,
  p3SearchRequestSchema,
  p3SearchResponseSchema,
  p3SimulationRequestSchema,
  p3SimulationResponseSchema,
  p3TraceRequestSchema,
  type P3AskResponse,
  type P3RuntimeResponse,
  type P3SearchResponse,
  type P3SimulationResponse,
  type P3TraceRequest,
} from "./contracts.js";
import {
  InMemoryP3ConsoleOperationStore,
  P3SemanticConflictError,
  type P3ConsoleOperationStore,
} from "./operation-store.js";
import { P3PolicyConsumerUnavailableError } from "./policy.js";
import type { ExplicitP3PolicyResolver } from "./policy.js";
import {
  SqliteRegistryKnowledgeRetrievalSource,
  type RegistryProjectionReadPort,
  type RegistryRetrievalBoundary,
} from "./registry-source.js";

interface AbortOptions {
  readonly signal?: AbortSignal;
}

export interface P3ConsoleRuntimeDependencies {
  readonly projection: RegistryProjectionReadPort;
  readonly policies: ExplicitP3PolicyResolver;
  readonly traces: RetrievalTraceStore;
  readonly model?: CodexKnowledgeQueryModel;
  readonly operations?: P3ConsoleOperationStore;
  readonly resolveProject?: (input: {
    readonly projectId?: string | undefined;
    readonly repositoryRoot?: string | undefined;
    readonly cwd?: string | undefined;
  }) => ProjectContext | undefined | Promise<ProjectContext | undefined>;
  readonly now?: () => Date;
}

export class P3RequestCancelledError extends Error {
  override readonly name = "P3RequestCancelledError";
}

export class P3TraceUnavailableError extends Error {
  override readonly name = "P3TraceUnavailableError";
}

const HASH = /^[a-f0-9]{64}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function semanticHash(kind: string, value: unknown): string {
  return sha256(JSON.stringify({ kind, value }));
}

function internalRequestId(kind: string, requestId: string): string {
  return `p3-${kind}-${sha256(requestId).slice(0, 40)}`;
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("P3 runtime clock returned an invalid date");
  return value.toISOString();
}

function project(input: { readonly projectId?: string | undefined; readonly repositoryRoot?: string | undefined }): ProjectContext | undefined {
  if (input.projectId === undefined) return undefined;
  return {
    projectId: input.projectId,
    ...(input.repositoryRoot === undefined ? {} : { repositoryRoot: input.repositoryRoot }),
    portable: input.repositoryRoot === undefined,
  };
}

function boundary(input: { readonly projectId?: string | undefined; readonly taskId?: string | undefined }): RegistryRetrievalBoundary {
  return {
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    allowGlobalKnowledge: input.projectId !== undefined,
  };
}

function queryHints(input: {
  readonly hints?: {
    readonly paths?: readonly string[] | undefined;
    readonly symbols?: readonly string[] | undefined;
    readonly errorCodes?: readonly string[] | undefined;
    readonly configKeys?: readonly string[] | undefined;
  } | undefined;
}): {
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly errorCodes?: readonly string[];
  readonly configKeys?: readonly string[];
} | undefined {
  if (input.hints === undefined) return undefined;
  return {
    ...(input.hints.paths === undefined ? {} : { paths: input.hints.paths }),
    ...(input.hints.symbols === undefined ? {} : { symbols: input.hints.symbols }),
    ...(input.hints.errorCodes === undefined ? {} : { errorCodes: input.hints.errorCodes }),
    ...(input.hints.configKeys === undefined ? {} : { configKeys: input.hints.configKeys }),
  };
}

function authority(item: TraceResultItem, source: SqliteRegistryKnowledgeRetrievalSource): RetrievalTraceContract["results"][number]["authority"] {
  const asset = source.getCurrent(item.knowledgeId)?.asset;
  if (asset === undefined || asset.version !== item.version) throw new Error("retrieval trace referenced unavailable current knowledge");
  if (asset.kind === "RULE" || asset.kind === "REQUIREMENT") return "NORMATIVE";
  if (asset.kind === "DECISION" || asset.kind === "FACT" && asset.status === "VERIFIED") return "INFORMATIVE";
  return "ADVISORY";
}

function queryContext(trace: ConsoleRetrievalTrace): RetrievalTraceContract["queryContext"] {
  const context = trace.queryContext;
  return {
    prompt: context.prompt,
    promptFingerprint: sha256(context.prompt),
    ...(context.project === undefined ? {} : { projectId: context.project.projectId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.project?.repositoryRoot === undefined ? {} : { repositoryRoot: context.project.repositoryRoot }),
    ...(context.project?.branch === undefined ? {} : { branch: context.project.branch }),
    ...(context.project?.revision === undefined ? {} : {
      commit: context.project.revision.commit,
      dirty: context.project.revision.dirty,
    }),
    paths: context.paths.map((item) => item.canonical),
    symbols: context.symbols.map((item) => item.canonical),
    errorCodes: context.errorCodes.map((item) => item.canonical),
    configKeys: context.configKeys.map((item) => item.canonical),
    allowProjectKnowledge: context.retrievalBoundary.allowProjectKnowledge,
    allowGlobalKnowledge: context.retrievalBoundary.allowGlobalKnowledge,
    reasonCodes: [...context.reasonCodes],
  };
}

function mapTrace(
  trace: ConsoleRetrievalTrace,
  source: SqliteRegistryKnowledgeRetrievalSource,
): RetrievalTraceContract {
  const mapped: RetrievalTraceContract = {
    schemaVersion: 1,
    traceId: trace.traceId,
    runId: trace.runId,
    ...(trace.replayOfTraceId === undefined ? {} : { replayOfTraceId: trace.replayOfTraceId }),
    queryContext: queryContext(trace),
    scenarios: trace.scenarioDirectory.map((item) => ({
      ...item,
      knowledgePointers: [...item.knowledgePointers],
      taskIntents: [...item.taskIntents],
      entryPoints: [...item.entryPoints],
    })),
    policy: { ...trace.policy },
    outcome: trace.outcome,
    filters: trace.filters.map((item) => ({ ...item })),
    results: trace.results.map((item) => {
      if (!["TASK", "SYMBOL", "MODULE", "PROJECT", "GLOBAL"].includes(item.scope.level)) {
        throw new Error("retrieval trace contained a non-console Scope");
      }
      return {
        knowledgeId: item.knowledgeId,
        version: item.version,
        title: item.title,
        summary: item.summary,
        scope: item.scope.level as "TASK" | "SYMBOL" | "MODULE" | "PROJECT" | "GLOBAL",
        status: item.status,
        authority: authority(item, source),
        evidenceIds: [...new Set(item.evidence.map((evidence) => evidence.evidenceId))],
        sourceEpisodeIds: [...new Set(item.sourceEpisodeIds)],
        retrievalRank: item.retrievalRank,
        finalRank: item.finalRank,
        rrfScore: item.rrfScore,
        contributions: item.contributions.map((contribution) => ({
          channel: contribution.channel,
          rank: contribution.rank,
          rawScore: contribution.contribution,
          contribution: contribution.contribution,
          reason: contribution.reason,
        })),
        rerankReasonCodes: [...new Set(item.rerankReasonCodes)],
      };
    }),
    envelope: {
      ...trace.envelope,
      selected: trace.envelope.selected.map((item) => ({ ...item })),
      omitted: trace.envelope.omitted.map((item) => ({ ...item })),
      reasonCodes: [...trace.envelope.reasonCodes],
    },
    injectionResult: trace.injection.result,
    durationMs: trace.durationMs,
    createdAt: trace.createdAt,
  };
  return retrievalTraceSchema.parse(mapped);
}

function assertTraceBoundary(trace: ConsoleRetrievalTrace, request: P3TraceRequest): void {
  const traceProjectId = trace.queryContext.project?.projectId;
  if (traceProjectId !== request.projectId
    || trace.queryContext.taskId !== request.taskId) {
    throw new P3TraceUnavailableError("retrieval trace is unavailable");
  }
}

function answerContext(trace: RetrievalTraceContract): CodexKnowledgeQueryContext {
  return {
    prompt: trace.queryContext.prompt,
    promptFingerprint: trace.queryContext.promptFingerprint,
    ...(trace.queryContext.projectId === undefined ? {} : { projectId: trace.queryContext.projectId }),
    ...(trace.queryContext.taskId === undefined ? {} : { taskId: trace.queryContext.taskId }),
    ...(trace.queryContext.repositoryRoot === undefined ? {} : { repositoryRoot: trace.queryContext.repositoryRoot }),
    paths: [...trace.queryContext.paths],
    symbols: [...trace.queryContext.symbols],
    errorCodes: [...trace.queryContext.errorCodes],
    configKeys: [...trace.queryContext.configKeys],
    allowProjectKnowledge: trace.queryContext.allowProjectKnowledge,
    allowGlobalKnowledge: trace.queryContext.allowGlobalKnowledge,
    reasonCodes: [...trace.queryContext.reasonCodes],
  };
}

function eligibleKnowledge(
  trace: RetrievalTraceContract,
  source: SqliteRegistryKnowledgeRetrievalSource,
): readonly EligibleRetrievedKnowledge[] {
  const results = new Map(trace.results.map((item) => [`${item.knowledgeId}@${item.version}`, item]));
  return trace.envelope.selected.flatMap((selected) => {
    const key = `${selected.knowledgeId}@${selected.version}`;
    const result = results.get(key);
    const current = source.getCurrent(selected.knowledgeId);
    if (result === undefined || current === undefined || current.asset.version !== selected.version
      || !["ACCEPTED", "IMPLEMENTED", "VERIFIED"].includes(current.asset.status)) return [];
    return [{
      knowledgeId: current.asset.id,
      version: current.asset.version,
      title: current.asset.title,
      content: current.asset.body,
      evidenceIds: [...new Set(current.asset.evidence.map((item) => item.evidenceId))],
      eligible: true as const,
    }];
  });
}

function validModelAnswer(
  answer: CodexKnowledgeQueryAnswer,
  queryId: string,
  traceId: string,
  eligible: readonly EligibleRetrievedKnowledge[],
): CodexKnowledgeAnswerContract | undefined {
  if (answer.queryId !== queryId || answer.retrievalTraceId !== traceId || answer.outcome !== "SUCCEEDED") return undefined;
  const allowed = new Map(eligible.map((item) => [`${item.knowledgeId}@${item.version}`, new Set(item.evidenceIds)]));
  if (answer.citations.some((citation) => {
    const evidence = allowed.get(`${citation.knowledgeId}@${citation.version}`);
    return evidence === undefined || citation.evidenceIds.some((id) => !evidence.has(id));
  })) return undefined;
  const parsed = codexKnowledgeAnswerSchema.safeParse(answer);
  if (!parsed.success) return undefined;
  const uncoveredContent = [...parsed.data.answer].some((character, index) => (
    character.trim().length > 0
    && !parsed.data.factualSpans.some((span) => span.start <= index && span.end > index)
  ));
  return uncoveredContent ? undefined : parsed.data;
}

function fallbackAnswer(
  requestId: string,
  traceId: string,
  outcome: "FALLBACK_SEARCH" | "CANCELLED",
  reason: string,
  latencyMs = 0,
): CodexKnowledgeAnswerContract {
  return codexKnowledgeAnswerSchema.parse({
    schemaVersion: 1,
    queryId: requestId,
    retrievalTraceId: traceId,
    outcome,
    answer: "",
    factualSpans: [],
    citations: [],
    unknowns: [reason],
    conflicts: [],
    latencyMs: Math.max(0, Math.round(latencyMs)),
    usage: {},
  });
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await operation;
  if (signal.aborted) throw new P3RequestCancelledError("P3 request was cancelled");
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new P3RequestCancelledError("P3 request was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

export class P3ConsoleRuntime {
  readonly #operations: P3ConsoleOperationStore;
  readonly #now: () => Date;
  readonly #inflight = new Map<string, { readonly requestHash: string; readonly promise: Promise<P3RuntimeResponse> }>();

  constructor(private readonly dependencies: P3ConsoleRuntimeDependencies) {
    this.#operations = dependencies.operations ?? new InMemoryP3ConsoleOperationStore();
    this.#now = dependencies.now ?? (() => new Date());
  }

  #source(input: { readonly projectId?: string | undefined; readonly taskId?: string | undefined }): SqliteRegistryKnowledgeRetrievalSource {
    return new SqliteRegistryKnowledgeRetrievalSource(this.dependencies.projection, boundary(input));
  }

  async #project(input: {
    readonly projectId?: string | undefined;
    readonly repositoryRoot?: string | undefined;
    readonly cwd?: string | undefined;
  }): Promise<ProjectContext | undefined> {
    return this.dependencies.resolveProject === undefined
      ? project(input)
      : await this.dependencies.resolveProject(input);
  }

  #retrieval(source: SqliteRegistryKnowledgeRetrievalSource): RetrievalQueryService {
    return new RetrievalQueryService({
      source,
      policies: this.dependencies.policies,
      traces: this.dependencies.traces,
      now: this.#now,
    });
  }

  async #idempotent<T extends P3RuntimeResponse>(
    requestId: string,
    requestHash: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!HASH.test(requestHash)) throw new Error("P3 request hash is invalid");
    const stored = this.#operations.get(requestId);
    if (stored !== undefined) {
      if (stored.requestHash !== requestHash) throw new P3SemanticConflictError("requestId was already used for different P3 semantics");
      return stored.response as T;
    }
    const running = this.#inflight.get(requestId);
    if (running !== undefined) {
      if (running.requestHash !== requestHash) throw new P3SemanticConflictError("requestId is in flight with different P3 semantics");
      return await running.promise as T;
    }
    const promise = action().then((response) => {
      const operation = {
        schemaVersion: 1 as const,
        requestId,
        requestHash,
        response,
        createdAt: canonicalNow(this.#now),
      };
      const status = this.#operations.commit(operation);
      if (status === "STORED") return response;
      const reloaded = this.#operations.get(requestId);
      if (reloaded === undefined || reloaded.requestHash !== requestHash) {
        throw new P3SemanticConflictError("idempotent P3 operation could not be reloaded");
      }
      return reloaded.response as T;
    }).finally(() => this.#inflight.delete(requestId));
    this.#inflight.set(requestId, { requestHash, promise });
    return await promise;
  }

  async search(input: unknown, options: AbortOptions = {}): Promise<P3SearchResponse> {
    const request = p3SearchRequestSchema.parse(input);
    const requestHash = semanticHash("SEARCH", request);
    return await this.#idempotent(request.requestId, requestHash, async () => {
      const resolvedProject = await this.#project(request);
      const source = this.#source({ projectId: resolvedProject?.projectId, taskId: request.taskId });
      const resolvedHints = queryHints(request);
      const result = await raceAbort(this.#retrieval(source).search({
        schemaVersion: 1,
        requestId: internalRequestId("search", request.requestId),
        query: request.query,
        ...(resolvedProject === undefined ? {} : { project: resolvedProject }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(resolvedHints === undefined ? {} : { hints: resolvedHints }),
        policy: request.policy,
        maxResults: request.maxResults,
        maxContextTokens: request.maxContextTokens,
        timeoutMs: request.timeoutMs,
      }), options.signal);
      return p3SearchResponseSchema.parse({ schemaVersion: 1, kind: "SEARCH", trace: mapTrace(result.trace, source) });
    });
  }

  async simulate(input: unknown, options: AbortOptions = {}): Promise<P3SimulationResponse> {
    const request = p3SimulationRequestSchema.parse(input);
    const requestHash = semanticHash("SIMULATION", request);
    return await this.#idempotent(request.requestId, requestHash, async () => {
      const resolvedProject = await this.#project(request);
      const source = this.#source({ projectId: resolvedProject?.projectId, taskId: request.taskId });
      const resolvedHints = queryHints(request);
      const result = await raceAbort(this.#retrieval(source).simulate({
        schemaVersion: 1,
        requestId: internalRequestId("simulate", request.requestId),
        query: request.query,
        ...(resolvedProject === undefined ? {} : { project: resolvedProject }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(resolvedHints === undefined ? {} : { hints: resolvedHints }),
        currentPolicy: request.currentPolicy,
        ...(request.draftPolicy === undefined ? {} : { draftPolicy: request.draftPolicy }),
        ...(request.fixedInputTraceId === undefined ? {} : { fixedInputTraceId: request.fixedInputTraceId }),
        maxResults: request.maxResults,
        maxContextTokens: request.maxContextTokens,
        timeoutMs: request.timeoutMs,
      }), options.signal);
      return this.#mapSimulation(result, source);
    });
  }

  #mapSimulation(
    result: ConsoleRetrievalSimulationResponse,
    source: SqliteRegistryKnowledgeRetrievalSource,
  ): P3SimulationResponse {
    return p3SimulationResponseSchema.parse({
      schemaVersion: 1,
      kind: "SIMULATION",
      current: mapTrace(result.current, source),
      ...(result.draft === undefined ? {} : { draft: mapTrace(result.draft, source) }),
      ...(result.comparison === undefined ? {} : { comparison: structuredClone(result.comparison) }),
    });
  }

  trace(input: unknown): RetrievalTraceContract {
    const request = p3TraceRequestSchema.parse(input);
    const trace = this.dependencies.traces.getTrace(request.traceId);
    if (trace === undefined) throw new P3TraceUnavailableError("retrieval trace is unavailable");
    assertTraceBoundary(trace, request);
    return mapTrace(trace, this.#source(request));
  }

  async ask(input: unknown, options: AbortOptions = {}): Promise<P3AskResponse> {
    const request = p3AskRequestSchema.parse(input);
    const requestHash = semanticHash("ASK", request);
    return await this.#idempotent(request.requestId, requestHash, async () => {
      const resolvedProject = await this.#project(request);
      const source = this.#source({ projectId: resolvedProject?.projectId, taskId: request.taskId });
      const started = performance.now();
      const resolvedHints = queryHints(request);
      const retrieval = await raceAbort(this.#retrieval(source).search({
        schemaVersion: 1,
        requestId: internalRequestId("ask", request.requestId),
        query: request.query,
        ...(resolvedProject === undefined ? {} : { project: resolvedProject }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(resolvedHints === undefined ? {} : { hints: resolvedHints }),
        policy: request.policy,
        maxResults: request.maxResults,
        maxContextTokens: request.maxContextTokens,
        timeoutMs: request.timeoutMs,
      }), options.signal);
      const trace = mapTrace(retrieval.trace, source);
      const knowledge = eligibleKnowledge(trace, source);
      let answer: CodexKnowledgeAnswerContract;
      if (knowledge.length === 0 || retrieval.trace.outcome === "TIMEOUT" || retrieval.trace.outcome === "ERROR") {
        answer = fallbackAnswer(request.requestId, trace.traceId, "FALLBACK_SEARCH", "No eligible retrieved knowledge was available for a cited answer.");
      } else if (this.dependencies.model === undefined) {
        answer = fallbackAnswer(request.requestId, trace.traceId, "FALLBACK_SEARCH", "Codex query model is not configured.");
      } else {
        try {
          this.dependencies.policies.requireReady(request.policy, "CODEX_QUERY");
          const controller = new AbortController();
          const remaining = Math.max(1, request.timeoutMs - Math.round(performance.now() - started));
          const timer = setTimeout(() => controller.abort("TIMEOUT"), remaining);
          const signal = options.signal === undefined
            ? controller.signal
            : AbortSignal.any([options.signal, controller.signal]);
          try {
            const model = await raceAbort(this.dependencies.model.answer({
              queryId: request.requestId,
              retrievalTraceId: trace.traceId,
              question: request.query,
              queryContext: answerContext(trace),
              retrievedKnowledge: knowledge,
              signal,
            }), signal);
            answer = validModelAnswer(model, request.requestId, trace.traceId, knowledge)
              ?? fallbackAnswer(request.requestId, trace.traceId, "FALLBACK_SEARCH", "Codex returned an invalid or uncited answer.", performance.now() - started);
          } catch {
            answer = fallbackAnswer(
              request.requestId,
              trace.traceId,
              options.signal?.aborted === true ? "CANCELLED" : "FALLBACK_SEARCH",
              options.signal?.aborted === true ? "Codex query was cancelled." : "Codex query was unavailable or exceeded its deadline.",
              performance.now() - started,
            );
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          if (!(error instanceof P3PolicyConsumerUnavailableError)) throw error;
          answer = fallbackAnswer(request.requestId, trace.traceId, "FALLBACK_SEARCH", `Codex query is ${error.state}: ${error.reasonCode}.`);
        }
      }
      return p3AskResponseSchema.parse({ schemaVersion: 1, kind: "ASK", trace, answer });
    });
  }
}

export type { SqliteKnowledgeRegistryProjection, RetrievalPolicyReference };
