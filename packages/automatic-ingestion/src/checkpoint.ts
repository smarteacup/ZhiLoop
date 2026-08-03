import type {
  AutomaticIngestionCheckpoint,
  AutomaticIngestionCheckpointPort,
  EligibleCheckpointRequest,
} from "./types.js";

function copy(checkpoint: AutomaticIngestionCheckpoint): AutomaticIngestionCheckpoint {
  return Object.freeze({ ...checkpoint });
}

/** Test/reference store only. Sidecar composition should supply a durable store. */
export class InMemoryAutomaticIngestionCheckpointStore implements AutomaticIngestionCheckpointPort {
  readonly #values = new Map<string, AutomaticIngestionCheckpoint>();

  async load(sessionId: string): Promise<AutomaticIngestionCheckpoint | undefined> {
    const value = this.#values.get(sessionId);
    return value === undefined ? undefined : copy(value);
  }

  async compareAndSwap(
    sessionId: string,
    expectedVersion: number | undefined,
    next: AutomaticIngestionCheckpoint,
  ): Promise<"COMMITTED" | "CONFLICT"> {
    const current = this.#values.get(sessionId);
    if (current?.version !== expectedVersion || next.sessionId !== sessionId || next.version !== (expectedVersion ?? 0) + 1) {
      return "CONFLICT";
    }
    this.#values.set(sessionId, copy(next));
    return "COMMITTED";
  }

  async listEligible(request: EligibleCheckpointRequest): Promise<readonly AutomaticIngestionCheckpoint[]> {
    const statuses = new Set(request.statuses);
    return Object.freeze(
      [...this.#values.values()]
        .filter((value) => statuses.has(value.status) && value.nextEligibleAt !== undefined && value.nextEligibleAt <= request.atOrBefore)
        .sort((left, right) => {
          const time = (left.nextEligibleAt as string).localeCompare(right.nextEligibleAt as string);
          return time === 0 ? left.sessionId.localeCompare(right.sessionId) : time;
        })
        .slice(0, request.limit)
        .map(copy),
    );
  }
}
