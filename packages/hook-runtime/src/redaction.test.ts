import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@zhiloop/domain";
import { adaptCodexHook } from "@zhiloop/ingestion-codex";

import { redactEventEnvelope } from "./redaction.js";

function event(): EventEnvelope {
  const result = adaptCodexHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    prompt: "safe",
  }, { observedAt: "2026-08-01T08:00:00.000Z" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("redactEventEnvelope", () => {
  it("rejects an invalid envelope before redaction", () => {
    expect(() => redactEventEnvelope({ ...event(), schemaVersion: 2 as 1 })).toThrow();
  });
});
