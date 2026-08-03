import {
  CONFIGURATION_HTTP_PATHS,
  SSE_EVENT_TYPES,
  type CONTROL_ERROR_CODES,
  capabilityPageSchema,
  captureCommitResultSchema,
  capturePreviewSchema,
  configurationMutationResultSchema,
  configurationStateSchema,
  configurationValidationResultSchema,
  controlResponseSchema,
  diagnosticsSchema,
  eventMetadataPageSchema,
  jobPageSchema,
  jobCommandResultSchema,
  overviewSchema,
  sseInvalidationEventSchema,
  sessionDetailSchema,
  sessionPageSchema,
  type Diagnostics,
  type Overview,
  type CaptureCommitResult,
  type CapturePreview,
  type ConfigurationMutationResult,
  type ConfigurationState,
  type ConfigurationValidationResult,
  type SseInvalidationEvent,
  type JobCommandResult,
  type SessionDetail,
  type SessionSummary,
} from "@zhiloop/control-api";
import { z } from "zod";
import {
  sessionExtractionViewSchema,
  knowledgeListViewSchema,
  knowledgeDetailViewSchema,
  knowledgeEditImpactSchema,
} from "./p2.js";
import type {
  KnowledgeDetailView,
  KnowledgeEditCommand,
  KnowledgeEditImpact,
  KnowledgeFilter,
  KnowledgeLifecycleCommand,
  KnowledgeListView,
  SessionExtractionView,
  StartSessionExtractionCommand,
} from "./p2.js";
import {
  p3ConsoleAskResponseSchema,
  p3ConsoleSearchResponseSchema,
  p3ConsoleSimulationResponseSchema,
  toRetrievalTraceView,
  type KnowledgeAskView,
  type KnowledgeSearchCommand,
  type RetrievalSimulationView,
  type RetrievalTraceView,
} from "./p3.js";
import { retrievalTraceSchema } from "@zhiloop/control-api";
import {
  closureRunListViewSchema,
  closureRunViewSchema,
  feedbackReceiptSchema,
  feedbackTargetViewSchema,
  highRiskGovernanceViewSchema,
  highRiskPreviewViewSchema,
  highRiskReceiptSchema,
  rolloutViewSchema,
  sessionInjectionViewSchema,
  type ClosureRunView,
  type FeedbackCommand,
  type FeedbackReceipt,
  type FeedbackTargetView,
  type HighRiskCommitCommand,
  type HighRiskGovernanceView,
  type HighRiskPreviewCommand,
  type HighRiskPreviewView,
  type HighRiskReceipt,
  type RolloutView,
  type SessionInjectionView,
} from "./p4.js";
import {
  p4WireCapabilityListSchema,
  p4WireClosurePageSchema,
  p4WireClosureSchema,
  p4WireFeedbackResponseSchema,
  p4WireHighRiskCommitSchema,
  p4WireHighRiskPreviewSchema,
  p4WireInjectionPageSchema,
  p4WireMcpPageSchema,
  p4WireRolloutSchema,
  type P4WireClosure,
  type P4WireInjection,
} from "./p4-wire.js";

