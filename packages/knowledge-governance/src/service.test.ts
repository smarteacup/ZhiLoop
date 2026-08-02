import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { KnowledgeAsset } from "@zhiloop/domain";
import { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import { calculateKnowledgeContentHash, MarkdownKnowledgeRepository } from "@zhiloop/markdown-repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KnowledgeGovernanceService, SqliteGovernanceStore } from "./index.js";

const now1 = "2026-08-02T10:00:00.000Z";
const now2 = "2026-08-02T11:00:00.000Z";

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  const draft: KnowledgeAsset = {
    schemaVersion: 1,
    id,
    subjectKey: id,
    kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-a" },
    version: 1,
    status: "IMPLEMENTED",
    title: "Governance title",
    summary: "Governance summary",
    body: "Governance body",
    aliases: [], keywords: ["governance"], applicability: ["project-a"], nonApplicability: [],
    symbols: ["KnowledgeGovernanceService"], relations: [],
    evidence: [{ evidenceId: "evidence-governance", verdict: "SUPPORTS" }],
    confidence: 0.95,
    sourceEpisodes: ["episode-governance"],
    contentHash: "",
    correlationId: "correlation-v1",
    createdAt: now1,
    updatedAt: now1,
    ...overrides,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

describe("KnowledgeGovernanceService", () => {
  let root: string;
  let markdown: MarkdownKnowledgeRepository;
  let registry: SqliteKnowledgeRegistryProjection;
  let store: SqliteGovernanceStore;
  let service: KnowledgeGovernanceService;
  let nextAudit: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zhiloop-governance-"));
    markdown = new MarkdownKnowledgeRepository(path.join(root, "markdown"));
    registry = new SqliteKnowledgeRegistryProjection(":memory:");
    nextAudit = 0;
    store = new SqliteGovernanceStore(":memory:", () => `audit-${++nextAudit}`);
    service = new KnowledgeGovernanceService(markdown, registry, store);
    const first = await markdown.publish(asset("knowledge.governance.asset"), { expectedCurrentVersion: 0 });
    registry.projectCurrent(first.value);
  });

  afterEach(async () => {
    store.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });

  it("lists, shows, diffs, and traces projected knowledge", async () => {
    const original = service.show("knowledge.governance.asset");
    expect(service.list()).toMatchObject([{ asset: { id: original.asset.id } }]);
    const secondAsset = asset(original.asset.id, {
      version: 2,
      title: "Updated governance title",
      relations: [{ type: "SUPERSEDES", targetId: original.asset.id, targetVersion: 1 }],
      correlationId: "correlation-v2",
      updatedAt: now2,
    });
    const second = await markdown.publish(secondAsset, { expectedCurrentVersion: 1 });
    registry.projectCurrent(second.value);
    expect(service.diff(original.asset.id, 1, 2).changes.map((change) => change.field)).toEqual(
      expect.arrayContaining(["version", "title", "relations", "contentHash"]),
    );
    expect(service.trace(original.asset.id)).toEqual({
      assetId: original.asset.id,
      version: 2,
      sourceEpisodes: ["episode-governance"],
      evidence: secondAsset.evidence,
      relations: secondAsset.relations,
    });
    expect(() => service.diff(original.asset.id, 2, 2)).toThrow("different");
    expect(() => service.trace(original.asset.id, 99)).toThrow("was not found");
  });

  it("marks eligible knowledge stale, publishes it, and retains a successful audit", async () => {
    const result = await service.markStale({
      assetId: "knowledge.governance.asset", reason: "implementation changed", actor: "tester",
      correlationId: "correlation-stale", now: now2,
    });
    expect(result).toMatchObject({ auditId: "audit-1", value: { asset: { version: 2, status: "STALE" } } });
    expect(result.value.asset.relations).toContainEqual({
      type: "SUPERSEDES", targetId: result.value.asset.id, targetVersion: 1, reason: "implementation changed",
    });
    expect((await markdown.readCurrent(result.value.asset.id))).toMatchObject({ ok: true, value: { asset: { status: "STALE" } } });
    expect(store.listAudit()).toMatchObject([{ operation: "MARK_STALE", status: "SUCCEEDED", actor: "tester" }]);
    await expect(service.markStale({
      assetId: result.value.asset.id, reason: "already stale", actor: "tester",
      correlationId: "correlation-stale-again", now: now2,
    })).rejects.toThrow("cannot mark STALE");
  });

  it("rejects illegal stale transitions and records the failed attempt", async () => {
    const accepted = asset("knowledge.governance.accepted", { status: "ACCEPTED" });
    registry.projectCurrent((await markdown.publish(accepted, { expectedCurrentVersion: 0 })).value);
    await expect(service.markStale({
      assetId: accepted.id, reason: "not legal", actor: "tester", correlationId: "correlation-failed", now: now2,
    })).rejects.toThrow("cannot mark ACCEPTED");
    expect(store.listAudit()).toContainEqual(expect.objectContaining({
      operation: "MARK_STALE", target: accepted.id, status: "FAILED", error: expect.stringContaining("cannot mark ACCEPTED"),
    }));
  });

  it("stores suppression and its audit atomically by asset and scope", () => {
    const result = service.suppress({
      assetId: "knowledge.governance.asset", reason: "irrelevant here", scopeKey: "PROJECT:project-a",
      actor: "tester", correlationId: "correlation-suppress", now: now2,
    });
    expect(result.auditId).toBe("audit-1");
    expect(store.getSuppression(result.value.assetId, result.value.scopeKey)).toEqual(result.value);
    expect(store.listAudit()).toMatchObject([{ operation: "SUPPRESS", status: "SUCCEEDED" }]);
    const defaultScope = service.suppress({
      assetId: "knowledge.governance.asset", reason: "default scope", actor: "tester",
      correlationId: "correlation-default-scope", now: now2,
    });
    expect(defaultScope.value.scopeKey).toBe('{"level":"PROJECT","projectId":"project-a"}');
  });

  it("rebuilds from Markdown with an audit and diagnoses missing/hash/orphan projection states", async () => {
    expect(await service.doctor()).toMatchObject({ healthy: true, markdownAssets: 1, projectedAssets: 1 });
    const current = await markdown.readCurrent("knowledge.governance.asset");
    if (!current.ok) throw new Error("fixture current missing");
    await writeFile(current.value.documentPath, (await readFile(current.value.documentPath, "utf8")).replace(
      "Governance summary", "Manually changed summary",
    ), "utf8");
    const mismatch = await service.doctor();
    expect(mismatch.healthy).toBe(false);
    expect(mismatch.diagnostics).toContainEqual(expect.objectContaining({ code: "HASH_MISMATCH" }));

    await markdown.adoptManualEdit("knowledge.governance.asset", {
      expectedCurrentVersion: 1, correlationId: "correlation-adopt", updatedAt: now2,
    });

    const rebuilt = await service.rebuild({ actor: "tester", correlationId: "correlation-rebuild", now: now2 });
    expect(rebuilt.value).toMatchObject({ assets: 1, versions: 2 });
    expect(store.listAudit().at(-1)).toMatchObject({ operation: "REBUILD", status: "SUCCEEDED" });
    expect((await service.doctor()).diagnostics).toEqual([]);
  });

  it("reports invalid Markdown current and projections without Markdown", async () => {
    const orphanRoot = path.join(root, "other-markdown");
    const orphanMarkdown = new MarkdownKnowledgeRepository(orphanRoot);
    const orphanRegistry = new SqliteKnowledgeRegistryProjection(":memory:");
    orphanRegistry.projectCurrent((await orphanMarkdown.publish(asset("knowledge.governance.orphan"), { expectedCurrentVersion: 0 })).value);
    const alternate = new KnowledgeGovernanceService(markdown, orphanRegistry, store);
    const invalid = await markdown.readCurrent("knowledge.governance.asset");
    if (!invalid.ok) throw new Error("fixture current missing");
    await writeFile(invalid.value.documentPath, "invalid", "utf8");
    const report = await alternate.doctor();
    expect(report.diagnostics.map((item) => item.code)).toEqual(["INVALID_MARKDOWN_CURRENT", "ORPHAN_PROJECTION"]);
    orphanRegistry.close();
  });

  it("reports every cross-store mismatch class without changing either store", async () => {
    const current = service.show("knowledge.governance.asset");
    const tombstone = await markdown.tombstone(current.asset.id, {
      expectedCurrentVersion: 1, reason: "retired", correlationId: "correlation-tombstone", updatedAt: now2,
    });
    expect(tombstone.value.tombstone).toBe(true);
    await markdown.publish(asset("knowledge.governance.missing", { title: "Missing projection" }), { expectedCurrentVersion: 0 });
    const orphanMarkdown = new MarkdownKnowledgeRepository(path.join(root, "orphan-source"));
    registry.projectCurrent((await orphanMarkdown.publish(asset("knowledge.governance.orphan"), { expectedCurrentVersion: 0 })).value);
    const report = await service.doctor();
    expect(report.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "VERSION_MISMATCH", "HASH_MISMATCH", "TOMBSTONE_MISMATCH", "MISSING_PROJECTION", "ORPHAN_PROJECTION",
    ]));
    expect(service.show(current.asset.id).asset.version).toBe(1);
  });

  it("audits a projection failure after a durable Markdown publish", async () => {
    let fail = false;
    const faultingRegistry = new SqliteKnowledgeRegistryProjection(":memory:", {
      faultInjector: () => { if (fail) throw new Error("injected projection failure"); },
    });
    const current = await markdown.readCurrent("knowledge.governance.asset");
    if (!current.ok) throw new Error("fixture current missing");
    faultingRegistry.projectCurrent(current.value);
    const faulting = new KnowledgeGovernanceService(markdown, faultingRegistry, store);
    fail = true;
    await expect(faulting.markStale({
      assetId: current.value.asset.id, reason: "changed", actor: "tester",
      correlationId: "correlation-projection-failure", now: now2,
    })).rejects.toThrow("injected projection failure");
    expect(store.listAudit().at(-1)).toMatchObject({ operation: "MARK_STALE", status: "FAILED" });
    expect((await markdown.readCurrent(current.value.asset.id))).toMatchObject({ ok: true, value: { asset: { version: 2 } } });
    expect(faultingRegistry.getAsset(current.value.asset.id, true)?.asset.version).toBe(1);
    faultingRegistry.close();
  });

  it("audits a failed rebuild and preserves the active projection", async () => {
    const second = asset("knowledge.governance.broken", { title: "Broken history" });
    await markdown.publish(second, { expectedCurrentVersion: 0 });
    const secondV2 = asset(second.id, { version: 2, title: "Broken v2", correlationId: "broken-v2", updatedAt: now2 });
    await markdown.publish(secondV2, { expectedCurrentVersion: 1 });
    await rm(path.join(root, "markdown", "assets", second.id, "versions", "00000001.md"));
    await expect(service.rebuild({ actor: "tester", correlationId: "correlation-broken", now: now2 })).rejects.toThrow("missing or invalid");
    expect(store.listAudit().at(-1)).toMatchObject({ operation: "REBUILD", status: "FAILED" });
    expect(service.show("knowledge.governance.asset").asset.version).toBe(1);
  });

  it("rejects missing assets and invalid versions", () => {
    expect(() => service.show("knowledge.governance.unknown")).toThrow("was not found");
    expect(() => service.diff("knowledge.governance.asset", 0, 1)).toThrow("positive safe integer");
    expect(() => service.diff("knowledge.governance.asset", 1, 99)).toThrow("@99 was not found");
    expect(() => service.trace("knowledge.governance.asset", 0)).toThrow("positive safe integer");
    expect(() => service.suppress({
      assetId: "knowledge.governance.unknown", reason: "unknown", actor: "tester",
      correlationId: "correlation-unknown", now: now2,
    })).toThrow("was not found");
  });
});
