import { readTranscriptIncrement, type TranscriptCursor } from "@zhiloop/ingestion-codex";

import { locateCodexTranscript } from "./locator.js";
import {
  SessionCaptureError,
  type CaptureCursorStore,
  type CaptureEventSample,
  type CaptureEventSink,
  type CaptureServiceOptions,
  type CaptureSessionReport,
  type CaptureSessionRequest,
} from "./types.js";

const DEFAULT_MAX_BATCHES = 16;
const DEFAULT_APPEND_BATCH_SIZE = 500;
const MAX_REPORTED_EVENTS = 100;

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
    const sampledEvents: CaptureEventSample[] = [];
    const appendedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    let sampledEventsTruncated = false;
    let eventIdsTruncated = false;

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
      for (const event of result.value.events) {
        eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1;
        if (this.options.projectEvent !== undefined) {
          if (sampledEvents.length < MAX_REPORTED_EVENTS) sampledEvents.push(this.options.projectEvent(event));
          else sampledEventsTruncated = true;
        }
      }
      if (request.dryRun !== true) {
        for (let offset = 0; offset < result.value.events.length; offset += this.#appendBatchSize) {
          const batch = result.value.events.slice(offset, offset + this.#appendBatchSize);
          const outcomes = this.sink.appendBatch(batch);
          for (let index = 0; index < outcomes.length; index += 1) {
            const outcome = outcomes[index];
            const event = batch[index];
            if (outcome === undefined || event === undefined) continue;
            const target = outcome.status === "appended" ? appendedEventIds : duplicateEventIds;
            if (outcome.status === "appended") appendedEvents += 1;
            else duplicateEvents += 1;
            if (target.length < MAX_REPORTED_EVENTS) target.push(event.eventId);
            else eventIdsTruncated = true;
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
      sampledEvents: Object.freeze([...sampledEvents]),
      sampledEventsTruncated,
      appendedEventIds: Object.freeze([...appendedEventIds]),
      duplicateEventIds: Object.freeze([...duplicateEventIds]),
      eventIdsTruncated,
      cursor: Object.freeze({ byteOffset: cursor.byteOffset, lineNumber: cursor.lineNumber }),
      hasMore,
      knowledgeCompiled: false,
    });
  }
}
