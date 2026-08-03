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
});

export type { CaptureCommitResult, CapturePreview, SessionSummary };
