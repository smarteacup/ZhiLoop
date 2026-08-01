import type { EventSource, EventType } from "./events.js";

export type NormalizedSessionStatus = "OPEN" | "CLOSED";
export type SessionCloseReason = "SOURCE_END" | "NEXT_SESSION" | "INACTIVITY_TIMEOUT";
export type NormalizedTurnStatus = "OPEN" | "CLOSED";
export type TurnCloseReason = "STOP_EVENT" | "NEXT_TURN" | "SESSION_CLOSED";

export interface NormalizedEventRef {
  readonly eventId: string;
  readonly source: EventSource;
  readonly eventType: EventType;
  readonly sourceOrder: number;
  readonly occurredAt: string;
}

export interface NormalizedTurn {
  readonly turnId: string;
  readonly sessionId: string;
  readonly syntheticId: boolean;
  readonly status: NormalizedTurnStatus;
  readonly closeReason?: TurnCloseReason;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly stopEventCount: number;
  readonly events: readonly NormalizedEventRef[];
}

export interface NormalizedSession {
  readonly sessionId: string;
  readonly status: NormalizedSessionStatus;
  readonly closeReason?: SessionCloseReason;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly closedAt?: string;
  readonly contextKey?: string;
  readonly sources: readonly EventSource[];
  readonly sessionEvents: readonly NormalizedEventRef[];
  readonly turns: readonly NormalizedTurn[];
}
