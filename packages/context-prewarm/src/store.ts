import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContextPrewarmStorePort, StableContextCatalog } from "./types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCatalog(value: unknown): value is StableContextCatalog {
  if (!record(value) || value["schemaVersion"] !== 1 || typeof value["cacheKey"] !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value["cacheKey"]) || typeof value["sessionId"] !== "string"
    || value["sessionId"].trim().length === 0 || typeof value["projectId"] !== "string"
    || value["projectId"].trim().length === 0 || typeof value["expiresAt"] !== "string"
    || !Number.isFinite(Date.parse(value["expiresAt"])) || !Array.isArray(value["items"]) || value["items"].length > 100) return false;
  return value["items"].every((item) => record(item) && typeof item["assetId"] === "string"
    && Number.isSafeInteger(item["assetVersion"]) && record(item["expansion"])
    && item["expansion"]["tool"] === "ckl.get" && item["expansion"]["assetId"] === item["assetId"]
    && item["expansion"]["version"] === item["assetVersion"]
    && !("content" in item) && !("symbols" in item) && !("sourceEpisodes" in item));
}

function parse(payload: string, expectedHash: string): StableContextCatalog {
  if (hash(payload) !== expectedHash) throw new Error("CONTEXT_PREWARM_INTEGRITY_FAILED");
  const value: unknown = JSON.parse(payload);
  if (!validCatalog(value)) throw new Error("CONTEXT_PREWARM_CORRUPT");
  return deepFreeze(value);
}

export class SqliteContextPrewarmStore implements ContextPrewarmStorePort {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    const resolved = filename === ":memory:" ? filename : path.resolve(filename);
    if (filename !== ":memory:") mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(resolved, 0o600);
      this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#database.exec(`CREATE TABLE IF NOT EXISTS context_prewarm_entries (
        cache_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
        expires_at TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS context_prewarm_session ON context_prewarm_entries(session_id, expires_at, cache_key);`);
    } catch (error) { this.#database.close(); this.#closed = true; throw error; }
  }

  #open(): void { if (this.#closed) throw new Error("CONTEXT_PREWARM_STORE_CLOSED"); }

  get(cacheKey: string, now: string): StableContextCatalog | undefined {
    this.#open();
    if (!/^sha256:[a-f0-9]{64}$/u.test(cacheKey) || !Number.isFinite(Date.parse(now))) throw new Error("CONTEXT_PREWARM_LOOKUP_INVALID");
    const row = this.#database.prepare(`SELECT payload_json,payload_hash,expires_at FROM context_prewarm_entries WHERE cache_key=?`)
      .get(cacheKey) as { payload_json: string; payload_hash: string; expires_at: string } | undefined;
    if (row === undefined || Date.parse(row.expires_at) <= Date.parse(now)) return undefined;
    return parse(row.payload_json, row.payload_hash);
  }

  put(catalog: StableContextCatalog): "STORED" | "IDEMPOTENT" {
    this.#open();
    const payload = canonical(catalog);
    const payloadHash = hash(payload);
    parse(payload, payloadHash);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT payload_hash,expires_at FROM context_prewarm_entries WHERE cache_key=?")
        .get(catalog.cacheKey) as { payload_hash: string; expires_at: string } | undefined;
      if (existing?.payload_hash === payloadHash) { this.#database.exec("COMMIT"); return "IDEMPOTENT"; }
      if (existing !== undefined && Date.parse(existing.expires_at) > Date.parse(catalog.createdAt)) {
        throw new Error("CONTEXT_PREWARM_KEY_CONFLICT");
      }
      if (existing !== undefined) this.#database.prepare("DELETE FROM context_prewarm_entries WHERE cache_key=?").run(catalog.cacheKey);
      this.#database.prepare(`INSERT INTO context_prewarm_entries
        (cache_key,session_id,project_id,expires_at,payload_json,payload_hash) VALUES(?,?,?,?,?,?)`)
        .run(catalog.cacheKey, catalog.sessionId, catalog.projectId, catalog.expiresAt, payload, payloadHash);
      this.#database.prepare(`DELETE FROM context_prewarm_entries WHERE cache_key IN (
        SELECT cache_key FROM context_prewarm_entries WHERE session_id=? ORDER BY expires_at DESC,cache_key DESC LIMIT -1 OFFSET 8
      )`).run(catalog.sessionId);
      this.#database.exec("COMMIT");
      return "STORED";
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  invalidateSession(sessionId: string): number {
    this.#open();
    if (sessionId.trim().length === 0 || sessionId.length > 4_096 || /[\0\r\n]/u.test(sessionId)) {
      throw new Error("CONTEXT_PREWARM_SESSION_INVALID");
    }
    const result = this.#database.prepare("DELETE FROM context_prewarm_entries WHERE session_id=?").run(sessionId);
    return Number(result.changes);
  }

  close(): void { if (!this.#closed) { this.#database.close(); this.#closed = true; } }
  [Symbol.dispose](): void { this.close(); }
}
