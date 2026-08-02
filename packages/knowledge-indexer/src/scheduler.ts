import type { IncrementalKnowledgeIndexer } from "./indexer.js";
import type { DebouncedIndexerOptions, IncrementalIndexResult } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MAX_WAIT_MS = 2_000;
const MAX_TIMER_MS = 60_000;

function assertTimer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be between 1 and ${MAX_TIMER_MS}`);
  }
}

export class DebouncedKnowledgeIndexer {
  readonly #indexer: IncrementalKnowledgeIndexer;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #onBatch: DebouncedIndexerOptions["onBatch"];
  readonly #onError: DebouncedIndexerOptions["onError"];
  readonly #pending = new Set<string>();
  #debounceTimer: NodeJS.Timeout | undefined;
  #maxWaitTimer: NodeJS.Timeout | undefined;
  #inFlight: Promise<readonly IncrementalIndexResult[]> | undefined;
  #closed = false;

  constructor(indexer: IncrementalKnowledgeIndexer, options: DebouncedIndexerOptions = {}) {
    this.#indexer = indexer;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.#onBatch = options.onBatch;
    this.#onError = options.onError;
    assertTimer(this.#debounceMs, "debounceMs");
    assertTimer(this.#maxWaitMs, "maxWaitMs");
    if (this.#maxWaitMs < this.#debounceMs) throw new Error("maxWaitMs must not be less than debounceMs");
  }

  notifyAsset(assetId: string): void {
    if (this.#closed) throw new Error("debounced indexer is closed");
    if (assetId.trim().length === 0) throw new Error("assetId must not be empty");
    const wasEmpty = this.#pending.size === 0;
    this.#pending.add(assetId);
    if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => { void this.flush().catch((error) => this.#onError?.(error)); }, this.#debounceMs);
    this.#debounceTimer.unref();
    if (wasEmpty && this.#maxWaitTimer === undefined) {
      this.#maxWaitTimer = setTimeout(() => { void this.flush().catch((error) => this.#onError?.(error)); }, this.#maxWaitMs);
      this.#maxWaitTimer.unref();
    }
  }

  #clearTimers(): void {
    if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
    if (this.#maxWaitTimer !== undefined) clearTimeout(this.#maxWaitTimer);
    this.#debounceTimer = undefined;
    this.#maxWaitTimer = undefined;
  }

  async flush(): Promise<readonly IncrementalIndexResult[]> {
    if (this.#inFlight !== undefined) {
      await this.#inFlight;
      if (this.#pending.size === 0) return [];
    }
    this.#clearTimers();
    const assetIds = [...this.#pending];
    this.#pending.clear();
    if (assetIds.length === 0) return [];
    const run = this.#indexer.syncMany(assetIds);
    this.#inFlight = run;
    try {
      const results = await run;
      await this.#onBatch?.(results);
      return results;
    } finally {
      this.#inFlight = undefined;
      if (!this.#closed && this.#pending.size > 0) {
        const pending = [...this.#pending];
        this.#pending.clear();
        for (const assetId of pending) this.notifyAsset(assetId);
      }
    }
  }

  async close(flushPending = true): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    if (flushPending) await this.flush();
    else {
      this.#pending.clear();
      await this.#inFlight;
    }
  }
}
