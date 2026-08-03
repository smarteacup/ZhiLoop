import { afterEach, describe, expect, it, vi } from "vitest";

import { browserConsoleApi, setCsrfToken } from "./client.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ schemaVersion: 1, requestId: "request-1", observedAt: timestamp, ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("typed Console API client", () => {
  it("sends in-memory CSRF proof and validates overview responses", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => envelope({ schemaVersion: 1, observedAt: timestamp, rolloutMode: "SHADOW", sidecarVersion: "0.1.4", capabilities: [], recentSessions: [], jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 }, alertCount: 0 }));
    vi.stubGlobal("fetch", fetcher);
    setCsrfToken("csrf-token-1234567890");
    await expect(browserConsoleApi.overview()).resolves.toMatchObject({ rolloutMode: "SHADOW" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/overview", expect.objectContaining({ credentials: "same-origin", headers: { "x-zhiloop-csrf": "csrf-token-1234567890" } }));
  });

  it("binds event cursors to an encoded session query", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => envelope({ items: [] }));
    vi.stubGlobal("fetch", fetcher);
    await browserConsoleApi.events("session:1", "signed cursor");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/events?sessionId=session%3A1&cursor=signed+cursor");
  });

  it("rejects unsafe CSRF values and strict response violations", async () => {
    expect(() => setCsrfToken("short")).toThrow(/invalid CSRF/u);
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ rawPrompt: "must not pass" })));
    await expect(browserConsoleApi.overview()).rejects.toThrow();
  });
});
