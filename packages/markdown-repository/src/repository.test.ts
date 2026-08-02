import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { KnowledgeAsset } from "@zhiloop/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  calculateKnowledgeContentHash,
  MarkdownKnowledgeRepository,
  MarkdownRepositoryConflictError,
  MarkdownRepositoryInvalidDocumentError,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
} from "./index.js";

const at1 = "2026-08-02T01:00:00.000Z";
const at2 = "2026-08-02T02:00:00.000Z";
const at3 = "2026-08-02T03:00:00.000Z";

function asset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  const draft: KnowledgeAsset = {
    schemaVersion: 1,
    id: "decision.codex.primary-source",
    subjectKey: "decision.codex.primary-source",
    kind: "DECISION",
    scope: { level: "PROJECT", projectId: "project-a", repositoryRemote: "example.com/team/project-a" },
    version: 1,
    status: "ACCEPTED",
    title: "Codex 作为主要对话事实源",
    summary: "Hooks 捕获当前对话，App Server 作为后续结构化入口。",
    body: "# 结论\n\n使用 Hooks。\n\n## 边界\n\n- 不修改业务仓库。\n",
    aliases: ["Codex 对话接入"],
    keywords: ["hooks", "app-server"],
    applicability: ["需要捕获可观察证据"],
    nonApplicability: ["只需要通用偏好"],
    symbols: ["UserPromptSubmit"],
    relations: [{ type: "DERIVED_FROM", targetId: "candidate-1", reason: "verified publication" }],
    evidence: [{ evidenceId: "evidence-1", verdict: "SUPPORTS" }],
    confidence: 0.95,
    sourceEpisodes: ["episode-1"],
    contentHash: "",
    codeFingerprint: "fingerprint-1",
    correlationId: "correlation-1",
    createdAt: at1,
    updatedAt: at1,
    ...overrides,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

describe("MarkdownKnowledgeRepository", () => {
  let temporaryRoot: string;
  let repositoryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-markdown-repository-"));
    repositoryRoot = path.join(temporaryRoot, "knowledge");
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("round-trips every KnowledgeAsset field through human-readable Markdown", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "roundtrip" });
    const original = asset();
    const published = await repository.publish(original, { expectedCurrentVersion: 0 });

    expect(published.status).toBe("PUBLISHED");
    expect(published.value.asset).toEqual(original);
    expect(await repository.readCurrent(original.id)).toEqual({ ok: true, value: published.value });
    expect((await repository.readVersion(original.id, 1))).toEqual({
      ok: true,
      value: { ...published.value, documentPath: path.join(repositoryRoot, "assets", original.id, "versions", "00000001.md") },
    });
    const markdown = await readFile(published.value.documentPath, "utf8");
    expect(markdown).toContain("subject_key: decision.codex.primary-source");
    expect(markdown).toContain("# 结论");
    expect(markdown).not.toContain("content_hash:");

    if (process.platform !== "win32") {
      expect((await stat(path.join(repositoryRoot, "assets", original.id))).mode & 0o777).toBe(0o700);
      expect((await stat(published.value.documentPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("creates immutable sequential versions with optimistic concurrency and idempotency", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "versions" });
    const first = asset();
    const second = asset({ version: 2, title: "Codex 是对话主事实源", updatedAt: at2, correlationId: "correlation-2" });
    await repository.publish(first, { expectedCurrentVersion: 0 });
    await expect(repository.publish(first, { expectedCurrentVersion: 1 })).resolves.toMatchObject({ status: "IDEMPOTENT" });
    await expect(repository.publish(asset({ title: "同版本不同内容" }), { expectedCurrentVersion: 1 }))
      .rejects.toThrow("already has different current content");
    await expect(repository.publish(second, { expectedCurrentVersion: 0 })).rejects.toBeInstanceOf(MarkdownRepositoryConflictError);
    await expect(repository.publish(asset({ version: 3, updatedAt: at3 }), { expectedCurrentVersion: 1 })).rejects.toThrow("immediately follow");
    await expect(repository.publish(asset({
      version: 2,
      subjectKey: "decision.other.subject",
      updatedAt: at2,
      correlationId: "correlation-takeover",
    }), { expectedCurrentVersion: 1 })).rejects.toThrow("lineage fields");
    await repository.publish(second, { expectedCurrentVersion: 1 });

    expect((await repository.readCurrent(first.id))).toMatchObject({ ok: true, value: { asset: { version: 2 } } });
    expect((await repository.readVersion(first.id, 1))).toMatchObject({ ok: true, value: { asset: { title: first.title } } });
    expect(await readdir(path.join(repositoryRoot, "assets", first.id, "versions"))).toEqual(["00000001.md", "00000002.md"]);
  });

  it("repairs a manually created current document that has no immutable version", async () => {
    const original = asset();
    const assetDirectory = path.join(repositoryRoot, "assets", original.id);
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(path.join(assetDirectory, "current.md"), serializeKnowledgeDocument(original), "utf8");
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "repair-history" });

    await expect(repository.publish(original, { expectedCurrentVersion: 1 })).resolves.toMatchObject({ status: "PUBLISHED" });
    expect((await repository.readVersion(original.id, 1))).toMatchObject({ ok: true, value: { asset: original } });
    await expect(repository.publish(original, { expectedCurrentVersion: 1 })).resolves.toMatchObject({ status: "IDEMPOTENT" });
  });

  it("does not leave a half file before version commit", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, {
      randomId: () => "fail-version",
      faultInjector: (phase) => { if (phase === "BEFORE_VERSION_COMMIT") throw new Error("disk unavailable"); },
    });
    await expect(repository.publish(asset(), { expectedCurrentVersion: 0 })).rejects.toThrow("disk unavailable");
    const directory = path.join(repositoryRoot, "assets", asset().id);
    expect(await readdir(directory)).toEqual(["versions"]);
    expect(await readdir(path.join(directory, "versions"))).toEqual([]);
  });

  it("recovers an immutable version after current replacement fails", async () => {
    let fail = true;
    const first = asset();
    const failing = new MarkdownKnowledgeRepository(repositoryRoot, {
      randomId: () => "fail-current",
      faultInjector: (phase) => {
        if (phase === "BEFORE_CURRENT_COMMIT" && fail) {
          fail = false;
          throw new Error("current rename interrupted");
        }
      },
    });
    await expect(failing.publish(first, { expectedCurrentVersion: 0 })).rejects.toThrow("interrupted");
    expect((await failing.readCurrent(first.id))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" }, lastValid: { asset: { version: 1 } } });
    expect((await readdir(path.join(repositoryRoot, "assets", first.id))).filter((name) => name.startsWith(".tmp"))).toEqual([]);
    await expect(failing.publish(asset({ version: 3, updatedAt: at3 }), { expectedCurrentVersion: 1 }))
      .rejects.toThrow("immediately follow repository history");
    await expect(failing.publish(first, { expectedCurrentVersion: 1 })).rejects.toThrow("expectedCurrentVersion");

    const recovered = await new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "recover" })
      .publish(first, { expectedCurrentVersion: 0 });
    expect(recovered.status).toBe("PUBLISHED");
    expect((await new MarkdownKnowledgeRepository(repositoryRoot).readCurrent(first.id))).toMatchObject({ ok: true, value: { asset: first } });
  });

  it("rejects invalid manual Front Matter while returning the last valid immutable version", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "invalid-manual" });
    const original = asset();
    await repository.publish(original, { expectedCurrentVersion: 0 });
    const currentPath = path.join(repositoryRoot, "assets", original.id, "current.md");
    await writeFile(currentPath, (await readFile(currentPath, "utf8")).replace("schema_version: 1", "schema_version: 99"), "utf8");

    const result = await repository.readCurrent(original.id);
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_SCHEMA_VERSION" }, lastValid: { asset: original } });
    await expect(repository.publish(asset({ version: 2, updatedAt: at2 }), { expectedCurrentVersion: 1 }))
      .rejects.toBeInstanceOf(MarkdownRepositoryInvalidDocumentError);
    expect((await repository.readVersion(original.id, 1))).toMatchObject({ ok: true, value: { asset: original } });
  });

  it("accepts a valid manual body edit, recalculates its hash, and does not mutate history", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "manual" });
    const original = asset();
    await repository.publish(original, { expectedCurrentVersion: 0 });
    const currentPath = path.join(repositoryRoot, "assets", original.id, "current.md");
    const versionPath = path.join(repositoryRoot, "assets", original.id, "versions", "00000001.md");
    const immutableBefore = await readFile(versionPath, "utf8");
    await writeFile(currentPath, (await readFile(currentPath, "utf8")).replace("使用 Hooks。", "使用 Hooks，并保留 App Server 扩展。"), "utf8");

    const current = await repository.readCurrent(original.id);
    expect(current).toMatchObject({ ok: true, value: { asset: { version: 1 } } });
    if (!current.ok) throw new Error("expected valid manual document");
    expect(current.value.historyState).toBe("MANUAL_EDIT");
    expect(current.value.asset.body).toContain("App Server 扩展");
    expect(current.value.asset.contentHash).not.toBe(original.contentHash);
    expect(await readFile(versionPath, "utf8")).toBe(immutableBefore);

    const adopted = await repository.adoptManualEdit(original.id, {
      expectedCurrentVersion: 1,
      updatedAt: at2,
      correlationId: "correlation-manual",
    });
    expect(adopted.value.asset).toMatchObject({ version: 2, updatedAt: at2, correlationId: "correlation-manual" });
    expect(adopted.value.asset.body).toContain("App Server 扩展");
    expect(adopted.value.asset.relations).toContainEqual({
      type: "SUPERSEDES",
      targetId: original.id,
      targetVersion: 1,
      reason: "adopted valid manual Markdown edit",
    });
    expect(await readFile(versionPath, "utf8")).toBe(immutableBefore);
  });

  it("does not let a valid YAML edit elevate protected trust fields", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "manual-trust" });
    const original = asset();
    await repository.publish(original, { expectedCurrentVersion: 0 });
    const currentPath = path.join(repositoryRoot, "assets", original.id, "current.md");
    await writeFile(currentPath, (await readFile(currentPath, "utf8")).replace("status: ACCEPTED", "status: VERIFIED"), "utf8");

    const manuallyElevated = await repository.readCurrent(original.id);
    expect(manuallyElevated).toMatchObject({
      ok: true,
      value: { historyState: "MANUAL_EDIT", asset: { status: "VERIFIED" } },
    });
    if (!manuallyElevated.ok) throw new Error("expected structurally valid manual edit");
    await expect(repository.publish(manuallyElevated.value.asset, { expectedCurrentVersion: 1 }))
      .rejects.toThrow("immutable version");
    await expect(repository.adoptManualEdit(original.id, {
      expectedCurrentVersion: 1,
      updatedAt: at2,
      correlationId: "correlation-forged-trust",
    })).rejects.toThrow("protected lineage or trust fields");
    expect((await repository.readVersion(original.id, 1))).toMatchObject({ ok: true, value: { asset: { status: "ACCEPTED" } } });
  });

  it("rejects duplicate, aliased, unknown, and path-mismatched Front Matter", () => {
    const original = asset();
    const markdown = serializeKnowledgeDocument(original);
    expect(() => parseKnowledgeDocument(markdown.replace("id: decision", "id: duplicate\nid: decision"))).toThrow("could not be parsed");
    expect(() => parseKnowledgeDocument(markdown.replace(
      "aliases:\n  - Codex 对话接入\nkeywords:\n  - hooks\n  - app-server",
      "aliases: &shared\n  - Codex 对话接入\nkeywords: *shared",
    ))).toThrow("aliases are not allowed");
    expect(() => parseKnowledgeDocument(markdown.replace("kind: DECISION", "kind: DECISION\nmodel_guess: true"))).toThrow("unknown fields");
    expect(() => parseKnowledgeDocument(markdown, "copied.md", { assetId: "decision.other.asset" })).toThrow("does not match");
    expect(() => parseKnowledgeDocument(markdown, "copied.md", { version: 2 })).toThrow("does not match");
  });

  it("diagnoses malformed document, schema, and tombstone metadata", () => {
    const original = asset();
    const markdown = serializeKnowledgeDocument(original);
    expect(() => serializeKnowledgeDocument(asset({ title: "" }))).toThrow("does not match schema");
    expect(() => serializeKnowledgeDocument(original, { tombstone: true, tombstoneReason: "" })).toThrow("must not be empty");
    expect(() => serializeKnowledgeDocument(original, { tombstoneReason: "orphan" })).toThrow("requires tombstone");
    expect(() => parseKnowledgeDocument("# no front matter")).toThrow("must start");
    expect(() => parseKnowledgeDocument("---\nplain scalar\n---\nbody")).toThrow("must be an object");
    expect(() => parseKnowledgeDocument(markdown.replace("status: ACCEPTED", "status: UNKNOWN"))).toThrow("does not match schema");
    expect(() => parseKnowledgeDocument(markdown.replace("status: ACCEPTED", "status: ACCEPTED\ntombstone: string"))).toThrow("must be a boolean");
    expect(() => parseKnowledgeDocument(markdown.replace("status: ACCEPTED", "status: ACCEPTED\ntombstone: true"))).toThrow("non-empty string");
    expect(() => parseKnowledgeDocument(markdown.replace("status: ACCEPTED", "status: ACCEPTED\ntombstone_reason: orphan"))).toThrow("requires tombstone");
  });

  it("creates a recoverable tombstone that remains outside normal asset semantics", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "tombstone" });
    const original = asset();
    await repository.publish(original, { expectedCurrentVersion: 0 });
    const removed = await repository.tombstone(original.id, {
      expectedCurrentVersion: 1,
      reason: "superseded by an external policy",
      updatedAt: at2,
      correlationId: "correlation-delete",
    });

    expect(removed.value).toMatchObject({ tombstone: true, tombstoneReason: "superseded by an external policy", asset: { version: 2 } });
    expect((await repository.readCurrent(original.id))).toMatchObject({ ok: true, value: { tombstone: true } });
    expect((await repository.readVersion(original.id, 1))).toMatchObject({ ok: true, value: { tombstone: false, asset: original } });
    await expect(repository.tombstone(original.id, {
      expectedCurrentVersion: 2, reason: "again", updatedAt: at3, correlationId: "correlation-again",
    })).rejects.toThrow("already tombstoned");
  });

  it("restores an old version as a new version without overwriting history", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "restore" });
    const first = asset();
    const second = asset({ version: 2, title: "第二版", updatedAt: at2, correlationId: "correlation-2" });
    await repository.publish(first, { expectedCurrentVersion: 0 });
    await repository.publish(second, { expectedCurrentVersion: 1 });
    const restored = await repository.restoreVersion(first.id, 1, {
      expectedCurrentVersion: 2,
      updatedAt: at3,
      correlationId: "correlation-restore",
    });

    expect(restored.value.asset).toMatchObject({ version: 3, title: first.title, updatedAt: at3, correlationId: "correlation-restore" });
    expect(restored.value.asset.relations).toContainEqual({
      type: "SUPERSEDES", targetId: first.id, targetVersion: 2, reason: "restored from version 1",
    });
    expect((await repository.readVersion(first.id, 1))).toMatchObject({ ok: true, value: { asset: first } });
    expect((await repository.readVersion(first.id, 2))).toMatchObject({ ok: true, value: { asset: second } });
    await expect(repository.restoreVersion(first.id, 99, {
      expectedCurrentVersion: 3, updatedAt: at3, correlationId: "missing-source",
    })).rejects.toBeInstanceOf(MarkdownRepositoryInvalidDocumentError);
    await expect(repository.restoreVersion(first.id, 1, {
      expectedCurrentVersion: 2, updatedAt: at3, correlationId: "stale-restore",
    })).rejects.toThrow("expectedCurrentVersion");
  });

  it("fails closed for invalid tombstone and manual-adoption requests", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "operation-errors" });
    const original = asset();
    await expect(repository.tombstone(original.id, {
      expectedCurrentVersion: 1, reason: "missing", updatedAt: at2, correlationId: "missing",
    })).rejects.toBeInstanceOf(MarkdownRepositoryInvalidDocumentError);
    await repository.publish(original, { expectedCurrentVersion: 0 });
    await expect(repository.tombstone(original.id, {
      expectedCurrentVersion: 0, reason: "stale request", updatedAt: at2, correlationId: "stale",
    })).rejects.toThrow("expectedCurrentVersion");
    await expect(repository.tombstone(original.id, {
      expectedCurrentVersion: 1, reason: " ", updatedAt: at2, correlationId: "empty",
    })).rejects.toThrow("must not be empty");
    await expect(repository.adoptManualEdit(original.id, {
      expectedCurrentVersion: 0, updatedAt: at2, correlationId: "stale-adopt",
    })).rejects.toThrow("expectedCurrentVersion");
    await expect(repository.adoptManualEdit(original.id, {
      expectedCurrentVersion: 1, updatedAt: at2, correlationId: "no-change",
    })).resolves.toMatchObject({ status: "IDEMPOTENT" });

    await repository.tombstone(original.id, {
      expectedCurrentVersion: 1, reason: "removed", updatedAt: at2, correlationId: "removed",
    });
    await expect(repository.adoptManualEdit(original.id, {
      expectedCurrentVersion: 2, updatedAt: at3, correlationId: "tombstone-adopt",
    })).rejects.toThrow("not a manual knowledge edit");
    await expect(repository.restoreVersion(original.id, 2, {
      expectedCurrentVersion: 2, updatedAt: at3, correlationId: "restore-tombstone",
    })).rejects.toThrow("tombstone version");
  });

  it("rejects unsafe IDs, symlink traversal, invalid hashes, and oversized documents", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { maxDocumentBytes: 1_000 });
    await expect(repository.readCurrent("../escape")).rejects.toThrow("safe single path");
    await expect(repository.publish({ ...asset(), contentHash: "forged" })).rejects.toBeInstanceOf(MarkdownRepositoryInvalidDocumentError);
    await expect(repository.publish(asset({ status: "PROPOSED" }))).rejects.toThrow("PROPOSED knowledge");
    await expect(repository.publish(asset({ body: "x".repeat(2_000) }))).rejects.toThrow("size limit");

    const target = path.join(temporaryRoot, "outside");
    await mkdir(path.join(repositoryRoot, "assets"), { recursive: true });
    await mkdir(target);
    await symlink(target, path.join(repositoryRoot, "assets", asset().id));
    expect(await repository.readCurrent(asset().id)).toMatchObject({ ok: false, error: { code: "UNSAFE_STORAGE" } });
    await expect(repository.publish(asset())).rejects.toThrow("real directories");
    await expect(repository.listAssetIds()).rejects.toThrow("symbolic-link asset directories");
  });

  it("bounds versions, reads, temp names, and immutable conflicts", async () => {
    expect(() => new MarkdownKnowledgeRepository(" ")).toThrow("must not be empty");
    expect(() => new MarkdownKnowledgeRepository(repositoryRoot, { maxDocumentBytes: 0 })).toThrow("positive safe integer");
    const repository = new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "bounds" });
    expect(repository.rootDirectory).toBe(path.resolve(repositoryRoot));
    await expect(repository.readVersion(asset().id, 0)).rejects.toThrow("positive safe integer");
    await expect(repository.readVersion(asset().id, 100_000_000)).rejects.toThrow("filename limit");
    await expect(new MarkdownKnowledgeRepository(repositoryRoot, { randomId: () => "../bad" }).publish(asset()))
      .rejects.toThrow("safe filename");

    const first = asset();
    await repository.publish(first, { expectedCurrentVersion: 0 });
    expect(await new MarkdownKnowledgeRepository(repositoryRoot, { maxDocumentBytes: 100 }).readCurrent(first.id))
      .toMatchObject({ ok: false, error: { code: "DOCUMENT_TOO_LARGE" } });

    const conflicting = asset({ version: 2, title: "预先冲突的第二版", updatedAt: at2, correlationId: "conflicting" });
    const desired = asset({ version: 2, title: "期望的第二版", updatedAt: at2, correlationId: "desired" });
    await writeFile(path.join(repositoryRoot, "assets", first.id, "versions", "00000002.md"), serializeKnowledgeDocument(conflicting), "utf8");
    await expect(repository.publish(desired, { expectedCurrentVersion: 1 })).rejects.toThrow("already has different content");
  });

  it("lists only safe real asset directories in stable order", async () => {
    const repository = new MarkdownKnowledgeRepository(repositoryRoot);
    await repository.publish(asset({ id: "knowledge.zeta.item", subjectKey: "knowledge.zeta.item" }));
    await repository.publish(asset({ id: "knowledge.alpha.item", subjectKey: "knowledge.alpha.item" }));
    expect(await repository.listAssetIds()).toEqual(["knowledge.alpha.item", "knowledge.zeta.item"]);
  });
});
