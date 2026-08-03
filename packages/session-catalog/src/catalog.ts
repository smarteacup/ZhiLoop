import {
  boundedLimit,
  compareSourceRecords,
  EmptyCaptureProjection,
  isAfterPosition,
  stableHash,
  toCatalogEntry,
  validateSessionId,
} from "./catalog-utils.js";
import type {
  SessionCaptureProjectionPort,
  SessionCatalogEntry,
  SessionCatalogListRequest,
  SessionCatalogListResult,
  SessionCatalogQueryPort,
  SessionCatalogSourcePort,
  SessionCatalogDiagnostic,
  SessionSourceCapability,
  SessionSourceSnapshot,
} from "./types.js";
import { MAX_DISCOVERED_SESSIONS } from "./types.js";

export interface SessionCatalogOptions {
  readonly captureProjection?: SessionCaptureProjectionPort;
  readonly clock?: () => Date;
}

/**
 * Selects one complete source snapshot. An AVAILABLE App Server source always wins;
 * transcript is scanned only when App Server is unavailable or incompatible.
 */
export class ReadOnlySessionCatalog implements SessionCatalogQueryPort {
  readonly #appServer: SessionCatalogSourcePort;
  readonly #transcript: SessionCatalogSourcePort;
  readonly #captureProjection: SessionCaptureProjectionPort;
  readonly #clock: () => Date;
  #lastRevision: string | undefined;

  constructor(appServer: SessionCatalogSourcePort, transcript: SessionCatalogSourcePort, options: SessionCatalogOptions = {}) {
    this.#appServer = appServer;
    this.#transcript = transcript;
    this.#captureProjection = options.captureProjection ?? new EmptyCaptureProjection();
    this.#clock = options.clock ?? (() => new Date());
  }

  async list(request: SessionCatalogListRequest = {}): Promise<SessionCatalogListResult> {
    const limit = boundedLimit(request.limit);
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("clock returned an invalid date");
    const loaded = await this.#loadEntries(now);
    let entries = loaded.entries;
    if (request.source !== undefined) entries = entries.filter((item) => item.source === request.source);
    if (request.captureStatus !== undefined) entries = entries.filter((item) => item.captureStatus === request.captureStatus);
    if (request.timeGroup !== undefined) entries = entries.filter((item) => item.timeGroup === request.timeGroup);
    if (request.projectHint !== undefined) entries = entries.filter((item) => item.projectHint === request.projectHint);
    const after = request.after;
    if (after !== undefined) entries = entries.filter((item) => isAfterPosition(item, after));
    const page = entries.slice(0, limit);
    const hasMore = entries.length > limit;
    const last = page.at(-1);
    return Object.freeze({
      items: Object.freeze(page),
      ...(hasMore && last !== undefined
        ? { nextPosition: Object.freeze({ lastActivityAt: last.lastActivityAt, sessionId: last.sessionId }) }
        : {}),
      sourceCapabilities: loaded.sourceCapabilities,
      diagnostics: loaded.diagnostics,
      revision: loaded.revision,
      changed: loaded.changed,
    });
  }

  async get(sessionId: string): Promise<SessionCatalogEntry | undefined> {
    const validId = validateSessionId(sessionId);
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("clock returned an invalid date");
    return (await this.#loadEntries(now)).entries.find((item) => item.sessionId === validId);
  }

  async #loadEntries(now: Date): Promise<{
    readonly entries: readonly SessionCatalogEntry[];
    readonly sourceCapabilities: readonly SessionSourceCapability[];
    readonly diagnostics: readonly SessionCatalogDiagnostic[];
    readonly revision: string;
    readonly changed: boolean;
  }> {
    const { selected, observed } = await this.#selectSource();
    let knownSessions = selected.sessions;
    if (selected.capability.status !== "AVAILABLE" && this.#captureProjection.listKnownSessions !== undefined) {
      const retained = await this.#captureProjection.listKnownSessions(MAX_DISCOVERED_SESSIONS);
      if (retained.length > MAX_DISCOVERED_SESSIONS) throw new RangeError("capture projection exceeded session catalog limit");
      knownSessions = retained.map((item) => Object.freeze({ ...item, sourceStatus: selected.capability.status }));
    }
    const capture = await this.#captureProjection.getMany(knownSessions.map((item) => item.sessionId));
    const entries = knownSessions.map((item) => toCatalogEntry(item, capture.get(item.sessionId), now)).sort(compareSourceRecords);
    const revision = stableHash({
      selected: selected.source,
      sourceRevision: selected.revision,
      capture: entries.map((item) => [item.sessionId, item.captureStatus, item.eventCount, item.turnCount, item.ignoredRecords, item.redactionCount]),
      utcDay: now.toISOString().slice(0, 10),
    });
    const changed = revision !== this.#lastRevision || observed.some((item) => item.changed);
    this.#lastRevision = revision;
    return {
      entries: Object.freeze(entries),
      sourceCapabilities: Object.freeze(observed.map((item) => item.capability)),
      diagnostics: Object.freeze(observed.flatMap((item) => item.diagnostics)),
      revision,
      changed,
    };
  }

  async #selectSource(): Promise<{ readonly selected: SessionSourceSnapshot; readonly observed: readonly SessionSourceSnapshot[] }> {
    const primary = await this.#appServer.scan();
    if (primary.capability.status === "AVAILABLE") return { selected: primary, observed: [primary] };
    const fallback = await this.#transcript.scan();
    return { selected: fallback, observed: [primary, fallback] };
  }
}
