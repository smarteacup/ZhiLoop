import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  OPERATIONAL_ALERT_SEVERITIES,
  OPERATIONAL_ALERT_TYPES,
  type OperationalAlertInput,
  type OperationalAlertPage,
  type OperationalAlertRecord,
  type OperationalAlertSink,
  type OperationalAlertStoreOptions,
  type AlertOperatorCommand,
  type AlertOperatorCommandResult,
  type AlertOperatorState,
} from "./types.js";

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_MS = 30 * 24 * 60 * 60_000;
const SAFE_TEXT = /^[^\0\r\n]+$/u;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,119}$/u;
const severityRank = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const;

interface AlertRow { readonly alert_id: string; readonly payload_json: string; readonly payload_hash: string; }
interface OperatorStateRow { readonly payload_json: string; readonly payload_hash: string; }
interface OperatorReceiptRow { readonly fingerprint: string; readonly result_json: string; readonly result_hash: string; }

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function safeText(name: string, value: string | undefined, maximum = 500): void {
  if (value !== undefined && (value.trim().length === 0 || value.length > maximum || !SAFE_TEXT.test(value))) throw new Error(`${name}_INVALID`);
}

function timestamp(value: string): void {
  if (value.length < 20 || value.length > 40 || Number.isNaN(Date.parse(value))) throw new Error("OPERATIONAL_ALERT_TIMESTAMP_INVALID");
}

function validate(input: OperationalAlertInput): OperationalAlertInput {
  safeText("OPERATIONAL_ALERT_EVENT_ID", input.eventId, 500);
  safeText("OPERATIONAL_ALERT_DEDUP_KEY", input.dedupKey, 500);
  safeText("OPERATIONAL_ALERT_PROJECT_ID", input.projectId, 500);
  safeText("OPERATIONAL_ALERT_ENTITY_REF", input.entityRef, 1_000);
  timestamp(input.observedAt);
  if (!(OPERATIONAL_ALERT_TYPES as readonly string[]).includes(input.type)) throw new Error("OPERATIONAL_ALERT_TYPE_INVALID");
  if (!(OPERATIONAL_ALERT_SEVERITIES as readonly string[]).includes(input.severity)) throw new Error("OPERATIONAL_ALERT_SEVERITY_INVALID");
  if (input.reasonCodes.length < 1 || input.reasonCodes.length > 32 || input.reasonCodes.some((reason) => !SAFE_REASON.test(reason))) {
    throw new Error("OPERATIONAL_ALERT_REASON_CODES_INVALID");
  }
  return Object.freeze({ ...input, reasonCodes: Object.freeze([...new Set(input.reasonCodes)].sort((a, b) => a.localeCompare(b, "en"))) });
}

function parse(row: AlertRow): OperationalAlertRecord {
  if (hash(row.payload_json) !== row.payload_hash) throw new Error("OPERATIONAL_ALERT_INTEGRITY_FAILED");
  const value = JSON.parse(row.payload_json) as OperationalAlertRecord;
  if (value.schemaVersion !== 1 || value.alertId !== row.alert_id || value.occurrenceCount < 1 || value.revision < 1) {
    throw new Error("OPERATIONAL_ALERT_CORRUPT");
  }
  return Object.freeze({ ...value, reasonCodes: Object.freeze([...value.reasonCodes]) });
}

function alertId(dedupKey: string): string { return `operational-alert-${hash(dedupKey).slice(0, 32)}`; }

export class SqliteOperationalAlertStore implements OperationalAlertSink {
  readonly #database: DatabaseSync;
  readonly #cooldownMs: number;
  readonly #provider: OperationalAlertStoreOptions["provider"];
  #closed = false;

