import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { KnowledgeAsset, KnowledgeRelation } from "@zhiloop/domain";
import { parseKnowledgeAsset } from "@zhiloop/schemas";
import { parseDocument, stringify } from "yaml";

import {
  MarkdownRepositoryConflictError,
  MarkdownRepositoryInvalidDocumentError,
  type MarkdownPublishOptions,
  type MarkdownPublishResult,
  type MarkdownReadResult,
  type MarkdownManualEditOptions,
  type MarkdownRepositoryDiagnostic,
  type MarkdownRepositoryDiagnosticCode,
  type MarkdownRepositoryOptions,
  type MarkdownRestoreOptions,
  type MarkdownTombstoneOptions,
  type StoredKnowledgeVersion,
} from "./types.js";

const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const SAFE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const VERSION_FILE = /^(\d{8})\.md$/;
const FRONT_MATTER_KEYS = new Set([
  "schema_version", "id", "subject_key", "kind", "scope", "version", "status", "title", "summary",
  "aliases", "keywords", "applicability", "non_applicability", "symbols", "relations", "evidence",
  "confidence", "source_episodes", "code_fingerprint", "correlation_id", "created_at", "updated_at",
  "tombstone", "tombstone_reason",
]);

interface SerializedDocumentOptions {
  readonly tombstone?: boolean;
  readonly tombstoneReason?: string;
}

class DocumentError extends Error {
  readonly code: MarkdownRepositoryDiagnosticCode;
  readonly issues: readonly string[];

  constructor(code: MarkdownRepositoryDiagnosticCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function withoutContentHash(asset: KnowledgeAsset): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asset).filter(([key]) => key !== "contentHash"));
}

export function calculateKnowledgeContentHash(asset: KnowledgeAsset): string {
  return `sha256_${createHash("sha256").update(canonicalJson(withoutContentHash(asset))).digest("hex")}`;
}

