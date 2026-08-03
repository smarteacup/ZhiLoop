import { open, lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  SessionCaptureError,
  type LocatedTranscript,
  type TranscriptLocatorOptions,
} from "./types.js";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_METADATA_BYTES = 65_536;

function bounded(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new SessionCaptureError("DISCOVERY_LIMIT_EXCEEDED");
  return selected;
}

export function validateSessionId(sessionId: string): string {
  if (sessionId.length < 1 || sessionId.length > 200 || /[\0\r\n/\\]/u.test(sessionId)) {
    throw new SessionCaptureError("INVALID_SESSION_ID");
  }
  return sessionId;
}

async function firstSessionId(path: string, maximum: number, likelyMatch: boolean): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 && bytesRead > maximum) {
      if (likelyMatch) throw new SessionCaptureError("TRANSCRIPT_METADATA_TOO_LARGE");
      return undefined;
    }
    const end = newline < 0 ? bytesRead : newline;
    if (end === 0) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, end).toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as { readonly type?: unknown; readonly payload?: unknown };
    if (record.type !== "session_meta" || typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
      return undefined;
    }
    const payload = record.payload as { readonly session_id?: unknown; readonly id?: unknown };
    const id = typeof payload.session_id === "string" ? payload.session_id : payload.id;
    return typeof id === "string" ? id : undefined;
  } finally {
    await handle.close();
  }
}

async function collectJsonl(root: string, maxDepth: number, maxFiles: number): Promise<readonly string[]> {
  const files: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth >= maxDepth) throw new SessionCaptureError("DISCOVERY_LIMIT_EXCEEDED");
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      files.push(path);
      if (files.length > maxFiles) throw new SessionCaptureError("DISCOVERY_LIMIT_EXCEEDED");
    }
  };
  await walk(root, 0);
  return files;
}

export async function locateCodexTranscript(
  sessionsRoot: string,
  requestedSessionId: string,
  options: TranscriptLocatorOptions = {},
): Promise<LocatedTranscript> {
  const sessionId = validateSessionId(requestedSessionId);
  if (!isAbsolute(sessionsRoot) || sessionsRoot.includes("\0")) throw new SessionCaptureError("UNSAFE_SESSIONS_ROOT");
  const normalized = resolve(sessionsRoot);
  let canonicalRoot: string;
  try {
    const stat = await lstat(normalized);
    canonicalRoot = await realpath(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SessionCaptureError("UNSAFE_SESSIONS_ROOT");
    }
  } catch (error) {
    if (error instanceof SessionCaptureError) throw error;
    throw new SessionCaptureError("UNSAFE_SESSIONS_ROOT");
  }
  const maxDepth = bounded(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxFiles = bounded(options.maxFiles, DEFAULT_MAX_FILES);
  const maxMetadataBytes = bounded(options.maxMetadataBytes, DEFAULT_MAX_METADATA_BYTES);
  const files = await collectJsonl(canonicalRoot, maxDepth, maxFiles);
  const preferred = files.filter((path) => path.includes(sessionId));
  const remaining = files.filter((path) => !path.includes(sessionId));
  const preferredSet = new Set(preferred);
  const matches: string[] = [];
  for (const path of [...preferred, ...remaining]) {
    const resolvedPath = resolve(path);
    if (!resolvedPath.startsWith(`${canonicalRoot}${sep}`)) throw new SessionCaptureError("UNSAFE_SESSIONS_ROOT");
    const stat = await lstat(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const declared = await firstSessionId(resolvedPath, maxMetadataBytes, preferredSet.has(path));
    if (declared === sessionId) matches.push(resolvedPath);
    if (matches.length > 1) throw new SessionCaptureError("SESSION_AMBIGUOUS");
  }
  const path = matches[0];
  if (path === undefined) throw new SessionCaptureError("SESSION_NOT_FOUND");
  return Object.freeze({ path, sessionId });
}
