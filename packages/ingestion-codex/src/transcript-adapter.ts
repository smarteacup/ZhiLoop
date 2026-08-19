import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import type { EventEnvelope, EventType } from "@zhiloop/domain";
import { parseEventEnvelope } from "@zhiloop/schemas";

import { canonicalStringify } from "./canonical-json.js";
import {
  CODEX_TRANSCRIPT_FORMAT_V1,
  type TranscriptCursor,
  type TranscriptDiagnostic,
  type TranscriptEventPayload,
  type TranscriptReadBatch,
  type TranscriptReaderOptions,
  type TranscriptReadResult,
} from "./transcript-types.js";

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
// Codex tool outputs can legitimately exceed 1 MiB even though the normalized
// projection ignores them. Keep this below the bounded read window so a record
// can be classified without accepting unbounded input.
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const ANCHOR_BYTES = 4096;
const SUPPORTED_V1_CLI_VERSION = /^0\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

interface ReaderState {
  formatVersion?: typeof CODEX_TRANSCRIPT_FORMAT_V1;
  sourceVersion?: string;
  sessionId?: string;
  activeTurnId?: string;
}

interface RolloutRecord {
  readonly type: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashValue(value: unknown): string {
  return digest(canonicalStringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileIdentity(stat: { dev: number | bigint; ino: number | bigint }): string {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

function transcriptKey(path: string): string {
  return digest(path);
}

function option(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive safe integer`);
  return resolved;
}

function validCursor(cursor: TranscriptCursor): boolean {
  return (
    Number.isSafeInteger(cursor.byteOffset) &&
    cursor.byteOffset >= 0 &&
    Number.isSafeInteger(cursor.lineNumber) &&
    cursor.lineNumber >= 0 &&
    Number.isSafeInteger(cursor.anchorStart) &&
    cursor.anchorStart >= 0 &&
    cursor.anchorStart <= cursor.byteOffset &&
    cursor.byteOffset - cursor.anchorStart <= ANCHOR_BYTES &&
    /^[a-f0-9]{64}$/.test(cursor.transcriptKey) &&
    /^[a-f0-9]{64}$/.test(cursor.anchorHash) &&
    cursor.fileIdentity.length > 0 &&
    (cursor.formatVersion === undefined ||
      (cursor.formatVersion === CODEX_TRANSCRIPT_FORMAT_V1 &&
        cursor.sourceVersion !== undefined &&
        cursor.sessionId !== undefined))
  );
}

async function readRange(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

async function withAnchor(
  handle: FileHandle,
  transcriptKeyValue: string,
  identity: string,
  byteOffset: number,
  lineNumber: number,
  state: ReaderState,
): Promise<TranscriptCursor> {
  const anchorStart = Math.max(0, byteOffset - ANCHOR_BYTES);
  const anchor = await readRange(handle, anchorStart, byteOffset - anchorStart);
  return {
    transcriptKey: transcriptKeyValue,
    fileIdentity: identity,
    byteOffset,
    lineNumber,
    anchorStart,
    anchorHash: digest(anchor),
    ...(state.formatVersion === undefined ? {} : { formatVersion: state.formatVersion }),
    ...(state.sourceVersion === undefined ? {} : { sourceVersion: state.sourceVersion }),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(state.activeTurnId === undefined ? {} : { activeTurnId: state.activeTurnId }),
  };
}

function failure(
  code: TranscriptDiagnostic["code"],
  message: string,
  byteOffset: number,
  lineNumber: number,
  recoverable: boolean,
  partial?: TranscriptReadBatch,
): TranscriptReadResult {
  return {
    ok: false,
    error: { code, message, byteOffset, lineNumber, recoverable },
    ...(partial === undefined ? {} : { partial }),
  };
}

function parseRecord(line: string): RolloutRecord {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || typeof parsed["type"] !== "string" || typeof parsed["timestamp"] !== "string" || !isRecord(parsed["payload"])) {
    throw new Error("record must contain type, timestamp, and object payload");
  }
  return { type: parsed["type"], timestamp: parsed["timestamp"], payload: parsed["payload"] };
}

function optionalText(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildEvent(
  record: RolloutRecord,
  state: ReaderState,
  eventType: EventType,
  sourceItemId: string,
  payload: TranscriptEventPayload,
  turnId?: string,
): EventEnvelope<TranscriptEventPayload> {
  if (state.sessionId === undefined) throw new Error("session metadata must precede transcript events");
  const payloadJson = canonicalStringify(payload);
  const contentHash = digest(payloadJson);
  const eventId = hashValue([
    "codex-transcript",
    state.sessionId,
    turnId ?? null,
    eventType,
    sourceItemId,
    contentHash,
  ]);
  const envelope: EventEnvelope<TranscriptEventPayload> = {
    schemaVersion: 1,
    eventId,
    source: "codex-transcript",
    ...(state.sourceVersion === undefined ? {} : { sourceVersion: state.sourceVersion }),
    sourceItemId,
    eventType,
    sessionId: state.sessionId,
    ...(turnId === undefined ? {} : { turnId }),
    occurredAt: record.timestamp,
    contentHash,
    correlationId: hashValue([state.sessionId, turnId ?? null]),
    payload,
  };
  const validated = parseEventEnvelope(envelope);
  if (!validated.ok) throw new Error(validated.error.message);
  return Object.freeze({ ...envelope, payload: Object.freeze(payload) });
}

function detectFormat(record: RolloutRecord, state: ReaderState): EventEnvelope<TranscriptEventPayload> {
  if (record.type !== "session_meta") throw new Error("first record is not session_meta");
  const sessionId = optionalText(record.payload, "session_id") ?? optionalText(record.payload, "id");
  const sourceVersion = optionalText(record.payload, "cli_version");
  if (sessionId === undefined || sourceVersion === undefined) {
    throw new Error("session_meta is missing session id or cli_version");
  }
  if (!SUPPORTED_V1_CLI_VERSION.test(sourceVersion)) {
    throw new Error(`unsupported transcript cli_version: ${sourceVersion}`);
  }
  state.formatVersion = CODEX_TRANSCRIPT_FORMAT_V1;
  state.sessionId = sessionId;
  state.sourceVersion = sourceVersion;
  const source = optionalText(record.payload, "source");
  const originator = optionalText(record.payload, "originator");
  const payload: TranscriptEventPayload = {
    kind: "transcript-session-started",
    transcriptFormat: CODEX_TRANSCRIPT_FORMAT_V1,
    ...(source === undefined ? {} : { source }),
    ...(originator === undefined ? {} : { originator }),
  };
  return buildEvent(record, state, "session.started", hashValue(record), payload);
}

function projectRecord(record: RolloutRecord, state: ReaderState): EventEnvelope<TranscriptEventPayload> | undefined {
  const subtype = optionalText(record.payload, "type");
  if (record.type === "event_msg" && subtype === "task_started") {
    const turnId = optionalText(record.payload, "turn_id");
    if (turnId !== undefined) state.activeTurnId = turnId;
    return undefined;
  }
  if (record.type === "turn_context") {
    const turnId = optionalText(record.payload, "turn_id");
    if (turnId !== undefined) state.activeTurnId = turnId;
    return undefined;
  }
  if (record.type === "event_msg" && subtype === "user_message") {
    const prompt = optionalText(record.payload, "message");
    if (prompt === undefined) throw new Error("user_message is missing message");
    return buildEvent(
      record,
      state,
      "user.prompted",
      optionalText(record.payload, "client_id") ?? hashValue(record),
      { kind: "transcript-user-prompt", prompt },
      state.activeTurnId,
    );
  }
  if (record.type === "event_msg" && subtype === "task_complete") {
    const turnId = optionalText(record.payload, "turn_id") ?? state.activeTurnId;
    const message = record.payload["last_agent_message"];
    if (message !== null && typeof message !== "string") throw new Error("task_complete has invalid last_agent_message");
    const duration = record.payload["duration_ms"];
    if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) {
      throw new Error("task_complete has invalid duration_ms");
    }
    const payload: TranscriptEventPayload = {
      kind: "transcript-turn-stopped",
      lastAssistantMessage: message,
      ...(duration === undefined ? {} : { durationMs: duration }),
    };
    const event = buildEvent(record, state, "turn.stopped", hashValue(record), payload, turnId);
    delete state.activeTurnId;
    return event;
  }
  return undefined;
}

export async function readTranscriptIncrement(
  path: string,
  cursor?: TranscriptCursor,
  options: TranscriptReaderOptions = {},
): Promise<TranscriptReadResult> {
  let handle: FileHandle | undefined;
  if (cursor !== undefined && !validCursor(cursor)) {
    return failure(
      "INVALID_TRANSCRIPT_CURSOR",
      "transcript cursor is malformed or internally inconsistent",
      0,
      0,
      false,
    );
  }
  let maxReadBytes: number;
  let maxLineBytes: number;
  try {
    maxReadBytes = option(options.maxReadBytes, DEFAULT_MAX_READ_BYTES, "maxReadBytes");
    maxLineBytes = option(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
    if (maxReadBytes <= maxLineBytes) throw new Error("maxReadBytes must be greater than maxLineBytes");
  } catch (error) {
    return failure(
      "INVALID_TRANSCRIPT_OPTIONS",
      error instanceof Error ? error.message : String(error),
      cursor?.byteOffset ?? 0,
      cursor?.lineNumber ?? 0,
      false,
    );
  }
  try {
    const resolvedPath = resolvePath(path);
    handle = await open(resolvedPath, "r");
    const stat = await handle.stat();
    const identity = fileIdentity(stat);
    const key = transcriptKey(resolvedPath);
    const initialState: ReaderState = {
      ...(cursor?.formatVersion === undefined ? {} : { formatVersion: cursor.formatVersion }),
      ...(cursor?.sourceVersion === undefined ? {} : { sourceVersion: cursor.sourceVersion }),
      ...(cursor?.sessionId === undefined ? {} : { sessionId: cursor.sessionId }),
      ...(cursor?.activeTurnId === undefined ? {} : { activeTurnId: cursor.activeTurnId }),
    };

    if (cursor !== undefined) {
      if (cursor.transcriptKey !== key || cursor.fileIdentity !== identity) {
        return failure("TRANSCRIPT_REPLACED", "transcript path or file identity changed", cursor.byteOffset, cursor.lineNumber, true);
      }
      if (stat.size < cursor.byteOffset) {
        return failure("TRANSCRIPT_TRUNCATED", "transcript is shorter than the committed cursor", cursor.byteOffset, cursor.lineNumber, true);
      }
      const anchor = await readRange(handle, cursor.anchorStart, cursor.byteOffset - cursor.anchorStart);
      if (digest(anchor) !== cursor.anchorHash) {
        return failure("TRANSCRIPT_ANCHOR_MISMATCH", "transcript content before the cursor changed", cursor.byteOffset, cursor.lineNumber, true);
      }
    }

    const start = cursor?.byteOffset ?? 0;
    const lineStart = cursor?.lineNumber ?? 0;
    const available = Math.max(0, stat.size - start);
    const readLength = Math.min(available, maxReadBytes);
    const chunk = await readRange(handle, start, readLength);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      if (chunk.length > maxLineBytes) {
        return failure("TRANSCRIPT_LINE_TOO_LARGE", "transcript line exceeds configured limit", start, lineStart + 1, false);
      }
      const nextCursor = await withAnchor(handle, key, identity, start, lineStart, initialState);
      return { ok: true, value: { cursor: nextCursor, events: [], ignoredRecords: 0, hasMore: available > 0 } };
    }

    const complete = chunk.subarray(0, lastNewline + 1);
    const events: EventEnvelope<TranscriptEventPayload>[] = [];
    let ignoredRecords = 0;
    let relativeOffset = 0;
    let lineNumber = lineStart;
    while (relativeOffset < complete.length) {
      const newline = complete.indexOf(0x0a, relativeOffset);
      const rawLine = complete.subarray(relativeOffset, newline > relativeOffset && complete[newline - 1] === 0x0d ? newline - 1 : newline);
      const absoluteOffset = start + relativeOffset;
      lineNumber += 1;
      if (rawLine.length > maxLineBytes) {
        const partialCursor = await withAnchor(handle, key, identity, absoluteOffset, lineNumber - 1, initialState);
        return failure(
          "TRANSCRIPT_LINE_TOO_LARGE",
          "transcript line exceeds configured limit",
          absoluteOffset,
          lineNumber,
          false,
          { cursor: partialCursor, events, ignoredRecords, hasMore: true },
        );
      }
      try {
        const record = parseRecord(rawLine.toString("utf8"));
        const event = initialState.formatVersion === undefined
          ? detectFormat(record, initialState)
          : projectRecord(record, initialState);
        if (event === undefined) ignoredRecords += 1;
        else events.push(event);
      } catch (error) {
        const partialCursor = await withAnchor(handle, key, identity, absoluteOffset, lineNumber - 1, initialState);
        const formatError = initialState.formatVersion === undefined && lineNumber === 1;
        return failure(
          formatError ? "UNSUPPORTED_TRANSCRIPT_FORMAT" : "MALFORMED_TRANSCRIPT_LINE",
          error instanceof Error ? error.message : String(error),
          absoluteOffset,
          lineNumber,
          formatError ? false : true,
          { cursor: partialCursor, events, ignoredRecords, hasMore: true },
        );
      }
      relativeOffset = newline + 1;
    }

    const nextOffset = start + complete.length;
    const nextCursor = await withAnchor(handle, key, identity, nextOffset, lineNumber, initialState);
    return {
      ok: true,
      value: {
        cursor: nextCursor,
        events,
        ignoredRecords,
        hasMore: nextOffset < stat.size,
      },
    };
  } catch (error) {
    return failure(
      "TRANSCRIPT_IO_ERROR",
      error instanceof Error ? error.message : String(error),
      cursor?.byteOffset ?? 0,
      cursor?.lineNumber ?? 0,
      true,
    );
  } finally {
    await handle?.close();
  }
}
