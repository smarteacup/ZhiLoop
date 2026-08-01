import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { adaptCodexHook } from "./adapter.js";
import { canonicalStringify, normalizeJson } from "./canonical-json.js";

const FIXTURE_DIRECTORY = new URL("../../../test-fixtures/codex-hooks/", import.meta.url);
const OBSERVED_AT = "2026-08-01T10:00:00.000Z";

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`${name}.json`, FIXTURE_DIRECTORY), "utf8")) as Record<string, unknown>;
}

describe("Codex Hook adapter fixtures", () => {
  it.each([
    ["user-prompt-submit", "user.prompted", "user-prompt"],
    ["post-tool-use", "tool.completed", "tool-completed"],
    ["stop", "turn.stopped", "turn-stopped"],
    ["session-end", "session.ended", "session-ended"],
  ] as const)("normalizes %s", async (name, eventType, payloadKind) => {
    const result = adaptCodexHook(await fixture(name), { observedAt: OBSERVED_AT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        schemaVersion: 1,
        source: "codex-hook",
        eventType,
        sessionId: "session-fixture-1",
        occurredAt: OBSERVED_AT,
        payload: { kind: payloadKind },
      });
      expect(result.value.eventId).toMatch(/^[a-f0-9]{64}$/);
      expect(result.value.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.payload)).toBe(true);
      expect(JSON.stringify(result.value)).not.toContain("transcript_path");
      expect(JSON.stringify(result.value)).not.toContain("future_field");
    }
  });

  it("accepts missing optional turn_id and transcript_path", async () => {
    const input = await fixture("user-prompt-submit");
    delete input["turn_id"];
    delete input["transcript_path"];

    const result = adaptCodexHook(input, { observedAt: OBSERVED_AT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.turnId).toBeUndefined();
      expect(result.value.sourceItemId).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("ignores unknown hook fields without changing event identity", async () => {
    const withUnknown = await fixture("user-prompt-submit");
    const withoutUnknown = { ...withUnknown };
    delete withoutUnknown["future_field"];

    const first = adaptCodexHook(withUnknown, { observedAt: OBSERVED_AT });
    const second = adaptCodexHook(withoutUnknown, { observedAt: "2026-08-01T11:00:00.000Z" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.eventId).toBe(second.value.eventId);
      expect(first.value.contentHash).toBe(second.value.contentHash);
      expect(first.value.occurredAt).not.toBe(second.value.occurredAt);
    }
  });

  it("changes event identity when normalized tool output changes", async () => {
    const input = await fixture("post-tool-use");
    const changed = { ...input, tool_response: { exitCode: 1, output: "failed" } };
    const first = adaptCodexHook(input, { observedAt: OBSERVED_AT });
    const second = adaptCodexHook(changed, { observedAt: OBSERVED_AT });
    expect(first.ok && second.ok && first.value.eventId !== second.value.eventId).toBe(true);
  });
});

describe("Codex Hook adapter diagnostics", () => {
  it("rejects unsupported events distinctly", () => {
    const result = adaptCodexHook({ session_id: "s1", hook_event_name: "PreToolUse" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_HOOK_EVENT", issues: [{ path: "$.hook_event_name" }] },
    });
  });

  it.each([
    ["non-object", null],
    ["missing session", { hook_event_name: "SessionEnd", reason: "other" }],
    ["invalid permission", { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "x", permission_mode: "root" }],
    ["missing tool output", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: {} }],
    ["invalid stop flag", { session_id: "s1", hook_event_name: "Stop", stop_hook_active: "false", last_assistant_message: null }],
    ["future end reason", { session_id: "s1", hook_event_name: "SessionEnd", reason: "logout" }],
  ] as const)("rejects invalid input: %s", (_name, input) => {
    expect(adaptCodexHook(input, { observedAt: OBSERVED_AT })).toMatchObject({
      ok: false,
      error: { code: "INVALID_HOOK_INPUT" },
    });
  });

  it("rejects invalid observation dates and adapter limits", async () => {
    const input = await fixture("user-prompt-submit");
    expect(adaptCodexHook(input, { observedAt: "not-a-date" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OBSERVED_AT" },
    });
    expect(adaptCodexHook(input, { observedAt: OBSERVED_AT, maxPayloadBytes: 1 })).toMatchObject({
      ok: false,
      error: { code: "HOOK_INPUT_TOO_LARGE" },
    });
    expect(adaptCodexHook(input, { observedAt: OBSERVED_AT, maxPayloadBytes: 0 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_HOOK_INPUT" },
    });
  });

  it("uses the injected clock when observedAt is omitted", async () => {
    const result = adaptCodexHook(await fixture("session-end"), {
      clock: () => new Date(OBSERVED_AT),
    });
    expect(result).toMatchObject({ ok: true, value: { occurredAt: OBSERVED_AT } });
  });

  it("uses the system clock by default and rejects an invalid injected clock", async () => {
    const input = await fixture("session-end");
    delete input["model"];
    const current = adaptCodexHook(input);
    expect(current.ok).toBe(true);
    if (current.ok) expect(Number.isNaN(Date.parse(current.value.occurredAt))).toBe(false);

    expect(adaptCodexHook(input, { clock: () => new Date(Number.NaN) })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OBSERVED_AT" },
    });
    expect(adaptCodexHook(input, { observedAt: "2026-08-01" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OBSERVED_AT" },
    });
    expect(adaptCodexHook(input, { observedAt: "2026-02-31T10:00:00Z" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OBSERVED_AT" },
    });
  });
});

describe("canonical JSON", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalStringify({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(canonicalStringify({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it.each([
    ["non-finite number", Number.NaN],
    ["undefined", undefined],
    ["non-JSON object", new Date(OBSERVED_AT)],
    ["excessive depth", Array.from({ length: 34 }).reduce<unknown>((value) => [value], null)],
  ])("rejects %s", (_name, value) => {
    expect(() => normalizeJson(value)).toThrow();
  });

  it("rejects cyclic objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => normalizeJson(cyclic)).toThrow("cyclic reference");
  });
});