export interface ConsoleApi {
  overview(signal?: AbortSignal): Promise<Overview>;
  capabilities(signal?: AbortSignal): Promise<z.infer<typeof capabilityPageSchema>>;
  sessions(signal?: AbortSignal): Promise<z.infer<typeof sessionPageSchema>>;
  session(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>;
  events(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<z.infer<typeof eventMetadataPageSchema>>;
  jobs(signal?: AbortSignal): Promise<z.infer<typeof jobPageSchema>>;
  cancelJob?(command: JobOperatorCommand, signal?: AbortSignal): Promise<JobCommandResult>;
  retryJob?(command: JobOperatorCommand, signal?: AbortSignal): Promise<JobCommandResult>;
  diagnostics(signal?: AbortSignal): Promise<Diagnostics>;
  previewCapture(sessionId: string, signal?: AbortSignal): Promise<CapturePreview>;
  commitCapture(command: CaptureCommitCommand, signal?: AbortSignal): Promise<CaptureCommitResult>;
  configuration?(projectId?: string, signal?: AbortSignal): Promise<ConfigurationState>;
  validateConfiguration?(command: ConfigurationDraftCommand, signal?: AbortSignal): Promise<ConfigurationValidationResult>;
  activateConfiguration?(command: ConfigurationActivateCommand, signal?: AbortSignal): Promise<ConfigurationMutationResult>;
  rollbackConfiguration?(command: ConfigurationRollbackCommand, signal?: AbortSignal): Promise<ConfigurationMutationResult>;
  openInvalidations?(handlers: InvalidationHandlers, signal?: AbortSignal): InvalidationSubscription;
  pollInvalidations?(afterRevision: number, signal?: AbortSignal): Promise<InvalidationPollResult>;
  sessionExtraction?(sessionId: string, signal?: AbortSignal): Promise<SessionExtractionView>;
  startSessionExtraction?(command: StartSessionExtractionCommand, signal?: AbortSignal): Promise<SessionExtractionView>;
  commitSessionExtraction?(command: { readonly sessionId: string; readonly previewId: string; readonly expectedPreviewRevision: number; readonly idempotencyKey: string }, signal?: AbortSignal): Promise<SessionExtractionView>;
  knowledgeList?(filter: KnowledgeFilter, signal?: AbortSignal): Promise<KnowledgeListView>;
  knowledgeDetail?(knowledgeId: string, signal?: AbortSignal): Promise<KnowledgeDetailView>;
  previewKnowledgeEdit?(command: KnowledgeEditCommand, signal?: AbortSignal): Promise<KnowledgeEditImpact>;
  commitKnowledgeEdit?(command: KnowledgeEditCommand, signal?: AbortSignal): Promise<KnowledgeDetailView>;
  suppressKnowledge?(command: KnowledgeLifecycleCommand, signal?: AbortSignal): Promise<KnowledgeDetailView>;
  restoreKnowledge?(command: KnowledgeLifecycleCommand, signal?: AbortSignal): Promise<KnowledgeDetailView>;
  searchKnowledge?(command: KnowledgeSearchCommand, signal?: AbortSignal): Promise<RetrievalTraceView>;
  askZhiLoop?(command: KnowledgeSearchCommand, signal?: AbortSignal): Promise<KnowledgeAskView>;
  simulateRetrieval?(command: KnowledgeSearchCommand, signal?: AbortSignal): Promise<RetrievalSimulationView>;
  retrievalTrace?(traceId: string, scope?: { readonly projectId?: string; readonly taskId?: string }, signal?: AbortSignal): Promise<RetrievalTraceView>;
  sessionInjections?(sessionId: string, signal?: AbortSignal): Promise<SessionInjectionView>;
  closureRuns?(sessionId?: string, signal?: AbortSignal): Promise<z.infer<typeof closureRunListViewSchema>>;
  closureRun?(sessionId: string, closureRunId: string, signal?: AbortSignal): Promise<ClosureRunView>;
  feedbackTargets?(sessionId: string, signal?: AbortSignal): Promise<readonly FeedbackTargetView[]>;
  recordFeedback?(command: FeedbackCommand, signal?: AbortSignal): Promise<FeedbackReceipt>;
  rollout?(signal?: AbortSignal): Promise<RolloutView>;
  highRiskGovernance?(signal?: AbortSignal): Promise<HighRiskGovernanceView>;
  previewHighRisk?(command: HighRiskPreviewCommand, signal?: AbortSignal): Promise<HighRiskPreviewView>;
  commitHighRisk?(command: HighRiskCommitCommand, signal?: AbortSignal): Promise<HighRiskReceipt>;
}

export interface CaptureCommitCommand {
  readonly sessionId: string;
  readonly previewRevision: number;
  readonly transcriptIdentityHash: string;
  readonly idempotencyKey: string;
}

export interface JobOperatorCommand {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface ConfigurationDraftCommand {
  readonly baseRevision: number;
  readonly scope: "GLOBAL" | "PROJECT";
  readonly projectId?: string;
  readonly draft: Readonly<Record<string, unknown>>;
}

export interface ConfigurationActivateCommand {
  readonly expectedRevision: number;
  readonly draftRevision: number;
  readonly idempotencyKey: string;
}

export interface ConfigurationRollbackCommand {
  readonly expectedRevision: number;
  readonly targetRevision: number;
  readonly idempotencyKey: string;
}

export interface InvalidationPollResult {
  readonly currentRevision: number;
  readonly oldestRetainedRevision: number;
  readonly requestedAfterRevision: number;
  readonly nextRevision: number;
  readonly resyncRequired: boolean;
  readonly hasMore: boolean;
  readonly events: readonly SseInvalidationEvent[];
  readonly retryAfterMs: number;
}

export interface InvalidationHandlers {
  readonly onOpen: () => void;
  readonly onEvent: (event: SseInvalidationEvent) => void;
  readonly onError: (error: Error) => void;
}

export interface InvalidationSubscription {
  close(): void;
}

const invalidationPollResultSchema = z.strictObject({
  currentRevision: z.number().int().nonnegative(),
  oldestRetainedRevision: z.number().int().nonnegative(),
  requestedAfterRevision: z.number().int().nonnegative(),
  nextRevision: z.number().int().nonnegative(),
  resyncRequired: z.boolean(),
  hasMore: z.boolean(),
  events: z.array(sseInvalidationEventSchema).max(200).readonly(),
  retryAfterMs: z.number().int().min(250).max(60_000),
});
const p4FeedbackTargetsResponseSchema = z.strictObject({ items: z.array(feedbackTargetViewSchema).max(500).readonly() });

type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export class ConsoleApiError extends Error {
  public readonly code: ControlErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ControlErrorCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConsoleApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

let csrfToken: string | undefined;

export function setCsrfToken(value: string): void {
  if (!/^[A-Za-z0-9._:-]{16,500}$/u.test(value)) throw new Error("invalid CSRF token");
  csrfToken = value;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { readonly signal?: AbortSignal | undefined; readonly body?: Readonly<Record<string, unknown>> } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (csrfToken !== undefined) headers["x-zhiloop-csrf"] = csrfToken;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      credentials: "same-origin",
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(options.body === undefined ? {} : { method: "POST", body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw new ConsoleApiError("SIDECAR_UNAVAILABLE", "ZhiLoop 本地控制服务不可用", true, { cause: error });
  }
  let envelope: z.infer<typeof controlResponseSchema>;
  try {
    envelope = controlResponseSchema.parse(await response.json());
  } catch (error) {
    throw new ConsoleApiError("INTERNAL_ERROR", "控制服务返回了无效响应", false, { cause: error });
  }
  if (!envelope.ok) throw new ConsoleApiError(envelope.error.code, envelope.error.message, envelope.error.retryable);
  try {
    return schema.parse(envelope.result);
  } catch (error) {
    throw new ConsoleApiError("INTERNAL_ERROR", "控制服务响应不符合协议", false, { cause: error });
  }
}

function openInvalidations(handlers: InvalidationHandlers, signal?: AbortSignal): InvalidationSubscription {
  if (typeof EventSource === "undefined") {
    queueMicrotask(() => handlers.onError(new Error("EventSource is unavailable")));
    return Object.freeze({ close: () => undefined });
  }
  const source = new EventSource("/api/v1/invalidations", { withCredentials: true });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };
  source.onopen = () => { if (!closed) handlers.onOpen(); };
  source.onerror = () => { if (!closed) handlers.onError(new Error("SSE invalidation stream is unavailable")); };
  for (const eventType of SSE_EVENT_TYPES) {
    source.addEventListener(eventType, (event) => {
      if (closed) return;
      try {
        const message = event as MessageEvent<string>;
        handlers.onEvent(sseInvalidationEventSchema.parse(JSON.parse(message.data) as unknown));
      } catch {
        handlers.onError(new Error("SSE invalidation event is invalid"));
      }
    });
  }
  if (signal?.aborted === true) close();
  else signal?.addEventListener("abort", close, { once: true });
  return Object.freeze({ close });
}

export const browserConsoleApi: ConsoleApi = Object.freeze({
  overview: async (signal?: AbortSignal) => await request("/overview", overviewSchema, { signal }),
  capabilities: async (signal?: AbortSignal) => await request("/capabilities", capabilityPageSchema, { signal }),
  sessions: async (signal?: AbortSignal) => await request("/sessions", sessionPageSchema, { signal }),
  session: async (sessionId: string, signal?: AbortSignal) => await request(`/sessions/${encodeURIComponent(sessionId)}`, sessionDetailSchema, { signal }),
  events: async (sessionId: string, cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ sessionId });
    if (cursor !== undefined) query.set("cursor", cursor);
    return await request(`/events?${query.toString()}`, eventMetadataPageSchema, { signal });
  },
  jobs: async (signal?: AbortSignal) => await request("/jobs", jobPageSchema, { signal }),
  cancelJob: async (command: JobOperatorCommand, signal?: AbortSignal) => await request(
    `/jobs/${encodeURIComponent(command.jobId)}/cancel`,
    jobCommandResultSchema,
    { signal, body: { expectedRevision: command.expectedRevision, idempotencyKey: command.idempotencyKey } },
  ),
  retryJob: async (command: JobOperatorCommand, signal?: AbortSignal) => await request(
    `/jobs/${encodeURIComponent(command.jobId)}/retry`,
    jobCommandResultSchema,
    { signal, body: { expectedRevision: command.expectedRevision, idempotencyKey: command.idempotencyKey } },
  ),
  diagnostics: async (signal?: AbortSignal) => await request("/diagnostics", diagnosticsSchema, { signal }),
  previewCapture: async (sessionId: string, signal?: AbortSignal) => {
    const result = await request(
      "/capture-jobs",
      capturePreviewSchema,
      { signal, body: { sessionId, dryRun: true } },
    );
    if (result.sessionId !== sessionId) {
      throw new ConsoleApiError("INTERNAL_ERROR", "采集预览与当前会话不匹配", false);
    }
    return result;
  },
  commitCapture: async (command: CaptureCommitCommand, signal?: AbortSignal) => {
    const result = await request(
      "/capture-jobs",
      captureCommitResultSchema,
      {
        signal,
        body: {
          sessionId: command.sessionId,
          dryRun: false,
          previewRevision: command.previewRevision,
          transcriptIdentityHash: command.transcriptIdentityHash,
          idempotencyKey: command.idempotencyKey,
        },
      },
    );
    if (result.sessionId !== command.sessionId || result.previewRevision !== command.previewRevision) {
      throw new ConsoleApiError("INTERNAL_ERROR", "采集结果与已确认预览不匹配", false);
    }
    return result;
  },
  configuration: async (projectId?: string, signal?: AbortSignal) => {
    const query = projectId === undefined ? "" : `?${new URLSearchParams({ projectId }).toString()}`;
    return await request(`/configuration${query}`, configurationStateSchema, { signal });
  },
  validateConfiguration: async (command: ConfigurationDraftCommand, signal?: AbortSignal) => await request(
    CONFIGURATION_HTTP_PATHS.draft,
    configurationValidationResultSchema,
    {
      signal,
      body: {
        baseRevision: command.baseRevision,
        scope: command.scope,
        ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
        draft: command.draft,
      },
    },
  ),
  activateConfiguration: async (command: ConfigurationActivateCommand, signal?: AbortSignal) => await request(
    CONFIGURATION_HTTP_PATHS.activate,
    configurationMutationResultSchema,
    { signal, body: { ...command } },
  ),
  rollbackConfiguration: async (command: ConfigurationRollbackCommand, signal?: AbortSignal) => await request(
    CONFIGURATION_HTTP_PATHS.rollback,
    configurationMutationResultSchema,
    { signal, body: { ...command } },
  ),
  openInvalidations,
  pollInvalidations: async (afterRevision: number, signal?: AbortSignal) => {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new Error("afterRevision is invalid");
    const query = new URLSearchParams({ afterRevision: String(afterRevision), limit: "100" });
    return await request(`/invalidations/poll?${query.toString()}`, invalidationPollResultSchema, { signal });
  },
  sessionExtraction: async (sessionId: string, signal?: AbortSignal) => await request(
    `/sessions/${encodeURIComponent(sessionId)}/extraction`, sessionExtractionViewSchema, { signal },
  ),
  startSessionExtraction: async (command: StartSessionExtractionCommand, signal?: AbortSignal) => await request(
    `/sessions/${encodeURIComponent(command.sessionId)}/extraction/preview`, sessionExtractionViewSchema,
    { signal, body: { expectedRevision: command.expectedRevision, idempotencyKey: command.idempotencyKey } },
  ),
  commitSessionExtraction: async (command: { readonly sessionId: string; readonly previewId: string; readonly expectedPreviewRevision: number; readonly idempotencyKey: string }, signal?: AbortSignal) => await request(
    `/sessions/${encodeURIComponent(command.sessionId)}/extraction/commit`, sessionExtractionViewSchema,
    { signal, body: { previewId: command.previewId, expectedPreviewRevision: command.expectedPreviewRevision, idempotencyKey: command.idempotencyKey } },
  ),
  knowledgeList: async (filter: KnowledgeFilter, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, String(value));
    return await request(`/knowledge${query.size === 0 ? "" : `?${query.toString()}`}`, knowledgeListViewSchema, { signal });
  },
  knowledgeDetail: async (knowledgeId: string, signal?: AbortSignal) => await request(`/knowledge/${encodeURIComponent(knowledgeId)}`, knowledgeDetailViewSchema, { signal }),
  previewKnowledgeEdit: async (command: KnowledgeEditCommand, signal?: AbortSignal) => await request(
    `/knowledge/${encodeURIComponent(command.knowledgeId)}/edit-preview`, knowledgeEditImpactSchema,
    { signal, body: { expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, draft: command.draft } },
  ),
  commitKnowledgeEdit: async (command: KnowledgeEditCommand, signal?: AbortSignal) => await request(
    `/knowledge/${encodeURIComponent(command.knowledgeId)}/edit-commit`, knowledgeDetailViewSchema,
    { signal, body: { expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, draft: command.draft } },
  ),
  suppressKnowledge: async (command: KnowledgeLifecycleCommand, signal?: AbortSignal) => await request(
    `/knowledge/${encodeURIComponent(command.knowledgeId)}/suppress`, knowledgeDetailViewSchema,
    { signal, body: { expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, reason: command.reason } },
  ),
  restoreKnowledge: async (command: KnowledgeLifecycleCommand, signal?: AbortSignal) => await request(
    `/knowledge/${encodeURIComponent(command.knowledgeId)}/restore`, knowledgeDetailViewSchema,
    { signal, body: { expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, reason: command.reason } },
  ),
  searchKnowledge: async (command: KnowledgeSearchCommand, signal?: AbortSignal) => {
    const response = await request("/retrieval/search", p3ConsoleSearchResponseSchema, {
      signal,
      body: retrievalQueryBody(command),
    });
    return toRetrievalTraceView(response.trace);
  },
  askZhiLoop: async (command: KnowledgeSearchCommand, signal?: AbortSignal) => {
    const response = await request("/retrieval/ask", p3ConsoleAskResponseSchema, {
      signal,
      body: retrievalQueryBody(command, 120_000),
    });
    return Object.freeze({
      outcome: response.answer.outcome,
      answer: response.answer.answer,
      citations: Object.freeze(response.answer.citations.map((item) => Object.freeze({
        knowledgeId: item.knowledgeId,
        version: item.version,
        answerSpans: Object.freeze(item.answerSpans.map((span) => Object.freeze({ ...span }))),
      }))),
      unknowns: Object.freeze([...response.answer.unknowns]),
      conflicts: Object.freeze(response.answer.conflicts.map((item) => Object.freeze({
        summary: item.summary,
        knowledgeVersions: Object.freeze(item.knowledgeVersions.map((version) => Object.freeze({ ...version }))),
      }))),
      retrieval: toRetrievalTraceView(response.trace),
      latencyMs: response.answer.latencyMs,
    });
  },
  simulateRetrieval: async (command: KnowledgeSearchCommand, signal?: AbortSignal) => {
    const response = await request("/retrieval/simulate", p3ConsoleSimulationResponseSchema, {
      signal,
      body: retrievalQueryBody(command),
    });
    return Object.freeze({
      current: toRetrievalTraceView(response.current),
      ...(response.draft === undefined ? {} : { draft: toRetrievalTraceView(response.draft) }),
      ...(response.comparison === undefined ? {} : {
        comparison: Object.freeze({
          selectedOnlyByCurrent: Object.freeze([...response.comparison.selectedOnlyByCurrent]),
          selectedOnlyByDraft: Object.freeze([...response.comparison.selectedOnlyByDraft]),
          tokenDelta: response.comparison.tokenDelta,
        }),
      }),
    });
  },
  retrievalTrace: async (traceId: string, scope: { readonly projectId?: string; readonly taskId?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (scope.projectId !== undefined) query.set("projectId", scope.projectId);
    if (scope.taskId !== undefined) query.set("taskId", scope.taskId);
    const result = await request(`/retrieval/traces/${encodeURIComponent(traceId)}${query.size === 0 ? "" : `?${query.toString()}`}`, retrievalTraceSchema, { signal });
    return toRetrievalTraceView(result);
  },
  sessionInjections: async (sessionId: string, signal?: AbortSignal) => {
    const [capabilities, page] = await Promise.all([
      p4Capabilities(signal),
      request(`/p4/sessions/${encodeURIComponent(sessionId)}/injections?limit=100`, p4WireInjectionPageSchema, { signal }),
    ]);
    const injection = p4Capability(capabilities, "INJECTION_AUDIT");
    const mcp = p4Capability(capabilities, "MCP_AUDIT");
    const expansions = mcp.status === "READY"
      ? await mapConcurrent(page.items, 8, async (attempt) => await request(
        `/p4/sessions/${encodeURIComponent(sessionId)}/injections/${encodeURIComponent(attempt.attemptId)}/mcp-expansions?limit=100`,
        p4WireMcpPageSchema, { signal },
      ))
      : page.items.map((): z.infer<typeof p4WireMcpPageSchema> => ({ items: [] }));
    const capabilityStatus = injection.status === "READY" && mcp.status !== "READY" ? "DEGRADED" : injection.status;
    const capabilityReasonCode = injection.status === "READY" && mcp.status !== "READY" ? mcp.reasonCode : injection.reasonCode;
    return sessionInjectionViewSchema.parse({
      observedAt: page.items[0]?.createdAt ?? new Date().toISOString(),
      truncated: page.nextCursor !== undefined || expansions.some((value) => value.nextCursor !== undefined),
      capabilityStatus,
      capabilityReasonCode,
      attempts: page.items.map((attempt, index) => p4InjectionView(attempt, expansions[index]?.items ?? [])),
    });
  },
  closureRuns: async (sessionId?: string, signal?: AbortSignal) => {
    if (sessionId === undefined) return closureRunListViewSchema.parse({
      capabilityStatus: "NOT_CONFIGURED", capabilityReasonCode: "SESSION_SCOPE_REQUIRED", truncated: false, items: [],
    });
    const [capabilities, page] = await Promise.all([
      p4Capabilities(signal),
      request(`/p4/sessions/${encodeURIComponent(sessionId)}/closures?limit=100`, p4WireClosurePageSchema, { signal }),
    ]);
    const capability = p4Capability(capabilities, "CLOSURE_AUDIT");
    return closureRunListViewSchema.parse({
      capabilityStatus: capability.status, capabilityReasonCode: capability.reasonCode,
      truncated: page.nextCursor !== undefined, items: page.items.map(p4ClosureView),
    });
  },
  closureRun: async (sessionId: string, closureRunId: string, signal?: AbortSignal) => p4ClosureView(await request(
    `/p4/sessions/${encodeURIComponent(sessionId)}/closures/${encodeURIComponent(closureRunId)}`, p4WireClosureSchema, { signal },
  )),
  feedbackTargets: async (sessionId: string, signal?: AbortSignal) => (await request(
    `/p4/sessions/${encodeURIComponent(sessionId)}/feedback-targets`, p4FeedbackTargetsResponseSchema, { signal },
  )).items,
  recordFeedback: async (command: FeedbackCommand, signal?: AbortSignal) => {
    const result = await request("/p4/feedback", p4WireFeedbackResponseSchema, {
      signal,
      body: {
        kind: command.kind,
        knowledgeId: command.knowledgeId,
        version: command.version,
        expectedRevision: command.expectedRevision,
        idempotencyKey: command.idempotencyKey,
        scopeKey: command.scopeKey,
        traceId: command.traceId,
        ...(command.kind === "MCP_USED" && command.expansionId !== undefined ? { expansionId: command.expansionId } : {}),
      },
    });
    return feedbackReceiptSchema.parse({
      result: result.outcome,
      eligibleAfterWrite: result.eligibleAfterWrite,
      revision: command.expectedRevision,
      reasonCode: result.outcome === "RECORDED" ? "FEEDBACK_RECORDED" : "FEEDBACK_EXISTING",
    });
  },
  rollout: async (signal?: AbortSignal) => {
    const [capabilities, raw] = await Promise.all([p4Capabilities(signal), request("/p4/rollout", p4WireRolloutSchema, { signal })]);
    const capability = p4Capability(capabilities, "ROLLOUT");
    const lastTransition = raw.state.audit.at(-1);
    return rolloutViewSchema.parse({
      capabilityStatus: capability.status, capabilityReasonCode: capability.reasonCode,
      stateRevision: raw.state.stateRevision, effective: raw.state.effective, lastKnownGood: raw.state.lastKnownGood,
      eligibility: raw.state.evidence.map((item) => ({
        evidenceId: item.evidenceId, datasetFingerprint: item.datasetFingerprint,
        configFingerprint: item.configFingerprint, versionFingerprint: item.versionFingerprint,
        traceCount: item.traceIds.length, eligible: item.eligible, checks: item.checks, createdAt: item.createdAt,
      })),
      ...(lastTransition === undefined ? {} : { lastTransition: { kind: lastTransition.kind, reasonCodes: lastTransition.reasonCodes, occurredAt: lastTransition.occurredAt } }),
    });
  },
  highRiskGovernance: async (signal?: AbortSignal) => await request("/p4/high-risk/governance", highRiskGovernanceViewSchema, { signal }),
  previewHighRisk: async (command: HighRiskPreviewCommand, signal?: AbortSignal) => {
    const raw = await request("/p4/high-risk/preview", p4WireHighRiskPreviewSchema, {
      signal,
      body: {
        expectedPolicyRevision: command.expectedPolicyRevision,
        idempotencyKey: command.idempotencyKey,
        command: {
          kind: command.kind, assetIds: command.assetIds, projectIds: command.projectIds,
          reason: command.reason, payloadFingerprint: command.payloadFingerprint,
        },
      },
    });
    return highRiskPreviewViewSchema.parse({
      previewId: raw.preview.previewId, policyRevision: raw.preview.policyRevision, kind: raw.preview.command.kind,
      expiresAt: raw.preview.expiresAt, confirmationPhrase: raw.confirmationPhrase, blastRadius: raw.blastRadius,
    });
  },
  commitHighRisk: async (command: HighRiskCommitCommand, signal?: AbortSignal) => {
    const raw = await request("/p4/high-risk/commit", p4WireHighRiskCommitSchema, {
      signal,
      body: {
        previewId: command.previewId, confirmationPhrase: command.confirmationPhrase,
        expectedPolicyRevision: command.expectedPolicyRevision, idempotencyKey: command.idempotencyKey,
      },
    });
    return highRiskReceiptSchema.parse({
      operationId: raw.result.operationId,
      previewId: raw.result.previewId,
      kind: raw.result.kind,
      actor: raw.result.actor,
      policyRevision: raw.result.policyRevision,
      committedAt: raw.result.committedAt,
    });
  },
});

type P4CapabilityName = z.infer<typeof p4WireCapabilityListSchema>["items"][number]["capability"];

async function p4Capabilities(signal?: AbortSignal): Promise<z.infer<typeof p4WireCapabilityListSchema> | undefined> {
  try { return await request("/p4/capabilities", p4WireCapabilityListSchema, { signal }); }
  catch (error) {
    if (error instanceof ConsoleApiError && error.code === "CAPABILITY_UNAVAILABLE") return undefined;
    throw error;
  }
}

function p4Capability(capabilities: z.infer<typeof p4WireCapabilityListSchema> | undefined, name: P4CapabilityName): {
  readonly status: "READY" | "DEGRADED" | "NOT_CONFIGURED" | "DISABLED";
  readonly reasonCode: string;
} {
  const value = capabilities?.items.find((item) => item.capability === name);
  return value === undefined
    ? { status: "NOT_CONFIGURED", reasonCode: "P4_CAPABILITY_FACTS_UNAVAILABLE" }
    : { status: value.state, reasonCode: value.reasonCode };
}

async function mapConcurrent<T, U>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

function p4InjectionView(raw: P4WireInjection, expansions: z.infer<typeof p4WireMcpPageSchema>["items"]): unknown {
  const deliveryConfirmed = raw.status === "INJECTED" && raw.deliveryEvidenceRef !== undefined;
  const automaticL4 = raw.envelope.complexity.level === "L4_EPISODE" || raw.envelope.items.some((item) => item.detailLevel === "L4_EPISODE");
  const status = (raw.status === "INJECTED" && !deliveryConfirmed) || automaticL4 ? "ERROR" : raw.status;
  const reason = automaticL4 ? "AUTOMATIC_L4_FORBIDDEN"
    : raw.status === "INJECTED" && !deliveryConfirmed ? "DELIVERY_EVIDENCE_NOT_CONFIRMED" : raw.reasonCode;
  const visibleItems = raw.envelope.items.filter((item) => item.detailLevel !== "L4_EPISODE");
  return {
    attemptId: raw.attemptId, sessionId: raw.sessionId, turnId: raw.turnId, runId: raw.runId,
    retrievalTraceId: raw.traceId, rolloutRevision: raw.rolloutRevision, status, reasonCode: reason,
    envelope: {
      mode: deliveryConfirmed ? "ACTUAL" : "SHADOW",
      detailLevel: automaticL4 ? "L3_EVIDENCED" : raw.envelope.complexity.level,
      maxTokens: raw.envelope.budget.maxTokens, estimatedTokens: raw.envelope.budget.estimatedTokens,
      items: visibleItems.map((item) => ({ knowledgeId: item.id, version: item.version, detailLevel: item.detailLevel })),
      omitted: [], omittedCount: raw.envelope.budget.omittedItems + (raw.envelope.items.length - visibleItems.length),
      reasonCodes: [...raw.envelope.complexity.reasonCodes, ...(reason === raw.reasonCode ? [] : [reason])],
    },
    ...(deliveryConfirmed ? { deliveryEvidenceRef: raw.deliveryEvidenceRef } : {}),
    createdAt: raw.createdAt, ...(raw.completedAt === undefined ? {} : { completedAt: raw.completedAt }),
    mcpExpansions: expansions.map((item) => ({
      expansionId: item.expansionId, tool: item.tool, knowledgeId: item.knowledgeId, knowledgeVersion: item.knowledgeVersion,
      fromDetailLevel: item.fromDetailLevel, toDetailLevel: item.toDetailLevel, latencyMs: item.latencyMs, used: item.used, occurredAt: item.occurredAt,
    })),
  };
}

function p4ClosureView(raw: P4WireClosure): ClosureRunView {
  return closureRunViewSchema.parse({
    closureRunId: raw.closureRunId, sessionId: raw.sessionId, turnId: raw.turnId, createdAt: raw.createdAt,
    taskContract: { objective: raw.taskContract.objective, boundaries: raw.taskContract.boundaries, completionGates: raw.taskContract.gates },
    gates: raw.gates.map((gate) => ({
      gateId: gate.gateId, label: gate.gateId, status: gate.status, evidenceRefs: gate.evidenceRefs,
      reasonCode: gate.reasonCodes[0] ?? "GATE_REASON_NOT_REPORTED",
    })),
    decision: raw.decision, ...(raw.correctionDelta === undefined ? {} : { correctionDelta: raw.correctionDelta }),
    continuationCount: raw.continuationCount, recursiveStopRejected: raw.recursiveStopRejected,
    ...(raw.interaction === undefined ? {} : { interaction: {
      required: raw.interaction.required,
      ...(raw.interaction.question === undefined ? {} : { question: raw.interaction.question }),
      ...(raw.interaction.safeDefault === undefined ? {} : { safeDefault: raw.interaction.safeDefault }),
      confirmationStatus: raw.interaction.required ? "PENDING" : "NOT_REQUIRED",
    } }),
  });
}

function retrievalQueryBody(command: KnowledgeSearchCommand, timeoutMs = 10_000): Readonly<Record<string, unknown>> {
  return Object.freeze({
    requestId: command.requestId,
    query: command.query,
    ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
    ...(command.taskId === undefined ? {} : { taskId: command.taskId }),
    ...(command.repositoryRoot === undefined ? {} : { repositoryRoot: command.repositoryRoot }),
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(command.hints === undefined ? {} : { hints: command.hints }),
    maxResults: command.maxResults,
    maxContextTokens: command.maxContextTokens,
    timeoutMs,
  });
}

export type { CaptureCommitResult, CapturePreview, SessionSummary };
