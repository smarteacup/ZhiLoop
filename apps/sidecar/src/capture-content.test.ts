import type { EventEnvelope } from "@zhiloop/domain";
import { describe, expect, it } from "vitest";

import { boundedContentPreview, projectCaptureEvent } from "./capture-content.js";

function event(payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    source: "codex-transcript",
    eventType: "user.prompted",
    sessionId: "session-1",
    turnId: "turn-1",
    occurredAt: "2026-08-04T00:00:00.000Z",
    contentHash: "a".repeat(64),
    correlationId: "correlation-1",
    payload,
  };
}

describe("capture content projection", () => {
  it("prefers conversational text and redacts secrets before exposing a preview", () => {
    expect(projectCaptureEvent(event({ prompt: "deploy with sk-abcdefghijklmnop", other: "ignored" }))).toMatchObject({
      eventId: "event-1",
      turnId: "turn-1",
      contentPreview: "deploy with [REDACTED]",
      contentTruncated: false,
    });
  });

  it("bounds Unicode content without retaining an oversized raw payload", () => {
    const value = boundedContentPreview({ prompt: "知".repeat(2_001) });
    expect(value.contentPreview).toHaveLength(2_000);
    expect(value.contentPreview.endsWith("…")).toBe(true);
    expect(value.contentTruncated).toBe(true);
  });

  it("bounds astral Unicode by the UTF-16 length enforced by the control schema", () => {
    const value = boundedContentPreview({ prompt: "😀".repeat(1_001) });
    expect(value.contentPreview.length).toBeLessThanOrEqual(2_000);
    expect(value.contentPreview.endsWith("…")).toBe(true);
    expect(value.contentPreview).not.toContain("\uFFFD");
    expect(value.contentTruncated).toBe(true);
  });

  it("renders string, structured fallback, and empty payloads without inventing content", () => {
    expect(boundedContentPreview("plain message")).toEqual({
      contentPreview: "plain message",
      contentTruncated: false,
    });
    expect(boundedContentPreview({ other: "kept as structured evidence" }).contentPreview)
      .toContain("kept as structured evidence");
    expect(boundedContentPreview(undefined)).toEqual({
      contentPreview: "（没有可展示的文本内容）",
      contentTruncated: false,
    });
  });
});
