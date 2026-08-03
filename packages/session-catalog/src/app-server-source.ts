import { compareSourceRecords, stableHash, validateSessionId } from "./catalog-utils.js";
import {
  SESSION_CATALOG_SCHEMA_VERSION,
  type SessionCatalogDiagnostic,
  type SessionCatalogSourcePort,
  type SessionSourceCapability,
  type SessionSourceSnapshot,
  type SourceSessionRecord,
} from "./types.js";

export const APP_SERVER_CATALOG_FORMAT_V1 = "codex-app-server-thread-list-v1";
export const APP_SERVER_CATALOG_FORMAT_V2 = "codex-app-server-thread-list-v2";
const SUPPORTED_FORMATS = Object.freeze([APP_SERVER_CATALOG_FORMAT_V1, APP_SERVER_CATALOG_FORMAT_V2]);

export type AppServerCatalogProviderResult =
  | {
      readonly available: true;
      readonly formatVersion: string;
      readonly sourceVersion?: string;
      readonly sessions: readonly unknown[];
    }
  | { readonly available: false; readonly retryable: boolean };

/** Provider boundary for a future stable App Server client; the catalog adapter never invokes Codex commands itself. */
export interface AppServerCatalogProviderPort {
  listPrimarySessions(maximum: number): Promise<AppServerCatalogProviderResult>;
}

export interface AppServerCatalogOptions {
  readonly maxSessions?: number;
  readonly maxRecordBytes?: number;
  readonly clock?: () => Date;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return selected;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const millis = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function primary(item: Record<string, unknown>): boolean {
  if (item["parentThreadId"] !== undefined || item["parentSessionId"] !== undefined || item["parentId"] !== undefined) return false;
  const kind = text(item["kind"])?.toLowerCase();
  const role = text(item["agentRole"])?.toLowerCase();
  return kind !== "subagent" && role !== "subagent";
}

function parseSession(value: unknown, formatVersion: string, providerSourceVersion?: string): SourceSessionRecord | undefined {
  if (!object(value) || !primary(value)) return undefined;
  const rawId = text(value["id"]) ?? text(value["threadId"]) ?? text(value["sessionId"]);
  if (rawId === undefined) throw new TypeError("missing session id");
  const sessionId = validateSessionId(rawId);
  const firstActivityAt = timestamp(value["createdAt"] ?? value["created_at"]);
  const lastActivityAt = timestamp(value["updatedAt"] ?? value["updated_at"] ?? value["lastActivityAt"]);
  if (firstActivityAt === undefined || lastActivityAt === undefined) throw new TypeError("missing timestamp");
  if (Date.parse(firstActivityAt) > Date.parse(lastActivityAt)) throw new TypeError("reversed timestamps");
  const explicitTitle = text(value["title"]) ?? text(value["name"]);
  const firstUserPrompt = text(value["preview"]) ?? text(value["firstUserMessage"]);
  const cwd = text(value["cwd"]);
  const sourceVersion = text(value["cliVersion"]) ?? text(value["sourceVersion"]) ?? providerSourceVersion;
  const sourceRecordCount = value["eventCount"];
  const sourceTurnCount = value["turnCount"];
  return Object.freeze({
    sessionId,
    source: "CODEX_APP_SERVER",
    sourceStatus: "AVAILABLE",
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    sourceFormatVersion: formatVersion,
    safeSourceAlias: `app-server:${sessionId}`,
    ...(explicitTitle === undefined ? {} : { explicitTitle }),
    ...(firstUserPrompt === undefined ? {} : { firstUserPrompt }),
    ...(cwd === undefined ? {} : { cwd }),
    firstActivityAt,
    lastActivityAt,
    sourceRecordCount: typeof sourceRecordCount === "number" && Number.isSafeInteger(sourceRecordCount) && sourceRecordCount >= 0 ? sourceRecordCount : 0,
    sourceTurnCount: typeof sourceTurnCount === "number" && Number.isSafeInteger(sourceTurnCount) && sourceTurnCount >= 0 ? sourceTurnCount : 0,
    ignoredRecords: 0,
  });
}

export class UnconfiguredAppServerCatalogProvider implements AppServerCatalogProviderPort {
  async listPrimarySessions(maximum: number): Promise<AppServerCatalogProviderResult> {
    void maximum;
    return { available: false, retryable: false };
  }
}

export class AppServerSessionCatalogSource implements SessionCatalogSourcePort {
  readonly #provider: AppServerCatalogProviderPort;
  readonly #maxSessions: number;
  readonly #maxRecordBytes: number;
  readonly #clock: () => Date;
  #lastRevision: string | undefined;

  constructor(provider: AppServerCatalogProviderPort = new UnconfiguredAppServerCatalogProvider(), options: AppServerCatalogOptions = {}) {
    this.#provider = provider;
    this.#maxSessions = positive(options.maxSessions, 10_000, "maxSessions");
    this.#maxRecordBytes = positive(options.maxRecordBytes, 256 * 1024, "maxRecordBytes");
    this.#clock = options.clock ?? (() => new Date());
  }

