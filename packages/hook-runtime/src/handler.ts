import { performance } from "node:perf_hooks";

import type { EventEnvelope } from "@zhiloop/domain";
import { adaptCodexHook } from "@zhiloop/ingestion-codex";

import { redactEventEnvelope } from "./redaction.js";
import type {
  CodexHookHandlerOptions,
  HookCaptureResult,
  HookEventSink,
  HookFallbackReason,
} from "./types.js";

const DEFAULT_ENQUEUE_DEADLINE_MS = 50;
const MAX_ENQUEUE_DEADLINE_MS = 100;

type EnqueueOutcome = "enqueued" | HookFallbackReason;

function errorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return "UnknownError";
}

async function enqueueBeforeDeadline(
  sink: HookEventSink,
  event: EventEnvelope,
  timeoutMs: number,
): Promise<EnqueueOutcome> {
  if (timeoutMs <= 0) return "enqueue-timeout";

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sinkOutcome = Promise.resolve()
    .then(() => sink.enqueue(event, controller.signal))
    .then<EnqueueOutcome, EnqueueOutcome>(() => "enqueued", () => "sink-unavailable");
  const timeoutOutcome = new Promise<EnqueueOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("hook enqueue deadline exceeded"));
      resolve("enqueue-timeout");
    }, timeoutMs);
  });

  try {
    return await Promise.race([sinkOutcome, timeoutOutcome]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class CodexHookHandler {
  readonly #options: CodexHookHandlerOptions;
  readonly #enqueueDeadlineMs: number;
  readonly #monotonicClock: () => number;

  constructor(options: CodexHookHandlerOptions) {
    const enqueueDeadlineMs = options.enqueueDeadlineMs ?? DEFAULT_ENQUEUE_DEADLINE_MS;
    if (!Number.isFinite(enqueueDeadlineMs) || enqueueDeadlineMs <= 0 || enqueueDeadlineMs > MAX_ENQUEUE_DEADLINE_MS) {
      throw new Error(`enqueueDeadlineMs must be greater than 0 and at most ${MAX_ENQUEUE_DEADLINE_MS}`);
    }
    this.#options = options;
    this.#enqueueDeadlineMs = enqueueDeadlineMs;
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
  }

  async handle(input: unknown): Promise<HookCaptureResult> {
    const startedAt = this.#monotonicClock();
    const durationMs = (): number => {
      const elapsed = this.#monotonicClock() - startedAt;
      return Number.isFinite(elapsed) ? Math.max(0, elapsed) : this.#enqueueDeadlineMs;
    };
    const adapted = adaptCodexHook(input, this.#options.adapterOptions);
    if (!adapted.ok) {
      return { status: "dropped-invalid", diagnostic: adapted.error, durationMs: durationMs() };
    }

    let redacted: ReturnType<typeof redactEventEnvelope>;
    try {
      redacted = redactEventEnvelope(adapted.value);
    } catch {
      return {
        status: "dropped-invalid",
        diagnostic: {
          code: "INTERNAL_ENVELOPE_INVALID",
          message: "normalized hook event could not be safely redacted",
          issues: [{ path: "$", code: "redaction_failed", message: "event redaction failed" }],
        },
        durationMs: durationMs(),
      };
    }

    const remainingMs = this.#enqueueDeadlineMs - durationMs();
    const outcome = await enqueueBeforeDeadline(this.#options.sink, redacted.event, remainingMs);
    if (outcome === "enqueued") return { status: "enqueued", durationMs: durationMs() };

    try {
      const stored = await this.#options.spool.store(redacted.event, redacted.redactionCount);
      return {
        status: "spooled",
        reason: outcome,
        spoolStatus: stored.status,
        durationMs: durationMs(),
      };
    } catch (error) {
      return {
        status: "dropped-spool-failed",
        reason: outcome,
        errorName: errorName(error),
        durationMs: durationMs(),
      };
    }
  }
}
