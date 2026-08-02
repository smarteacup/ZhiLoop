import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { adaptCodexHook } from "./adapter.js";
import { CodexAppServerEventAdapter } from "./app-server-adapter.js";

const FIXTURE = new URL("../../../test-fixtures/codex-app-server/v2/stream.jsonl", import.meta.url);
const OBSERVED_AT = "2026-08-02T08:00:02.000Z";

async function notifications(): Promise<unknown[]> {
  return (await readFile(FIXTURE, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
}

describe("Codex App Server adapter", () => {
  it("maps thread, final items, diff, and terminal turn while ignoring transient lifecycle data", async () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT, sourceVersion: "0.144.4" });
    const results = (await notifications()).map((notification) => adapter.adapt(notification));
    expect(results.every((result) => result.ok)).toBe(true);
    const events = results.flatMap((result) => result.ok ? result.value.events : []);

    expect(events.map((event) => event.eventType)).toEqual([
      "session.started", "user.prompted", "tool.completed", "file.changed", "turn.stopped",
    ]);
    expect(events[0]).toMatchObject({ source: "codex-app-server", sessionId: "session-fixture-1", cwd: "/workspace/project", sourceVersion: "0.144.4" });
    expect(events[1]?.payload).toMatchObject({ kind: "user-prompt", prompt: "Implement the adapter." });
    expect(events[2]?.payload).toMatchObject({ kind: "tool-completed", toolName: "commandExecution", toolUseId: "tool-fixture-1" });
    expect(events[3]?.payload).toMatchObject({ kind: "app-server-turn-diff" });
    expect(events[4]?.payload).toMatchObject({ kind: "turn-stopped", lastAssistantMessage: "Done.", status: "completed" });
    expect(events[1]?.occurredAt).toBe("2026-08-02T04:00:00.200Z");
    expect(Object.isFrozen(events[4]?.payload)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("futureField");
  });

  it("uses turn/completed items to recover final notifications missed during a reconnect", () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT });
    const result = adapter.adapt({
      method: "turn/completed",
      params: {
        threadId: "thread-recovery",
        turn: {
          id: "turn-recovery", status: "completed", completedAt: 1785643201, durationMs: 10, error: null,
          items: [
            { type: "userMessage", id: "user-recovery", content: [{ type: "text", text: "Recover me", text_elements: [] }] },
            { type: "agentMessage", id: "agent-recovery", text: "Recovered.", phase: "final_answer", memoryCitation: null },
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events.map((event) => event.eventType)).toEqual(["user.prompted", "turn.stopped"]);
      expect(result.value.events[1]?.payload).toMatchObject({ lastAssistantMessage: "Recovered." });
    }
  });

  it("makes Hook and App Server equivalent fixtures semantically consistent", () => {
    const hookPrompt = adaptCodexHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-fixture-1", turn_id: "turn-fixture-1", prompt: "Implement the adapter.",
    }, { observedAt: OBSERVED_AT });
    const hookStop = adaptCodexHook({
      hook_event_name: "Stop", session_id: "session-fixture-1", turn_id: "turn-fixture-1", stop_hook_active: false, last_assistant_message: "Done.",
    }, { observedAt: OBSERVED_AT });
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT });
    const prompt = adapter.adapt({
      method: "item/completed", params: { threadId: "session-fixture-1", turnId: "turn-fixture-1", completedAtMs: 1785643200200, item: { type: "userMessage", id: "turn-fixture-1", content: [{ type: "text", text: "Implement the adapter.", text_elements: [] }] } },
    });
    adapter.adapt({
      method: "item/completed", params: { threadId: "session-fixture-1", turnId: "turn-fixture-1", completedAtMs: 1785643200400, item: { type: "agentMessage", id: "agent-1", text: "Done.", phase: "final_answer", memoryCitation: null } },
    });
    const stopped = adapter.adapt({
      method: "turn/completed", params: { threadId: "session-fixture-1", turn: { id: "turn-fixture-1", status: "completed", items: [], completedAt: 1785643201, durationMs: 1000, error: null } },
    });
    const appPrompt = prompt.ok ? prompt.value.events[0] : undefined;
    const appStop = stopped.ok ? stopped.value.events[0] : undefined;
    expect(hookPrompt.ok && appPrompt !== undefined && hookPrompt.value.eventType === appPrompt.eventType).toBe(true);
    expect(hookPrompt.ok && hookPrompt.value.payload.kind === "user-prompt" && appPrompt?.payload.kind === "user-prompt" && hookPrompt.value.payload.prompt === appPrompt.payload.prompt).toBe(true);
    expect(hookStop.ok && appStop !== undefined && hookStop.value.eventType === appStop.eventType).toBe(true);
    expect(hookStop.ok && hookStop.value.payload.kind === "turn-stopped" && appStop?.payload.kind === "turn-stopped" && hookStop.value.payload.lastAssistantMessage === appStop.payload.lastAssistantMessage).toBe(true);
  });

  it("is deterministic across reconnections", () => {
    const notification = { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1785643200200, item: { type: "userMessage", id: "user-1", content: [{ type: "text", text: "same", text_elements: [] }] } } };
    const first = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT }).adapt(notification);
    const second = new CodexAppServerEventAdapter({ observedAt: "2026-08-02T09:00:00.000Z" }).adapt(notification);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.events[0]?.eventId).toBe(second.value.events[0]?.eventId);
  });

  it("does not emit started, delta, or duplicate completed items", () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT });
    expect(adapter.adapt({ method: "item/started", params: {} })).toMatchObject({ ok: true, value: { events: [], ignoredReason: "NON_AUTHORITATIVE_LIFECYCLE" } });
    const completed = { method: "item/completed", params: { threadId: "t", turnId: "u", completedAtMs: 1785643200200, item: { type: "userMessage", id: "i", content: [{ type: "text", text: "x", text_elements: [] }] } } };
    expect(adapter.adapt(completed)).toMatchObject({ ok: true, value: { ignored: false } });
    expect(adapter.adapt(completed)).toMatchObject({ ok: true, value: { events: [], ignoredReason: "DUPLICATE_IN_CONNECTION" } });
  });

  it("returns bounded diagnostics for unsupported, malformed, oversized, and invalid timestamp inputs", () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT, maxPayloadBytes: 256 });
    expect(adapter.adapt({ id: 1, method: "thread/closed", params: { threadId: "x" } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "thread/deleted", params: { threadId: "x" } })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "turn/diff/updated", params: { turnId: "y", diff: "" } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "thread/closed", params: { threadId: "x", padding: "x".repeat(300) } })).toMatchObject({ ok: false, error: { code: "APP_SERVER_NOTIFICATION_TOO_LARGE" } });
    expect(new CodexAppServerEventAdapter({ observedAt: "bad" }).adapt({ method: "turn/diff/updated", params: { threadId: "x", turnId: "y", diff: "" } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_TIMESTAMP" } });
    expect(new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT }).adapt({ method: "item/completed", params: { threadId: "x", turnId: "y", completedAtMs: -1, item: { type: "plan", id: "z", text: "x" } } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_TIMESTAMP" } });
  });

  it("maps final file and tool item variants and rejects an in-progress final item", () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT });
    const completed = (item: Record<string, unknown>) => adapter.adapt({
      method: "item/completed",
      params: { threadId: "thread-tools", turnId: "turn-tools", completedAtMs: 1785643200200, item },
    });
    const items = [
      { type: "fileChange", id: "file-1", status: "completed", changes: [{ path: "a.ts", kind: "update", diff: "+x" }] },
      { type: "mcpToolCall", id: "mcp-1", server: "knowledge", tool: "search", status: "completed", arguments: { q: "x" }, result: { content: [] }, error: null, durationMs: 1 },
      { type: "dynamicToolCall", id: "dynamic-1", namespace: null, tool: "lookup", status: "completed", arguments: {}, contentItems: [], success: true, durationMs: 2 },
      { type: "dynamicToolCall", id: "dynamic-2", namespace: "repo", tool: "lookup", status: "failed", arguments: {}, contentItems: null, success: false, durationMs: null },
      { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "completed", senderThreadId: "thread-tools", receiverThreadIds: ["child"], prompt: "check", agentsStates: {} },
      { type: "webSearch", id: "web-1", query: "Codex" },
      { type: "imageView", id: "image-1", path: "/tmp/a.png" },
    ];
    const events = items.map((item) => completed(item)).flatMap((result) => result.ok ? result.value.events : []);
    expect(events.map((event) => event.eventType)).toEqual(["file.changed", ...Array(6).fill("tool.completed")]);
    expect(events.map((event) => event.payload.kind === "tool-completed" ? event.payload.toolName : event.payload.kind)).toEqual([
      "app-server-file-changed", "knowledge.search", "lookup", "repo.lookup", "collaboration.spawnAgent", "webSearch", "imageView",
    ]);
    expect(completed({ type: "commandExecution", id: "running", status: "inProgress" })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
  });

  it("prefers final answers over later commentary and preserves failure details", () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT });
    const message = (id: string, text: string, phase: string | null) => adapter.adapt({
      method: "item/completed",
      params: { threadId: "thread-message", turnId: "turn-message", completedAtMs: 1785643200200, item: { type: "agentMessage", id, text, phase } },
    });
    expect(message("commentary-1", "Working", "commentary").ok).toBe(true);
    expect(message("final-1", "Final", "final_answer").ok).toBe(true);
    expect(message("commentary-2", "Later commentary", null).ok).toBe(true);
    const completed = adapter.adapt({
      method: "turn/completed",
      params: { threadId: "thread-message", turn: { id: "turn-message", status: "failed", items: [], completedAt: null, durationMs: null, error: { message: "failed" } } },
    });
    expect(completed).toMatchObject({ ok: true, value: { events: [{ payload: { lastAssistantMessage: "Final", status: "failed", error: { message: "failed" } } }] } });
    expect(message("bad", "Bad", "analysis")).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
  });

  it("validates constructors, thread metadata, diffs, turn recovery, and clocks", () => {
    expect(() => new CodexAppServerEventAdapter({ maxPayloadBytes: 0 })).toThrow("maxPayloadBytes");
    expect(() => new CodexAppServerEventAdapter({ maxStateEntries: 0 })).toThrow("maxStateEntries");
    expect(() => new CodexAppServerEventAdapter({ sourceVersion: "" })).toThrow("sourceVersion");
    const adapter = new CodexAppServerEventAdapter({ clock: () => new Date(OBSERVED_AT), maxStateEntries: 1 });
    expect(adapter.adapt(null)).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "", params: {} })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "turn/diff/updated", params: { threadId: "t", turnId: "u", diff: 1 } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "thread/started", params: { thread: { id: "minimal", createdAt: 1785643200 } } })).toMatchObject({ ok: true, value: { events: [{ payload: { kind: "app-server-session-started" } }] } });
    expect(adapter.adapt({ method: "thread/started", params: { thread: { id: "invalid", createdAt: 1785643200, modelProvider: 1 } } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "thread/started", params: { thread: { id: "invalid", createdAt: 1785643200, ephemeral: "no" } } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "thread/closed", params: { threadId: "minimal" } })).toMatchObject({ ok: true, value: { events: [], ignoredReason: "NON_AUTHORITATIVE_LIFECYCLE" } });
    expect(new CodexAppServerEventAdapter({ clock: () => new Date(Number.NaN) }).adapt({ method: "turn/diff/updated", params: { threadId: "x", turnId: "y", diff: "" } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_TIMESTAMP" } });
  });

  it("fails closed on malformed completed turns and user items", () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT });
    const completeTurn = (turn: unknown) => adapter.adapt({ method: "turn/completed", params: { threadId: "thread-invalid", turn } });
    expect(completeTurn({ id: "t", status: "inProgress", items: [], completedAt: 1785643201 })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(completeTurn({ id: "t", status: "completed", items: {}, completedAt: 1785643201 })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(completeTurn({ id: "t", status: "completed", items: [null], completedAt: 1785643201 })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(completeTurn({ id: "t", status: "completed", items: [], completedAt: 1785643201, durationMs: -1 })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "item/completed", params: { threadId: "x", turnId: "y", completedAtMs: 1785643200200, item: { type: "userMessage", id: "u", content: {} } } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_NOTIFICATION" } });
    expect(adapter.adapt({ method: "item/completed", params: { threadId: "x", turnId: "y", completedAtMs: 1785643200200, item: { type: "plan", id: "p", text: "ignored" } } })).toMatchObject({ ok: true, value: { ignoredReason: "NON_MATERIAL_ITEM" } });
  });

  it("bounds per-connection deduplication and message state", () => {
    const adapter = new CodexAppServerEventAdapter({ observedAt: OBSERVED_AT, maxStateEntries: 1 });
    const user = (id: string) => ({ method: "item/completed", params: { threadId: "thread-bound", turnId: id, completedAtMs: 1785643200200, item: { type: "userMessage", id, content: [{ type: "text", text: id }] } } });
    expect(adapter.adapt(user("one"))).toMatchObject({ ok: true, value: { ignored: false } });
    expect(adapter.adapt(user("two"))).toMatchObject({ ok: true, value: { ignored: false } });
    expect(adapter.adapt(user("one"))).toMatchObject({ ok: true, value: { ignored: false } });
    adapter.adapt({ method: "item/completed", params: { threadId: "thread-bound", turnId: "old", completedAtMs: 1785643200200, item: { type: "agentMessage", id: "a", text: "old", phase: null } } });
    adapter.adapt({ method: "item/completed", params: { threadId: "thread-bound", turnId: "new", completedAtMs: 1785643200200, item: { type: "agentMessage", id: "b", text: "new", phase: null } } });
    const old = adapter.adapt({ method: "turn/completed", params: { threadId: "thread-bound", turn: { id: "old", status: "interrupted", items: [], completedAt: 1785643201, error: null } } });
    expect(old).toMatchObject({ ok: true, value: { events: [{ payload: { lastAssistantMessage: null } }] } });
  });

  it.each([
    "2026-02-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00",
  ])("rejects invalid fallback time %s", (observedAt) => {
    expect(new CodexAppServerEventAdapter({ observedAt }).adapt({ method: "turn/diff/updated", params: { threadId: "x", turnId: "y", diff: "" } })).toMatchObject({ ok: false, error: { code: "INVALID_APP_SERVER_TIMESTAMP" } });
  });
});
