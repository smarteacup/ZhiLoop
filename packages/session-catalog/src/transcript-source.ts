import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { compareSourceRecords, stableHash, validTimestamp, validateSessionId } from "./catalog-utils.js";
import {
  SESSION_CATALOG_SCHEMA_VERSION,
  type SessionCatalogDiagnostic,
  type SessionCatalogSourcePort,
  type SessionSourceCapability,
  type SessionSourceSnapshot,
  type SourceSessionRecord,
} from "./types.js";

export const TRANSCRIPT_FORMAT_V1 = "codex-rollout-jsonl-v1";
export const TRANSCRIPT_FORMAT_V2 = "codex-rollout-jsonl-v2";
const SUPPORTED_FORMATS = Object.freeze([TRANSCRIPT_FORMAT_V1, TRANSCRIPT_FORMAT_V2]);

export interface TranscriptCatalogOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxLineBytes?: number;
  readonly clock?: () => Date;
}

interface CachedFile {
  readonly identity: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly result: ParsedFile;
}

type ParsedFile =
  | { readonly ok: true; readonly session?: SourceSessionRecord }
  | { readonly ok: false; readonly code: SessionCatalogDiagnostic["code"] };

interface JsonRecord {
  readonly type: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
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

function record(line: string): JsonRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!object(parsed) || typeof parsed["type"] !== "string" || !validTimestamp(parsed["timestamp"]) || !object(parsed["payload"])) {
    return undefined;
  }
  return { type: parsed["type"], timestamp: parsed["timestamp"], payload: parsed["payload"] };
}

function formatVersion(payload: Record<string, unknown>): string | undefined {
  const declared = payload["format_version"] ?? payload["transcript_version"];
  if (declared === undefined || declared === 1 || declared === "1" || declared === TRANSCRIPT_FORMAT_V1) return TRANSCRIPT_FORMAT_V1;
  if (declared === 2 || declared === "2" || declared === TRANSCRIPT_FORMAT_V2) return TRANSCRIPT_FORMAT_V2;
  return undefined;
}

function primary(payload: Record<string, unknown>): boolean {
  if (payload["parent_thread_id"] !== undefined || payload["parent_session_id"] !== undefined || payload["parent_id"] !== undefined) return false;
  const role = text(payload["agent_role"])?.toLowerCase();
  const source = text(payload["source"])?.toLowerCase();
  const originator = text(payload["originator"])?.toLowerCase();
  return role !== "subagent" && source !== "subagent" && source !== "collaboration" && !originator?.includes("subagent");
}

async function readStableFile(handle: FileHandle, expectedSize: number): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expectedSize) throw new Error("file changed during bounded read");
  return buffer.subarray(0, offset);
}

function parseTranscript(buffer: Buffer, safeAlias: string, maxLineBytes: number): ParsedFile {
  const lines = buffer.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  else lines.pop(); // Ignore a record still being appended; a later scan will parse it once newline-committed.
  if (lines.length === 0) return { ok: false, code: "MALFORMED_RECORD" };
  const firstText = lines[0]?.replace(/\r$/u, "");
  if (firstText === undefined || Buffer.byteLength(firstText, "utf8") > maxLineBytes) {
    return { ok: false, code: "LINE_TOO_LARGE" };
  }
  const metadata = record(firstText);
  if (metadata === undefined || metadata.type !== "session_meta") return { ok: false, code: "UNSUPPORTED_FORMAT" };
  const version = formatVersion(metadata.payload);
  if (version === undefined) return { ok: false, code: "UNSUPPORTED_FORMAT" };
  const rawSessionId = text(metadata.payload["id"]) ?? text(metadata.payload["session_id"]);
  if (rawSessionId === undefined) return { ok: false, code: "MALFORMED_RECORD" };
  let sessionId: string;
  try {
    sessionId = validateSessionId(rawSessionId);
  } catch {
    return { ok: false, code: "MALFORMED_RECORD" };
  }
  if (!primary(metadata.payload)) return { ok: true };

  let firstActivityAt = metadata.timestamp;
  let lastActivityAt = metadata.timestamp;
  let firstUserPrompt: string | undefined;
  let sourceRecordCount = 1;
  let ignoredRecords = 0;
  const turns = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.replace(/\r$/u, "") ?? "";
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) return { ok: false, code: "LINE_TOO_LARGE" };
    const item = record(line);
    if (item === undefined) return { ok: false, code: "MALFORMED_RECORD" };
    sourceRecordCount += 1;
    if (Date.parse(item.timestamp) < Date.parse(firstActivityAt)) firstActivityAt = item.timestamp;
    if (Date.parse(item.timestamp) > Date.parse(lastActivityAt)) lastActivityAt = item.timestamp;
    const subtype = text(item.payload["type"]);
    const turnId = text(item.payload["turn_id"]);
    if (turnId !== undefined) turns.add(turnId);
    if (firstUserPrompt === undefined && item.type === "event_msg" && subtype === "user_message") {
      firstUserPrompt = text(item.payload["message"]);
    } else if (item.type !== "event_msg" && item.type !== "turn_context" && item.type !== "response_item") {
      ignoredRecords += 1;
    }
  }
  const explicitTitle = text(metadata.payload["title"]) ?? text(metadata.payload["name"]) ?? text(metadata.payload["thread_name"]);
  const cwd = text(metadata.payload["cwd"]);
  const sourceVersion = text(metadata.payload["cli_version"]);
  return {
    ok: true,
    session: Object.freeze({
      sessionId,
      source: "CODEX_TRANSCRIPT",
      sourceStatus: "AVAILABLE",
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
      sourceFormatVersion: version,
      safeSourceAlias: safeAlias,
      ...(explicitTitle === undefined ? {} : { explicitTitle }),
      ...(firstUserPrompt === undefined ? {} : { firstUserPrompt }),
      ...(cwd === undefined ? {} : { cwd }),
      firstActivityAt,
      lastActivityAt,
      sourceRecordCount,
      sourceTurnCount: turns.size,
      ignoredRecords,
      sourceByteLength: buffer.byteLength,
    }),
  };
}

