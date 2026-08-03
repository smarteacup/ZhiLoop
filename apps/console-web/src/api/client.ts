import {
  type CONTROL_ERROR_CODES,
  capabilityPageSchema,
  captureCommitResultSchema,
  capturePreviewSchema,
  controlResponseSchema,
  diagnosticsSchema,
  eventMetadataPageSchema,
  jobPageSchema,
  overviewSchema,
  sessionDetailSchema,
  sessionPageSchema,
  type Diagnostics,
  type Overview,
  type CaptureCommitResult,
  type CapturePreview,
  type SessionDetail,
  type SessionSummary,
} from "@zhiloop/control-api";
import type { z } from "zod";

export interface ConsoleApi {
  overview(signal?: AbortSignal): Promise<Overview>;
  capabilities(signal?: AbortSignal): Promise<z.infer<typeof capabilityPageSchema>>;
  sessions(signal?: AbortSignal): Promise<z.infer<typeof sessionPageSchema>>;
  session(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>;
  events(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<z.infer<typeof eventMetadataPageSchema>>;
  jobs(signal?: AbortSignal): Promise<z.infer<typeof jobPageSchema>>;
  diagnostics(signal?: AbortSignal): Promise<Diagnostics>;
  previewCapture(sessionId: string, signal?: AbortSignal): Promise<CapturePreview>;
  commitCapture(command: CaptureCommitCommand, signal?: AbortSignal): Promise<CaptureCommitResult>;
}

export interface CaptureCommitCommand {
  readonly sessionId: string;
  readonly previewRevision: number;
  readonly transcriptIdentityHash: string;
  readonly idempotencyKey: string;
}

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
});

export type { CaptureCommitResult, CapturePreview, SessionSummary };
