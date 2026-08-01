import { describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "@zhiloop/domain";

import { CodexHookHandler } from "./handler.js";
import type { HookEventSink, HookEventSpool } from "./types.js";

const observedAt = "2026-08-01T08:00:00.000Z";

function promptHook(prompt = "keep this decision"): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "/workspace/project",
    prompt,
  };
}

function acceptingSpool(store = vi.fn()): HookEventSpool {
  return {
    store: async (event, redactionCount) => {
      store(event, redactionCount);
      return { status: "stored", fileName: "event.json", redactionCount };
    },
  };
}

describe("CodexHookHandler", () => {
  it("enqueues a normalized event without touching the spool", async () => {
    const enqueue = vi.fn<(event: EventEnvelope, signal: AbortSignal) => Promise<void>>().mockResolvedValue();
    const store = vi.fn();
    const handler = new CodexHookHandler({
      sink: { enqueue },
      spool: acceptingSpool(store),
      adapterOptions: { observedAt },
    });

    await expect(handler.handle(promptHook())).resolves.toMatchObject({ status: "enqueued" });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ source: "codex-hook", eventType: "user.prompted" });
    expect(store).not.toHaveBeenCalled();
  });

  it("redacts the full envelope before sending it to the daemon", async () => {
    const captured: EventEnvelope[] = [];
    const secret = `Bearer ${"d".repeat(24)}`;
    const handler = new CodexHookHandler({
      sink: { enqueue: async (event) => { captured.push(event); } },
      spool: acceptingSpool(),
      adapterOptions: { observedAt },
    });

    await expect(handler.handle({
      ...promptHook(`prompt=${secret}`),
      turn_id: `turn-${secret}`,
    })).resolves.toMatchObject({ status: "enqueued" });
    expect(JSON.stringify(captured)).not.toContain(secret);
    expect(captured[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails open and sends only redacted payload to the spool when the sink rejects", async () => {
    const captured: EventEnvelope[] = [];
    const counts: number[] = [];
    const spool: HookEventSpool = {
      store: async (event, redactionCount) => {
        captured.push(event);
        counts.push(redactionCount);
        return { status: "stored", fileName: "event.json", redactionCount };
      },
    };
    const sink: HookEventSink = { enqueue: async () => { throw new Error("daemon offline"); } };
    const handler = new CodexHookHandler({ sink, spool, adapterOptions: { observedAt } });
    const secret = `Bearer ${"a".repeat(24)}`;

    await expect(handler.handle(promptHook(`token=${secret}`))).resolves.toMatchObject({
      status: "spooled",
      reason: "sink-unavailable",
      spoolStatus: "stored",
    });
    expect(JSON.stringify(captured)).not.toContain(secret);
    expect(JSON.stringify(captured)).toContain("[REDACTED]");
    expect(counts).toEqual([1]);
  });

  it("aborts a hung sink at the deadline and spools the event", async () => {
    let aborted = false;
    const sink: HookEventSink = {
      enqueue: async (_event, signal) => await new Promise<void>(() => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      }),
    };
    const handler = new CodexHookHandler({
      sink,
      spool: acceptingSpool(),
      enqueueDeadlineMs: 10,
      adapterOptions: { observedAt },
    });
    const startedAt = performance.now();

    await expect(handler.handle(promptHook())).resolves.toMatchObject({
      status: "spooled",
      reason: "enqueue-timeout",
    });
    expect(aborted).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it("does not call the sink or spool for invalid hook input", async () => {
    const enqueue = vi.fn();
    const store = vi.fn();
    const handler = new CodexHookHandler({
      sink: { enqueue },
      spool: acceptingSpool(store),
      adapterOptions: { observedAt },
    });

    await expect(handler.handle({ hook_event_name: "BeforeToolUse" })).resolves.toMatchObject({
      status: "dropped-invalid",
      diagnostic: { code: "UNSUPPORTED_HOOK_EVENT" },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("still resolves successfully when both sink and spool fail", async () => {
    const handler = new CodexHookHandler({
      sink: { enqueue: async () => { throw new Error("offline"); } },
      spool: { store: async () => { throw new RangeError("disk unavailable"); } },
      adapterOptions: { observedAt },
    });

    await expect(handler.handle(promptHook())).resolves.toMatchObject({
      status: "dropped-spool-failed",
      reason: "sink-unavailable",
      errorName: "RangeError",
    });
  });

  it("does not expose a non-Error spool rejection", async () => {
    const handler = new CodexHookHandler({
      sink: { enqueue: async () => { throw new Error("offline"); } },
      spool: { store: async () => { throw "disk unavailable"; } },
      adapterOptions: { observedAt },
    });

    await expect(handler.handle(promptHook())).resolves.toMatchObject({
      status: "dropped-spool-failed",
      errorName: "UnknownError",
    });
  });

  it("bounds an invalid monotonic clock instead of returning NaN", async () => {
    const handler = new CodexHookHandler({
      sink: { enqueue: async () => undefined },
      spool: acceptingSpool(),
      adapterOptions: { observedAt },
      monotonicClock: () => Number.NaN,
    });

    await expect(handler.handle(promptHook())).resolves.toMatchObject({
      status: "spooled",
      reason: "enqueue-timeout",
      durationMs: 50,
    });
  });

  it("spools without calling a sink after adaptation consumes the deadline", async () => {
    const enqueue = vi.fn();
    const ticks = [0, 60, 61, 62];
    const handler = new CodexHookHandler({
      sink: { enqueue },
      spool: acceptingSpool(),
      enqueueDeadlineMs: 50,
      adapterOptions: { observedAt },
      monotonicClock: () => ticks.shift() ?? 62,
    });

    await expect(handler.handle(promptHook())).resolves.toMatchObject({
      status: "spooled",
      reason: "enqueue-timeout",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects deadlines that could violate the 100 ms capture gate", () => {
    const options = { sink: { enqueue: async () => undefined }, spool: acceptingSpool() };
    expect(() => new CodexHookHandler({ ...options, enqueueDeadlineMs: 0 })).toThrow();
    expect(() => new CodexHookHandler({ ...options, enqueueDeadlineMs: 101 })).toThrow();
    expect(() => new CodexHookHandler({ ...options, enqueueDeadlineMs: Number.NaN })).toThrow();
  });
});
