import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BrowserSessionManager, createBootstrapToken } from "./auth.js";
import { FixedWindowRateLimiter, assertLoopbackBind, isLoopbackAddress } from "./security.js";
import { StaticAssetStore } from "./static-assets.js";

describe("browser session primitives", () => {
  it("expires bootstrap and browser sessions and rejects malformed cookies", () => {
    const manager = new BrowserSessionManager("x".repeat(32), 10_000, 1_000);
    expect(manager.exchange("wrong", 1)).toBeUndefined();
    const exchange = manager.exchange("x".repeat(32), 1);
    expect(exchange).toBeDefined();
    expect(manager.exchange("x".repeat(32), 2)).toBeUndefined();
    const cookie = exchange?.cookie.split(";", 1)[0];
    expect(manager.authenticate(cookie, exchange?.csrfToken, 2)).toEqual({ authenticated: true, csrfValid: true });
    expect(manager.resume(cookie, 2)).toEqual({ csrfToken: exchange?.csrfToken, expiresAt: "1970-01-01T00:00:10.001Z" });
    expect(manager.resume("malformed", 2)).toBeUndefined();
    expect(manager.authenticate(`${cookie}; ${cookie}`, exchange?.csrfToken, 2)).toEqual({ authenticated: false, csrfValid: false });
    expect(manager.authenticate(cookie, "wrong", 2)).toEqual({ authenticated: true, csrfValid: false });
    expect(manager.authenticate(cookie, exchange?.csrfToken, 10_002)).toEqual({ authenticated: false, csrfValid: false });
    expect(manager.resume(cookie, 10_002)).toBeUndefined();
    expect(new BrowserSessionManager("y".repeat(32), 10_000, 1).exchange("y".repeat(32), 1)).toBeUndefined();
    expect(createBootstrapToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  });

  it("rejects unsafe session manager configuration", () => {
    expect(() => new BrowserSessionManager("short")).toThrow(/bootstrapToken/u);
    expect(() => new BrowserSessionManager("x".repeat(32), 1)).toThrow(/safe range/u);
  });
});

describe("loopback and rate-limit primitives", () => {
  it("recognizes only explicit IPv4 and IPv6 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.99.2.3")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
    expect(() => assertLoopbackBind("::")).toThrow(/loopback/u);
  });

  it("uses a fixed bounded window", () => {
    const limiter = new FixedWindowRateLimiter(2, 100);
    expect(limiter.allow("client", 1)).toBe(true);
    expect(limiter.allow("client", 2)).toBe(true);
    expect(limiter.allow("client", 3)).toBe(false);
    expect(limiter.allow("client", 101)).toBe(true);
    expect(() => new FixedWindowRateLimiter(0, 100)).toThrow(/rate/u);
    expect(() => new FixedWindowRateLimiter(1, 1)).toThrow(/window/u);
  });
});

describe("static asset containment", () => {
  it("rejects unsupported, malformed, oversized and symlink-escaped assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhiloop-assets-"));
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "zhiloop-outside-")), "secret.txt");
    await writeFile(path.join(root, "unknown.bin"), "binary");
    await writeFile(path.join(root, "large.js"), "x".repeat(100));
    await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "escape.js"));
    const store = await StaticAssetStore.create(root, 50);
    await expect(store.read("/%zz")).resolves.toBeUndefined();
    await expect(store.read("/dir\\file.js")).resolves.toBeUndefined();
    await expect(store.read("/./large.js")).resolves.toBeUndefined();
    await expect(store.read("/unknown.bin")).resolves.toBeUndefined();
    await expect(store.read("/large.js")).resolves.toBeUndefined();
    await expect(store.read("/escape.js")).resolves.toBeUndefined();
    await expect(store.read("/missing.js")).resolves.toBeUndefined();
    await expect(StaticAssetStore.create("relative")).rejects.toThrow(/absolute/u);
    await expect(StaticAssetStore.create(root, 0)).rejects.toThrow(/byte limit/u);
  });
});
