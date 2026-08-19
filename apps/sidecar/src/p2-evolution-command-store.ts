import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class EvolutionCommandReceiptStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    const target = resolve(filename); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(target);
    try {
      if (process.platform !== "win32") chmodSync(target, 0o600);
      this.#database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS evolution_command_receipts(
          idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          result_json TEXT NOT NULL, result_hash TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;`);
    } catch (error) { this.#database.close(); throw error; }
  }

  get<T>(idempotencyKey: string, fingerprint: string): T | undefined {
    if (this.#closed) throw new Error("EVOLUTION_COMMAND_STORE_CLOSED");
    const row = this.#database.prepare(`SELECT fingerprint,result_json,result_hash FROM evolution_command_receipts WHERE idempotency_key=?`)
      .get(idempotencyKey) as { fingerprint: string; result_json: string; result_hash: string } | undefined;
    if (row === undefined) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("EVOLUTION_COMMAND_IDEMPOTENCY_CONFLICT");
    if (hash(row.result_json) !== row.result_hash) throw new Error("EVOLUTION_COMMAND_RECEIPT_INTEGRITY_FAILED");
    return Object.freeze(JSON.parse(row.result_json) as T);
  }

  save<T>(idempotencyKey: string, fingerprint: string, result: T, createdAt: string): T {
    if (this.#closed) throw new Error("EVOLUTION_COMMAND_STORE_CLOSED");
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) throw new Error("EVOLUTION_COMMAND_RECEIPT_LIMIT_EXCEEDED");
    this.#database.prepare(`INSERT INTO evolution_command_receipts(idempotency_key,fingerprint,result_json,result_hash,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).run(idempotencyKey, fingerprint, serialized, hash(serialized), createdAt);
    const stored = this.get<T>(idempotencyKey, fingerprint);
    if (stored === undefined) throw new Error("EVOLUTION_COMMAND_RECEIPT_MISSING");
    return stored;
  }

  close(): void { if (this.#closed) return; this.#database.close(); this.#closed = true; }
}
