import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteGovernanceStore } from "./audit-store.js";

const context = { actor: "tester", correlationId: "correlation-audit", now: "2026-08-02T13:00:00.000Z" };

describe("SqliteGovernanceStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("retains STARTED, SUCCEEDED, and FAILED audit details", () => {
    let id = 0;
    const store = new SqliteGovernanceStore(":memory:", () => `audit-store-${++id}`);
    const started = store.begin("REBUILD", "registry", context);
    const failed = store.begin("MARK_STALE", "asset-a", context, "changed");
    store.complete(failed, "FAILED", context.now, "projection failed");
    const successful = store.begin("REBUILD", "registry", context);
    store.complete(successful, "SUCCEEDED", context.now);
    expect(store.listAudit()).toEqual([
      expect.objectContaining({ auditId: started, status: "STARTED" }),
      expect.objectContaining({ auditId: failed, status: "FAILED", reason: "changed", error: "projection failed" }),
      expect.objectContaining({ auditId: successful, status: "SUCCEEDED", completedAt: context.now }),
    ]);
    expect(() => store.complete(successful, "SUCCEEDED", context.now)).toThrow("already completed");
    store.close();
    store.close();
    expect(() => store.listAudit()).toThrow("closed");
  });

  it("validates bounded audit fields", () => {
    const emptyId = new SqliteGovernanceStore(":memory:", () => " ");
    expect(() => emptyId.begin("REBUILD", "registry", context)).toThrow("auditId must not be empty");
    emptyId.close();
    const store = new SqliteGovernanceStore(":memory:", () => "audit-bounds");
    expect(() => store.begin("REBUILD", "x".repeat(1_001), context)).toThrow("exceeds 1000");
    store.close();
  });

  it("upserts suppression and rolls it back if the paired audit cannot commit", () => {
    const ids = ["audit-suppress-1", "audit-suppress-2", "audit-suppress-2"];
    const store = new SqliteGovernanceStore(":memory:", () => ids.shift() ?? "audit-extra");
    const first = {
      assetId: "asset-a", scopeKey: "PROJECT:a", reason: "noise", actor: "tester",
      correlationId: "correlation-1", createdAt: context.now,
    };
    store.suppress(first);
    store.suppress({ ...first, reason: "still noise", correlationId: "correlation-2" });
    expect(store.getSuppression(first.assetId, first.scopeKey)).toMatchObject({ reason: "still noise" });
    expect(() => store.suppress({ ...first, assetId: "asset-b" })).toThrow();
    expect(store.getSuppression("asset-b", first.scopeKey)).toBeUndefined();
    store.close();
  });

  it("creates a private on-disk database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-governance-store-"));
    roots.push(root);
    const filename = path.join(root, "governance.sqlite");
    const store = new SqliteGovernanceStore(filename, () => "audit-file");
    store.close();
    new SqliteGovernanceStore(filename).close();
    if (process.platform !== "win32") expect((await stat(filename)).mode & 0o777).toBe(0o600);
  });

  it("rejects a governance schema newer than the running code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-governance-newer-"));
    roots.push(root);
    const filename = path.join(root, "future.sqlite");
    const future = new DatabaseSync(filename);
    future.exec(`
      CREATE TABLE governance_meta(component TEXT PRIMARY KEY, migration_version INTEGER NOT NULL);
      INSERT INTO governance_meta VALUES ('knowledge-governance', 2);
    `);
    future.close();
    expect(() => new SqliteGovernanceStore(filename)).toThrow("newer than supported");
  });
});