function capability(
  status: SessionSourceCapability["status"],
  observedAt: string,
  diagnostics: readonly SessionCatalogDiagnostic[],
  observedFormatVersion?: string,
): SessionSourceCapability {
  const reason = status === "AVAILABLE" ? "READY" : status === "UNSUPPORTED" ? "UNSUPPORTED" : "UNAVAILABLE";
  return Object.freeze({
    schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
    source: "CODEX_TRANSCRIPT",
    status,
    reason,
    observedAt,
    supportedFormatVersions: SUPPORTED_FORMATS,
    ...(observedFormatVersion === undefined ? {} : { observedFormatVersion }),
    diagnosticCount: diagnostics.length,
  });
}

export class TranscriptSessionCatalogSource implements SessionCatalogSourcePort {
  readonly #root: string;
  readonly #maxDepth: number;
  readonly #maxFiles: number;
  readonly #maxFileBytes: number;
  readonly #maxLineBytes: number;
  readonly #clock: () => Date;
  readonly #cache = new Map<string, CachedFile>();
  #lastRevision: string | undefined;

  constructor(root: string, options: TranscriptCatalogOptions = {}) {
    if (!isAbsolute(root) || root.includes("\0")) throw new TypeError("transcript root must be an absolute safe path");
    this.#root = resolve(root);
    this.#maxDepth = positive(options.maxDepth, 8, "maxDepth");
    this.#maxFiles = positive(options.maxFiles, 50_000, "maxFiles");
    this.#maxFileBytes = positive(options.maxFileBytes, 128 * 1024 * 1024, "maxFileBytes");
    this.#maxLineBytes = positive(options.maxLineBytes, 1024 * 1024, "maxLineBytes");
    this.#clock = options.clock ?? (() => new Date());
  }

