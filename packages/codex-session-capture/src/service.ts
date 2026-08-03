import { readTranscriptIncrement, type TranscriptCursor } from "@zhiloop/ingestion-codex";

import { locateCodexTranscript } from "./locator.js";
import {
  SessionCaptureError,
  type CaptureCursorStore,
  type CaptureEventSink,
  type CaptureServiceOptions,
  type CaptureSessionReport,
  type CaptureSessionRequest,
} from "./types.js";

const DEFAULT_MAX_BATCHES = 16;
const DEFAULT_APPEND_BATCH_SIZE = 500;

function positive(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new SessionCaptureError("CAPTURE_BATCH_LIMIT_EXCEEDED");
  }
  return selected;
}

export class CodexSessionCaptureService {
  readonly #appendBatchSize: number;
  readonly #maxBatches: number;

  constructor(
    private readonly sessionsRoot: string,
    private readonly sink: CaptureEventSink,
    private readonly cursors: CaptureCursorStore,
    private readonly options: CaptureServiceOptions = {},
  ) {
    this.#maxBatches = positive(options.maxBatches, DEFAULT_MAX_BATCHES, 1_024);
    this.#appendBatchSize = positive(options.appendBatchSize, DEFAULT_APPEND_BATCH_SIZE, 1_000);
  }

  async capture(request: CaptureSessionRequest): Promise<CaptureSessionReport> {
    const located = await locateCodexTranscript(this.sessionsRoot, request.sessionId, this.options);
    const ingestionId = `codex-transcript:${located.sessionId}`;
    let cursor: TranscriptCursor | undefined = this.cursors.load(ingestionId);
    let batches = 0;
    let projectedEvents = 0;
    let appendedEvents = 0;
    let duplicateEvents = 0;
    let ignoredRecords = 0;
    let hasMore: boolean;
    const eventTypes: Record<string, number> = {};

    do {
      if (batches >= this.#maxBatches) {
        hasMore = true;
        break;
      }
      const previousOffset = cursor?.byteOffset ?? 0;
      const result = await readTranscriptIncrement(located.path, cursor, {
        ...(this.options.maxReadBytes === undefined ? {} : { maxReadBytes: this.options.maxReadBytes }),
        ...(this.options.maxLineBytes === undefined ? {} : { maxLineBytes: this.options.maxLineBytes }),
      });
      if (!result.ok) {
        throw new SessionCaptureError(result.error.code, {
          lineNumber: result.error.lineNumber,
          byteOffset: result.error.byteOffset,
        });
      }
      batches += 1;
      projectedEvents += result.value.events.length;
      ignoredRecords += result.value.ignoredRecords;
      for (const event of result.value.events) eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1;
      if (request.dryRun !== true) {
        for (let offset = 0; offset < result.value.events.length; offset += this.#appendBatchSize) {
          const outcomes = this.sink.appendBatch(result.value.events.slice(offset, offset + this.#appendBatchSize));
          for (const outcome of outcomes) {
            if (outcome.status === "appended") appendedEvents += 1;
            else duplicateEvents += 1;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        this.cursors.commit(ingestionId, result.value.cursor);
      }
      cursor = result.value.cursor;
      hasMore = result.value.hasMore;
      if (hasMore && cursor.byteOffset === previousOffset) break;
    } while (hasMore);

    if (cursor === undefined) throw new SessionCaptureError("TRANSCRIPT_IO_ERROR");
    return Object.freeze({
      schemaVersion: 1,
      status: request.dryRun === true ? "PREVIEWED" : "CAPTURED",
      sessionId: located.sessionId,
      transcriptPath: located.path,
      batches,
      projectedEvents,
      appendedEvents,
      duplicateEvents,
      ignoredRecords,
      eventTypes: Object.freeze({ ...eventTypes }),
      cursor: Object.freeze({ byteOffset: cursor.byteOffset, lineNumber: cursor.lineNumber }),
      hasMore,
      knowledgeCompiled: false,
    });
  }
}
