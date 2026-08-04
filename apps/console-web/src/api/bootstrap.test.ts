import { describe, expect, it, vi } from "vitest";

import { exchangeBootstrapToken, resumeBrowserSession, takeBootstrapToken } from "./bootstrap.js";

describe("Console bootstrap contract", () => {
  it("uses the gateway token field and never puts the token in the request URL", async () => {
    const token = "a".repeat(32);
    const request = vi.fn(async () => new Response(JSON.stringify({ csrfToken: "b".repeat(32) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    expect(takeBootstrapToken(`#bootstrap=${token}`)).toBe(token);
    await expect(exchangeBootstrapToken(token, request)).resolves.toBe("b".repeat(32));
    expect(request).toHaveBeenCalledWith("/api/v1/auth/exchange", expect.objectContaining({ body: JSON.stringify({ token }) }));
  });

  it("rejects absent and malformed bootstrap fragments", () => {
    expect(takeBootstrapToken("#/overview")).toBeUndefined();
    expect(takeBootstrapToken("#bootstrap=short")).toBeUndefined();
  });

  it("restores the in-memory CSRF proof from an existing HttpOnly session after reload", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ csrfToken: "c".repeat(32) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(resumeBrowserSession(request)).resolves.toBe("c".repeat(32));
    expect(request).toHaveBeenCalledWith("/api/v1/auth/session", {
      method: "GET", credentials: "same-origin", cache: "no-store",
    });
  });
});
