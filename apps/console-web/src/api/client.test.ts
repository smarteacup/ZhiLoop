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
});