  async scan(): Promise<SessionSourceSnapshot> {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("clock returned an invalid date");
    const observedAt = now.toISOString();
    const diagnostics: SessionCatalogDiagnostic[] = [];
    let canonicalRoot: string;
    try {
      const rootStat = await lstat(this.#root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe");
      canonicalRoot = await realpath(this.#root);
    } catch {
      diagnostics.push({ code: "UNSAFE_ROOT", source: "CODEX_TRANSCRIPT", retryable: true });
      return this.#snapshot([], capability("UNAVAILABLE", observedAt, diagnostics), diagnostics, { filesVisited: 0, filesRead: 0, filesReused: 0 });
    }

    const files: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          diagnostics.push({ code: "UNSAFE_PATH", source: "CODEX_TRANSCRIPT", safeSourceAlias: relative(canonicalRoot, path), retryable: false });
          continue;
        }
        if (entry.isDirectory()) {
          if (depth >= this.#maxDepth) {
            diagnostics.push({ code: "DEPTH_LIMIT_EXCEEDED", source: "CODEX_TRANSCRIPT", safeSourceAlias: relative(canonicalRoot, path), retryable: false });
          } else {
            await walk(path, depth + 1);
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (files.length >= this.#maxFiles) {
          diagnostics.push({ code: "FILE_LIMIT_EXCEEDED", source: "CODEX_TRANSCRIPT", retryable: false });
          return;
        }
        files.push(path);
      }
    };
    try {
      await walk(canonicalRoot, 0);
    } catch {
      diagnostics.push({ code: "SOURCE_UNAVAILABLE", source: "CODEX_TRANSCRIPT", retryable: true });
      return this.#snapshot([], capability("UNAVAILABLE", observedAt, diagnostics), diagnostics, { filesVisited: files.length, filesRead: 0, filesReused: 0 });
    }

    const records: SourceSessionRecord[] = [];
    const seenPaths = new Set<string>();
    let filesRead = 0;
    let filesReused = 0;
    for (const path of files) {
      const safeAlias = relative(canonicalRoot, path);
      let parsed: ParsedFile;
      try {
        const canonicalFile = await realpath(path);
        if (canonicalFile === canonicalRoot || !canonicalFile.startsWith(`${canonicalRoot}${sep}`)) throw new Error("escape");
        const stat = await lstat(canonicalFile);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
        if (stat.size > this.#maxFileBytes) {
          diagnostics.push({ code: "FILE_TOO_LARGE", source: "CODEX_TRANSCRIPT", safeSourceAlias: safeAlias, retryable: false });
          continue;
        }
        const identity = `${String(stat.dev)}:${String(stat.ino)}`;
        const cached = this.#cache.get(canonicalFile);
        if (
          cached !== undefined && cached.identity === identity && cached.size === stat.size &&
          cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs
        ) {
          parsed = cached.result;
          filesReused += 1;
        } else {
          const handle = await open(canonicalFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size !== stat.size) throw new Error("changed during scan");
            parsed = parseTranscript(await readStableFile(handle, stat.size), safeAlias, this.#maxLineBytes);
          } finally {
            await handle.close();
          }
          this.#cache.set(canonicalFile, { identity, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, result: parsed });
          filesRead += 1;
        }
        seenPaths.add(canonicalFile);
      } catch {
        diagnostics.push({ code: "UNSAFE_PATH", source: "CODEX_TRANSCRIPT", safeSourceAlias: safeAlias, retryable: true });
        continue;
      }
      if (!parsed.ok) {
        diagnostics.push({ code: parsed.code, source: "CODEX_TRANSCRIPT", safeSourceAlias: safeAlias, retryable: false });
      } else if (parsed.session !== undefined) {
        records.push(parsed.session);
      }
    }
    for (const cachedPath of this.#cache.keys()) if (!seenPaths.has(cachedPath)) this.#cache.delete(cachedPath);

    const deduplicated = new Map<string, SourceSessionRecord>();
    for (const current of records.sort(compareSourceRecords)) {
      const existing = deduplicated.get(current.sessionId);
      if (existing === undefined) {
        deduplicated.set(current.sessionId, current);
      } else {
        diagnostics.push({ code: "DUPLICATE_SESSION_ID", source: "CODEX_TRANSCRIPT", safeSourceAlias: current.safeSourceAlias, retryable: false });
        const activityDifference = Date.parse(current.lastActivityAt) - Date.parse(existing.lastActivityAt);
        if (activityDifference > 0 || (activityDifference === 0 && current.safeSourceAlias.localeCompare(existing.safeSourceAlias, "en") < 0)) {
          deduplicated.set(current.sessionId, current);
        }
      }
    }
    const sessions = [...deduplicated.values()].sort(compareSourceRecords);
    const hasUnsupported = diagnostics.some((item) => item.code === "UNSUPPORTED_FORMAT" || item.code === "MALFORMED_RECORD" || item.code === "LINE_TOO_LARGE");
    const sourceStatus = sessions.length === 0 && files.length > 0 && hasUnsupported ? "UNSUPPORTED" : "AVAILABLE";
    const formats = [...new Set(sessions.map((item) => item.sourceFormatVersion))];
    return this.#snapshot(
      sessions,
      capability(sourceStatus, observedAt, diagnostics, formats.length === 1 ? formats[0] : undefined),
      diagnostics,
      { filesVisited: files.length, filesRead, filesReused },
    );
  }

  #snapshot(
    sessions: readonly SourceSessionRecord[],
    sourceCapability: SessionSourceCapability,
    diagnostics: readonly SessionCatalogDiagnostic[],
    scanStats: SessionSourceSnapshot["scanStats"],
  ): SessionSourceSnapshot {
    const revision = stableHash({
      source: "CODEX_TRANSCRIPT",
      capability: { status: sourceCapability.status, observedFormatVersion: sourceCapability.observedFormatVersion },
      sessions,
      diagnostics: diagnostics.map(({ code, safeSourceAlias }) => ({ code, safeSourceAlias })),
    });
    const changed = revision !== this.#lastRevision;
    this.#lastRevision = revision;
    return Object.freeze({
      source: "CODEX_TRANSCRIPT",
      capability: sourceCapability,
      sessions: Object.freeze([...sessions]),
      diagnostics: Object.freeze([...diagnostics]),
      revision,
      changed,
      scanStats: Object.freeze(scanStats),
    });
  }
}
