import { describe, expect, it } from "vitest";

import { ZhiLoopDaemonRuntime } from "./runtime.js";
import type {
  DaemonLifecycleComponent,
  DaemonRuntimeOptions,
  DaemonRuntimePorts,
  DaemonWorkerCycle,
} from "./types.js";

const options: DaemonRuntimeOptions = {
  compatibility: {
    pluginVersion: "0.1.0",
    minimumSidecarVersion: "0.1.0",
    protocolVersion: 1,
    hookSchemaVersion: "codex-hooks-v1",
    appServerSchemaVersion: "codex-app-server-v2",
  },
  sidecarVersion: "0.1.0",
  clock: () => new Date("2026-08-02T12:00:00.000Z"),
  hookDeadlinesMs: { UserPromptSubmit: 20, PostToolUse: 20, Stop: 20, SessionEnd: 20, other: 20 },
  shutdownDeadlineMs: 20,
};

function component(name = "storage", overrides: Partial<DaemonLifecycleComponent> = {}): DaemonLifecycleComponent {
  return {
    name,
    start: async () => undefined,
    stop: async () => undefined,
    health: async () => ({ healthy: true }),
    ...overrides,
  };
}

function ports(overrides: Partial<DaemonRuntimePorts> = {}): DaemonRuntimePorts {
  return {
    components: [component()],
    hook: { handle: async () => '{"continue":true}' },
    mcp: { handle: async (input) => ({ input }) },
    worker: { runOnce: async () => ({ consumed: 1, produced: 1, cursor: 1, retryableFailures: 0 }) },
    ...overrides,
  };
}

