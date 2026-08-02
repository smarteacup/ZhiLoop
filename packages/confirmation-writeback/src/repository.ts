import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ConfirmationRequest, ConfirmationResolution } from "@zhiloop/domain";
import { parseConfirmationRequest, parseConfirmationResolution } from "@zhiloop/schemas";

import type {
  ConfirmationClaimResult,
  ConfirmationTargetSnapshot,
  ConfirmationWritebackRepository,
  PendingConfirmation,
} from "./types.js";

const MIGRATION_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,499}$/u;

interface ConfirmationRow {
  readonly confirmation_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly turn_ordinal: number;
  readonly status: "PENDING" | "CLAIMED" | "RESOLVED";
  readonly request_json: string;
  readonly request_hash: string;
  readonly targets_json: string;
  readonly targets_hash: string;
  readonly claim_resolution_id: string | null;
  readonly claim_response_event_id: string | null;
  readonly claim_response_hash: string | null;
  readonly resolution_json: string | null;
  readonly resolution_hash: string | null;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported undefined value in durable confirmation payload");
  return encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateTargets(request: ConfirmationRequest, targets: readonly ConfirmationTargetSnapshot[]): readonly ConfirmationTargetSnapshot[] {
  if (targets.length !== request.subjectIds.length || targets.length < 1 || targets.length > 20) throw new Error("confirmation targets must exactly cover request subjects");
  const normalized = targets.map((item) => ({ subjectId: item.subjectId, expectedRevision: item.expectedRevision }))
    .sort((left, right) => left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0);
  if (new Set(normalized.map((item) => item.subjectId)).size !== normalized.length
    || normalized.some((item) => !SAFE_ID.test(item.subjectId) || !SAFE_REVISION.test(item.expectedRevision))
    || request.subjectIds.some((id) => !normalized.some((item) => item.subjectId === id))) {
    throw new Error("confirmation targets are invalid or expanded");
  }
  return freeze(normalized);
}

function parseRequest(row: ConfirmationRow): ConfirmationRequest {
  if (sha256(row.request_json) !== row.request_hash) throw new Error(`confirmation ${row.confirmation_id} request integrity failure`);
  const parsed = parseConfirmationRequest(JSON.parse(row.request_json));
  if (!parsed.ok || parsed.value.confirmationId !== row.confirmation_id || parsed.value.sessionId !== row.session_id
    || parsed.value.turnId !== row.turn_id || parsed.value.turnOrdinal !== row.turn_ordinal) {
    throw new Error(`confirmation ${row.confirmation_id} request is corrupt`);
  }
  return freeze(structuredClone(parsed.value));
}

function parseTargets(row: ConfirmationRow, request: ConfirmationRequest): readonly ConfirmationTargetSnapshot[] {
  if (sha256(row.targets_json) !== row.targets_hash) throw new Error(`confirmation ${row.confirmation_id} target integrity failure`);
  const value = JSON.parse(row.targets_json) as readonly ConfirmationTargetSnapshot[];
  return validateTargets(request, value);
}

export class SqliteConfirmationWritebackRepository implements ConfirmationWritebackRepository {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    this.#database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("confirmation writeback repository is closed");
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS confirmation_writeback_meta (
        component TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version >= 0)
      );
    `);
    const current = this.#database.prepare(
      "SELECT version FROM confirmation_writeback_meta WHERE component = 'confirmation-writeback'",
    ).get() as { version: number } | undefined;
    if (current !== undefined && current.version > MIGRATION_VERSION) throw new Error("confirmation writeback migration is newer than supported");
    if (current?.version === MIGRATION_VERSION) return;
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS confirmation_requests (
          confirmation_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_ordinal INTEGER NOT NULL CHECK (turn_ordinal >= 0),
          status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'RESOLVED')),
          request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
          targets_json TEXT NOT NULL, targets_hash TEXT NOT NULL,
          claim_resolution_id TEXT, claim_response_event_id TEXT, claim_response_hash TEXT,
          resolution_json TEXT, resolution_hash TEXT,
          created_at TEXT NOT NULL, resolved_at TEXT,
          CHECK ((status = 'PENDING') = (claim_resolution_id IS NULL)),
          CHECK ((status = 'PENDING') = (claim_response_event_id IS NULL)),
          CHECK ((status = 'PENDING') = (claim_response_hash IS NULL)),
          CHECK ((status = 'RESOLVED') = (resolution_json IS NOT NULL)),
          CHECK ((status = 'RESOLVED') = (resolution_hash IS NOT NULL)),
          CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS confirmation_pending_session_idx
          ON confirmation_requests(session_id, status, turn_ordinal DESC, confirmation_id);
        INSERT INTO confirmation_writeback_meta(component, version) VALUES ('confirmation-writeback', 1)
          ON CONFLICT(component) DO UPDATE SET version = excluded.version;
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #row(confirmationId: string): ConfirmationRow | undefined {
    return this.#database.prepare(`
      SELECT confirmation_id, session_id, turn_id, turn_ordinal, status, request_json, request_hash,
             targets_json, targets_hash, claim_resolution_id, claim_response_event_id, claim_response_hash,
             resolution_json, resolution_hash
      FROM confirmation_requests WHERE confirmation_id = ?
    `).get(confirmationId) as ConfirmationRow | undefined;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  save(request: ConfirmationRequest, targets: readonly ConfirmationTargetSnapshot[]): "SAVED" | "EXISTING" {
    this.#assertOpen();
    const parsed = parseConfirmationRequest(request);
    if (!parsed.ok) throw new Error("ConfirmationRequest schema is invalid");
    const safeTargets = validateTargets(parsed.value, targets);
    const requestJson = canonical(parsed.value);
    const targetsJson = canonical(safeTargets);
    return this.#transaction(() => {
      const existing = this.#row(parsed.value.confirmationId);
      if (existing !== undefined) {
        if (existing.request_hash !== sha256(requestJson) || existing.targets_hash !== sha256(targetsJson)) {
          throw new Error(`confirmation identity conflict for ${parsed.value.confirmationId}`);
        }
        return "EXISTING";
      }
      this.#database.prepare(`
        INSERT INTO confirmation_requests (
          confirmation_id, session_id, turn_id, turn_ordinal, status, request_json, request_hash,
          targets_json, targets_hash, created_at
        ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)
      `).run(
        parsed.value.confirmationId, parsed.value.sessionId, parsed.value.turnId, parsed.value.turnOrdinal,
        requestJson, sha256(requestJson), targetsJson, sha256(targetsJson), parsed.value.createdAt,
      );
      return "SAVED";
    });
  }

  pending(sessionId: string, confirmationId?: string): readonly PendingConfirmation[] {
    this.#assertOpen();
    if (!SAFE_ID.test(sessionId) || (confirmationId !== undefined && !SAFE_ID.test(confirmationId))) throw new Error("pending confirmation query is invalid");
    const rows = this.#database.prepare(`
      SELECT confirmation_id, session_id, turn_id, turn_ordinal, status, request_json, request_hash,
             targets_json, targets_hash, claim_resolution_id, claim_response_event_id, claim_response_hash,
             resolution_json, resolution_hash
      FROM confirmation_requests
      WHERE session_id = ? AND status IN ('PENDING', 'CLAIMED')
        AND (? IS NULL OR confirmation_id = ?)
      ORDER BY turn_ordinal DESC, confirmation_id ASC LIMIT 100
    `).all(sessionId, confirmationId ?? null, confirmationId ?? null) as unknown as ConfirmationRow[];
    return freeze(rows.map((row) => {
      const request = parseRequest(row);
      return { request, targets: parseTargets(row, request) };
    }));
  }

  claim(confirmationId: string, resolutionId: string, responseEventId: string, responseTextHash: string): ConfirmationClaimResult {
    this.#assertOpen();
    if (![confirmationId, resolutionId, responseEventId].every((value) => SAFE_ID.test(value)) || !/^[a-f0-9]{64}$/u.test(responseTextHash)) {
      throw new Error("confirmation claim identity is invalid");
    }
    return this.#transaction(() => {
      const row = this.#row(confirmationId);
      if (row === undefined) return "CONFLICT";
      if (row.status === "RESOLVED") return row.claim_resolution_id === resolutionId ? "RESOLVED" : "CONFLICT";
      if (row.status === "CLAIMED") {
        return row.claim_resolution_id === resolutionId && row.claim_response_event_id === responseEventId
          && row.claim_response_hash === responseTextHash ? "RETRY" : "CONFLICT";
      }
      this.#database.prepare(`
        UPDATE confirmation_requests SET status = 'CLAIMED', claim_resolution_id = ?,
          claim_response_event_id = ?, claim_response_hash = ? WHERE confirmation_id = ? AND status = 'PENDING'
      `).run(resolutionId, responseEventId, responseTextHash, confirmationId);
      return "CLAIMED";
    });
  }

  complete(resolution: ConfirmationResolution): "COMPLETED" | "EXISTING" {
    this.#assertOpen();
    const parsed = parseConfirmationResolution(resolution);
    if (!parsed.ok) throw new Error("ConfirmationResolution schema is invalid");
    const resolutionJson = canonical(parsed.value);
    return this.#transaction(() => {
      const row = this.#row(parsed.value.confirmationId);
      if (row === undefined) throw new Error("confirmation does not exist");
      if (row.status === "RESOLVED") {
        if (row.resolution_hash !== sha256(resolutionJson)) throw new Error("confirmation resolution conflict");
        return "EXISTING";
      }
      if (row.status !== "CLAIMED" || row.claim_resolution_id !== parsed.value.resolutionId
        || row.claim_response_event_id !== parsed.value.responseEventId || row.claim_response_hash !== parsed.value.responseTextHash) {
        throw new Error("confirmation resolution does not own the claim");
      }
      const request = parseRequest(row);
      const option = request.options.find((item) => item.optionId === parsed.value.selectedOptionId);
      const targets = parseTargets(row, request);
      if (request.sessionId !== parsed.value.sessionId || request.turnId !== parsed.value.requestTurnId
        || option?.effect !== parsed.value.effect
        || (parsed.value.responseKind === "CORRECTION"
          && (request.kind !== "KNOWLEDGE_CONFLICT" || parsed.value.effect !== "REJECT_CANDIDATE"))
        || request.subjectIds.length !== parsed.value.subjectIds.length
        || request.subjectIds.some((id) => !parsed.value.subjectIds.includes(id))
        || targets.some((target) => parsed.value.relations.find((item) => item.subjectId === target.subjectId)?.beforeRevision !== target.expectedRevision)) {
        throw new Error("confirmation resolution expanded request identity or subjects");
      }
      this.#database.prepare(`
        UPDATE confirmation_requests SET status = 'RESOLVED', resolution_json = ?, resolution_hash = ?, resolved_at = ?
        WHERE confirmation_id = ? AND status = 'CLAIMED'
      `).run(resolutionJson, sha256(resolutionJson), parsed.value.resolvedAt, parsed.value.confirmationId);
      return "COMPLETED";
    });
  }

  resolution(confirmationId: string): ConfirmationResolution | undefined {
    this.#assertOpen();
    if (!SAFE_ID.test(confirmationId)) throw new Error("confirmationId is invalid");
    const row = this.#row(confirmationId);
    if (row?.status !== "RESOLVED" || row.resolution_json === null || row.resolution_hash === null) return undefined;
    if (sha256(row.resolution_json) !== row.resolution_hash) throw new Error("confirmation resolution integrity failure");
    const parsed = parseConfirmationResolution(JSON.parse(row.resolution_json));
    if (!parsed.ok || parsed.value.confirmationId !== confirmationId) throw new Error("confirmation resolution is corrupt");
    return freeze(structuredClone(parsed.value));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
