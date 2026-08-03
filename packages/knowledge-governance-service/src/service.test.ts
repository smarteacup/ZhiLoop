import { mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "@zhiloop/domain";
import type { IncrementalIndexResult } from "@zhiloop/knowledge-indexer";
import type {
  ProjectedKnowledgeAsset,
  ProjectedKnowledgeVersion,
  ProjectionWriteResult,
} from "@zhiloop/knowledge-registry";
import { calculateKnowledgeContentHash } from "@zhiloop/markdown-repository";
import type {
  MarkdownPublishOptions,
  MarkdownPublishResult,
  MarkdownReadResult,
  MarkdownTombstoneOptions,
  StoredKnowledgeVersion,
} from "@zhiloop/markdown-repository";

import { KnowledgeGovernanceMutationService } from "./governance-service.js";
import { GovernanceCursorCodec } from "./cursor.js";
import { KnowledgeGovernanceQueryService } from "./query-service.js";
import { SqliteGovernanceOperationStore } from "./store.js";
import type {
  EligibilityGatePort,
  GovernanceIndexPort,
  GovernanceMarkdownPort,
  GovernanceOperation,
  GovernanceOperationStore,
  KnowledgeEditDraft,
  KnowledgeMetadataPort,
  KnowledgeRegistryPort,
  KnowledgeRevalidationPort,
} from "./types.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  const base: KnowledgeAsset = {
    schemaVersion: 1,
    id,
    subjectKey: `project.runtime.${id}`,
    kind: "FACT",
    scope: { level: "PROJECT", projectId: "project-1" },
    version: 1,
    status: "VERIFIED",
    title: `Knowledge ${id}`,
    summary: "summary",
    body: "body",
    aliases: [],
    keywords: ["runtime"],
    applicability: [],
    nonApplicability: [],
    symbols: ["Runtime"],
    relations: [],
    evidence: [{ evidenceId: `evidence-${id}`, verdict: "SUPPORTS" }],
    confidence: 0.9,
    sourceEpisodes: [`episode-${id}`],
    contentHash: "",
    correlationId: `correlation-${id}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const draft = { ...base, ...overrides, contentHash: "" };
  return { ...draft, contentHash: calculateKnowledgeContentHash(draft) };
}

function stored(value: KnowledgeAsset, tombstone = false, historyState: StoredKnowledgeVersion["historyState"] = "COMMITTED"):
StoredKnowledgeVersion {
  return {
    asset: value,
    tombstone,
    ...(tombstone ? { tombstoneReason: "suppressed" } : {}),
    historyState,
    documentPath: `/knowledge/${value.id}/versions/${value.version}.md`,
  };
}

class MemoryMarkdown implements GovernanceMarkdownPort {
  readonly history = new Map<string, StoredKnowledgeVersion[]>();
  publishCalls = 0;
  tombstoneCalls = 0;
  manual = false;

  seed(value: KnowledgeAsset): void {
    this.history.set(value.id, [stored(value)]);
  }

  readCurrent(assetId: string): MarkdownReadResult {
    const value = this.history.get(assetId)?.at(-1);
    if (value === undefined) return { ok: false, error: { code: "NOT_FOUND", message: "missing", path: assetId, issues: [] } };
    return { ok: true, value: this.manual ? { ...value, historyState: "MANUAL_EDIT" } : value };
  }

  readVersion(assetId: string, version: number): MarkdownReadResult {
    const value = this.history.get(assetId)?.find((item) => item.asset.version === version);
    return value === undefined
      ? { ok: false, error: { code: "NOT_FOUND", message: "missing", path: assetId, issues: [] } }
      : { ok: true, value };
  }

  publish(value: KnowledgeAsset, options: MarkdownPublishOptions = {}): MarkdownPublishResult {
    this.publishCalls += 1;
    const versions = this.history.get(value.id) ?? [];
    const current = versions.at(-1);
    if (current?.asset.version === value.version && current.asset.contentHash === value.contentHash && !current.tombstone) {
      return { status: "IDEMPOTENT", value: current };
    }
    if (current?.asset.version !== options.expectedCurrentVersion || value.version !== (current?.asset.version ?? 0) + 1) {
      throw Object.assign(new Error("version conflict"), { retryable: false });
    }
    const next = stored(value);
    versions.push(next);
    this.history.set(value.id, versions);
    return { status: "PUBLISHED", value: next };
  }

  tombstone(assetId: string, options: MarkdownTombstoneOptions): MarkdownPublishResult {
    this.tombstoneCalls += 1;
    const versions = this.history.get(assetId) ?? [];
    const current = versions.at(-1);
    if (current === undefined || current.asset.version !== options.expectedCurrentVersion) throw new Error("version conflict");
    const draft = {
      ...current.asset,
      version: current.asset.version + 1,
      correlationId: options.correlationId,
      updatedAt: options.updatedAt,
      contentHash: "",
    };
    const target = { ...draft, contentHash: calculateKnowledgeContentHash(draft) };
    const next = { ...stored(target, true), tombstoneReason: options.reason };
    versions.push(next);
    return { status: "PUBLISHED", value: next };
  }
}

class MemoryRegistry implements KnowledgeRegistryPort {
  readonly histories = new Map<string, ProjectedKnowledgeVersion[]>();
  failProjection = false;

  seed(value: KnowledgeAsset): void {
    this.histories.set(value.id, [{ ...stored(value), indexVersion: 1 }]);
  }

  getAsset(assetId: string, includeTombstone = false): ProjectedKnowledgeAsset | undefined {
    const value = this.histories.get(assetId)?.at(-1);
    if (value === undefined || (!includeTombstone && value.tombstone)) return undefined;
    return value;
  }

  listAssets(options: { readonly includeTombstones?: boolean; readonly limit?: number; readonly offset?: number } = {}):
  readonly ProjectedKnowledgeAsset[] {
    return [...this.histories.values()].flatMap((versions) => versions.at(-1) ?? [])
      .filter((value) => options.includeTombstones === true || !value.tombstone)
      .sort((left, right) => left.asset.subjectKey.localeCompare(right.asset.subjectKey) || left.asset.id.localeCompare(right.asset.id))
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  getVersion(assetId: string, version: number): ProjectedKnowledgeVersion | undefined {
    return this.histories.get(assetId)?.find((value) => value.asset.version === version);
  }

  listVersions(assetId: string): readonly ProjectedKnowledgeVersion[] {
    return this.histories.get(assetId) ?? [];
  }

  getEvidence(assetId: string, version: number) {
    return { assetId, assetVersion: version, evidence: this.getVersion(assetId, version)?.asset.evidence ?? [] };
  }

  getRelations(assetId: string, version: number) {
    return { assetId, assetVersion: version, relations: this.getVersion(assetId, version)?.asset.relations ?? [] };
  }

  projectCurrent(record: StoredKnowledgeVersion): ProjectionWriteResult {
    if (this.failProjection) throw new Error("registry offline");
    const versions = this.histories.get(record.asset.id) ?? [];
    const current = versions.at(-1);
    if (current?.asset.version === record.asset.version && current.asset.contentHash === record.asset.contentHash) {
      return { status: "IDEMPOTENT", indexVersion: current.indexVersion, assetId: record.asset.id, assetVersion: record.asset.version };
    }
    if (record.asset.version !== (current?.asset.version ?? 0) + 1) throw new Error("projection gap");
    const indexVersion = (current?.indexVersion ?? 0) + 1;
    versions.push({ ...record, indexVersion });
    this.histories.set(record.asset.id, versions);
    return { status: "PROJECTED", indexVersion, assetId: record.asset.id, assetVersion: record.asset.version };
  }
}

class MemoryEligibility implements EligibilityGatePort {
  readonly excluded = new Set<string>();
  exclude(assetId: string): void { this.excluded.add(assetId); }
  include(assetId: string): void { this.excluded.delete(assetId); }
  isExcluded(assetId: string): boolean { return this.excluded.has(assetId); }
}

class MemoryIndex implements GovernanceIndexPort {
  fail = false;
  calls = 0;
  constructor(private readonly markdown: MemoryMarkdown) {}
  syncAsset(assetId: string): IncrementalIndexResult {
    this.calls += 1;
    if (this.fail) throw new Error("index offline");
    const current = this.markdown.history.get(assetId)?.at(-1);
    return {
      assetId,
      action: "INDEXED",
      ...(current === undefined ? {} : { assetVersion: current.asset.version, contentHash: current.asset.contentHash }),
      indexVersion: this.calls,
      chunks: [],
      diagnostics: [],
    };
  }
}

class MemoryStore implements GovernanceOperationStore {
  readonly drafts = new Map<string, KnowledgeEditDraft>();
  readonly operations = new Map<string, GovernanceOperation>();
  getDraft(id: string) { return this.drafts.get(id); }
  getDraftByIdempotencyKey(key: string) { return [...this.drafts.values()].find((draft) => draft.idempotencyKey === key); }
  createDraft(draft: KnowledgeEditDraft) { this.drafts.set(draft.draftId, structuredClone(draft)); }
  markDraftCommitted(id: string, operationId: string) {
    const draft = this.drafts.get(id);
    if (draft === undefined) throw new Error("missing draft");
    this.drafts.set(id, { ...draft, status: "COMMITTED", committedOperationId: operationId });
  }
  getOperation(id: string) { return this.operations.get(id); }
  getOperationByIdempotencyKey(key: string) {
    return [...this.operations.values()].find((operation) => operation.idempotencyKey === key);
  }
  createOperation(operation: GovernanceOperation) { this.operations.set(operation.operationId, structuredClone(operation)); }
  saveOperation(operation: GovernanceOperation, expectedRevision: number) {
    if (this.operations.get(operation.operationId)?.revision !== expectedRevision) throw new Error("CAS conflict");
    this.operations.set(operation.operationId, structuredClone(operation));
  }
}

const metadata: KnowledgeMetadataPort = {
  getProvenance: async (assetId, version) => ({
    snapshotIds: [`snapshot-${assetId}`],
    episodeIds: [`episode-${assetId}`],
    sessionIds: ["session-1"],
    turnIds: ["turn-1"],
    eventIds: [`event-${version}`],
  }),
  getUsage: async (assetId, version) => [{
    usageId: `usage-${assetId}-${version}`,
    kind: "RETRIEVED",
    occurredAt: "2026-08-02T00:00:00.000Z",
    detail: "exact subject match",
  }],
  getAssertions: async () => ["assertion-1"],
  getScopeReasonCodes: async () => ["PROJECT_BOUND"],
  getLifecycle: async () => [{
    version: 1,
    status: "VERIFIED",
    occurredAt: "2026-08-01T00:00:00.000Z",
    reasonCodes: ["TEST_PASSED"],
  }],
  getLastVerifiedAt: async () => "2026-08-01T00:00:00.000Z",
};

function setup(initialAssets: readonly KnowledgeAsset[] = [asset("asset-a")]) {
  const markdown = new MemoryMarkdown();
  const registry = new MemoryRegistry();
  for (const value of initialAssets) {
    markdown.seed(value);
    registry.seed(value);
  }
  const eligibility = new MemoryEligibility();
  const index = new MemoryIndex(markdown);
  let evidenceSupported = true;
  const revalidation: KnowledgeRevalidationPort = {
    revalidate: async (_current, draft) => ({
      scopeValid: true,
      evidenceSupported,
      evidence: evidenceSupported ? draft.evidence : [],
      reasonCodes: evidenceSupported ? ["EVIDENCE_REVALIDATED"] : ["EVIDENCE_NO_LONGER_SUPPORTS_EDIT"],
    }),
  };
  const store = new MemoryStore();
  const mutations = new KnowledgeGovernanceMutationService({ registry, markdown, index, eligibility, revalidation }, store);
  const query = new KnowledgeGovernanceQueryService(registry, metadata, eligibility, Buffer.alloc(32, 7));
  return {
    markdown, registry, eligibility, index, store, mutations, query,
    setEvidenceSupported(value: boolean) { evidenceSupported = value; },
  };
}

const now = "2026-08-03T00:00:00.000Z";
const actor = "operator-1";

describe("KnowledgeGovernanceQueryService", () => {
  it("rejects weak secrets and structurally malformed cursor payloads", () => {
    expect(() => new GovernanceCursorCodec(Buffer.alloc(31))).toThrow("at least 32 bytes");
    const secret = Buffer.alloc(32, 7);
    const codec = new GovernanceCursorCodec(secret);
    expect(() => codec.decode("missing-signature", "hash")).toThrow("cursor is invalid");
    const body = Buffer.from("{", "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(body).digest("base64url");
    expect(() => codec.decode(`${body}.${signature}`, "hash")).toThrow("payload is invalid");
  });

  it("provides bounded filtered current views, immutable versions, provenance and usage", async () => {
    const a = asset("asset-a");
    const b = asset("asset-b", { status: "STALE", symbols: ["Other"], keywords: ["other"] });
    const value = setup([a, b]);

    const page = await value.query.list({ filter: { projectId: "project-1", eligibleOnly: true, symbol: "Runtime" }, limit: 1 });
    const detail = await value.query.detail("asset-a");

    expect(page.items.map((item) => item.current.asset.id)).toEqual(["asset-a"]);
    expect(page.items[0]).toMatchObject({ eligible: true, evidenceCount: 1 });
    expect(detail).toMatchObject({
      current: { asset: { id: "asset-a", version: 1 } },
      provenance: { sessionIds: ["session-1"] },
      assertions: ["assertion-1"],
      scopeReasonCodes: ["PROJECT_BOUND"],
    });
    expect(detail.usage).toHaveLength(1);
    await expect(value.query.version("asset-a", 0)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(() => value.query.diff("asset-a", 1, 1)).toThrow("must differ");
  });

  it("uses query-bound tamper-resistant pagination cursors", async () => {
    const value = setup([asset("asset-a"), asset("asset-b")]);
    const first = await value.query.list({ limit: 1, filter: { projectId: "project-1" } });
    expect(first.nextCursor).toBeDefined();
    const cursor = first.nextCursor as string;
    const second = await value.query.list({ limit: 1, cursor, filter: { projectId: "project-1" } });
    expect(second.items[0]?.current.asset.id).not.toBe(first.items[0]?.current.asset.id);
    await expect(value.query.list({ limit: 1, cursor: `${cursor}x`, filter: { projectId: "project-1" } }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.query.list({ limit: 1, cursor, filter: { projectId: "other" } }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("accounts for every bounded filter and reports suppressed or ineligible records", async () => {
    const active = asset("asset-active", { kind: "DESIGN", symbols: ["Active"], keywords: ["active"] });
    const stale = asset("asset-stale", { status: "STALE", symbols: ["Stale"], keywords: ["stale"] });
    const value = setup([active, stale]);
    value.eligibility.exclude("asset-active");

    expect((await value.query.list({ filter: { includeSuppressed: true } })).items).toMatchObject([
      { current: { asset: { id: "asset-active" } }, eligible: false, eligibilityReasonCodes: ["GOVERNANCE_SUPPRESSED"] },
      { current: { asset: { id: "asset-stale" } }, eligible: false, eligibilityReasonCodes: ["STATUS_NOT_ELIGIBLE"] },
    ]);
    expect((await value.query.list({ filter: { scopeLevels: ["GLOBAL"] } })).excludedByReason).toMatchObject({ FILTER_SCOPE: 2 });
    expect((await value.query.list({ filter: { projectId: "other" } })).excludedByReason).toMatchObject({ FILTER_PROJECT: 2 });
    expect((await value.query.list({ filter: { kinds: ["RULE"] } })).excludedByReason).toMatchObject({ FILTER_KIND: 2 });
    expect((await value.query.list({ filter: { statuses: ["ACCEPTED"] } })).excludedByReason).toMatchObject({ FILTER_STATUS: 2 });
    expect((await value.query.list({ filter: { subject: "missing" } })).excludedByReason).toMatchObject({ FILTER_SUBJECT: 2 });
    expect((await value.query.list({ filter: { symbol: "Missing" } })).excludedByReason).toMatchObject({ FILTER_SYMBOL: 2 });
    expect((await value.query.list({ filter: { keyword: "missing" } })).excludedByReason).toMatchObject({ FILTER_KEYWORD: 2 });
    expect((await value.query.list({ filter: { version: 2 } })).excludedByReason).toMatchObject({ FILTER_VERSION: 2 });
    expect((await value.query.list({ filter: { evidenceVerdict: "CONTRADICTS" } })).excludedByReason)
      .toMatchObject({ FILTER_EVIDENCE: 2 });
    expect((await value.query.list({ filter: { eligibleOnly: true } })).excludedByReason)
      .toMatchObject({ GOVERNANCE_SUPPRESSED: 1, STATUS_NOT_ELIGIBLE: 1 });
    await expect(value.query.list({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.query.list({ limit: 101 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("returns deterministic detail errors and diffs immutable versions", async () => {
    const value = setup();
    const current = value.registry.getAsset("asset-a")?.asset as KnowledgeAsset;
    const next = asset("asset-a", {
      ...current,
      version: 2,
      title: "Changed title",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    const published = value.markdown.publish(next, { expectedCurrentVersion: 1 });
    value.registry.projectCurrent(published.value);
    expect(value.query.diff("asset-a", 1, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "title", before: `Knowledge asset-a`, after: "Changed title" }),
      expect.objectContaining({ field: "version", before: 1, after: 2 }),
    ]));
    await expect(value.query.detail("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(value.query.version("asset-a", 99)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(() => value.query.diff("asset-a", 1, 99)).toThrow("not found");
  });
});

describe("KnowledgeGovernanceMutationService", () => {
  it("downgrades unsupported edited Evidence and preserves immutable history", async () => {
    const value = setup();
    value.setEvidenceSupported(false);
    const draft = await value.mutations.createEditDraft({
      assetId: "asset-a",
      expectedVersion: 1,
      idempotencyKey: "draft-1",
      patch: { body: "claim changed beyond its evidence" },
      correlationId: "correlation-edit",
      actor,
      now,
    });
    const committed = await value.mutations.commitEditDraft({
      draftId: draft.draftId,
      expectedVersion: 1,
      idempotencyKey: "commit-1",
      actor,
      now,
    });

    expect(draft.proposed.status).toBe("STALE");
    expect(draft.impact).toMatchObject({ evidenceDowngraded: true, nextEligible: false });
    expect(committed.status).toBe("COMPLETED");
    expect(value.markdown.history.get("asset-a")?.map((item) => [item.asset.version, item.asset.status]))
      .toEqual([[1, "VERIFIED"], [2, "STALE"]]);
    expect(value.eligibility.excluded.has("asset-a")).toBe(true);
  });

  it("rejects stale versions, manual Markdown conflicts and high-risk governance", async () => {
    const value = setup();
    await expect(value.mutations.suppress({
      assetId: "asset-a", expectedVersion: 2, idempotencyKey: "s-1", correlationId: "c-1", actor, now, reason: "bad",
    })).rejects.toMatchObject({ code: "STALE_EXPECTED_VERSION" });
    value.markdown.manual = true;
    await expect(value.mutations.createEditDraft({
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "d-1", correlationId: "c-1", actor, now,
      patch: { title: "external overwrite" },
    })).rejects.toMatchObject({ code: "MANUAL_MARKDOWN_CONFLICT" });
    value.markdown.manual = false;
    const globalValue = setup([asset("asset-global", { scope: { level: "GLOBAL" } })]);
    await expect(globalValue.mutations.suppress({
      assetId: "asset-global", expectedVersion: 1, idempotencyKey: "s-global", correlationId: "c-1", actor, now, reason: "bad",
    })).rejects.toMatchObject({ code: "HIGH_RISK_GOVERNANCE_DISABLED" });
  });

  it("refuses a draft commit when current changes after preview", async () => {
    const value = setup();
    const draft = await value.mutations.createEditDraft({
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "stale-draft", correlationId: "c-1", actor, now,
      patch: { title: "preview title" },
    });
    const current = value.markdown.history.get("asset-a")?.at(-1)?.asset as KnowledgeAsset;
    const changed = asset("asset-a", {
      ...current,
      version: 2,
      title: "external accepted revision",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    const published = value.markdown.publish(changed, { expectedCurrentVersion: 1 });
    value.registry.projectCurrent(published.value);

    await expect(value.mutations.commitEditDraft({
      draftId: draft.draftId, expectedVersion: 1, idempotencyKey: "stale-commit", actor, now,
    })).rejects.toMatchObject({ code: "STALE_EXPECTED_VERSION" });
    expect(value.markdown.history.get("asset-a")?.at(-1)?.asset.title).toBe("external accepted revision");
  });

  it("suppresses immediately, restores only after revalidation, and retains every revision", async () => {
    const value = setup();
    const started = performance.now();
    const suppressed = await value.mutations.suppress({
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "suppress-1", correlationId: "c-s", actor, now, reason: "obsolete",
    });
    const elapsed = performance.now() - started;

    expect(suppressed.status).toBe("COMPLETED");
    expect(elapsed).toBeLessThan(1_000);
    expect(value.eligibility.excluded.has("asset-a")).toBe(true);
    expect((await value.query.list({ filter: { eligibleOnly: true } })).items).toEqual([]);

    value.setEvidenceSupported(false);
    await expect(value.mutations.restore({
      assetId: "asset-a", expectedVersion: 2, sourceVersion: 1, idempotencyKey: "restore-bad",
      correlationId: "c-r", now,
      actor,
    })).rejects.toMatchObject({ code: "RESTORE_REVALIDATION_FAILED" });
    expect(value.markdown.history.get("asset-a")).toHaveLength(2);

    value.setEvidenceSupported(true);
    const restored = await value.mutations.restore({
      assetId: "asset-a", expectedVersion: 2, sourceVersion: 1, idempotencyKey: "restore-good",
      correlationId: "c-r", now,
      actor,
    });
    expect(restored.status).toBe("COMPLETED");
    expect(value.eligibility.excluded.has("asset-a")).toBe(false);
    expect(value.markdown.history.get("asset-a")?.map((item) => [item.asset.version, item.tombstone]))
      .toEqual([[1, false], [2, true], [3, false]]);
  });

  it("binds an idempotency key to the complete semantic mutation request", async () => {
    const value = setup();
    const request = {
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "semantic-suppress", correlationId: "c-s",
      actor, now, reason: "obsolete",
    } as const;
    const first = await value.mutations.suppress(request);
    await expect(value.mutations.suppress({ ...request, reason: "different reason" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.suppress({ ...request, correlationId: "different-correlation" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.suppress({ ...request, now: "2026-08-02T00:00:00.000Z" }))
      .resolves.toEqual(first);
  });

  it("reports index partial failure as DEGRADED and replays without another Markdown version", async () => {
    const value = setup();
    value.index.fail = true;
    const degraded = await value.mutations.suppress({
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "suppress-degraded", correlationId: "c-s", actor, now,
      reason: "obsolete",
    });
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.stages.INDEX.status).toBe("RETRYABLE");
    expect(value.markdown.history.get("asset-a")).toHaveLength(2);
    expect(value.registry.getAsset("asset-a", true)?.tombstone).toBe(true);

    value.index.fail = false;
    const recovered = await value.mutations.retry(degraded.operationId);
    expect(recovered.status).toBe("COMPLETED");
    expect(value.markdown.history.get("asset-a")).toHaveLength(2);
    expect(value.markdown.tombstoneCalls).toBe(1);
  });

  it("recovers when Registry projection fails after durable Markdown publication", async () => {
    const value = setup();
    value.registry.failProjection = true;
    const degraded = await value.mutations.suppress({
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "registry-degraded", correlationId: "c-r", actor, now,
      reason: "obsolete",
    });
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.stages.MARKDOWN.status).toBe("SUCCEEDED");
    expect(degraded.stages.REGISTRY.status).toBe("RETRYABLE");
    expect(value.registry.getAsset("asset-a", true)?.asset.version).toBe(1);
    expect(value.eligibility.excluded.has("asset-a")).toBe(true);

    value.registry.failProjection = false;
    const recovered = await value.mutations.retry(degraded.operationId);
    expect(recovered.status).toBe("COMPLETED");
    expect(value.registry.getAsset("asset-a", true)?.asset.version).toBe(2);
    expect(value.markdown.history.get("asset-a")).toHaveLength(2);
  });

  it("creates an ordinary supersede revision linked to an eligible replacement", async () => {
    const value = setup([asset("asset-a"), asset("asset-b")]);
    const result = await value.mutations.supersede({
      assetId: "asset-a",
      replacementAssetId: "asset-b",
      expectedVersion: 1,
      idempotencyKey: "supersede-1",
      correlationId: "c-supersede",
      actor,
      now,
      reason: "replaced by corrected guidance",
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.target.status).toBe("SUPERSEDED");
    expect(result.target.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RELATED_TO", targetId: "asset-b" }),
    ]));
    expect(value.eligibility.excluded.has("asset-a")).toBe(true);
  });

  it("fails closed for invalid governance identities, timestamps and semantic requests", async () => {
    const value = setup([asset("asset-a"), asset("asset-b", { status: "STALE" })]);
    const suppress = {
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "valid-key", correlationId: "valid-correlation",
      actor, now, reason: "obsolete",
    } as const;
    await expect(value.mutations.suppress({ ...suppress, actor: "" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.suppress({ ...suppress, now: "2026-08-03 00:00:00" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.suppress({ ...suppress, expectedVersion: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.suppress({ ...suppress, reason: " " })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.restore({ ...suppress, sourceVersion: 0 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.restore({ ...suppress, sourceVersion: 99 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.supersede({ ...suppress, replacementAssetId: "asset-a" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.supersede({ ...suppress, replacementAssetId: "asset-b" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.retry("missing-operation")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(value.mutations.createEditDraft({
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "no-change", correlationId: "c-edit", actor, now,
      patch: {},
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(value.mutations.commitEditDraft({
      draftId: "missing-draft", expectedVersion: 1, idempotencyKey: "missing-commit", actor, now,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reuses identical edit drafts and completed commits but rejects a changed idempotent draft", async () => {
    const value = setup();
    const request = {
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "reused-draft", correlationId: "c-edit", actor, now,
      patch: { summary: "updated summary" },
    } as const;
    const draft = await value.mutations.createEditDraft(request);
    await expect(value.mutations.createEditDraft(request)).resolves.toEqual(draft);
    await expect(value.mutations.createEditDraft({ ...request, patch: { summary: "different" } }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const commitRequest = { draftId: draft.draftId, expectedVersion: 1, idempotencyKey: "reused-commit", actor, now } as const;
    const committed = await value.mutations.commitEditDraft(commitRequest);
    await expect(value.mutations.commitEditDraft(commitRequest)).resolves.toEqual(committed);
    await expect(value.mutations.commitEditDraft({ ...commitRequest, expectedVersion: 2 }))
      .rejects.toMatchObject({ code: "STALE_EXPECTED_VERSION" });
  });
});

describe("SqliteGovernanceOperationStore", () => {
  it("persists immutable drafts and CAS-protected outbox records across restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-governance-"));
    directories.push(directory);
    const databasePath = path.join(directory, "governance.sqlite");
    const value = setup();
    const first = new SqliteGovernanceOperationStore(databasePath);
    const revalidation: KnowledgeRevalidationPort = { revalidate: async (_current, draft) => ({
      scopeValid: true, evidenceSupported: true, evidence: draft.evidence, reasonCodes: ["OK"],
    }) };
    const service = new KnowledgeGovernanceMutationService({
      registry: value.registry,
      markdown: value.markdown,
      index: value.index,
      eligibility: first,
      revalidation,
    }, first);
    const draft = await service.createEditDraft({
      assetId: "asset-a", expectedVersion: 1, idempotencyKey: "sqlite-draft", correlationId: "c-1", actor, now,
      patch: { summary: "updated" },
    });
    value.index.fail = true;
    const operation = await service.commitEditDraft({
      draftId: draft.draftId,
      expectedVersion: 1,
      idempotencyKey: "sqlite-commit",
      actor,
      now,
    });
    expect(operation.status).toBe("DEGRADED");
    first.close();

    using reopened = new SqliteGovernanceOperationStore(databasePath);
    expect(reopened.getDraft(draft.draftId)).toMatchObject({ status: "COMMITTED", committedOperationId: operation.operationId });
    expect(reopened.getOperation(operation.operationId)).toEqual(operation);
    expect(reopened.getOperationByIdempotencyKey("sqlite-commit")).toEqual(operation);
    expect(reopened.isExcluded("asset-a")).toBe(true);
    value.index.fail = false;
    const resumed = await new KnowledgeGovernanceMutationService({
      registry: value.registry,
      markdown: value.markdown,
      index: value.index,
      eligibility: reopened,
      revalidation,
    }, reopened).retry(operation.operationId);
    expect(resumed.status).toBe("COMPLETED");
    expect(reopened.isExcluded("asset-a")).toBe(false);
    reopened.exclude("asset-a", "operation-a");
    reopened.exclude("asset-a", "operation-b");
    reopened.include("asset-a", "operation-a");
    expect(reopened.isExcluded("asset-a")).toBe(true);
    reopened.include("asset-a", "operation-b");
    expect(reopened.isExcluded("asset-a")).toBe(false);
    expect(() => reopened.createDraft(draft)).toThrow();
    expect(() => reopened.createOperation(resumed)).toThrow();
    expect(() => reopened.saveOperation(
      { ...resumed, revision: resumed.revision },
      resumed.revision - 1,
    )).toThrow("concurrently");
    expect(() => reopened.exclude("", "operation-a")).toThrow("invalid");
    expect(() => reopened.markDraftCommitted("missing", "operation-a")).toThrow("not found");
    expect(() => reopened.markDraftCommitted(draft.draftId, operation.operationId)).not.toThrow();
    reopened.close();
    reopened.close();
  });
});
