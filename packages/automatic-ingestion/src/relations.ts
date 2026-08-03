import type {
  SessionRelationObservation,
  SessionRelationQueryPort,
  SessionRelationStorePort,
} from "./types.js";

function key(relation: SessionRelationObservation): string {
  return `${relation.parentSessionId}\0${relation.childSessionId}\0${relation.kind}`;
}

/** Test/reference projection. Production composition can back both ports with SQLite. */
export class InMemorySessionRelationProjection implements SessionRelationStorePort, SessionRelationQueryPort {
  readonly #relations = new Map<string, SessionRelationObservation>();

  async upsertMany(relations: readonly SessionRelationObservation[]): Promise<void> {
    for (const relation of relations) this.#relations.set(key(relation), Object.freeze({ ...relation }));
  }

  async getForSession(sessionId: string, limit: number): Promise<readonly SessionRelationObservation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("relation query limit is invalid");
    return Object.freeze(
      [...this.#relations.values()]
        .filter((relation) => relation.parentSessionId === sessionId || relation.childSessionId === sessionId)
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || key(left).localeCompare(key(right)))
        .slice(0, limit)
        .map((relation) => Object.freeze({ ...relation })),
    );
  }
}
