import type { EventEnvelope } from "@zhiloop/domain";
import type { TranscriptCursor } from "@zhiloop/ingestion-codex";

export type SessionCaptureErrorCode =
  | "INVALID_SESSION_ID"
  | "UNSAFE_SESSIONS_ROOT"
  | "DISCOVERY_LIMIT_EXCEEDED"
  | "SESSION_NOT_FOUND"
  | "SESSION_AMBIGUOUS"
  | "TRANSCRIPT_METADATA_TOO_LARGE"
  | "CAPTURE_BATCH_LIMIT_EXCEEDED"
  | "TRANSCRIPT_IO_ERROR"
  | "TRANSCRIPT_REPLACED"
  | "TRANSCRIPT_TRUNCATED"
  | "TRANSCRIPT_ANCHOR_MISMATCH"
  | "INVALID_TRANSCRIPT_OPTIONS"
  | "INVALID_TRANSCRIPT_CURSOR"
  | "TRANSCRIPT_LINE_TOO_LARGE"
  | "MALFORMED_TRANSCRIPT_LINE"
  | "UNSUPPORTED_TRANSCRIPT_FORMAT"
  | "INVALID_TRANSCRIPT_RECORD";

export class SessionCaptureError extends Error {
  readonly code: SessionCaptureErrorCode;
  readonly lineNumber?: number;
  readonly byteOffset?: number;

  constructor(code: SessionCaptureErrorCode, options: { readonly lineNumber?: number; readonly byteOffset?: number } = {}) {
    super(code);
    this.name = "SessionCaptureError";
    this.code = code;
    if (options.lineNumber !== undefined) this.lineNumber = options.lineNumber;
    if (options.byteOffset !== undefined) this.byteOffset = options.byteOffset;
  }
}

export interface TranscriptLocatorOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly maxMetadataBytes?: number;
}

export interface LocatedTranscript {
  readonly path: string;
  readonly sessionId: string;
}

export interface CaptureAppendResult {
  readonly status: "appended" | "duplicate";
}

export interface CaptureEventSink {
  appendBatch(events: readonly EventEnvelope[]): readonly CaptureAppendResult[];
}

export interface CaptureCursorStore {
  load(ingestionId: string): TranscriptCursor | undefined;
  commit(ingestionId: string, cursor: TranscriptCursor): void;
}

export interface CaptureSessionRequest {
  readonly sessionId: string;
  readonly dryRun?: boolean;
}

export interface CaptureServiceOptions extends TranscriptLocatorOptions {
  readonly maxBatches?: number;
  readonly appendBatchSize?: number;
  readonly maxReadBytes?: number;
  readonly maxLineBytes?: number;
  readonly projectEvent?: (event: EventEnvelope) => CaptureEventSample;
}

export interface CaptureEventSample {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly turnId?: string;
  readonly contentPreview: string;
  readonly contentTruncated: boolean;
}

export interface CaptureSessionReport {
  readonly schemaVersion: 1;
  readonly status: "CAPTURED" | "PREVIEWED";
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly batches: number;
  readonly projectedEvents: number;
  readonly appendedEvents: number;
  readonly duplicateEvents: number;
  readonly ignoredRecords: number;
  readonly eventTypes: Readonly<Record<string, number>>;
  readonly sampledEvents: readonly CaptureEventSample[];
  readonly sampledEventsTruncated: boolean;
  readonly appendedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly eventIdsTruncated: boolean;
  readonly cursor: {
    readonly byteOffset: number;
    readonly lineNumber: number;
  };
  readonly hasMore: boolean;
  readonly knowledgeCompiled: false;
}
