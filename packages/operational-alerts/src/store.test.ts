import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteOperationalAlertStore } from "./store.js";
import type { OperationalAlertInput } from "./types.js";

const roots: string[] = [];
const at = "2026-08-19T01:00:00.000Z";

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function filename(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "zhiloop-operational-alerts-"));
  roots.push(root);
  return path.join(root, "alerts.sqlite");
}

function input(overrides: Partial<OperationalAlertInput> = {}): OperationalAlertInput {
  return {
    eventId: "event-1", observedAt: at, dedupKey: "knowledge:asset-1@2", severity: "WARNING",
    type: "STALE_KNOWLEDGE", projectId: "project-1", entityRef: "asset-1@2",
    reasonCodes: ["VERIFICATION_CONFLICT"], ...overrides,
  };
}

describe("SqliteOperationalAlertStore", () => {
  it("persists owner-only local alerts and survives restart", async () => {
    const file = await filename();
    let store = new SqliteOperationalAlertStore(file);
    const created = await store.emit(input());
    expect(created).toMatchObject({ occurrenceCount: 1, deliveryState: "LOCAL_ONLY", revision: 1 });
    store.close();
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    store = new SqliteOperationalAlertStore(file);
    expect(store.get(created.alertId)).toEqual(created);
    store.close();
  });

  it("makes exact event replay idempotent and rejects conflicting reuse", async () => {
    const store = new SqliteOperationalAlertStore(await filename());
    const first = await store.emit(input());
    expect(await store.emit(input())).toEqual(first);
    await expect(store.emit(input({ severity: "CRITICAL" }))).rejects.toThrow("OPERATIONAL_ALERT_EVENT_CONFLICT");
    expect(store.list({ limit: 10 }).items).toHaveLength(1);
    store.close();
  });

  it("aggregates duplicate keys and suppresses provider delivery inside cooldown", async () => {
    const deliver = vi.fn().mockResolvedValue({ providerRef: "provider-1" });
    const store = new SqliteOperationalAlertStore(await filename(), { cooldownMs: 60_000, provider: { deliver } });
    const first = await store.emit(input());
    expect(first).toMatchObject({ deliveryState: "DELIVERED", providerRef: "provider-1" });
    const second = await store.emit(input({ eventId: "event-2", observedAt: "2026-08-19T01:00:30.000Z", severity: "CRITICAL",
      reasonCodes: ["VERIFICATION_CONFLICT", "ASSERTION_REFUTED"] }));
    expect(second).toMatchObject({ occurrenceCount: 2, severity: "CRITICAL", deliveryState: "DELIVERED" });
    expect(second.reasonCodes).toEqual(["ASSERTION_REFUTED", "VERIFICATION_CONFLICT"]);
    expect(deliver).toHaveBeenCalledTimes(1);
    await store.emit(input({ eventId: "event-3", observedAt: "2026-08-19T01:01:30.000Z" }));
    expect(deliver).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("preserves local evidence when provider delivery fails", async () => {
    const store = new SqliteOperationalAlertStore(await filename(), { provider: { deliver: async () => { throw new Error("secret provider failure"); } } });
    const result = await store.emit(input());
    expect(result.deliveryState).toBe("DELIVERY_FAILED");
    expect(JSON.stringify(result)).not.toContain("secret");
    store.close();
  });

  it("merges delivery state into an alert updated while provider delivery is pending", async () => {
    let release: ((value: { providerRef: string }) => void) | undefined;
    const delivery = new Promise<{ providerRef: string }>((resolve) => { release = resolve; });
    const store = new SqliteOperationalAlertStore(await filename(), { cooldownMs: 60_000,
      provider: { deliver: async () => await delivery } });
    const first = store.emit(input());
    const second = await store.emit(input({ eventId: "event-2", observedAt: "2026-08-19T01:00:30.000Z" }));
    expect(second).toMatchObject({ occurrenceCount: 2, deliveryState: "PENDING" });
    release?.({ providerRef: "provider-race" });
    await expect(first).resolves.toMatchObject({ occurrenceCount: 2, deliveryState: "DELIVERED", providerRef: "provider-race" });
    store.close();
  });

  it("rejects reuse of one deduplication key for a different alert identity", async () => {
    const store = new SqliteOperationalAlertStore(await filename());
    await store.emit(input());
    await expect(store.emit(input({ eventId: "event-2", type: "MIGRATION_FAILED" })))
      .rejects.toThrow("OPERATIONAL_ALERT_DEDUP_IDENTITY_CONFLICT");
    store.close();
  });

  it("paginates deterministically and validates input bounds", async () => {
    const store = new SqliteOperationalAlertStore(await filename());
    await store.emit(input());
    await store.emit(input({ eventId: "event-2", dedupKey: "job:2", type: "PERMANENT_JOB_FAILURE",
      entityRef: "job-2", observedAt: "2026-08-19T01:01:00.000Z", reasonCodes: ["ATTEMPTS_EXHAUSTED"] }));
    const page = store.list({ limit: 1 });
    expect(page.items[0]?.entityRef).toBe("job-2");
    expect(store.list({ limit: 1, after: page.next! }).items[0]?.entityRef).toBe("asset-1@2");
    await expect(store.emit(input({ reasonCodes: ["not safe"] }))).rejects.toThrow("REASON_CODES_INVALID");
    expect(() => store.list({ limit: 0 })).toThrow("LIST_LIMIT_INVALID");
    store.close();
  });

  it("applies a project filter before pagination", async () => {
    const store = new SqliteOperationalAlertStore(await filename());
    await store.emit(input({ eventId: "event-project-a", dedupKey: "project-a", projectId: "project-a" }));
    await store.emit(input({ eventId: "event-project-b", dedupKey: "project-b", projectId: "project-b",
      observedAt: "2026-08-19T02:00:00.000Z" }));
    expect(store.list({ projectId: "project-a", limit: 1 }).items.map((item) => item.projectId)).toEqual(["project-a"]);
    store.close();
  });

  it("stores acknowledgement and suppression independently with revision and idempotency guards", async () => {
    const file = await filename(); let store = new SqliteOperationalAlertStore(file);
    const alert = await store.emit(input());
    const acknowledged = store.acknowledge({ alertId: alert.alertId, expectedRevision: 0,
      idempotencyKey: "ack:alert-1", requestedAt: "2026-08-19T01:02:00.000Z", actor: "local-console" });
    expect(acknowledged.operatorState).toMatchObject({ revision: 1, acknowledgedBy: "local-console" });
    expect(store.get(alert.alertId)).toEqual(alert);
    expect(store.acknowledge({ alertId: alert.alertId, expectedRevision: 0,
      idempotencyKey: "ack:alert-1", requestedAt: "2026-08-19T01:02:30.000Z", actor: "local-console" })).toEqual(acknowledged);
    const suppressed = store.suppress({ alertId: alert.alertId, expectedRevision: acknowledged.operatorState.revision,
      idempotencyKey: "suppress:alert-1", requestedAt: "2026-08-19T01:03:00.000Z",
      suppressedUntil: "2026-08-19T02:03:00.000Z", actor: "local-console" });
    expect(suppressed.operatorState).toMatchObject({ revision: 2, acknowledgedBy: "local-console",
      suppressedUntil: "2026-08-19T02:03:00.000Z" });
    store.close(); store = new SqliteOperationalAlertStore(file);
    expect(store.getOperatorState(alert.alertId)).toEqual(suppressed.operatorState);
    store.close();
  });

  it("rejects stale, conflicting, missing, and invalid suppression commands", async () => {
    const store = new SqliteOperationalAlertStore(await filename()); const alert = await store.emit(input());
    expect(() => store.acknowledge({ alertId: alert.alertId, expectedRevision: 99, idempotencyKey: "ack:stale",
      requestedAt: "2026-08-19T01:02:00.000Z", actor: "local-console" })).toThrow("REVISION_CONFLICT");
    store.acknowledge({ alertId: alert.alertId, expectedRevision: 0, idempotencyKey: "ack:conflict",
      requestedAt: "2026-08-19T01:02:00.000Z", actor: "local-console" });
    expect(() => store.acknowledge({ alertId: alert.alertId, expectedRevision: 0, idempotencyKey: "ack:stale-tab",
      requestedAt: "2026-08-19T01:02:30.000Z", actor: "local-console" })).toThrow("REVISION_CONFLICT");
    expect(() => store.acknowledge({ alertId: alert.alertId, expectedRevision: 1,
      idempotencyKey: "ack:conflict", requestedAt: "2026-08-19T01:03:00.000Z", actor: "another-actor" })).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => store.suppress({ alertId: alert.alertId, expectedRevision: 1, idempotencyKey: "suppress:bad",
      requestedAt: "2026-08-19T01:03:00.000Z", suppressedUntil: "2026-08-19T01:02:00.000Z", actor: "local-console" }))
      .toThrow("SUPPRESSION_EXPIRY_INVALID");
    store.close();
  });

  it("rejects invalid configuration and bounded alert fields", async () => {
    expect(() => new SqliteOperationalAlertStore(":memory:", { cooldownMs: -1 })).toThrow("COOLDOWN_INVALID");
    const store = new SqliteOperationalAlertStore(":memory:");
    const invalid: Array<[Partial<OperationalAlertInput>, string]> = [
      [{ eventId: "" }, "EVENT_ID_INVALID"],
      [{ dedupKey: "bad\nkey" }, "DEDUP_KEY_INVALID"],
      [{ observedAt: "not-a-time" }, "TIMESTAMP_INVALID"],
      [{ type: "UNKNOWN" as never }, "TYPE_INVALID"],
      [{ severity: "ERROR" as never }, "SEVERITY_INVALID"],
      [{ reasonCodes: [] }, "REASON_CODES_INVALID"],
      [{ reasonCodes: Array.from({ length: 33 }, (_, index) => `REASON_${index}`) }, "REASON_CODES_INVALID"],
    ];
    for (const [override, error] of invalid) await expect(store.emit(input(override))).rejects.toThrow(error);
    expect(store.get("missing-alert")).toBeUndefined();
    store.close();
    expect(() => store.get("missing-alert")).toThrow("STORE_CLOSED");
    await expect(store.emit(input())).rejects.toThrow("STORE_CLOSED");
  });

  it("rolls back the current alert when its emission receipt cannot be persisted", async () => {
    const file = await filename();
    const store = new SqliteOperationalAlertStore(file);
    const database = new DatabaseSync(file);
    database.exec("CREATE TRIGGER reject_emission BEFORE INSERT ON operational_alert_emissions BEGIN SELECT RAISE(ABORT, 'rejected'); END;");
    database.close();
    await expect(store.emit(input())).rejects.toThrow("rejected");
    expect(store.list({ limit: 10 }).items).toEqual([]);
    store.close();
  });

  it("closes a database that fails schema initialization", async () => {
    const file = await filename();
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE operational_alerts(x TEXT) STRICT;");
    database.close();
    expect(() => new SqliteOperationalAlertStore(file)).toThrow();
  });

  it("detects payload corruption", async () => {
    const file = await filename();
    const store = new SqliteOperationalAlertStore(file);
    const created = await store.emit(input());
    store.close();
    const database = new DatabaseSync(file);
    database.prepare("UPDATE operational_alerts SET payload_json='{}',payload_hash=? WHERE alert_id=?")
      .run(createHash("sha256").update("{}").digest("hex"), created.alertId);
    database.close();
    const reopened = new SqliteOperationalAlertStore(file);
    expect(() => reopened.get(created.alertId)).toThrow("OPERATIONAL_ALERT_CORRUPT");
    reopened.close();
  });
});
