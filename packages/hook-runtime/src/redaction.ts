import { redactEventPayload } from "@zhiloop/conversation-ledger/redaction";
import type { EventEnvelope } from "@zhiloop/domain";
import { parseEventEnvelope } from "@zhiloop/schemas";

export interface RedactedEventEnvelope {
  readonly event: EventEnvelope;
  readonly redactionCount: number;
}

export function redactEventEnvelope(event: EventEnvelope): RedactedEventEnvelope {
  const parsed = parseEventEnvelope(event);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const redacted = redactEventPayload(parsed.value);
  const reparsed = parseEventEnvelope(redacted.value);
  if (!reparsed.ok) throw new Error("event redaction changed the envelope into an invalid shape");
  return { event: reparsed.value, redactionCount: redacted.redactionCount };
}