  constructor(filename: string, options: OperationalAlertStoreOptions = {}) {
    const resolved = filename === ":memory:" ? filename : path.resolve(filename);
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#provider = options.provider;
    if (!Number.isSafeInteger(this.#cooldownMs) || this.#cooldownMs < 0 || this.#cooldownMs > MAX_COOLDOWN_MS) {
      throw new Error("OPERATIONAL_ALERT_COOLDOWN_INVALID");
    }
    if (filename !== ":memory:") mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(resolved, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS operational_alerts(
          alert_id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
          severity TEXT NOT NULL, last_observed_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
          payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS operational_alerts_recent ON operational_alerts(last_observed_at DESC,alert_id ASC);
        CREATE TABLE IF NOT EXISTS operational_alert_emissions(
          event_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, alert_id TEXT NOT NULL,
          observed_at TEXT NOT NULL, FOREIGN KEY(alert_id) REFERENCES operational_alerts(alert_id) ON DELETE RESTRICT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS operational_alert_operator_states(
          alert_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
          payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
          FOREIGN KEY(alert_id) REFERENCES operational_alerts(alert_id) ON DELETE RESTRICT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS operational_alert_operator_receipts(
          idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          result_json TEXT NOT NULL, result_hash TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
      `);
    } catch (error) { this.#database.close(); this.#closed = true; throw error; }
  }

  #open(): void { if (this.#closed) throw new Error("OPERATIONAL_ALERT_STORE_CLOSED"); }

  #getById(id: string): OperationalAlertRecord | undefined {
    const row = this.#database.prepare("SELECT alert_id,payload_json,payload_hash FROM operational_alerts WHERE alert_id=?").get(id) as AlertRow | undefined;
    return row === undefined ? undefined : parse(row);
  }

  async emit(raw: OperationalAlertInput): Promise<OperationalAlertRecord> {
    this.#open();
    const input = validate(raw);
    const inputHash = hash(canonical(input));
    const existingEmission = this.#database.prepare("SELECT input_hash,alert_id FROM operational_alert_emissions WHERE event_id=?")
      .get(input.eventId) as { input_hash: string; alert_id: string } | undefined;
    if (existingEmission !== undefined) {
      if (existingEmission.input_hash !== inputHash) throw new Error("OPERATIONAL_ALERT_EVENT_CONFLICT");
      const replay = this.#getById(existingEmission.alert_id);
      if (replay === undefined) throw new Error("OPERATIONAL_ALERT_EMISSION_CORRUPT");
      return replay;
    }

    const id = alertId(input.dedupKey);
    const previous = this.#getById(id);
    if (previous !== undefined && previous.dedupKey !== input.dedupKey) throw new Error("OPERATIONAL_ALERT_ID_COLLISION");
    if (previous !== undefined && (previous.type !== input.type
      || (input.projectId !== undefined && previous.projectId !== undefined && input.projectId !== previous.projectId)
      || (input.entityRef !== undefined && previous.entityRef !== undefined && input.entityRef !== previous.entityRef))) {
      throw new Error("OPERATIONAL_ALERT_DEDUP_IDENTITY_CONFLICT");
    }
    const shouldDeliver = this.#provider !== undefined && (previous?.lastDeliveryAttemptAt === undefined
      || Date.parse(input.observedAt) - Date.parse(previous.lastDeliveryAttemptAt) >= this.#cooldownMs);
    const stronger = previous === undefined || severityRank[input.severity] > severityRank[previous.severity] ? input.severity : previous.severity;
    const record: OperationalAlertRecord = Object.freeze({
      schemaVersion: 1, alertId: id, dedupKey: input.dedupKey, type: input.type, severity: stronger,
      ...(input.projectId === undefined ? previous?.projectId === undefined ? {} : { projectId: previous.projectId } : { projectId: input.projectId }),
      ...(input.entityRef === undefined ? previous?.entityRef === undefined ? {} : { entityRef: previous.entityRef } : { entityRef: input.entityRef }),
      reasonCodes: Object.freeze([...new Set([...(previous?.reasonCodes ?? []), ...input.reasonCodes])]
        .sort((a, b) => a.localeCompare(b, "en")).slice(0, 32)),
      occurrenceCount: (previous?.occurrenceCount ?? 0) + 1,
      firstObservedAt: previous === undefined || Date.parse(input.observedAt) < Date.parse(previous.firstObservedAt)
        ? input.observedAt : previous.firstObservedAt,
      lastObservedAt: previous === undefined || Date.parse(input.observedAt) > Date.parse(previous.lastObservedAt)
        ? input.observedAt : previous.lastObservedAt,
      revision: (previous?.revision ?? 0) + 1,
      deliveryState: this.#provider === undefined ? "LOCAL_ONLY" : shouldDeliver ? "PENDING" : previous?.deliveryState ?? "PENDING",
      ...(shouldDeliver ? { lastDeliveryAttemptAt: input.observedAt } : previous?.lastDeliveryAttemptAt === undefined ? {} : { lastDeliveryAttemptAt: previous.lastDeliveryAttemptAt }),
      ...(previous?.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: previous.lastDeliveredAt }),
      ...(previous?.providerRef === undefined ? {} : { providerRef: previous.providerRef }),
    });
    const serialized = canonical(record);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const write = this.#database.prepare(`INSERT INTO operational_alerts(alert_id,dedup_key,type,severity,last_observed_at,revision,payload_json,payload_hash)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(alert_id) DO UPDATE SET
        type=excluded.type,severity=excluded.severity,last_observed_at=excluded.last_observed_at,
        revision=excluded.revision,payload_json=excluded.payload_json,payload_hash=excluded.payload_hash
        WHERE operational_alerts.revision=?`).run(id, input.dedupKey, input.type, stronger, input.observedAt,
          record.revision, serialized, hash(serialized), previous?.revision ?? 0);
      if (write.changes !== 1) throw new Error("OPERATIONAL_ALERT_REVISION_CONFLICT");
      this.#database.prepare("INSERT INTO operational_alert_emissions(event_id,input_hash,alert_id,observed_at) VALUES(?,?,?,?)")
        .run(input.eventId, inputHash, id, input.observedAt);
      this.#database.exec("COMMIT");
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
    if (!shouldDeliver || this.#provider === undefined) return record;
    try {
      const receipt = await this.#provider.deliver(record);
      return this.#updateDelivery(record.alertId, "DELIVERED", input.observedAt, receipt.providerRef);
    } catch {
      return this.#updateDelivery(record.alertId, "DELIVERY_FAILED", input.observedAt);
    }
  }

  #updateDelivery(alertIdValue: string, state: "DELIVERED" | "DELIVERY_FAILED", at: string, providerRef?: string): OperationalAlertRecord {
    safeText("OPERATIONAL_ALERT_PROVIDER_REF", providerRef, 500);
    const record = this.#getById(alertIdValue);
    if (record === undefined) throw new Error("OPERATIONAL_ALERT_DELIVERY_SOURCE_MISSING");
    const next = Object.freeze({ ...record, revision: record.revision + 1, deliveryState: state,
      ...(state === "DELIVERED" ? { lastDeliveredAt: at } : {}), ...(providerRef === undefined ? {} : { providerRef }) });
    const serialized = canonical(next);
    const result = this.#database.prepare(`UPDATE operational_alerts SET revision=?,payload_json=?,payload_hash=?
      WHERE alert_id=? AND revision=?`).run(next.revision, serialized, hash(serialized), next.alertId, record.revision);
    if (result.changes !== 1) throw new Error("OPERATIONAL_ALERT_DELIVERY_REVISION_CONFLICT");
    return next;
  }

  get(id: string): OperationalAlertRecord | undefined { this.#open(); safeText("OPERATIONAL_ALERT_ID", id, 500); return this.#getById(id); }

  getOperatorState(alertIdValue: string): AlertOperatorState | undefined {
    this.#open(); safeText("OPERATIONAL_ALERT_ID", alertIdValue, 500);
    const row = this.#database.prepare(`SELECT payload_json,payload_hash FROM operational_alert_operator_states WHERE alert_id=?`)
      .get(alertIdValue) as OperatorStateRow | undefined;
    if (row === undefined) return undefined;
    if (hash(row.payload_json) !== row.payload_hash) throw new Error("OPERATIONAL_ALERT_OPERATOR_STATE_INTEGRITY_FAILED");
    const value = JSON.parse(row.payload_json) as AlertOperatorState;
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("OPERATIONAL_ALERT_OPERATOR_STATE_CORRUPT");
    return Object.freeze({ ...value });
  }

  acknowledge(command: AlertOperatorCommand): AlertOperatorCommandResult {
    return this.#operatorCommand(command, "ACKNOWLEDGE");
  }

  suppress(command: AlertOperatorCommand & { readonly suppressedUntil: string }): AlertOperatorCommandResult {
    return this.#operatorCommand(command, "SUPPRESS");
  }

  #operatorCommand(command: AlertOperatorCommand, kind: "ACKNOWLEDGE" | "SUPPRESS"): AlertOperatorCommandResult {
    this.#open();
    safeText("OPERATIONAL_ALERT_ID", command.alertId, 500);
    safeText("OPERATIONAL_ALERT_IDEMPOTENCY_KEY", command.idempotencyKey, 500);
    safeText("OPERATIONAL_ALERT_ACTOR", command.actor, 200);
    timestamp(command.requestedAt);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new Error("OPERATIONAL_ALERT_EXPECTED_REVISION_INVALID");
    }
    if (kind === "SUPPRESS") {
      if (command.suppressedUntil === undefined) throw new Error("OPERATIONAL_ALERT_SUPPRESSION_EXPIRY_REQUIRED");
      timestamp(command.suppressedUntil);
      if (Date.parse(command.suppressedUntil) <= Date.parse(command.requestedAt)
        || Date.parse(command.suppressedUntil) - Date.parse(command.requestedAt) > 30 * 24 * 60 * 60_000) {
        throw new Error("OPERATIONAL_ALERT_SUPPRESSION_EXPIRY_INVALID");
      }
    }
    const fingerprint = hash(canonical({ kind, alertId: command.alertId,
      expectedRevision: command.expectedRevision, actor: command.actor,
      ...(command.suppressedUntil === undefined ? {} : { suppressedUntil: command.suppressedUntil }) }));
    const receipt = this.#database.prepare(`SELECT fingerprint,result_json,result_hash FROM operational_alert_operator_receipts WHERE idempotency_key=?`)
      .get(command.idempotencyKey) as OperatorReceiptRow | undefined;
    if (receipt !== undefined) {
      if (receipt.fingerprint !== fingerprint) throw new Error("OPERATIONAL_ALERT_IDEMPOTENCY_CONFLICT");
      if (hash(receipt.result_json) !== receipt.result_hash) throw new Error("OPERATIONAL_ALERT_OPERATOR_RECEIPT_INTEGRITY_FAILED");
      return Object.freeze(JSON.parse(receipt.result_json) as AlertOperatorCommandResult);
    }
    const alert = this.#getById(command.alertId);
    if (alert === undefined) throw new Error("OPERATIONAL_ALERT_NOT_FOUND");
    const previous = this.getOperatorState(command.alertId);
    if ((previous?.revision ?? 0) !== command.expectedRevision) throw new Error("OPERATIONAL_ALERT_REVISION_CONFLICT");
    const state: AlertOperatorState = Object.freeze({
      revision: (previous?.revision ?? 0) + 1,
      ...(kind === "ACKNOWLEDGE" ? { acknowledgedAt: command.requestedAt, acknowledgedBy: command.actor }
        : previous?.acknowledgedAt === undefined ? {} : { acknowledgedAt: previous.acknowledgedAt, acknowledgedBy: previous.acknowledgedBy }),
      ...(kind === "SUPPRESS" ? { suppressedUntil: command.suppressedUntil }
        : previous?.suppressedUntil === undefined ? {} : { suppressedUntil: previous.suppressedUntil }),
      updatedAt: command.requestedAt,
    });
    const result: AlertOperatorCommandResult = Object.freeze({ alertId: alert.alertId, alertRevision: alert.revision, operatorState: state });
    const stateJson = canonical(state); const resultJson = canonical(result);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const write = previous === undefined
        ? this.#database.prepare(`INSERT INTO operational_alert_operator_states(alert_id,revision,payload_json,payload_hash) VALUES(?,?,?,?)`)
          .run(alert.alertId, state.revision, stateJson, hash(stateJson))
        : this.#database.prepare(`UPDATE operational_alert_operator_states SET revision=?,payload_json=?,payload_hash=? WHERE alert_id=? AND revision=?`)
          .run(state.revision, stateJson, hash(stateJson), alert.alertId, previous.revision);
      if (write.changes !== 1) throw new Error("OPERATIONAL_ALERT_OPERATOR_STATE_REVISION_CONFLICT");
      this.#database.prepare(`INSERT INTO operational_alert_operator_receipts(idempotency_key,fingerprint,result_json,result_hash,created_at) VALUES(?,?,?,?,?)`)
        .run(command.idempotencyKey, fingerprint, resultJson, hash(resultJson), command.requestedAt);
      this.#database.exec("COMMIT");
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
    return result;
  }

  list(request: { readonly limit: number; readonly projectId?: string;
    readonly after?: { readonly lastObservedAt: string; readonly alertId: string } }): OperationalAlertPage {
    this.#open();
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) throw new Error("OPERATIONAL_ALERT_LIST_LIMIT_INVALID");
    safeText("OPERATIONAL_ALERT_PROJECT_ID", request.projectId, 500);
    if (request.after !== undefined) { timestamp(request.after.lastObservedAt); safeText("OPERATIONAL_ALERT_CURSOR_ID", request.after.alertId, 500); }
    const projectClause = request.projectId === undefined ? "" : "json_extract(payload_json,'$.projectId')=? AND ";
    const rows = (request.after === undefined
      ? this.#database.prepare(`SELECT alert_id,payload_json,payload_hash FROM operational_alerts
          WHERE ${projectClause}1=1 ORDER BY last_observed_at DESC,alert_id ASC LIMIT ?`)
        .all(...(request.projectId === undefined ? [] : [request.projectId]), request.limit + 1)
      : this.#database.prepare(`SELECT alert_id,payload_json,payload_hash FROM operational_alerts
          WHERE ${projectClause}(last_observed_at < ? OR (last_observed_at=? AND alert_id>?))
          ORDER BY last_observed_at DESC,alert_id ASC LIMIT ?`).all(
            ...(request.projectId === undefined ? [] : [request.projectId]), request.after.lastObservedAt,
            request.after.lastObservedAt, request.after.alertId, request.limit + 1,
          )) as unknown as AlertRow[];
    const page = rows.slice(0, request.limit).map(parse);
    const last = page.at(-1);
    return Object.freeze({ items: Object.freeze(page), ...(rows.length <= request.limit || last === undefined ? {} : {
      next: Object.freeze({ lastObservedAt: last.lastObservedAt, alertId: last.alertId }),
    }) });
  }

  close(): void { if (this.#closed) return; this.#database.close(); this.#closed = true; }
}
