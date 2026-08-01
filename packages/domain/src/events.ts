export const EVENT_SOURCES = [
  "codex-hook",
  "codex-app-server",
  "filesystem",
  "git",
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_TYPES = [
  "session.started",
  "user.prompted",
  "tool.completed",
  "file.changed",
  "turn.stopped",
  "session.ended",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope<TPayload = unknown> {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly source: EventSource;
  readonly sourceVersion?: string;
  readonly sourceItemId?: string;
  readonly eventType: EventType;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly occurredAt: string;
  readonly cwd?: string;
  readonly projectHint?: string;
  readonly contentHash: string;
  readonly correlationId: string;
  readonly payload: TPayload;
}

