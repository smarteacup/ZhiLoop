import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONSOLE_CONFIGURATION } from "./schema.js";
import { SqliteConfigurationService } from "./service.js";
import type { ConfigurationActivationComponent, ConsumerCapability } from "./types.js";

const services: SqliteConfigurationService[] = [];
const directories: string[] = [];

function service(options: ConstructorParameters<typeof SqliteConfigurationService>[1] = {}): SqliteConfigurationService {
  const value = new SqliteConfigurationService(":memory:", options);
  services.push(value);
  return value;
}

function key(suffix: string): string {
  return `configuration-test-${suffix.padEnd(20, "x")}`;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (value) => await value.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteConfigurationService", () => {
  it("starts with bounded defaults and rejects stale or unknown drafts", () => {
    const target = service();
    expect(target.get()).toMatchObject({ revision: 0, effective: DEFAULT_CONSOLE_CONFIGURATION });
    expect(target.get().sources["runtime.sessionScanIntervalMs"]).toBe("DEFAULT");
    expect(() => { (target.get().effective.runtime as { scanBatchSize: number }).scanBatchSize = 999; }).toThrow();
    expect(target.validateDraft({ baseRevision: 1, scope: "GLOBAL", draft: {} })).toEqual({
      ok: false,
      diagnostics: [{ code: "STALE_REVISION", retryable: false }],
    });
    const invalid = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { unexpected: true } });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.diagnostics[0]).toMatchObject({ code: "INVALID_CONFIGURATION", path: "unexpected" });
  });

  it("preserves future drafts but rejects activation until the consumer is ready", async () => {
    let capability: ConsumerCapability = "DISABLED";
    const target = service({ capabilities: () => ({ "knowledge.retrieval": capability }) });
    const validation = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { future: { injectionMaxTokens: 1_200 } } });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.draft).toMatchObject({ activatable: false, diagnostics: [{ code: "CONSUMER_DISABLED", path: "future.injectionMaxTokens" }] });
    expect(await target.activate(0, validation.draft.draftRevision, key("disabled"))).toMatchObject({ ok: false, diagnostic: { code: "CONSUMER_DISABLED" } });
    capability = "READY";
    expect(await target.activate(0, validation.draft.draftRevision, key("ready"))).toMatchObject({ ok: false, diagnostic: { code: "CONSUMER_DISABLED" } });
  });

  it("rechecks a READY future consumer at activation time", async () => {
    let capability: ConsumerCapability = "READY";
    const target = service({ capabilities: () => ({ "codex.query": capability }) });
    const validation = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { future: { codexQueryConcurrency: 4 } } });
    if (!validation.ok) throw new Error("expected draft");
    expect(validation.draft).toMatchObject({ activatable: true, requiresRestart: true });
    capability = "DISABLED";
    expect(await target.activate(0, validation.draft.draftRevision, key("recheck"))).toMatchObject({ ok: false, diagnostic: { code: "CONSUMER_DISABLED" } });
  });

  it("marks restart impact, activates atomically and replays an idempotent command", async () => {
    const applied: number[] = [];
    const component: ConfigurationActivationComponent = {
      componentId: "worker",
      prepare: vi.fn(async () => undefined),
      apply: vi.fn(async (configuration) => {
        applied.push(configuration.runtime.workerConcurrency);
        return async () => { applied.pop(); };
      }),
    };
    const target = service({ components: [component] });
    const validation = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { workerConcurrency: 4 } } });
    if (!validation.ok) throw new Error("expected valid draft");
    expect(validation.draft.requiresRestart).toBe(true);
    expect(target.drafts(1)[0]?.draftRevision).toBe(validation.draft.draftRevision);
    const result = await target.activate(0, validation.draft.draftRevision, key("activate"), "operator-1");
    expect(result).toMatchObject({ ok: true, revision: 1, status: "EFFECTIVE" });
    expect(await target.activate(0, validation.draft.draftRevision, key("activate"), "operator-1")).toEqual(result);
    expect(component.apply).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([4]);
    expect(target.get()).toMatchObject({ revision: 1, effective: { runtime: { workerConcurrency: 4 } } });
    expect(target.audit()).toMatchObject([{ revision: 1, operatorId: "operator-1", code: "ACTIVATED", changedPaths: ["runtime.workerConcurrency"] }]);
  });

  it("rolls back applied components and records a rejected immutable revision on partial failure", async () => {
    const rollback = vi.fn(async () => undefined);
    const target = service({
      components: [
        { componentId: "first", prepare: async () => undefined, apply: async () => rollback },
        { componentId: "second", prepare: async () => undefined, apply: async () => { throw new Error("apply failed"); } },
      ],
    });
    const validation = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { scanBatchSize: 20 } } });
    if (!validation.ok) throw new Error("expected valid draft");
    expect(await target.activate(0, validation.draft.draftRevision, key("partial"))).toMatchObject({ ok: false, diagnostic: { code: "COMPONENT_APPLY_FAILED" } });
    expect(rollback).toHaveBeenCalledOnce();
    expect(target.get()).toMatchObject({ revision: 1, effective: { runtime: { scanBatchSize: 100 } } });
    expect(target.history()[0]).toMatchObject({ revision: 1, status: "REJECTED", reasonCode: "COMPONENT_APPLY_FAILED" });
  });

  it("records prepare failure without applying another component", async () => {
    const apply = vi.fn(async () => async () => undefined);
    const target = service({ components: [{
      componentId: "rejecting-component",
      prepare: async () => { throw new Error("prepare failed"); },
      apply,
    }] });
    const validation = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { captureBatchSize: 22 } } });
    if (!validation.ok) throw new Error("expected draft");
    expect(await target.activate(0, validation.draft.draftRevision, key("prepare"), "operator-prepare")).toMatchObject({ ok: false, diagnostic: { code: "COMPONENT_PREPARE_FAILED" } });
    expect(apply).not.toHaveBeenCalled();
    expect(target.history(1)[0]).toMatchObject({ status: "REJECTED" });
    expect(target.audit(1)[0]).toMatchObject({ operatorId: "operator-prepare", component: "rejecting-component", code: "PREPARE_FAILED" });
  });

  it("retains project override inheritance across later global activation", async () => {
    const target = service();
    const project = target.validateDraft({ baseRevision: 0, scope: "PROJECT", projectId: "project-a", draft: { runtime: { scanBatchSize: 25 } } });
    if (!project.ok) throw new Error("expected project draft");
    expect(await target.activate(0, project.draft.draftRevision, key("project"))).toMatchObject({ ok: true, revision: 1 });
    const global = target.validateDraft({ baseRevision: 1, scope: "GLOBAL", draft: { runtime: { captureBatchSize: 35 } } });
    if (!global.ok) throw new Error("expected global draft");
    expect(await target.activate(1, global.draft.draftRevision, key("global"))).toMatchObject({ ok: true, revision: 2 });
    const effective = target.get("project-a");
    expect(effective.effective.runtime).toMatchObject({ scanBatchSize: 25, captureBatchSize: 35 });
    expect(effective.sources).toMatchObject({
      "runtime.scanBatchSize": "PROJECT_OVERRIDE",
      "runtime.captureBatchSize": "GLOBAL",
      "runtime.sessionScanIntervalMs": "DEFAULT",
    });
  });

  it("creates a new rollback revision and keeps history immutable", async () => {
    const target = service();
    const one = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { scanBatchSize: 10 } } });
    if (!one.ok) throw new Error("expected draft");
    await target.activate(0, one.draft.draftRevision, key("one"));
    const two = target.validateDraft({ baseRevision: 1, scope: "GLOBAL", draft: { runtime: { scanBatchSize: 20 } } });
    if (!two.ok) throw new Error("expected draft");
    await target.activate(1, two.draft.draftRevision, key("two"));
    expect(await target.rollback(2, 1, key("rollback"))).toMatchObject({ ok: true, revision: 3, status: "ROLLED_BACK" });
    expect(target.get().effective.runtime.scanBatchSize).toBe(10);
    expect(target.history().map(({ revision, status }) => [revision, status])).toEqual([[3, "ROLLED_BACK"], [2, "EFFECTIVE"], [1, "EFFECTIVE"], [0, "EFFECTIVE"]]);
  });

  it("rejects missing, stale, and rejected rollback targets", async () => {
    const target = service({ components: [{ componentId: "reject", prepare: async () => { throw new Error("no"); }, apply: async () => async () => undefined }] });
    expect(await target.rollback(0, 99, key("missing"))).toMatchObject({ ok: false, diagnostic: { code: "NOT_FOUND" } });
    const draft = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { captureBatchSize: 42 } } });
    if (!draft.ok) throw new Error("expected draft");
    await target.activate(0, draft.draft.draftRevision, key("rejected"));
    expect(await target.rollback(1, 1, key("rejected-target"))).toMatchObject({ ok: false, diagnostic: { code: "NOT_FOUND" } });
    expect(await target.rollback(0, 0, key("stale-rollback"))).toMatchObject({ ok: false, diagnostic: { code: "STALE_REVISION" } });
  });

  it("keeps the effective revision when a rollback component fails to apply", async () => {
    let fail = false;
    const rollbackApplied = vi.fn(async () => undefined);
    const first: ConfigurationActivationComponent = {
      componentId: "rollback-first",
      prepare: async () => undefined,
      apply: async () => rollbackApplied,
    };
    const second: ConfigurationActivationComponent = {
      componentId: "rollback-sensitive",
      prepare: async () => undefined,
      apply: async () => {
        if (fail) throw new Error("rollback apply failed");
        return async () => undefined;
      },
    };
    const target = service({ components: [first, second] });
    const draft = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { scanBatchSize: 9 } } });
    if (!draft.ok) throw new Error("expected draft");
    await target.activate(0, draft.draft.draftRevision, key("before-rollback-fail"));
    fail = true;
    expect(await target.rollback(1, 0, key("rollback-apply-fail"))).toMatchObject({ ok: false, diagnostic: { code: "COMPONENT_APPLY_FAILED" } });
    expect(rollbackApplied).toHaveBeenCalledOnce();
    expect(target.get()).toMatchObject({ revision: 2, effective: { runtime: { scanBatchSize: 9 } } });
    expect(target.history(1)[0]).toMatchObject({ status: "REJECTED", reasonCode: "ROLLBACK_COMPONENT_APPLY_FAILED" });
  });

  it("bounds list queries, project identity, clocks, and closed access", async () => {
    const target = service();
    expect(target.getDraft(404)).toBeUndefined();
    expect(target.drafts()).toEqual([]);
    expect(() => target.drafts(0)).toThrow("draft limit");
    expect(() => target.history(501)).toThrow("history limit");
    expect(() => target.audit(Number.NaN)).toThrow("audit limit");
    expect(() => target.validateDraft({ baseRevision: 0, scope: "PROJECT", draft: {} })).toThrow("safe project id");
    expect(() => target.validateDraft({ baseRevision: 0, scope: "GLOBAL", projectId: "unexpected", draft: {} })).toThrow("must not name a project");
    const invalidBackoff = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { captureRetry: { baseDelayMs: 2_000, maximumDelayMs: 1_000 } } } });
    expect(invalidBackoff).toMatchObject({ ok: false, diagnostics: [{ code: "INVALID_CONFIGURATION", path: "runtime.captureRetry.baseDelayMs" }] });
    await target.close();
    await target.close();
    expect(() => target.get()).toThrow("closed");

    expect(() => service({ clock: () => new Date(Number.NaN) })).toThrow("invalid date");
  });

  it("detects idempotency conflicts and never copies configuration values into audit", async () => {
    const target = service();
    const draft = target.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { sessionScanIntervalMs: 12_345 } } });
    if (!draft.ok) throw new Error("expected draft");
    await target.activate(0, draft.draft.draftRevision, key("conflict"));
    expect(await target.rollback(1, 0, key("conflict"))).toMatchObject({ ok: false, diagnostic: { code: "CONFLICT" } });
    expect(JSON.stringify(target.audit())).not.toContain("12345");
  });

  it("persists the last-known-good revision with private database permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-configuration-"));
    directories.push(directory);
    const filename = join(directory, "configuration.sqlite");
    const first = new SqliteConfigurationService(filename);
    const draft = first.validateDraft({ baseRevision: 0, scope: "GLOBAL", draft: { runtime: { captureBatchSize: 41 } } });
    if (!draft.ok) throw new Error("expected draft");
    await first.activate(0, draft.draft.draftRevision, key("persist"));
    await first.close();
    const bytes = readFileSync(filename);
    expect(bytes.length).toBeGreaterThan(0);
    const reopened = new SqliteConfigurationService(filename);
    services.push(reopened);
    expect(reopened.get()).toMatchObject({ revision: 1, effective: { runtime: { captureBatchSize: 41 } } });
  });
});
