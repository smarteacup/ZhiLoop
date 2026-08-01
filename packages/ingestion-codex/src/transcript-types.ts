import type { EventEnvelope } from "@zhiloop/domain";

export const CODEX_TRANSCRIPT_FORMAT_V1 = "codex-rollout-jsonl-v1" as const;

export interface TranscriptCursor {
  readonly transcriptKey: string;
  readonly fileIdentity: string;
  readonly byteOffset: number;
  readonly lineNumber: number;
  readonly anchorStart: number;
  readonly anchorHash: string;
  readonly formatVersion?: typeof CODEX_TRANSCRIPT_FORMAT_V1;
  readonly sourceVersion?: string;
  readonly sessionId?: string;
  readonly activeTurnId?: string;
}

export interface TranscriptSessionStartedPayload {
  readonly kind: "transcript-session-started";
  readonly transcriptFormat: typeof CODEX_TRANSCRIPT_FORMAT_V1;
  readonly source?: string;
  readonly originator?: string;
}

export interface TranscriptUserPromptPayload {
  readonly kind: "transcript-user-prompt";
  readonly prompt: string;
}

export interface TranscriptTurnStoppedPayload {
  readonly kind: "transcript-turn-stopped";
  readonly lastAssistantMessage: string | null;
  readonly durationMs?: number;
}

export type TranscriptEventPayload =
  | TranscriptSessionStartedPayload
  | TranscriptUserPromptPayload
  | TranscriptTurnStoppedPayload;

export interface TranscriptReadBatch {
  readonly cursor: TranscriptCursor;
  readonly events: readonly EventEnvelope<TranscriptEventPayload>[];
  readonly ignoredRecords: number;
  readonly hasMore: boolean;
}

export interface TranscriptDiagnostic {
  readonly code:
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
  readonly message: string;
  readonly byteOffset: number;
  readonly lineNumber: number;
  readonly recoverable: boolean;
}

export type TranscriptReadResult =
  | { readonly ok: true; readonly value: TranscriptReadBatch }
  | {
      readonly ok: false;
      readonly error: TranscriptDiagnostic;
      readonly partial?: TranscriptReadBatch;
    };

export interface TranscriptReaderOptions {
  readonly maxReadBytes?: number;
  readonly maxLineBytes?: number;
}
