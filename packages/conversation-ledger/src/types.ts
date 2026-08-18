import type { EventEnvelope } from "@zhiloop/domain";

export interface LedgerEventRecord<TPayload = unknown> {
  readonly sequence: number;
  readonly event: EventEnvelope<TPayload>;
  readonly storedPayloadHash: string;
  readonly redactionCount: number;
  readonly payloadPurged: boolean;
  readonly insertedAt: string;
}

/** Bounded metadata for background consumers that must not materialize payloads. */
export interface SessionLedgerStats {
  readonly sessionId: string;
  readonly latestSequence: number;
  readonly eventCount: number;
  readonly turnCount: number;
  readonly latestEventType?: EventEnvelope["eventType"];
  readonly lastOccurredAt?: string;
}

export type AppendResult =
  | { readonly status: "appended"; readonly sequence: number; readonly redactionCount: number }
  | { readonly status: "duplicate"; readonly sequence: number };

export type CursorCommitResult =
  | { readonly status: "registered"; readonly sequence: number }
  | { readonly status: "advanced"; readonly previousSequence: number; readonly sequence: number }
  | { readonly status: "unchanged"; readonly sequence: number }
  | { readonly status: "rejected-rewind"; readonly currentSequence: number; readonly attemptedSequence: number };

export interface RetentionResult {
  readonly purgedPayloads: number;
  readonly safeThroughSequence: number;
  readonly blockedByMissingConsumer: boolean;
  readonly hasMore: boolean;
}

export interface EventLedgerOptions {
  readonly clock?: () => Date;
}

export interface IngestionCursorRecord<TCursor = unknown> {
  readonly ingestionId: string;
  readonly cursor: TCursor;
  readonly updatedAt: string;
}
