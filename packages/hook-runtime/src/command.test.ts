import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runCodexHookCommand } from "./command.js";
import { CodexHookHandler } from "./handler.js";

function handler(enqueue = vi.fn().mockResolvedValue(undefined)): CodexHookHandler {
  return new CodexHookHandler({
    sink: { enqueue },
    spool: {
      store: async (_event, redactionCount) => ({ status: "stored", fileName: "event.json", redactionCount }),
    },
    adapterOptions: { observedAt: "2026-08-01T08:00:00.000Z" },
  });
}

describe("runCodexHookCommand", () => {
  it("reads one bounded JSON object from stdin and invokes the handler", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const input = Readable.from([JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "record this",
    })]);

    await expect(runCodexHookCommand(input, handler(enqueue))).resolves.toMatchObject({
      exitCode: 0,
      capture: { status: "enqueued" },
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("fails open on malformed or oversized stdin", async () => {
    await expect(runCodexHookCommand(Readable.from(["{"]), handler())).resolves.toMatchObject({
      exitCode: 0,
      capture: { status: "dropped-invalid" },
    });
    await expect(runCodexHookCommand(Readable.from(["12345"]), handler(), { maxInputBytes: 4 })).resolves.toMatchObject({
      exitCode: 0,
      capture: { status: "dropped-invalid" },
    });
  });

  it("validates the input bound before reading", async () => {
    await expect(runCodexHookCommand(Readable.from([]), handler(), { maxInputBytes: 0 })).rejects.toThrow(
      "maxInputBytes must be a positive safe integer",
    );
  });
});
