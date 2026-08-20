import type { CaptureEventSample } from "@zhiloop/codex-session-capture";
import { redactEventPayload } from "@zhiloop/conversation-ledger";
import type { EventEnvelope } from "@zhiloop/domain";

const MAX_CONTENT_PREVIEW_CHARACTERS = 2_000;

export function boundedContentPreview(payload: unknown): { readonly contentPreview: string; readonly contentTruncated: boolean } {
  let text: string | undefined;
  if (typeof payload === "string") text = payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["prompt", "lastAssistantMessage", "message", "text", "diff", "reason"] as const) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        text = candidate;
        break;
      }
    }
  }
  text ??= JSON.stringify(payload, null, 2);
  if (text === undefined || text.trim().length === 0) text = "（没有可展示的文本内容）";
  if (text.length <= MAX_CONTENT_PREVIEW_CHARACTERS) return { contentPreview: text, contentTruncated: false };
  let prefix = text.slice(0, MAX_CONTENT_PREVIEW_CHARACTERS - 1);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return {
    contentPreview: `${prefix}…`,
    contentTruncated: true,
  };
}

export function projectCaptureEvent(event: EventEnvelope): CaptureEventSample {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...boundedContentPreview(redactEventPayload(event.payload).value),
  };
}