describe("ZhiLoopDaemonRuntime", () => {
  it("starts components in order, exposes compatible health, and stops in reverse order", async () => {
    const calls: string[] = [];
    const runtime = new ZhiLoopDaemonRuntime(ports({ components: [
      component("ledger", { start: async () => { calls.push("start-ledger"); }, stop: async () => { calls.push("stop-ledger"); } }),
      component("registry", { start: async () => { calls.push("start-registry"); }, stop: async () => { calls.push("stop-registry"); } }),
    ] }), options);
    await Promise.all([runtime.start(), runtime.start()]);
    await runtime.start();
    expect(runtime.state).toBe("READY");
    expect(await runtime.health()).toMatchObject({ status: "READY", daemonState: "READY", components: [{ name: "ledger", healthy: true }, { name: "registry", healthy: true }] });
    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.stop();
    expect(runtime.state).toBe("STOPPED");
    expect(calls).toEqual(["start-ledger", "start-registry", "stop-registry", "stop-ledger"]);
  });

  it("rolls back already-started components and supports a later retry", async () => {
    let fail = true;
    let stops = 0;
    const runtime = new ZhiLoopDaemonRuntime(ports({ components: [
      component("ledger", { stop: async () => { stops += 1; } }),
      component("registry", { start: async () => { if (fail) throw new Error("registry unavailable"); } }),
    ] }), options);
    await expect(runtime.start()).rejects.toThrow("registry unavailable");
    expect(runtime.state).toBe("DEGRADED");
    expect(stops).toBe(1);
    expect(await runtime.health()).toMatchObject({ status: "DEGRADED", diagnostic: "Error: registry unavailable" });
    fail = false;
    await runtime.start();
    expect(runtime.state).toBe("READY");
    await runtime.stop();
  });

  it("fails Hook calls open when stopped, timed out, rejected, oversized, or NUL-tainted", async () => {
    const outputs: Array<() => string | undefined | Promise<string>> = [
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 100)),
      () => Promise.reject(new Error("hook failure")),
      () => "x".repeat(1_048_577),
      () => "bad\0output",
      () => undefined,
      () => '{"continue":true}',
    ];
    const runtime = new ZhiLoopDaemonRuntime(ports({ hook: { handle: async () => await outputs.shift()?.() as string } }), options);
    expect(await runtime.handleHook({ hook_event_name: "PostToolUse" })).toBe("");
    await runtime.start();
    expect(await runtime.handleHook({ hook_event_name: "UserPromptSubmit" })).toBe("");
    expect(await runtime.handleHook({ hook_event_name: "Stop" })).toBe("");
    expect(await runtime.handleHook({ hook_event_name: "SessionEnd" })).toBe("");
    expect(await runtime.handleHook({ hook_event_name: "Unknown" })).toBe("");
    expect(await runtime.handleHook(null)).toBe("");
    expect(await runtime.handleHook({ hook_event_name: "PostToolUse" })).toBe('{"continue":true}');
    await runtime.stop();
  });

  it("fails MCP closed and aborts in-flight MCP when stopping", async () => {
    let signal: AbortSignal | undefined;
    const runtime = new ZhiLoopDaemonRuntime(ports({ mcp: {
      handle: async (_input, received) => {
        signal = received;
        return await new Promise((_resolve, reject) => received.addEventListener("abort", () => reject(received.reason), { once: true }));
      },
    } }), options);
    await expect(runtime.handleMcp({})).rejects.toThrow("not ready");
    await runtime.start();
    const cancelled = new AbortController();
    cancelled.abort(new Error("caller cancelled"));
    await expect(runtime.handleMcp({}, cancelled.signal)).rejects.toThrow("caller cancelled");
    const request = runtime.handleMcp({ method: "ckl.search" });
    await Promise.resolve();
    const stopping = runtime.stop();
    await expect(request).rejects.toThrow("stopping");
    expect(signal?.aborted).toBe(true);
    await stopping;
  });

  it("runs one worker cycle at a time, records health, and rejects invalid or regressing cursors", async () => {
    let calls = 0;
    let release: ((value: DaemonWorkerCycle) => void) | undefined;
    const barrier = new Promise<DaemonWorkerCycle>((resolve) => { release = resolve; });
    const cycles: DaemonWorkerCycle[] = [];
    const runtime = new ZhiLoopDaemonRuntime(ports({ worker: { runOnce: async () => {
      calls += 1;
      return cycles.shift() ?? await barrier;
    } } }), options);
    await runtime.start();
    const first = runtime.runWorkerOnce();
    const duplicate = runtime.runWorkerOnce();
    release?.({ consumed: 2, produced: 1, cursor: 8, retryableFailures: 1 });
    expect(await Promise.all([first, duplicate])).toEqual([
      { consumed: 2, produced: 1, cursor: 8, retryableFailures: 1 },
      { consumed: 2, produced: 1, cursor: 8, retryableFailures: 1 },
    ]);
    expect(calls).toBe(1);
    expect(await runtime.health()).toMatchObject({ lastWorkerCycle: { cursor: 8 } });
    cycles.push({ consumed: 0, produced: 0, cursor: 7, retryableFailures: 0 });
    await expect(runtime.runWorkerOnce()).rejects.toThrow("invalid cycle");
    expect(await runtime.health()).toMatchObject({ status: "DEGRADED", diagnostic: "Error: daemon worker returned an invalid cycle" });
    cycles.push({ consumed: -1, produced: 0, cursor: 8, retryableFailures: 0 });
    await expect(runtime.runWorkerOnce()).rejects.toThrow("invalid cycle");
    await runtime.stop();
  });

  it("reports component health errors without leaking multiline diagnostics", async () => {
    const runtime = new ZhiLoopDaemonRuntime(ports({ components: [
      component("unhealthy", { health: async () => ({ healthy: false, diagnostic: "needs\nrepair" }) }),
      component("broken", { health: async () => { throw new Error("secret\nsecond line"); } }),
      component("invalid", { health: async () => ({ healthy: "yes" }) as never }),
    ] }), options);
    await runtime.start();
    expect(await runtime.health()).toMatchObject({ status: "DEGRADED", components: [
      { healthy: false, diagnostic: "needs repair" },
      { healthy: false, diagnostic: "Error: secret second line" },
      { healthy: false, diagnostic: "Error: component returned invalid health" },
    ] });
    await runtime.stop();
  });

  it("validates components, deadlines, clocks, and stop failures", async () => {
    expect(() => new ZhiLoopDaemonRuntime(ports({ components: [] }), options)).toThrow("unique safe names");
    expect(() => new ZhiLoopDaemonRuntime(ports({ components: [component("same"), component("same")] }), options)).toThrow("unique safe names");
    expect(() => new ZhiLoopDaemonRuntime(ports({ components: [component("bad\nname")] }), options)).toThrow("unique safe names");
    expect(() => new ZhiLoopDaemonRuntime(ports(), { ...options, hookDeadlinesMs: { Stop: 0 } })).toThrow("Stop deadline");
    expect(() => new ZhiLoopDaemonRuntime(ports(), { ...options, shutdownDeadlineMs: 30_001 })).toThrow("shutdownDeadlineMs");
    const badClock = new ZhiLoopDaemonRuntime(ports(), { ...options, clock: () => new Date(Number.NaN) });
    await expect(badClock.start()).rejects.toThrow("clock");
    const stopFailure = new ZhiLoopDaemonRuntime(ports({ components: [component("bad-stop", { stop: async () => { throw new Error("stop failed"); } })] }), options);
    await stopFailure.start();
    await expect(stopFailure.stop()).rejects.toThrow("stop failed");
    expect(stopFailure.state).toBe("DEGRADED");
  });

  it("rejects restart while a bounded shutdown is still running", async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new ZhiLoopDaemonRuntime(ports({ components: [component("slow-stop", { stop: async () => barrier })] }), options);
    await runtime.start();
    const stopping = runtime.stop();
    await expect(runtime.start()).rejects.toThrow("stopping");
    release?.();
    await stopping;
  });

  it("cannot become ready after shutdown begins during component startup", async () => {
    let release: (() => void) | undefined;
    let stops = 0;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new ZhiLoopDaemonRuntime(ports({ components: [component("slow-start", {
      start: async () => barrier,
      stop: async () => { stops += 1; },
    })] }), options);
    const starting = runtime.start();
    await Promise.resolve();
    const stopping = runtime.stop();
    release?.();
    await expect(starting).rejects.toThrow("stopping");
    await stopping;
    expect(runtime.state).toBe("STOPPED");
    expect(stops).toBe(1);
  });
});
