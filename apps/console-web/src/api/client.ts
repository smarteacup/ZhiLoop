import {
  capabilityPageSchema,
  controlResponseSchema,
  diagnosticsSchema,
  eventMetadataPageSchema,
  jobPageSchema,
  overviewSchema,
  sessionDetailSchema,
  sessionPageSchema,
  type Diagnostics,
  type Overview,
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
}

let csrfToken: string | undefined;

export function setCsrfToken(value: string): void {
  if (!/^[A-Za-z0-9._:-]{16,500}$/u.test(value)) throw new Error("invalid CSRF token");
  csrfToken = value;
}

async function request<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...(csrfToken === undefined ? {} : { headers: { "x-zhiloop-csrf": csrfToken } }),
    ...(signal === undefined ? {} : { signal }),
  });
  const envelope = controlResponseSchema.parse(await response.json());
  if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return schema.parse(envelope.result);
}

export const browserConsoleApi: ConsoleApi = Object.freeze({
  overview: async (signal?: AbortSignal) => await request("/overview", overviewSchema, signal),
  capabilities: async (signal?: AbortSignal) => await request("/capabilities", capabilityPageSchema, signal),
  sessions: async (signal?: AbortSignal) => await request("/sessions", sessionPageSchema, signal),
  session: async (sessionId: string, signal?: AbortSignal) => await request(`/sessions/${encodeURIComponent(sessionId)}`, sessionDetailSchema, signal),
  events: async (sessionId: string, cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ sessionId });
    if (cursor !== undefined) query.set("cursor", cursor);
    return await request(`/events?${query.toString()}`, eventMetadataPageSchema, signal);
  },
  jobs: async (signal?: AbortSignal) => await request("/jobs", jobPageSchema, signal),
  diagnostics: async (signal?: AbortSignal) => await request("/diagnostics", diagnosticsSchema, signal),
});

export type { SessionSummary };
