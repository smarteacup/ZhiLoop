import {
  CONTROL_API_SCHEMA_VERSION,
  sseInvalidationEventSchema,
  type SseInvalidationEvent,
} from "@zhiloop/control-api";

export const DEFAULT_INVALIDATION_EVENTS = 256;
export const DEFAULT_INVALIDATION_BYTES = 256 * 1_024;
export const MAX_INVALIDATION_EVENTS = 4_096;
export const MAX_INVALIDATION_BYTES = 1_048_576;
export const MAX_POLL_INVALIDATIONS = 200;

export interface InvalidationLogOptions {
  readonly maximumEvents?: number;
  readonly maximumBytes?: number;
}

export interface InvalidationSnapshot {
  readonly currentRevision: number;
  readonly oldestRetainedRevision: number;
  readonly requestedAfterRevision: number;
  readonly nextRevision: number;
  readonly resyncRequired: boolean;
  readonly hasMore: boolean;
  readonly events: readonly SseInvalidationEvent[];
}

export interface InvalidationPollResult extends InvalidationSnapshot {
  readonly retryAfterMs: number;
}

interface StoredInvalidation {
  readonly event: SseInvalidationEvent;
  readonly frame: string;
  readonly bytes: number;
}

type InvalidationListener = (event: SseInvalidationEvent, frame: string) => void;

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer within ${minimum}..${maximum}`);
  }
  return value;
}

export function encodeInvalidationFrame(event: SseInvalidationEvent): string {
  return `id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createResyncInvalidation(
  revision: number,
  reason: "INVALID_CURSOR" | "STALE_REVISION",
  occurredAt = new Date().toISOString(),
): SseInvalidationEvent {
  return sseInvalidationEventSchema.parse({
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    eventId: `resync-${reason.toLowerCase().replace("_", "-")}-${revision}`,
    type: "resync.required",
    revision,
    occurredAt,
    reasonCode: reason === "INVALID_CURSOR" ? "INVALID_INPUT" : "SOURCE_UNAVAILABLE",
  });
}

/** A process-local replay log. Producers own event content; the log owns ordering, bounds and fan-out. */
export class BoundedInvalidationLog {
  private readonly retained: StoredInvalidation[] = [];
  private readonly listeners = new Set<InvalidationListener>();
  private retainedBytes = 0;
  private latestRevision = 0;
  public readonly maximumEvents: number;
  public readonly maximumBytes: number;

  public constructor(options: InvalidationLogOptions = {}) {
    this.maximumEvents = boundedInteger(options.maximumEvents ?? DEFAULT_INVALIDATION_EVENTS, "maximumEvents", 1, MAX_INVALIDATION_EVENTS);
    this.maximumBytes = boundedInteger(options.maximumBytes ?? DEFAULT_INVALIDATION_BYTES, "maximumBytes", 1_024, MAX_INVALIDATION_BYTES);
  }

  public get currentRevision(): number {
    return this.latestRevision;
  }

  public get oldestRetainedRevision(): number {
    return this.retained[0]?.event.revision ?? this.latestRevision;
  }

  public publish(value: unknown): SseInvalidationEvent {
    const parsed = sseInvalidationEventSchema.safeParse(value);
    if (!parsed.success) throw new TypeError("invalidation does not match the Control API schema");
    const event = Object.freeze(parsed.data);
    if (!Number.isSafeInteger(event.revision) || event.revision <= this.latestRevision) {
      throw new RangeError(`invalidation revision must be greater than ${this.latestRevision}`);
    }
    const frame = encodeInvalidationFrame(event);
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.maximumBytes) throw new RangeError("invalidation exceeds the replay byte bound");
    this.latestRevision = event.revision;
    this.retained.push({ event, frame, bytes });
    this.retainedBytes += bytes;
    while (this.retained.length > this.maximumEvents || this.retainedBytes > this.maximumBytes) {
      const removed = this.retained.shift();
      if (removed) this.retainedBytes -= removed.bytes;
    }
    for (const listener of this.listeners) {
      try {
        listener(event, frame);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return event;
  }

  public snapshot(afterRevision: number, limit = this.maximumEvents): InvalidationSnapshot {
    boundedInteger(afterRevision, "afterRevision", 0, Number.MAX_SAFE_INTEGER);
    boundedInteger(limit, "limit", 1, this.maximumEvents);
    const oldest = this.oldestRetainedRevision;
    const resyncRequired = afterRevision > this.latestRevision
      || (this.retained.length > 0 && afterRevision < oldest - 1);
    if (resyncRequired) {
      return Object.freeze({
        currentRevision: this.latestRevision,
        oldestRetainedRevision: oldest,
        requestedAfterRevision: afterRevision,
        nextRevision: this.latestRevision,
        resyncRequired: true,
        hasMore: false,
        events: Object.freeze([]),
      });
    }
    const candidates = this.retained.filter(({ event }) => event.revision > afterRevision);
    const selected = candidates.slice(0, limit).map(({ event }) => event);
    return Object.freeze({
      currentRevision: this.latestRevision,
      oldestRetainedRevision: oldest,
      requestedAfterRevision: afterRevision,
      nextRevision: selected.at(-1)?.revision ?? afterRevision,
      resyncRequired: false,
      hasMore: candidates.length > selected.length,
      events: Object.freeze(selected),
    });
  }

  public subscribe(listener: InvalidationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function parseRevision(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d{0,15})$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
