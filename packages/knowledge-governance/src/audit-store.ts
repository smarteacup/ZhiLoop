import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type {
  GovernanceAuditEntry,
  GovernanceMutationContext,
  GovernanceOperation,
  SuppressionRecord,
} from "./types.js";

const CURRENT_MIGRATION_VERSION = 1;

interface AuditRow {
  readonly audit_id: string;
  readonly operation: GovernanceOperation;
  readonly target: string;
  readonly actor: string;
  readonly correlation_id: string;
  readonly status: GovernanceAuditEntry["status"];
  readonly reason: string | null;
  readonly error: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be empty`);
  if (normalized.length > 1_000) throw new Error(`${name} exceeds 1000 characters`);
  return normalized;
}

function audit(row: AuditRow): GovernanceAuditEntry {
  return Object.freeze({
    auditId: row.audit_id,
    operation: row.operation,
    target: row.target,
    actor: row.actor,
    correlationId: row.correlation_id,
    status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  });
}

export class SqliteGovernanceStore {
  readonly #database: DatabaseSync;
  readonly #newId: () => string;
  #closed = false;

  constructor(filename: string, newId: () => string = randomUUID) {
    this.#database = new DatabaseSync(filename);
    this.#newId = newId;
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS governance_meta (
        component TEXT PRIMARY KEY,
        migration_version INTEGER NOT NULL CHECK(migration_version >= 0)
      );
    `);
    const existing = this.#database.prepare(
      "SELECT migration_version FROM governance_meta WHERE component = 'knowledge-governance'",
    ).get() as { migration_version: number } | undefined;
    if (existing !== undefined && existing.migration_version > CURRENT_MIGRATION_VERSION) {
      throw new Error(
        `governance migration ${existing.migration_version} is newer than supported version ${CURRENT_MIGRATION_VERSION}`,
      );
    }
    if (existing?.migration_version === CURRENT_MIGRATION_VERSION) return;
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS governance_audit (
          audit_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          target TEXT NOT NULL,
          actor TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('STARTED', 'SUCCEEDED', 'FAILED')),
          reason TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS governance_audit_created_idx ON governance_audit(started_at, audit_id);
        CREATE TABLE IF NOT EXISTS knowledge_suppressions (
          asset_id TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          reason TEXT NOT NULL,
          actor TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(asset_id, scope_key)
        );
        INSERT INTO governance_meta(component, migration_version)
          VALUES ('knowledge-governance', 1)
          ON CONFLICT(component) DO UPDATE SET migration_version=excluded.migration_version;
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("governance store is closed");
  }

  begin(operation: GovernanceOperation, target: string, context: GovernanceMutationContext, reason?: string): string {
    this.#assertOpen();
    const auditId = requireText(this.#newId(), "auditId");
    this.#database.prepare(`
      INSERT INTO governance_audit(
        audit_id, operation, target, actor, correlation_id, status, reason, started_at
      ) VALUES (?, ?, ?, ?, ?, 'STARTED', ?, ?)
    `).run(
      auditId, operation, requireText(target, "target"), requireText(context.actor, "actor"),
      requireText(context.correlationId, "correlationId"), reason === undefined ? null : requireText(reason, "reason"),
      requireText(context.now, "now"),
    );
    return auditId;
  }

  complete(auditId: string, status: "SUCCEEDED" | "FAILED", completedAt: string, error?: string): void {
    this.#assertOpen();
    const result = this.#database.prepare(`
      UPDATE governance_audit SET status = ?, completed_at = ?, error = ?
      WHERE audit_id = ? AND status = 'STARTED'
    `).run(status, requireText(completedAt, "completedAt"), error === undefined ? null : requireText(error.slice(0, 1_000), "error"), auditId);
    if (result.changes !== 1) throw new Error(`audit ${auditId} is missing or already completed`);
  }

  suppress(input: SuppressionRecord): string {
    this.#assertOpen();
    const auditId = requireText(this.#newId(), "auditId");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO knowledge_suppressions(asset_id, scope_key, reason, actor, correlation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, scope_key) DO UPDATE SET
          reason=excluded.reason, actor=excluded.actor, correlation_id=excluded.correlation_id,
          created_at=excluded.created_at
      `).run(
        requireText(input.assetId, "assetId"), requireText(input.scopeKey, "scopeKey"),
        requireText(input.reason, "reason"), requireText(input.actor, "actor"),
        requireText(input.correlationId, "correlationId"), requireText(input.createdAt, "createdAt"),
      );
      this.#database.prepare(`
        INSERT INTO governance_audit(
          audit_id, operation, target, actor, correlation_id, status, reason, started_at, completed_at
        ) VALUES (?, 'SUPPRESS', ?, ?, ?, 'SUCCEEDED', ?, ?, ?)
      `).run(auditId, input.assetId, input.actor, input.correlationId, input.reason, input.createdAt, input.createdAt);
      this.#database.exec("COMMIT");
      return auditId;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getSuppression(assetId: string, scopeKey: string): SuppressionRecord | undefined {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT asset_id, scope_key, reason, actor, correlation_id, created_at
      FROM knowledge_suppressions WHERE asset_id = ? AND scope_key = ?
    `).get(assetId, scopeKey) as {
      asset_id: string; scope_key: string; reason: string; actor: string; correlation_id: string; created_at: string;
    } | undefined;
    return row === undefined ? undefined : Object.freeze({
      assetId: row.asset_id, scopeKey: row.scope_key, reason: row.reason, actor: row.actor,
      correlationId: row.correlation_id, createdAt: row.created_at,
    });
  }

  listAudit(): readonly GovernanceAuditEntry[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT audit_id, operation, target, actor, correlation_id, status, reason, error, started_at, completed_at
      FROM governance_audit ORDER BY started_at ASC, audit_id ASC
    `).all() as unknown as AuditRow[];
    return Object.freeze(rows.map(audit));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
