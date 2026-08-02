import { describe, expect, it } from "vitest";

import { SidecarLifecycleService } from "./lifecycle.js";
import type { SidecarCompatibilityPolicy, SidecarControlPort, SidecarHealth } from "./types.js";

const policy: SidecarCompatibilityPolicy = {
  pluginVersion: "0.1.0",
  minimumSidecarVersion: "0.1.0",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
};

const ready: SidecarHealth = {
  schemaVersion: 1,
  status: "READY",
  pluginVersion: "0.1.0",
  sidecarVersion: "0.1.0",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
  startedAt: "2026-08-02T10:00:00.000Z",
};

describe("SidecarLifecycleService", () => {
  it("reuses a compatible running sidecar without starting it", async () => {
    let starts = 0;
    const port: SidecarControlPort = { health: async () => ready, start: async () => { starts += 1; } };
    const result = await new SidecarLifecycleService(port, policy).ensureReady();
    expect(result).toMatchObject({ started: false, compatibility: { compatible: true } });
    expect(starts).toBe(0);
  });

  it("coalesces concurrent starts and verifies health after startup", async () => {
    let running = false;
    let starts = 0;
    let release: (() => void) | undefined;
    const startBarrier = new Promise<void>((resolve) => { release = resolve; });
    const port: SidecarControlPort = {
      health: async () => running ? ready : undefined,
      start: async () => { starts += 1; await startBarrier; running = true; },
    };
    const service = new SidecarLifecycleService(port, policy);
    const first = service.ensureReady();
    const second = service.ensureReady();
    await Promise.resolve();
    release?.();
    const results = await Promise.all([first, second]);
    expect(starts).toBe(1);
    expect(results.every((result) => result.started && result.compatibility.compatible)).toBe(true);
  });

  it("does not replace a running incompatible sidecar and propagates cancellation", async () => {
    let starts = 0;
    const port: SidecarControlPort = {
      health: async () => ({ ...ready, protocolVersion: 2 }),
      start: async () => { starts += 1; },
    };
    const service = new SidecarLifecycleService(port, policy);
    expect(await service.ensureReady()).toMatchObject({ started: false, compatibility: { compatible: false } });
    expect(starts).toBe(0);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(service.ensureReady(controller.signal)).rejects.toThrow("cancelled");
  });

  it("reports startup that did not become healthy", async () => {
    const port: SidecarControlPort = { health: async () => undefined, start: async () => undefined };
    const result = await new SidecarLifecycleService(port, policy).ensureReady();
    expect(result).toMatchObject({ started: true, compatibility: { compatible: false, issues: [{ code: "INVALID_HEALTH" }] } });
  });
});
