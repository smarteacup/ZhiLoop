import type { ContinuationCounterStore } from "./types.js";

export class InMemoryContinuationCounter implements ContinuationCounterStore {
  private readonly counts = new Map<string, number>();

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  claim(key: string, maximum: number): boolean {
    const current = this.get(key);
    if (current >= maximum) return false;
    this.counts.set(key, current + 1);
    return true;
  }
}
