import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ActiveClosureOperationOutcome,
  ActiveClosureOperationState,
  ActiveClosureOperationStore,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_OUTCOME_BYTES = 4 * 1024 * 1024;

export class ActiveClosureOperationConflictError extends Error {
  override readonly name = "ActiveClosureOperationConflictError";
}

function serialize(value: ActiveClosureOperationOutcome): string {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, "utf8") > MAX_OUTCOME_BYTES) throw new Error("closure operation outcome exceeds byte limit");
  return payload;
}

export class SqliteActiveClosureOperationStore implements ActiveClosureOperationStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(filename);
    if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
    this.#database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode=WAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS active_closure_operations (
        identity_key TEXT PRIMARY KEY NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','OUTCOME','COMPLETED')),
        outcome_json TEXT,
        CHECK((status = 'PENDING') = (outcome_json IS NULL))
      ) STRICT;
    `);
  }

  #state(identityKey: string): ActiveClosureOperationState | undefined {
    const row = this.#database.prepare(`
      SELECT identity_key,request_hash,status,outcome_json FROM active_closure_operations WHERE identity_key=?
    `).get(identityKey) as {
      identity_key: string;
      request_hash: string;
      status: ActiveClosureOperationState["status"];
      outcome_json: string | null;
    } | undefined;
    if (row === undefined) return undefined;
    return {
      identityKey: row.identity_key,
      requestHash: row.request_hash,
      status: row.status,
      ...(row.outcome_json === null ? {} : { outcome: JSON.parse(row.outcome_json) as ActiveClosureOperationOutcome }),
    };
  }

  #validate(identityKey: string, requestHash: string): void {
    if (this.#closed) throw new Error("closure operation store is closed");
    if (!SAFE_ID.test(identityKey) || !HASH.test(requestHash)) throw new Error("closure operation identity is invalid");
  }

  #owned(identityKey: string, requestHash: string): ActiveClosureOperationState {
    const state = this.#state(identityKey);
    if (state === undefined) throw new Error("closure operation was not prepared");
    if (state.requestHash !== requestHash) throw new ActiveClosureOperationConflictError("closure identity was reused for a different request");
    return state;
  }

  begin(identityKey: string, requestHash: string): ActiveClosureOperationState {
    this.#validate(identityKey, requestHash);
    const existing = this.#state(identityKey);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw new ActiveClosureOperationConflictError("closure identity was reused for a different request");
      return existing;
    }
    this.#database.prepare(`
      INSERT INTO active_closure_operations(identity_key,request_hash,status,outcome_json) VALUES (?,?,'PENDING',NULL)
    `).run(identityKey, requestHash);
    return this.#owned(identityKey, requestHash);
  }

  saveOutcome(
    identityKey: string,
    requestHash: string,
    outcome: ActiveClosureOperationOutcome,
  ): ActiveClosureOperationState {
    this.#validate(identityKey, requestHash);
    const current = this.#owned(identityKey, requestHash);
    const payload = serialize(outcome);
    if (current.outcome !== undefined) {
      if (JSON.stringify(current.outcome) !== payload) throw new ActiveClosureOperationConflictError("closure outcome changed after checkpoint");
      return current;
    }
    const result = this.#database.prepare(`
      UPDATE active_closure_operations SET status='OUTCOME',outcome_json=?
      WHERE identity_key=? AND request_hash=? AND status='PENDING'
    `).run(payload, identityKey, requestHash);
    if (result.changes !== 1) throw new ActiveClosureOperationConflictError("closure operation checkpoint changed concurrently");
    return this.#owned(identityKey, requestHash);
  }

  complete(identityKey: string, requestHash: string): ActiveClosureOperationState {
    this.#validate(identityKey, requestHash);
    const current = this.#owned(identityKey, requestHash);
    if (current.status === "COMPLETED") return current;
    if (current.outcome === undefined) throw new Error("closure operation cannot complete before its outcome checkpoint");
    const result = this.#database.prepare(`
      UPDATE active_closure_operations SET status='COMPLETED'
      WHERE identity_key=? AND request_hash=? AND status='OUTCOME'
    `).run(identityKey, requestHash);
    if (result.changes !== 1) throw new ActiveClosureOperationConflictError("closure operation completion changed concurrently");
    return this.#owned(identityKey, requestHash);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void { this.close(); }
}
