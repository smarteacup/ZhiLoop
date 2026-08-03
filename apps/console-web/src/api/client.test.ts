import { afterEach, describe, expect, it, vi } from "vitest";

import { browserConsoleApi, ConsoleApiError, setCsrfToken } from "./client.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ schemaVersion: 1, requestId: "request-1", observedAt: timestamp, ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: "STALE_REVISION" | "SIDECAR_UNAVAILABLE", retryable: boolean): Response {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    requestId: "request-1",
    observedAt: timestamp,
    ok: false,
    error: { code, message: code === "STALE_REVISION" ? "Preview changed" : "Unavailable", retryable },
  }), { status: code === "STALE_REVISION" ? 409 : 503, headers: { "content-type": "application/json" } });
}

const retrievalTrace = {
  schemaVersion: 1 as const,
  traceId: "trace-web-p3", runId: "run-web-p3",
  queryContext: {
    prompt: "ConfigService", promptFingerprint: "a".repeat(64), projectId: "project-a",
    paths: [], symbols: ["ConfigService"], errorCodes: [], configKeys: [],
    allowProjectKnowledge: true, allowGlobalKnowledge: true, reasonCodes: ["PROJECT_RESOLVED"],
  },
  policy: { policyId: "policy-current", revision: 1, fingerprint: "b".repeat(64), source: "CURRENT" as const },
  outcome: "NO_CONTEXT" as const,
  filters: [], results: [],
  envelope: {
    detailLevel: "L0_NONE" as const, maxTokens: 800, estimatedTokens: 0, truncated: false,
    selected: [], omitted: [], reasonCodes: ["RISK_LOW", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT", "BUDGET_WITHIN_LIMIT"],
  },
  injectionResult: "NO_CONTEXT" as const,
  durationMs: 1, createdAt: timestamp,
};

afterEach(() => vi.unstubAllGlobals());

describe("typed Console API client", () => {
  it("sends in-memory CSRF proof and validates overview responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => envelope({ schemaVersion: 1, observedAt: timestamp, rolloutMode: "SHADOW", sidecarVersion: "0.1.4", capabilities: [], recentSessions: [], jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 }, alertCount: 0 }));
    vi.stubGlobal("fetch", fetcher);
    setCsrfToken("csrf-token-1234567890");
    await expect(browserConsoleApi.overview()).resolves.toMatchObject({ rolloutMode: "SHADOW" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/overview", expect.objectContaining({ credentials: "same-origin", headers: { "x-zhiloop-csrf": "csrf-token-1234567890" } }));
  });

  it("binds event cursors to an encoded session query", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => envelope({ items: [] }));
    vi.stubGlobal("fetch", fetcher);
    await browserConsoleApi.events("session:1", "signed cursor");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/events?sessionId=session%3A1&cursor=signed+cursor");
  });

  it("rejects unsafe CSRF values and strict response violations", async () => {
    expect(() => setCsrfToken("short")).toThrow(/invalid CSRF/u);
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ rawPrompt: "must not pass" })));
    await expect(browserConsoleApi.overview()).rejects.toThrow();
  });

  it("uses the unified capture command endpoint and strict preview/commit schemas", async () => {
    const preview = { schemaVersion: 1, sessionId: "session-1", previewRevision: 7, transcriptIdentityHash: "a".repeat(64), projectedEvents: 3, ignoredRecords: 1, eventTypes: { USER_PROMPT: 3 }, cursor: { byteOffset: 42, lineNumber: 4 }, hasMore: false, expiresAt: "2099-08-03T12:00:00.000Z" };
    const commit = { schemaVersion: 1, sessionId: "session-1", previewRevision: 7, appendedEvents: 3, duplicateEvents: 0, cursor: { byteOffset: 42, lineNumber: 4 }, knowledgeCompileStage: { schemaVersion: 1, entityId: "session-1", stage: "KNOWLEDGE_COMPILE", status: "DISABLED", reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED", observedAt: timestamp, lastTransitionAt: timestamp, retryable: false, evidenceRefs: [] } };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
      return envelope(body.dryRun ? preview : commit);
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(browserConsoleApi.previewCapture("session-1")).resolves.toMatchObject({ previewRevision: 7 });
    await expect(browserConsoleApi.commitCapture({ sessionId: "session-1", previewRevision: 7, transcriptIdentityHash: "a".repeat(64), idempotencyKey: "capture:7:aaaaaaaaaaaaaaaa" })).resolves.toMatchObject({ appendedEvents: 3 });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/v1/capture-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId: "session-1", dryRun: true }),
      headers: expect.objectContaining({ "content-type": "application/json" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/v1/capture-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId: "session-1", dryRun: false, previewRevision: 7, transcriptIdentityHash: "a".repeat(64), idempotencyKey: "capture:7:aaaaaaaaaaaaaaaa" }),
    }));
  });

  it("sends strict revision-bound cancel and retry commands without placing fields in the URL", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const action = String(input).endsWith("/cancel") ? "CANCEL" : "RETRY";
      const body = JSON.parse(String(init?.body)) as { expectedRevision: number };
      return envelope({
        schemaVersion: 1,
        action,
        disposition: "APPLIED",
        job: {
          schemaVersion: 1, jobId: "job-1", jobType: "AUTOMATIC_INGESTION_SCAN", revision: body.expectedRevision + 1,
          status: action === "CANCEL" ? "CANCELLED" : "QUEUED", attempt: 1, maxAttempts: 3, progress: 0,
          reasonCode: action === "CANCEL" ? "JOB_CANCELLED" : "JOB_QUEUED", observedAt: timestamp,
          lastTransitionAt: timestamp, retryable: action === "RETRY", evidenceRefs: [],
        },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(browserConsoleApi.cancelJob?.({ jobId: "job-1", expectedRevision: 3, idempotencyKey: "operator:cancel:web:one" }))
      .resolves.toMatchObject({ action: "CANCEL", job: { revision: 4 } });
    await expect(browserConsoleApi.retryJob?.({ jobId: "job-1", expectedRevision: 4, idempotencyKey: "operator:retry:web:one" }))
      .resolves.toMatchObject({ action: "RETRY", job: { revision: 5 } });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/v1/jobs/job-1/cancel", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 3, idempotencyKey: "operator:cancel:web:one" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/v1/jobs/job-1/retry", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 4, idempotencyKey: "operator:retry:web:one" }),
    }));
  });

  it("preserves stable API error codes for stale and unavailable UI states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorEnvelope("STALE_REVISION", false)));
    await expect(browserConsoleApi.previewCapture("session-1")).rejects.toMatchObject({ code: "STALE_REVISION", retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));
    const unavailable = await browserConsoleApi.previewCapture("session-1").catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(ConsoleApiError);
    expect(unavailable).toMatchObject({ code: "SIDECAR_UNAVAILABLE", retryable: true });
  });

  it("rejects a validly shaped capture response bound to another session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ schemaVersion: 1, sessionId: "session-other", previewRevision: 7, transcriptIdentityHash: "a".repeat(64), projectedEvents: 0, ignoredRecords: 0, eventTypes: {}, cursor: { byteOffset: 0, lineNumber: 0 }, hasMore: false, expiresAt: "2099-08-03T12:00:00.000Z" })));
    await expect(browserConsoleApi.previewCapture("session-1")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("uses typed configuration query, validate, activate and rollback endpoints with CSRF", async () => {
    const configuration = {
      schemaVersion: 1,
      runtime: {
        sessionScanIntervalMs: 60_000, followDebounceMs: 1_000, workerPollIntervalMs: 1_000, extractionDelayMs: 300_000,
        workerConcurrency: 2, scanBatchSize: 100, captureBatchSize: 100,
        captureRetry: { maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 },
        alerts: {
          enabled: true, notify: false, minimumSeverity: "WARNING",
          spoolDepth: { warning: 100, error: 1_000 }, spoolOldestAgeMs: { warning: 60_000, error: 600_000 },
          cursorLagEvents: { warning: 1_000, error: 10_000 }, failedJobs: { warning: 1, error: 10 }, hookSilenceMs: { warning: 3_600_000, error: 21_600_000 },
          quietHours: { enabled: false, startMinute: 1_320, endMinute: 480, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], utcOffsetMinutes: 480 },
        },
      },
      future: { injectionMaxTokens: 800, compilerBatchSize: 50, codexQueryTimeoutMs: 30_000, codexQueryConcurrency: 2 },
    };
    const state = { view: { schemaVersion: 1, revision: 2, hash: "a".repeat(64), effective: configuration, sources: { "runtime.sessionScanIntervalMs": "GLOBAL" } }, drafts: [], history: [] };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const path = String(input);
      if (path.includes("/draft")) return envelope({ ok: false, diagnostics: [{ code: "CONSUMER_DISABLED", retryable: false }] });
      if (path.includes("/activate")) return envelope({ ok: true, revision: 3, hash: "b".repeat(64), status: "EFFECTIVE" });
      if (path.includes("/rollback")) return envelope({ ok: true, revision: 4, hash: "c".repeat(64), status: "ROLLED_BACK" });
      return envelope(state);
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(browserConsoleApi.configuration?.("project-1")).resolves.toMatchObject({ view: { revision: 2 } });
    await expect(browserConsoleApi.validateConfiguration?.({ baseRevision: 2, scope: "PROJECT", projectId: "project-1", draft: configuration })).resolves.toMatchObject({ ok: false });
    await expect(browserConsoleApi.activateConfiguration?.({ expectedRevision: 2, draftRevision: 3, idempotencyKey: "config-activate-2-3" })).resolves.toMatchObject({ status: "EFFECTIVE" });
    await expect(browserConsoleApi.rollbackConfiguration?.({ expectedRevision: 3, targetRevision: 2, idempotencyKey: "config-rollback-3-2" })).resolves.toMatchObject({ status: "ROLLED_BACK" });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/configuration?projectId=project-1",
      "/api/v1/configuration/draft",
      "/api/v1/configuration/activate",
      "/api/v1/configuration/rollback",
    ]);
    expect(fetcher.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-zhiloop-csrf": "csrf-token-1234567890" }) }));
  });

  it("strictly parses bounded invalidation polling and rejects unsafe revisions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({
      currentRevision: 2, oldestRetainedRevision: 1, requestedAfterRevision: 0, nextRevision: 2,
      resyncRequired: false, hasMore: false, retryAfterMs: 1_000,
      events: [{ schemaVersion: 1, eventId: "event-2", type: "job.updated", entityId: "job-1", revision: 2, occurredAt: timestamp }],
    })));
    await expect(browserConsoleApi.pollInvalidations?.(0)).resolves.toMatchObject({ nextRevision: 2 });
    await expect(browserConsoleApi.pollInvalidations?.(-1)).rejects.toThrow(/afterRevision/u);
  });

  it("uses strict P3 search transport and maps the trace without exposing injection authority", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => envelope({ schemaVersion: 1, kind: "SEARCH", trace: retrievalTrace }));
    vi.stubGlobal("fetch", fetcher);
    const result = await browserConsoleApi.searchKnowledge?.({
      requestId: "request-web-p3",
      query: "ConfigService",
      projectId: "project-a",
      maxResults: 10,
      maxContextTokens: 800,
    });
    expect(result).toMatchObject({ traceId: "trace-web-p3", injectionResult: "NO_CONTEXT", results: [] });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/retrieval/search", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        requestId: "request-web-p3", query: "ConfigService", projectId: "project-a",
        maxResults: 10, maxContextTokens: 800, timeoutMs: 10_000,
      }),
    }));

    vi.stubGlobal("fetch", vi.fn(async () => envelope({ schemaVersion: 1, kind: "SEARCH", trace: retrievalTrace, unexpected: true })));
    await expect(browserConsoleApi.searchKnowledge?.({
      requestId: "request-web-p3-invalid", query: "ConfigService", maxResults: 10, maxContextTokens: 800,
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("parses named SSE invalidations and closes the native source on abort", () => {
    class FakeEventSource {
      static instance: FakeEventSource | undefined;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readonly listeners = new Map<string, EventListener>();
      readonly close = vi.fn();
      constructor(readonly url: string, readonly options: EventSourceInit) { FakeEventSource.instance = this; }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") this.listeners.set(type, listener);
      }
      emit(type: string, value: unknown): void { this.listeners.get(type)?.({ data: JSON.stringify(value) } as unknown as Event); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const controller = new AbortController();
    const onOpen = vi.fn();
    const onEvent = vi.fn();
    const onError = vi.fn();
    browserConsoleApi.openInvalidations?.({ onOpen, onEvent, onError }, controller.signal);
    FakeEventSource.instance?.onopen?.();
    FakeEventSource.instance?.emit("job.updated", { schemaVersion: 1, eventId: "event-1", type: "job.updated", entityId: "job-1", revision: 1, occurredAt: timestamp });
    expect(FakeEventSource.instance?.url).toBe("/api/v1/invalidations");
    expect(FakeEventSource.instance?.options.withCredentials).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, type: "job.updated" }));
    controller.abort();
    expect(FakeEventSource.instance?.close).toHaveBeenCalledOnce();
  });
});
