import { mkdir, readFile, writeFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { KnowledgeAsset } from "@zhiloop/domain";
import { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import { calculateKnowledgeContentHash, MarkdownKnowledgeRepository } from "@zhiloop/markdown-repository";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assetIdFromKnowledgePath,
  chunkKnowledgeAsset,
  DebouncedKnowledgeIndexer,
  IncrementalKnowledgeIndexer,
  NodeMarkdownKnowledgeWatcher,
  type KnowledgeChunkSink,
} from "./index.js";

const at1 = "2026-08-02T01:00:00.000Z";
const at2 = "2026-08-02T02:00:00.000Z";
const at3 = "2026-08-02T03:00:00.000Z";

function asset(id: string, overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  const draft: KnowledgeAsset = {
    schemaVersion: 1,
    id,
    subjectKey: id,
    kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-a" },
    version: 1,
    status: "IMPLEMENTED",
    title: "Incremental Indexer",
    summary: "Indexes changed Markdown only.",
    body: "# Stable\n\nThis section stays stable.\n\n# Changed\n\nOriginal content.",
    aliases: ["Indexer"],
    keywords: ["contentHash"],
    applicability: [],
    nonApplicability: [],
    symbols: ["IncrementalKnowledgeIndexer"],
    relations: [],
    evidence: [{ evidenceId: "evidence-indexer", verdict: "SUPPORTS" }],
    confidence: 0.9,
    sourceEpisodes: ["episode-indexer"],
    contentHash: "",
    correlationId: "correlation-indexer",
    createdAt: at1,
    updatedAt: at1,
    ...overrides,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

describe("IncrementalKnowledgeIndexer", () => {
  let temporaryRoot: string;
  let markdown: MarkdownKnowledgeRepository;
  let projection: SqliteKnowledgeRegistryProjection;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-incremental-indexer-"));
    markdown = new MarkdownKnowledgeRepository(path.join(temporaryRoot, "markdown"));
    projection = new SqliteKnowledgeRegistryProjection(":memory:");
  });

  afterEach(async () => {
    projection.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("keeps chunk IDs stable for unchanged sections across asset versions", () => {
    const first = asset("knowledge.indexer.chunks");
    const second = asset(first.id, {
      version: 2,
      body: "# Stable\n\nThis section stays stable.\n\n# Changed\n\nUpdated content.",
      updatedAt: at2,
      correlationId: "correlation-v2",
    });
    const firstChunks = chunkKnowledgeAsset(first, 300);
    const secondChunks = chunkKnowledgeAsset(second, 300);
    expect(firstChunks.find((chunk) => chunk.heading === "Stable")?.chunkId)
      .toBe(secondChunks.find((chunk) => chunk.heading === "Stable")?.chunkId);
    expect(firstChunks.find((chunk) => chunk.heading === "Changed")?.chunkId)
      .not.toBe(secondChunks.find((chunk) => chunk.heading === "Changed")?.chunkId);
    expect(() => chunkKnowledgeAsset(first, 10)).toThrow("maxChars");
    const long = chunkKnowledgeAsset(asset(first.id, { body: "x".repeat(450) }), 200);
    expect(long).toHaveLength(3);
    expect(chunkKnowledgeAsset(asset(first.id, { body: "", summary: "summary fallback" }), 200)[0]?.content)
      .toBe("summary fallback");
    expect(() => new IncrementalKnowledgeIndexer(markdown, projection, { chunkMaxChars: 20 })).toThrow("chunkMaxChars");
  });

  it("indexes once per contentHash and does not increase indexVersion for repeats", async () => {
    const original = asset("knowledge.indexer.unchanged");
    await markdown.publish(original, { expectedCurrentVersion: 0 });
    const replaceAssetChunks = vi.fn();
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection, {
      chunkSink: { replaceAssetChunks, removeAsset: vi.fn() },
    });
    const first = await indexer.syncAsset(original.id);
    const second = await indexer.syncAsset(original.id);
    expect(first).toMatchObject({ action: "INDEXED", indexVersion: 1, assetVersion: 1 });
    expect(second).toMatchObject({ action: "UNCHANGED", indexVersion: 1, chunks: [] });
    expect(replaceAssetChunks).toHaveBeenCalledTimes(1);
    expect(projection.search("Original")[0]?.asset.id).toBe(original.id);
  });

  it("coalesces skipped versions into one single-asset history transaction", async () => {
    const first = asset("knowledge.indexer.coalesced");
    await markdown.publish(first, { expectedCurrentVersion: 0 });
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection);
    await indexer.syncAsset(first.id);
    const second = asset(first.id, { version: 2, body: "# V2\n\nsecond", updatedAt: at2, correlationId: "v2" });
    const third = asset(first.id, { version: 3, body: "# V3\n\nthird", updatedAt: at3, correlationId: "v3" });
    await markdown.publish(second, { expectedCurrentVersion: 1 });
    await markdown.publish(third, { expectedCurrentVersion: 2 });
    const result = await indexer.syncAsset(first.id);

    expect(result).toMatchObject({ action: "INDEXED", assetVersion: 3, indexVersion: 2 });
    expect(projection.listVersions(first.id).map((item) => item.asset.version)).toEqual([1, 2, 3]);
    expect(projection.search("third")[0]?.asset.version).toBe(3);
  });

  it("adopts safe manual content but rejects manual trust elevation", async () => {
    const safe = asset("knowledge.indexer.manual-safe");
    const unsafe = asset("knowledge.indexer.manual-unsafe");
    await markdown.publish(safe, { expectedCurrentVersion: 0 });
    await markdown.publish(unsafe, { expectedCurrentVersion: 0 });
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection);
    await indexer.syncMany([safe.id, unsafe.id]);
    const safePath = (await markdown.readCurrent(safe.id));
    const unsafePath = (await markdown.readCurrent(unsafe.id));
    if (!safePath.ok || !unsafePath.ok) throw new Error("fixture current missing");
    await writeFile(safePath.value.documentPath, (await readFile(safePath.value.documentPath, "utf8")).replace("Original content.", "Safely edited content."), "utf8");
    await writeFile(unsafePath.value.documentPath, (await readFile(unsafePath.value.documentPath, "utf8")).replace("status: IMPLEMENTED", "status: VERIFIED"), "utf8");

    expect(await indexer.syncAsset(safe.id)).toMatchObject({ action: "INDEXED", assetVersion: 2, indexVersion: 3 });
    expect(projection.search("Safely")[0]?.asset.version).toBe(2);
    expect(await indexer.syncAsset(unsafe.id)).toMatchObject({ action: "SKIPPED_UNSAFE", indexVersion: 3 });
    expect(projection.getAsset(unsafe.id)?.asset.status).toBe("IMPLEMENTED");
  });

  it("preserves the prior projection for invalid current and broken history", async () => {
    const original = asset("knowledge.indexer.invalid");
    const published = await markdown.publish(original, { expectedCurrentVersion: 0 });
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection);
    await indexer.syncAsset(original.id);
    await writeFile(published.value.documentPath, "---\nschema_version: 99\n---\ninvalid", "utf8");
    expect(await indexer.syncAsset(original.id)).toMatchObject({ action: "SKIPPED_INVALID", indexVersion: 1 });
    expect(projection.getAsset(original.id)?.asset.version).toBe(1);

    await writeFile(published.value.documentPath, await readFile(path.join(temporaryRoot, "markdown", "assets", original.id, "versions", "00000001.md"), "utf8"), "utf8");
    const second = asset(original.id, { version: 2, updatedAt: at2, correlationId: "v2" });
    const third = asset(original.id, { version: 3, updatedAt: at3, correlationId: "v3" });
    await markdown.publish(second, { expectedCurrentVersion: 1 });
    await markdown.publish(third, { expectedCurrentVersion: 2 });
    await rm(path.join(temporaryRoot, "markdown", "assets", original.id, "versions", "00000002.md"));
    expect(await indexer.syncAsset(original.id)).toMatchObject({
      action: "SKIPPED_INVALID",
      diagnostics: [{ code: "PROJECTION_FAILED" }],
      indexVersion: 1,
    });
    expect(projection.getAsset(original.id)?.asset.version).toBe(1);
  });

  it("retries a failed chunk sink without reindexing SQLite", async () => {
    const original = asset("knowledge.indexer.chunk-retry");
    await markdown.publish(original, { expectedCurrentVersion: 0 });
    let attempts = 0;
    const sink: KnowledgeChunkSink = {
      replaceAssetChunks: () => { attempts += 1; if (attempts === 1) throw new Error("vector offline"); },
      removeAsset: () => undefined,
    };
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection, { chunkSink: sink });
    expect(await indexer.syncAsset(original.id)).toMatchObject({ action: "INDEXED_WITH_CHUNK_ERROR", indexVersion: 1 });
    expect(await indexer.syncAsset(original.id)).toMatchObject({ action: "CHUNKS_REFRESHED", indexVersion: 1 });
    expect(attempts).toBe(2);
  });

  it("removes tombstone chunks and FTS", async () => {
    const original = asset("knowledge.indexer.tombstone");
    await markdown.publish(original, { expectedCurrentVersion: 0 });
    const removeAsset = vi.fn();
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection, {
      chunkSink: { replaceAssetChunks: vi.fn(), removeAsset },
    });
    await indexer.syncAsset(original.id);
    await markdown.tombstone(original.id, {
      expectedCurrentVersion: 1, reason: "retired", updatedAt: at2, correlationId: "deleted",
    });
    expect(await indexer.syncAsset(original.id)).toMatchObject({ action: "INDEXED", assetVersion: 2, chunks: [] });
    expect(removeAsset).toHaveBeenCalledWith(original.id, 2);
    expect(projection.search("Original")).toEqual([]);
  });

  it("deduplicates a batch and flushes well inside the five-second SLA", async () => {
    const original = asset("knowledge.indexer.debounce");
    await markdown.publish(original, { expectedCurrentVersion: 0 });
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection);
    let resolveBatch: ((value: readonly unknown[]) => void) | undefined;
    const batch = new Promise<readonly unknown[]>((resolve) => { resolveBatch = resolve; });
    const scheduler = new DebouncedKnowledgeIndexer(indexer, {
      debounceMs: 20,
      maxWaitMs: 50,
      onBatch: (results) => { resolveBatch?.(results); },
    });
    const started = performance.now();
    scheduler.notifyAsset(original.id);
    scheduler.notifyAsset(original.id);
    scheduler.notifyAsset(original.id);
    const results = await Promise.race([
      batch,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("batch timeout")), 1_000)),
    ]);
    expect(results).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(5_000);
    await scheduler.close();
    await scheduler.close();
    expect(() => scheduler.notifyAsset(original.id)).toThrow("closed");
  });

  it("validates scheduler inputs and isolates one bad asset from its batch", async () => {
    const valid = asset("knowledge.indexer.batch-valid");
    await markdown.publish(valid, { expectedCurrentVersion: 0 });
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection);
    expect(() => new DebouncedKnowledgeIndexer(indexer, { debounceMs: 0 })).toThrow("debounceMs");
    expect(() => new DebouncedKnowledgeIndexer(indexer, { debounceMs: 20, maxWaitMs: 10 })).toThrow("less than");
    const scheduler = new DebouncedKnowledgeIndexer(indexer, { debounceMs: 20, maxWaitMs: 30 });
    expect(() => scheduler.notifyAsset(" ")).toThrow("assetId");
    expect(await scheduler.flush()).toEqual([]);
    const results = await indexer.syncMany(["../unsafe", valid.id, valid.id]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ action: "SKIPPED_INVALID" });
    expect(results[1]).toMatchObject({ action: "INDEXED" });
    scheduler.notifyAsset(valid.id);
    await scheduler.close(false);
  });

  it("flushes at max wait, reports timer errors, and serializes in-flight batches", async () => {
    const maxWaitSync = vi.fn().mockResolvedValue([]);
    let resolveMaxWait: (() => void) | undefined;
    const maxWaitDone = new Promise<void>((resolve) => { resolveMaxWait = resolve; });
    const maxWaitScheduler = new DebouncedKnowledgeIndexer(
      { syncMany: maxWaitSync } as unknown as IncrementalKnowledgeIndexer,
      { debounceMs: 50, maxWaitMs: 60, onBatch: () => { resolveMaxWait?.(); } },
    );
    maxWaitScheduler.notifyAsset("asset-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    maxWaitScheduler.notifyAsset("asset-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    maxWaitScheduler.notifyAsset("asset-a");
    await Promise.race([maxWaitDone, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("max wait timeout")), 500))]);
    expect(maxWaitSync).toHaveBeenCalledTimes(1);
    await maxWaitScheduler.close();

    let resolveError: (() => void) | undefined;
    const errorSeen = new Promise<void>((resolve) => { resolveError = resolve; });
    const errorScheduler = new DebouncedKnowledgeIndexer(
      { syncMany: vi.fn().mockRejectedValue(new Error("batch failed")) } as unknown as IncrementalKnowledgeIndexer,
      { debounceMs: 10, maxWaitMs: 20, onError: () => { resolveError?.(); } },
    );
    errorScheduler.notifyAsset("asset-error");
    await Promise.race([errorSeen, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("error timeout")), 500))]);
    await errorScheduler.close(false);

    let release: (() => void) | undefined;
    const firstRun = new Promise<readonly never[]>((resolve) => { release = () => resolve([]); });
    const serialSync = vi.fn().mockReturnValueOnce(firstRun).mockResolvedValue([]);
    const serialScheduler = new DebouncedKnowledgeIndexer(
      { syncMany: serialSync } as unknown as IncrementalKnowledgeIndexer,
      { debounceMs: 100, maxWaitMs: 200 },
    );
    serialScheduler.notifyAsset("first");
    const flushing = serialScheduler.flush();
    serialScheduler.notifyAsset("second");
    release?.();
    await flushing;
    await serialScheduler.flush();
    expect(serialSync).toHaveBeenCalledTimes(2);
    await serialScheduler.close();
  });

  it("maps only canonical knowledge paths and observes a real current.md change", async () => {
    const original = asset("knowledge.indexer.watcher");
    const published = await markdown.publish(original, { expectedCurrentVersion: 0 });
    const root = path.join(temporaryRoot, "markdown");
    expect(assetIdFromKnowledgePath(root, published.value.documentPath)).toBe(original.id);
    expect(assetIdFromKnowledgePath(root, path.join(root, "assets", original.id, "versions", "00000001.md"))).toBe(original.id);
    expect(assetIdFromKnowledgePath(root, path.join(root, "wrong", original.id, "current.md"))).toBeUndefined();
    expect(assetIdFromKnowledgePath(root, path.join(root, "assets", original.id, "other.md"))).toBeUndefined();
    expect(assetIdFromKnowledgePath(root, path.join(temporaryRoot, "outside.md"))).toBeUndefined();

    const indexer = new IncrementalKnowledgeIndexer(markdown, projection, {
      clock: () => new Date(at2), correlationIdFactory: () => "watcher-edit",
    });
    let resolveBatch: (() => void) | undefined;
    const batch = new Promise<void>((resolve) => { resolveBatch = resolve; });
    const scheduler = new DebouncedKnowledgeIndexer(indexer, {
      debounceMs: 20, maxWaitMs: 100, onBatch: () => { resolveBatch?.(); },
    });
    const watcher = new NodeMarkdownKnowledgeWatcher(root, scheduler);
    expect(watcher.lastError).toBeUndefined();
    watcher.start();
    watcher.start();
    await writeFile(published.value.documentPath, (await readFile(published.value.documentPath, "utf8")).replace("Original content.", "Watcher content."), "utf8");
    await Promise.race([batch, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("watch timeout")), 2_000))]);
    expect(projection.search("Watcher")[0]?.asset.version).toBe(2);
    watcher.close();
    await scheduler.close();
  });

  it("rejects empty and symbolic-link watcher roots", async () => {
    const indexer = new IncrementalKnowledgeIndexer(markdown, projection);
    const scheduler = new DebouncedKnowledgeIndexer(indexer);
    expect(() => new NodeMarkdownKnowledgeWatcher(" ", scheduler)).toThrow("must not be empty");
    const target = path.join(temporaryRoot, "watch-target");
    const linked = path.join(temporaryRoot, "watch-link");
    await mkdir(target);
    await symlink(target, linked);
    const watcher = new NodeMarkdownKnowledgeWatcher(linked, scheduler);
    expect(() => watcher.start()).toThrow("real directory");
    watcher.close();
    await scheduler.close(false);
  });
});