  async scan(): Promise<SessionSourceSnapshot> {
    const date = this.#clock();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError("clock returned an invalid date");
    const observedAt = date.toISOString();
    const diagnostics: SessionCatalogDiagnostic[] = [];
    let providerResult: AppServerCatalogProviderResult;
    try {
      providerResult = await this.#provider.listPrimarySessions(this.#maxSessions);
    } catch {
      providerResult = { available: false, retryable: true };
    }
    if (!providerResult.available) {
      diagnostics.push({
        code: providerResult.retryable ? "SOURCE_UNAVAILABLE" : "SOURCE_NOT_CONFIGURED",
        source: "CODEX_APP_SERVER",
        retryable: providerResult.retryable,
      });
      return this.#snapshot([], this.#capability("UNAVAILABLE", providerResult.retryable ? "UNAVAILABLE" : "NOT_CONFIGURED", observedAt, diagnostics), diagnostics);
    }
    if (typeof providerResult.formatVersion !== "string" || !SUPPORTED_FORMATS.includes(providerResult.formatVersion)) {
      diagnostics.push({ code: "UNSUPPORTED_FORMAT", source: "CODEX_APP_SERVER", retryable: false });
      return this.#snapshot(
        [],
        this.#capability("UNSUPPORTED", "UNSUPPORTED", observedAt, diagnostics, typeof providerResult.formatVersion === "string" ? providerResult.formatVersion : undefined),
        diagnostics,
      );
    }
    if (!Array.isArray(providerResult.sessions) || providerResult.sessions.length > this.#maxSessions) {
      diagnostics.push({ code: "PROVIDER_LIMIT_EXCEEDED", source: "CODEX_APP_SERVER", retryable: false });
      return this.#snapshot([], this.#capability("UNSUPPORTED", "UNSUPPORTED", observedAt, diagnostics, providerResult.formatVersion), diagnostics);
    }

    const records: SourceSessionRecord[] = [];
    for (const value of providerResult.sessions) {
      let serialized: string;
      try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new TypeError("not JSON serializable");
        serialized = encoded;
      } catch {
        diagnostics.push({ code: "MALFORMED_RECORD", source: "CODEX_APP_SERVER", retryable: false });
        continue;
      }
      if (Buffer.byteLength(serialized, "utf8") > this.#maxRecordBytes) {
        diagnostics.push({ code: "FILE_TOO_LARGE", source: "CODEX_APP_SERVER", retryable: false });
        continue;
      }
      try {
        const parsed = parseSession(value, providerResult.formatVersion, providerResult.sourceVersion);
        if (parsed !== undefined) records.push(parsed);
      } catch {
        diagnostics.push({ code: "MALFORMED_RECORD", source: "CODEX_APP_SERVER", retryable: false });
      }
    }
    if (diagnostics.some((item) => item.code === "MALFORMED_RECORD" || item.code === "FILE_TOO_LARGE")) {
      return this.#snapshot(
        [],
        this.#capability("UNSUPPORTED", "UNSUPPORTED", observedAt, diagnostics, providerResult.formatVersion),
        diagnostics,
      );
    }
    const deduplicated = new Map<string, SourceSessionRecord>();
    for (const current of records.sort(compareSourceRecords)) {
      const existing = deduplicated.get(current.sessionId);
      if (existing === undefined) {
        deduplicated.set(current.sessionId, current);
      } else {
        diagnostics.push({ code: "DUPLICATE_SESSION_ID", source: "CODEX_APP_SERVER", retryable: false });
        const activityDifference = Date.parse(current.lastActivityAt) - Date.parse(existing.lastActivityAt);
        if (activityDifference > 0 || (activityDifference === 0 && stableHash(current).localeCompare(stableHash(existing), "en") < 0)) {
          deduplicated.set(current.sessionId, current);
        }
      }
    }
    const sessions = [...deduplicated.values()].sort(compareSourceRecords);
    return this.#snapshot(
      sessions,
      this.#capability("AVAILABLE", "READY", observedAt, diagnostics, providerResult.formatVersion),
      diagnostics,
    );
  }

  #capability(
    status: SessionSourceCapability["status"],
    reason: SessionSourceCapability["reason"],
    observedAt: string,
    diagnostics: readonly SessionCatalogDiagnostic[],
    observedFormatVersion?: string,
  ): SessionSourceCapability {
    return Object.freeze({
      schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
      source: "CODEX_APP_SERVER",
      status,
      reason,
      observedAt,
      supportedFormatVersions: SUPPORTED_FORMATS,
      ...(observedFormatVersion === undefined ? {} : { observedFormatVersion }),
      diagnosticCount: diagnostics.length,
    });
  }

  #snapshot(
    sessions: readonly SourceSessionRecord[],
    sourceCapability: SessionSourceCapability,
    diagnostics: readonly SessionCatalogDiagnostic[],
  ): SessionSourceSnapshot {
    const revision = stableHash({
      source: "CODEX_APP_SERVER",
      capability: { status: sourceCapability.status, observedFormatVersion: sourceCapability.observedFormatVersion },
      sessions,
      diagnostics: diagnostics.map(({ code }) => code),
    });
    const changed = revision !== this.#lastRevision;
    this.#lastRevision = revision;
    return Object.freeze({
      source: "CODEX_APP_SERVER",
      capability: sourceCapability,
      sessions: Object.freeze([...sessions]),
      diagnostics: Object.freeze([...diagnostics]),
      revision,
      changed,
      scanStats: Object.freeze({ filesVisited: 0, filesRead: 0, filesReused: 0 }),
    });
  }
}
