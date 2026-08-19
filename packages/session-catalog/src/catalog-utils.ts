import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  MAX_SESSION_PAGE_SIZE,
  SESSION_CATALOG_SCHEMA_VERSION,
  type CapturedSessionState,
  type ControlSessionSummaryCompatible,
  type SessionCatalogEntry,
  type SessionCaptureProjectionPort,
  type SessionPagePosition,
  type SessionTimeGroup,
  type SessionTitleSource,
  type SourceSessionRecord,
} from "./types.js";

const SECRET_PATTERNS = [
  /\b(?:bearer|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
] as const;

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

export function validateSessionId(value: string): string {
  if (value.length < 1 || value.length > 500 || /[\0\r\n/\\]/u.test(value)) throw new TypeError("invalid session id");
  return value;
}

export function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_PAGE_SIZE) {
    throw new RangeError(`limit must be between 1 and ${String(MAX_SESSION_PAGE_SIZE)}`);
  }
  return limit;
}

function oneLine(value: string, maximum: number): string | undefined {
  let result = [...value]
    .map((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127 ? " " : character)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  if (result.length === 0) return undefined;
  return result.length <= maximum ? result : `${result.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function safeTitle(record: SourceSessionRecord): { readonly title: string; readonly source: SessionTitleSource } {
  const explicit = record.explicitTitle === undefined ? undefined : oneLine(record.explicitTitle, 300);
  if (explicit !== undefined) return { title: explicit, source: "SOURCE" };
  const prompt = record.firstUserPrompt === undefined ? undefined : oneLine(record.firstUserPrompt, 160);
  if (prompt !== undefined) return { title: prompt, source: "FIRST_USER_PROMPT" };
  if (record.cwd !== undefined) {
    const cwdTitle = oneLine(basename(record.cwd), 160);
    if (cwdTitle !== undefined) return { title: cwdTitle, source: "CWD" };
  }
  return { title: `Session ${record.sessionId.slice(0, 12)}`, source: "SESSION_ID" };
}

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function timeGroup(lastActivityAt: string, now: Date): SessionTimeGroup {
  const activity = new Date(lastActivityAt);
  const days = Math.floor((utcDay(now) - utcDay(activity)) / 86_400_000);
  if (days <= 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  if (days <= 7) return "PREVIOUS_7_DAYS";
  return "OLDER";
}

export function compareSourceRecords(
  left: Pick<SourceSessionRecord, "lastActivityAt" | "sessionId">,
  right: Pick<SourceSessionRecord, "lastActivityAt" | "sessionId">,
): number {
  const activity = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
  if (activity !== 0) return activity;
  return left.sessionId.localeCompare(right.sessionId, "en");
}

export function isAfterPosition(entry: SessionCatalogEntry, position: SessionPagePosition): boolean {
  const activity = Date.parse(entry.lastActivityAt);
  const cursorActivity = Date.parse(position.lastActivityAt);
  if (!Number.isFinite(cursorActivity) || position.sessionId.length < 1) throw new TypeError("invalid page position");
  return activity < cursorActivity || (activity === cursorActivity && entry.sessionId.localeCompare(position.sessionId, "en") > 0);
}

export class EmptyCaptureProjection implements SessionCaptureProjectionPort {
  async getMany(sessionIds: readonly string[]): Promise<ReadonlyMap<string, CapturedSessionState>> {
    void sessionIds;
    return new Map();
  }
}

export function toCatalogEntry(record: SourceSessionRecord, capture: CapturedSessionState | undefined, now: Date): SessionCatalogEntry {
  const title = safeTitle(record);
  const cwdProject = record.cwd === undefined ? undefined : oneLine(basename(record.cwd), 500);
  const projectHint = capture?.projectHint ?? cwdProject;
  const cwdAlias = capture?.cwdAlias ?? cwdProject;
  const cursorMatchesSource = capture?.cursorByteOffset === undefined || record.sourceByteLength === undefined
    || capture.cursorByteOffset === record.sourceByteLength;
  const captureStatus = record.sourceStatus !== "AVAILABLE"
    ? "SOURCE_UNAVAILABLE"
    : capture === undefined
      ? "DISCOVERED_NOT_CAPTURED"
      : capture.current && cursorMatchesSource
        ? "CAPTURED_CURRENT"
        : "CAPTURED_PARTIAL";
  return Object.freeze({
    schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
    sessionId: record.sessionId,
    title: title.title,
    titleSource: title.source,
    source: record.source,
    sourceStatus: record.sourceStatus,
    ...(record.sourceVersion === undefined ? {} : { sourceVersion: record.sourceVersion }),
    sourceFormatVersion: record.sourceFormatVersion,
    safeSourceAlias: record.safeSourceAlias,
    captureStatus,
    ...(projectHint === undefined ? {} : { projectHint }),
    ...(cwdAlias === undefined ? {} : { cwdAlias }),
    firstActivityAt: record.firstActivityAt,
    lastActivityAt: record.lastActivityAt,
    timeGroup: timeGroup(record.lastActivityAt, now),
    eventCount: capture?.eventCount ?? 0,
    turnCount: capture?.turnCount ?? 0,
    ignoredRecords: capture?.ignoredRecords ?? 0,
    redactionCount: capture?.redactionCount ?? 0,
  });
}

export function toControlSessionSummary(entry: SessionCatalogEntry): ControlSessionSummaryCompatible {
  return Object.freeze({
    schemaVersion: 1,
    sessionId: entry.sessionId,
    title: entry.title,
    source: entry.source,
    sourceStatus: entry.sourceStatus,
    ...(entry.sourceVersion === undefined ? {} : { sourceVersion: entry.sourceVersion }),
    captureStatus: entry.captureStatus,
    ...(entry.projectHint === undefined ? {} : { projectHint: entry.projectHint }),
    ...(entry.cwdAlias === undefined ? {} : { cwdAlias: entry.cwdAlias }),
    firstActivityAt: entry.firstActivityAt,
    lastActivityAt: entry.lastActivityAt,
    eventCount: entry.eventCount,
    turnCount: entry.turnCount,
    ignoredRecords: entry.ignoredRecords,
    redactionCount: entry.redactionCount,
  });
}