function assertSafeAssetId(assetId: string): void {
  if (!SAFE_ASSET_ID.test(assetId) || assetId === "." || assetId === "..") {
    throw new Error("assetId must be a safe single path component");
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function versionFileName(version: number): string {
  assertPositiveSafeInteger(version, "version");
  if (version > 99_999_999) throw new Error("version exceeds the Markdown filename limit");
  return `${String(version).padStart(8, "0")}.md`;
}

function frontMatterFor(asset: KnowledgeAsset, options: SerializedDocumentOptions): Record<string, unknown> {
  const frontMatter: Record<string, unknown> = {
    schema_version: asset.schemaVersion,
    id: asset.id,
    subject_key: asset.subjectKey,
    kind: asset.kind,
    scope: asset.scope,
    version: asset.version,
    status: asset.status,
    title: asset.title,
    summary: asset.summary,
    aliases: asset.aliases,
    keywords: asset.keywords,
    applicability: asset.applicability,
    non_applicability: asset.nonApplicability,
    symbols: asset.symbols,
    relations: asset.relations,
    evidence: asset.evidence,
    confidence: asset.confidence,
    source_episodes: asset.sourceEpisodes,
    correlation_id: asset.correlationId,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
  if (asset.codeFingerprint !== undefined) frontMatter["code_fingerprint"] = asset.codeFingerprint;
  if (options.tombstone === true) {
    frontMatter["tombstone"] = true;
    frontMatter["tombstone_reason"] = options.tombstoneReason;
  }
  return frontMatter;
}

function validateAssetForWrite(asset: KnowledgeAsset): void {
  assertSafeAssetId(asset.id);
  const parsed = parseKnowledgeAsset(asset);
  if (!parsed.ok) {
    throw new DocumentError(
      parsed.error.code,
      parsed.error.message,
      parsed.error.issues.map((issue) => `${issue.instancePath || "$"}: ${issue.message}`),
    );
  }
  if (asset.status === "PROPOSED") {
    throw new DocumentError("INVALID_DOCUMENT", "PROPOSED knowledge cannot enter the authoritative Markdown repository");
  }
  const calculated = calculateKnowledgeContentHash(asset);
  if (asset.contentHash !== calculated) {
    throw new DocumentError("INVALID_DOCUMENT", "KnowledgeAsset contentHash does not match its canonical content", [
      `expected ${calculated}`,
    ]);
  }
}

export function serializeKnowledgeDocument(
  asset: KnowledgeAsset,
  options: SerializedDocumentOptions = {},
): string {
  validateAssetForWrite(asset);
  if (options.tombstone === true && (options.tombstoneReason?.trim().length ?? 0) === 0) {
    throw new DocumentError("INVALID_FRONT_MATTER", "tombstoneReason must not be empty");
  }
  if (options.tombstone !== true && options.tombstoneReason !== undefined) {
    throw new DocumentError("INVALID_FRONT_MATTER", "tombstoneReason requires tombstone=true");
  }
  const yaml = stringify(frontMatterFor(asset, options), { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${asset.body}`;
}

function extractDocument(text: string): { readonly frontMatter: string; readonly body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match || match[1] === undefined) {
    throw new DocumentError("INVALID_DOCUMENT", "Markdown document must start with a closed YAML Front Matter block");
  }
  return { frontMatter: match[1], body: text.slice(match[0].length) };
}

function parseFrontMatter(input: string): Record<string, unknown> {
  let document;
  try {
    document = parseDocument(input, { strict: true, uniqueKeys: true, schema: "core" });
  } catch (error) {
    throw new DocumentError("INVALID_FRONT_MATTER", "YAML Front Matter could not be parsed", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (document.errors.length > 0) {
    throw new DocumentError(
      "INVALID_FRONT_MATTER",
      "YAML Front Matter could not be parsed",
      document.errors.map((error) => error.message),
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new DocumentError("INVALID_FRONT_MATTER", "YAML aliases are not allowed in Front Matter", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (!isRecord(value)) throw new DocumentError("INVALID_FRONT_MATTER", "Front Matter must be an object");
  const unknown = Object.keys(value).filter((key) => !FRONT_MATTER_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DocumentError("INVALID_FRONT_MATTER", "Front Matter contains unknown fields", unknown.sort());
  }
  return value;
}

function assetFromFrontMatter(frontMatter: Record<string, unknown>, body: string): KnowledgeAsset {
  const draft = {
    schemaVersion: frontMatter["schema_version"],
    id: frontMatter["id"],
    subjectKey: frontMatter["subject_key"],
    kind: frontMatter["kind"],
    scope: frontMatter["scope"],
    version: frontMatter["version"],
    status: frontMatter["status"],
    title: frontMatter["title"],
    summary: frontMatter["summary"],
    body,
    aliases: frontMatter["aliases"],
    keywords: frontMatter["keywords"],
    applicability: frontMatter["applicability"],
    nonApplicability: frontMatter["non_applicability"],
    symbols: frontMatter["symbols"],
    relations: frontMatter["relations"],
    evidence: frontMatter["evidence"],
    confidence: frontMatter["confidence"],
    sourceEpisodes: frontMatter["source_episodes"],
    contentHash: "derived-before-validation",
    ...(frontMatter["code_fingerprint"] === undefined ? {} : { codeFingerprint: frontMatter["code_fingerprint"] }),
    correlationId: frontMatter["correlation_id"],
    createdAt: frontMatter["created_at"],
    updatedAt: frontMatter["updated_at"],
  };
  const parsed = parseKnowledgeAsset(draft);
  if (!parsed.ok) {
    throw new DocumentError(
      parsed.error.code,
      parsed.error.message,
      parsed.error.issues.map((issue) => `${issue.instancePath || "$"}: ${issue.message}`),
    );
  }
  const asset = { ...parsed.value, contentHash: "" };
  return Object.freeze({ ...asset, contentHash: calculateKnowledgeContentHash(asset) });
}

export function parseKnowledgeDocument(
  text: string,
  documentPath = "<memory>",
  expected: { readonly assetId?: string; readonly version?: number } = {},
): StoredKnowledgeVersion {
  const extracted = extractDocument(text);
  const frontMatter = parseFrontMatter(extracted.frontMatter);
  const tombstone = frontMatter["tombstone"] === true;
  if (frontMatter["tombstone"] !== undefined && typeof frontMatter["tombstone"] !== "boolean") {
    throw new DocumentError("INVALID_FRONT_MATTER", "tombstone must be a boolean");
  }
  const reason = frontMatter["tombstone_reason"];
  if (tombstone && (typeof reason !== "string" || reason.trim().length === 0)) {
    throw new DocumentError("INVALID_FRONT_MATTER", "tombstone_reason must be a non-empty string");
  }
  if (!tombstone && reason !== undefined) {
    throw new DocumentError("INVALID_FRONT_MATTER", "tombstone_reason requires tombstone=true");
  }
  const asset = assetFromFrontMatter(frontMatter, extracted.body);
  if (expected.assetId !== undefined && asset.id !== expected.assetId) {
    throw new DocumentError("PATH_BINDING_MISMATCH", "asset id does not match its directory", [
      `expected ${expected.assetId}, received ${asset.id}`,
    ]);
  }
  if (expected.version !== undefined && asset.version !== expected.version) {
    throw new DocumentError("PATH_BINDING_MISMATCH", "asset version does not match its filename", [
      `expected ${expected.version}, received ${asset.version}`,
    ]);
  }
  return Object.freeze({
    asset,
    tombstone,
    ...(tombstone ? { tombstoneReason: reason as string } : {}),
    historyState: "UNVERIFIED",
    documentPath,
  });
}

function diagnostic(error: unknown, documentPath: string): MarkdownRepositoryDiagnostic {
  if (error instanceof DocumentError) {
    return { code: error.code, message: error.message, path: documentPath, issues: error.issues };
  }
  const code = errorCode(error);
  if (code === "ENOENT") return { code: "NOT_FOUND", message: "Markdown document was not found", path: documentPath, issues: [] };
  if (code === "ELOOP") return { code: "UNSAFE_STORAGE", message: "symbolic-link Markdown files are not allowed", path: documentPath, issues: [] };
  return {
    code: "INVALID_DOCUMENT",
    message: error instanceof Error ? error.message : String(error),
    path: documentPath,
    issues: [],
  };
}

function rehashAsset(asset: KnowledgeAsset, overrides: Partial<Omit<KnowledgeAsset, "contentHash">>): KnowledgeAsset {
  const draft = { ...asset, ...overrides, contentHash: "" };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

function sameDocument(left: StoredKnowledgeVersion, rightText: string): boolean {
  try {
    const right = parseKnowledgeDocument(rightText);
    return canonicalJson({ asset: left.asset, tombstone: left.tombstone, tombstoneReason: left.tombstoneReason }) ===
      canonicalJson({ asset: right.asset, tombstone: right.tombstone, tombstoneReason: right.tombstoneReason });
  } catch {
    return false;
  }
}

function sameStoredContent(left: StoredKnowledgeVersion, right: StoredKnowledgeVersion): boolean {
  return canonicalJson({ asset: left.asset, tombstone: left.tombstone, tombstoneReason: left.tombstoneReason }) ===
    canonicalJson({ asset: right.asset, tombstone: right.tombstone, tombstoneReason: right.tombstoneReason });
}

function withHistoryState<T extends StoredKnowledgeVersion>(
  value: T,
  historyState: StoredKnowledgeVersion["historyState"],
): T {
  return Object.freeze({ ...value, historyState });
}

function protectedManualFields(asset: KnowledgeAsset): string {
  return canonicalJson({
    schemaVersion: asset.schemaVersion,
    id: asset.id,
    subjectKey: asset.subjectKey,
    kind: asset.kind,
    scope: asset.scope,
    version: asset.version,
    status: asset.status,
    relations: asset.relations,
    evidence: asset.evidence,
    confidence: asset.confidence,
    sourceEpisodes: asset.sourceEpisodes,
    codeFingerprint: asset.codeFingerprint,
    correlationId: asset.correlationId,
    createdAt: asset.createdAt,
  });
}

export class MarkdownKnowledgeRepository {
  readonly #rootDirectory: string;
  readonly #assetsDirectory: string;
  readonly #maxDocumentBytes: number;
  readonly #randomId: () => string;
  readonly #faultInjector: NonNullable<MarkdownRepositoryOptions["faultInjector"]> | undefined;

  constructor(rootDirectory: string, options: MarkdownRepositoryOptions = {}) {
    if (rootDirectory.trim().length === 0) throw new Error("Markdown repository root must not be empty");
    this.#rootDirectory = path.resolve(rootDirectory);
    this.#assetsDirectory = path.join(this.#rootDirectory, "assets");
    this.#maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.#randomId = options.randomId ?? randomUUID;
    this.#faultInjector = options.faultInjector;
    assertPositiveSafeInteger(this.#maxDocumentBytes, "maxDocumentBytes");
  }

  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  #assetDirectory(assetId: string): string {
    assertSafeAssetId(assetId);
    return path.join(this.#assetsDirectory, assetId);
  }

  #versionsDirectory(assetId: string): string {
    return path.join(this.#assetDirectory(assetId), "versions");
  }

  #currentPath(assetId: string): string {
    return path.join(this.#assetDirectory(assetId), "current.md");
  }

  #versionPath(assetId: string, version: number): string {
    return path.join(this.#versionsDirectory(assetId), versionFileName(version));
  }

  async #ensureRealDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new DocumentError("UNSAFE_STORAGE", "Markdown repository paths must be real directories");
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);
  }

  async #ensureRoot(): Promise<void> {
    await this.#ensureRealDirectory(this.#rootDirectory);
    await this.#ensureRealDirectory(this.#assetsDirectory);
  }

  async #assertRealExistingDirectory(directory: string): Promise<void> {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new DocumentError("UNSAFE_STORAGE", "Markdown repository paths must be real directories");
    }
  }

  async #assertSafeReadPath(assetId: string, includeVersions: boolean): Promise<void> {
    await this.#assertRealExistingDirectory(this.#rootDirectory);
    await this.#assertRealExistingDirectory(this.#assetsDirectory);
    await this.#assertRealExistingDirectory(this.#assetDirectory(assetId));
    if (includeVersions) await this.#assertRealExistingDirectory(this.#versionsDirectory(assetId));
  }

  async #ensureAssetDirectories(assetId: string): Promise<void> {
    await this.#ensureRoot();
    await this.#ensureRealDirectory(this.#assetDirectory(assetId));
    await this.#ensureRealDirectory(this.#versionsDirectory(assetId));
  }

  async #syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #readText(documentPath: string): Promise<string> {
    const handle = await open(documentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new DocumentError("UNSAFE_STORAGE", "Markdown path must be a regular file");
      if (metadata.size > this.#maxDocumentBytes) throw new DocumentError("DOCUMENT_TOO_LARGE", "Markdown document exceeds the configured size limit");
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  }

  async #readAt(documentPath: string, expected: { readonly assetId: string; readonly version?: number }): Promise<MarkdownReadResult> {
    try {
      return { ok: true, value: parseKnowledgeDocument(await this.#readText(documentPath), documentPath, expected) };
    } catch (error) {
      return { ok: false, error: diagnostic(error, documentPath) };
    }
  }

  async #findLastValid(assetId: string): Promise<StoredKnowledgeVersion | undefined> {
    const versionsDirectory = this.#versionsDirectory(assetId);
    let names: string[] = [];
    try {
      await this.#assertRealExistingDirectory(versionsDirectory);
      const directory = await opendir(versionsDirectory);
      for await (const entry of directory) if (entry.isFile() && VERSION_FILE.test(entry.name)) names.push(entry.name);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    names = names.sort().reverse();
    for (const name of names) {
      const match = VERSION_FILE.exec(name);
      const versionText = match?.[1];
      if (versionText === undefined) continue;
      const version = Number(versionText);
      const result = await this.#readAt(path.join(versionsDirectory, name), { assetId, version });
      if (result.ok) return withHistoryState(result.value, "COMMITTED");
    }
    return undefined;
  }

  async readCurrent(assetId: string): Promise<MarkdownReadResult> {
    assertSafeAssetId(assetId);
    try {
      await this.#assertSafeReadPath(assetId, false);
    } catch (error) {
      return { ok: false, error: diagnostic(error, this.#currentPath(assetId)) };
    }
    const result = await this.#readAt(this.#currentPath(assetId), { assetId });
    if (result.ok) {
      const immutable = await this.readVersion(assetId, result.value.asset.version);
      const historyState = immutable.ok && sameStoredContent(result.value, immutable.value) ? "COMMITTED" : "MANUAL_EDIT";
      return { ok: true, value: withHistoryState(result.value, historyState) };
    }
    if (result.error.code === "UNSAFE_STORAGE") return result;
    try {
      const lastValid = await this.#findLastValid(assetId);
      return lastValid === undefined ? result : { ...result, lastValid };
    } catch (error) {
      return { ok: false, error: diagnostic(error, this.#versionsDirectory(assetId)) };
    }
  }

  async readVersion(assetId: string, version: number): Promise<MarkdownReadResult> {
    assertSafeAssetId(assetId);
    assertPositiveSafeInteger(version, "version");
    try {
      await this.#assertSafeReadPath(assetId, true);
    } catch (error) {
      return { ok: false, error: diagnostic(error, this.#versionPath(assetId, version)) };
    }
    const result = await this.#readAt(this.#versionPath(assetId, version), { assetId, version });
    return result.ok ? { ok: true, value: withHistoryState(result.value, "COMMITTED") } : result;
  }

  async listAssetIds(): Promise<readonly string[]> {
    await this.#ensureRoot();
    const ids: string[] = [];
    const directory = await opendir(this.#assetsDirectory);
    for await (const entry of directory) {
      if (entry.isDirectory() && SAFE_ASSET_ID.test(entry.name)) ids.push(entry.name);
      else if (entry.isSymbolicLink()) throw new DocumentError("UNSAFE_STORAGE", "symbolic-link asset directories are not allowed");
    }
    return Object.freeze(ids.sort());
  }

  async #writeDocument(assetId: string, version: number, serialized: string): Promise<void> {
    if (Buffer.byteLength(serialized, "utf8") > this.#maxDocumentBytes) {
      throw new DocumentError("DOCUMENT_TOO_LARGE", "Markdown document exceeds the configured size limit");
    }
    await this.#ensureAssetDirectories(assetId);
    const randomId = this.#randomId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(randomId)) throw new Error("randomId must be a safe filename component");
    const assetDirectory = this.#assetDirectory(assetId);
    const temporaryPath = path.join(assetDirectory, `.tmp-version-${process.pid}-${randomId}`);
    const currentTemporaryPath = path.join(assetDirectory, `.tmp-current-${process.pid}-${randomId}`);
    const versionPath = this.#versionPath(assetId, version);
    const currentPath = this.#currentPath(assetId);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(serialized, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }

      await this.#faultInjector?.("BEFORE_VERSION_COMMIT");
      try {
        await link(temporaryPath, versionPath);
        await this.#syncDirectory(this.#versionsDirectory(assetId));
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await this.#readText(versionPath);
        if (existing !== serialized) {
          throw new MarkdownRepositoryConflictError(`immutable version ${assetId}@${version} already has different content`);
        }
      }

      await this.#faultInjector?.("BEFORE_CURRENT_COMMIT");
      const currentHandle = await open(currentTemporaryPath, "wx", 0o600);
      try {
        try {
          await currentHandle.writeFile(serialized, { encoding: "utf8" });
          await currentHandle.sync();
        } finally {
          await currentHandle.close();
        }
        await rename(currentTemporaryPath, currentPath);
      } finally {
        try {
          await unlink(currentTemporaryPath);
        } catch {
          // The rename consumes the temp file; cleanup only handles a failed write/rename.
        }
      }
      await this.#syncDirectory(assetDirectory);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch {
        // Cleanup must not hide the durable commit or its original failure.
      }
    }
  }

  async publish(asset: KnowledgeAsset, options: MarkdownPublishOptions = {}): Promise<MarkdownPublishResult> {
    let serialized: string;
    try {
      serialized = serializeKnowledgeDocument(asset);
    } catch (error) {
      throw new MarkdownRepositoryInvalidDocumentError(diagnostic(error, this.#currentPath(asset.id)));
    }

    const current = await this.readCurrent(asset.id);
    if (current.ok) {
      if (options.expectedCurrentVersion !== undefined && options.expectedCurrentVersion !== current.value.asset.version) {
        throw new MarkdownRepositoryConflictError("expectedCurrentVersion does not match current.md");
      }
      if (asset.version === current.value.asset.version) {
        if (!current.value.tombstone && sameDocument(current.value, serialized)) {
          const immutable = await this.readVersion(asset.id, asset.version);
          if (immutable.ok && !immutable.value.tombstone && sameDocument(immutable.value, serialized)) {
            return { status: "IDEMPOTENT", value: current.value };
          }
          if (!immutable.ok && immutable.error.code === "NOT_FOUND") {
            await this.#writeDocument(asset.id, asset.version, serialized);
            return {
              status: "PUBLISHED",
              value: withHistoryState(parseKnowledgeDocument(serialized, this.#currentPath(asset.id), { assetId: asset.id, version: asset.version }), "COMMITTED"),
            };
          }
          throw new MarkdownRepositoryConflictError(`immutable version ${asset.id}@${asset.version} does not match current.md`);
        }
        throw new MarkdownRepositoryConflictError(`version ${asset.version} already has different current content`);
      }
      if (asset.version !== current.value.asset.version + 1) {
        throw new MarkdownRepositoryConflictError("KnowledgeAsset version must immediately follow current.md");
      }
      if (
        asset.subjectKey !== current.value.asset.subjectKey ||
        asset.kind !== current.value.asset.kind ||
        asset.createdAt !== current.value.asset.createdAt
      ) {
        throw new MarkdownRepositoryConflictError("KnowledgeAsset lineage fields cannot change under the same id");
      }
    } else if (current.error.code === "NOT_FOUND") {
      const lastVersion = current.lastValid?.asset.version ?? 0;
      const recoveringInterruptedCommit = lastVersion === asset.version;
      if (!recoveringInterruptedCommit && asset.version !== lastVersion + 1) {
        throw new MarkdownRepositoryConflictError("KnowledgeAsset version must immediately follow repository history");
      }
      const expectedBase = recoveringInterruptedCommit ? asset.version - 1 : lastVersion;
      if (options.expectedCurrentVersion !== undefined && options.expectedCurrentVersion !== expectedBase) {
        throw new MarkdownRepositoryConflictError("expectedCurrentVersion does not match repository history");
      }
    } else {
      throw new MarkdownRepositoryInvalidDocumentError(current.error);
    }

    await this.#writeDocument(asset.id, asset.version, serialized);
    const stored = withHistoryState(parseKnowledgeDocument(serialized, this.#currentPath(asset.id), { assetId: asset.id, version: asset.version }), "COMMITTED");
    return { status: "PUBLISHED", value: stored };
  }

  async tombstone(assetId: string, options: MarkdownTombstoneOptions): Promise<MarkdownPublishResult> {
    assertSafeAssetId(assetId);
    if (options.reason.trim().length === 0) throw new Error("tombstone reason must not be empty");
    const current = await this.readCurrent(assetId);
    if (!current.ok) throw new MarkdownRepositoryInvalidDocumentError(current.error);
    if (current.value.tombstone) throw new MarkdownRepositoryConflictError("asset is already tombstoned");
    if (current.value.asset.version !== options.expectedCurrentVersion) {
      throw new MarkdownRepositoryConflictError("expectedCurrentVersion does not match current.md");
    }
    const source = current.value.asset;
    const next = rehashAsset(source, {
      version: source.version + 1,
      correlationId: options.correlationId,
      updatedAt: options.updatedAt,
    });
    const serialized = serializeKnowledgeDocument(next, { tombstone: true, tombstoneReason: options.reason });
    await this.#writeDocument(assetId, next.version, serialized);
    return {
      status: "PUBLISHED",
      value: withHistoryState(parseKnowledgeDocument(serialized, this.#currentPath(assetId), { assetId, version: next.version }), "COMMITTED"),
    };
  }

  async restoreVersion(assetId: string, sourceVersion: number, options: MarkdownRestoreOptions): Promise<MarkdownPublishResult> {
    assertSafeAssetId(assetId);
    const sourceResult = await this.readVersion(assetId, sourceVersion);
    if (!sourceResult.ok) throw new MarkdownRepositoryInvalidDocumentError(sourceResult.error);
    if (sourceResult.value.tombstone) throw new MarkdownRepositoryConflictError("a tombstone version cannot be restored as knowledge");

    const currentResult = await this.readCurrent(assetId);
    const current = currentResult.ok ? currentResult.value : currentResult.lastValid;
    if (current === undefined) throw new MarkdownRepositoryInvalidDocumentError(currentResult.ok ? diagnostic(new Error("missing current"), this.#currentPath(assetId)) : currentResult.error);
    if (current.asset.version !== options.expectedCurrentVersion) {
      throw new MarkdownRepositoryConflictError("expectedCurrentVersion does not match repository history");
    }
    const supersedes: KnowledgeRelation = { type: "SUPERSEDES", targetId: assetId, targetVersion: current.asset.version, reason: `restored from version ${sourceVersion}` };
    const source = sourceResult.value.asset;
    const relations = [...source.relations.filter((relation) => !(
      relation.type === supersedes.type && relation.targetId === supersedes.targetId && relation.targetVersion === supersedes.targetVersion
    )), supersedes];
    const restored = rehashAsset(source, {
      version: current.asset.version + 1,
      relations,
      correlationId: options.correlationId,
      updatedAt: options.updatedAt,
    });
    const serialized = serializeKnowledgeDocument(restored);
    await this.#writeDocument(assetId, restored.version, serialized);
    return {
      status: "PUBLISHED",
      value: withHistoryState(parseKnowledgeDocument(serialized, this.#currentPath(assetId), { assetId, version: restored.version }), "COMMITTED"),
    };
  }

  async adoptManualEdit(assetId: string, options: MarkdownManualEditOptions): Promise<MarkdownPublishResult> {
    assertSafeAssetId(assetId);
    const currentResult = await this.readCurrent(assetId);
    if (!currentResult.ok) throw new MarkdownRepositoryInvalidDocumentError(currentResult.error);
    if (currentResult.value.tombstone) throw new MarkdownRepositoryConflictError("a tombstone is not a manual knowledge edit");
    if (currentResult.value.asset.version !== options.expectedCurrentVersion) {
      throw new MarkdownRepositoryConflictError("expectedCurrentVersion does not match current.md");
    }
    const immutableResult = await this.readVersion(assetId, options.expectedCurrentVersion);
    if (!immutableResult.ok) throw new MarkdownRepositoryInvalidDocumentError(immutableResult.error);
    if (immutableResult.value.tombstone) throw new MarkdownRepositoryConflictError("the current lineage version is tombstoned");
    const current = currentResult.value.asset;
    const immutable = immutableResult.value.asset;
    if (protectedManualFields(current) !== protectedManualFields(immutable)) {
      throw new MarkdownRepositoryConflictError("manual edit cannot change protected lineage or trust fields");
    }
    if (current.contentHash === immutable.contentHash) return { status: "IDEMPOTENT", value: currentResult.value };
    const supersedes: KnowledgeRelation = {
      type: "SUPERSEDES",
      targetId: assetId,
      targetVersion: immutable.version,
      reason: "adopted valid manual Markdown edit",
    };
    const relations = [...current.relations.filter((relation) => !(
      relation.type === supersedes.type && relation.targetId === supersedes.targetId && relation.targetVersion === supersedes.targetVersion
    )), supersedes];
    const adopted = rehashAsset(current, {
      version: immutable.version + 1,
      relations,
      correlationId: options.correlationId,
      updatedAt: options.updatedAt,
    });
    const serialized = serializeKnowledgeDocument(adopted);
    await this.#writeDocument(assetId, adopted.version, serialized);
    return {
      status: "PUBLISHED",
      value: withHistoryState(parseKnowledgeDocument(serialized, this.#currentPath(assetId), { assetId, version: adopted.version }), "COMMITTED"),
    };
  }
}
