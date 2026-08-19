import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CodeGraphCliAdapter, NodeCodeGraphProcess, type CodeGraphProcessPort } from "@zhiloop/codegraph-adapter";
import type { CodeGraphCapabilityView, CodeGraphInitializationPreview } from "@zhiloop/control-api";
import { NonRetryableJobError, RetryableJobError, type JobHandler } from "@zhiloop/job-runtime";
import { parseEvolutionJobInput } from "@zhiloop/evolution-job-runtime";

const PREVIEW_TTL_MS = 5 * 60_000;
const INITIALIZATION_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

interface StoredRow { readonly payload_json: string; readonly payload_hash: string; }
interface ReceiptRow { readonly fingerprint: string; readonly job_id: string; }

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function identity(value: unknown): string { return hash(canonical(value)); }

function readRow<T>(row: StoredRow | undefined, code: string): T | undefined {
  if (row === undefined) return undefined;
  if (hash(row.payload_json) !== row.payload_hash) throw new Error(`${code}_INTEGRITY_FAILED`);
  return Object.freeze(JSON.parse(row.payload_json) as T);
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function safeRepository(projectId: string, repositoryRoot: string): { readonly root: string; readonly repositoryIdentity: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,499}$/u.test(projectId) || !isAbsolute(repositoryRoot)) {
    throw new Error("CODEGRAPH_PROJECT_INVALID");
  }
  const requested = resolve(repositoryRoot);
  const root = realpathSync(requested);
  const home = realpathSync(homedir());
  if (root === resolve(root, "/") || root === home) throw new Error("CODEGRAPH_REPOSITORY_ROOT_FORBIDDEN");
  const stats = statSync(root);
  if (!stats.isDirectory()) throw new Error("CODEGRAPH_REPOSITORY_NOT_DIRECTORY");
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== currentUid) throw new Error("CODEGRAPH_REPOSITORY_OWNER_MISMATCH");
  const target = join(root, ".codegraph");
  if (existsSync(target)) {
    const targetStats = lstatSync(target);
    if (targetStats.isSymbolicLink() || !inside(root, realpathSync(target))) throw new Error("CODEGRAPH_TARGET_SYMLINK_ESCAPE");
    if (!targetStats.isDirectory()) throw new Error("CODEGRAPH_TARGET_INVALID");
  }
  return Object.freeze({ root, repositoryIdentity: identity([projectId, root, stats.dev, stats.ino]) });
}

export interface CodeGraphLifecycleOptions {
  readonly databasePath: string;
  readonly projectRoot: (projectId: string) => string | undefined;
  readonly process?: CodeGraphProcessPort;
  readonly executable?: string;
  readonly clock?: () => Date;
}

export class CodeGraphLifecycleService {
  readonly #database: DatabaseSync;
  readonly #projectRoot: CodeGraphLifecycleOptions["projectRoot"];
  readonly #process: CodeGraphProcessPort;
  readonly #adapter: CodeGraphCliAdapter;
  readonly #executable: string;
  readonly #clock: () => Date;
  #closed = false;

  constructor(options: CodeGraphLifecycleOptions) {
    this.#projectRoot = options.projectRoot;
    this.#process = options.process ?? new NodeCodeGraphProcess();
    this.#executable = options.executable ?? "codegraph";
    this.#clock = options.clock ?? (() => new Date());
    this.#adapter = new CodeGraphCliAdapter(this.#process, {
      executable: this.#executable, timeoutMs: 10_000, capabilityTtlMs: 0,
    });
    this.#database = new DatabaseSync(options.databasePath);
    try {
      this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS codegraph_initialization_previews(
          preview_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
          expires_at TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS codegraph_preview_project ON codegraph_initialization_previews(project_id,expires_at DESC);
        CREATE TABLE IF NOT EXISTS codegraph_capabilities(
          project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS codegraph_initialization_receipts(
          idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
      `);
    } catch (error) { this.#database.close(); this.#closed = true; throw error; }
  }

  #open(): void { if (this.#closed) throw new Error("CODEGRAPH_LIFECYCLE_CLOSED"); }

  repository(projectId: string): { readonly root: string; readonly repositoryIdentity: string } {
    this.#open();
    const root = this.#projectRoot(projectId);
    if (root === undefined) throw new Error("CODEGRAPH_PROJECT_UNOBSERVED");
    return safeRepository(projectId, root);
  }

  storedCapability(projectId: string): CodeGraphCapabilityView | undefined {
    this.#open();
    const row = this.#database.prepare("SELECT payload_json,payload_hash FROM codegraph_capabilities WHERE project_id=?")
      .get(projectId) as StoredRow | undefined;
    return readRow<CodeGraphCapabilityView>(row, "CODEGRAPH_CAPABILITY");
  }

  view(projectId: string): CodeGraphCapabilityView {
    const repository = this.repository(projectId);
    return this.storedCapability(projectId) ?? Object.freeze({
      schemaVersion: 1,
      projectId,
      repositoryIdentity: repository.repositoryIdentity,
      repositoryRootLabel: `${basename(repository.root)} · …/${basename(dirname(repository.root))}/${basename(repository.root)}`,
      status: "NOT_CONFIGURED",
      reasonCode: "CODEGRAPH_CAPABILITY_NOT_OBSERVED",
      revision: 0,
      evidenceRefs: [],
      observedAt: this.#clock().toISOString(),
    });
  }

  async capability(projectId: string): Promise<CodeGraphCapabilityView> {
    const repository = this.repository(projectId);
    const observedAt = this.#clock().toISOString();
    const detected = await this.#adapter.capabilities({ projectRoot: repository.root, projectFingerprint: repository.repositoryIdentity }, { refresh: true });
    const previous = this.storedCapability(projectId);
    const mappedStatus = detected.status === "READY" ? "READY" : detected.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED"
      : detected.status === "INCOMPATIBLE" ? "FAILED" : "DEGRADED";
    return Object.freeze({
      schemaVersion: 1, projectId, repositoryIdentity: repository.repositoryIdentity,
      repositoryRootLabel: `${basename(repository.root)} · …/${basename(dirname(repository.root))}/${basename(repository.root)}`,
      status: mappedStatus, reasonCode: detected.reasonCode,
      revision: previous?.revision ?? 0,
      ...(detected.providerVersion === undefined ? {} : { providerVersion: detected.providerVersion }),
      ...(detected.indexRevision === undefined ? {} : { indexRevision: detected.indexRevision }),
      ...(detected.indexedFiles === undefined ? {} : { indexedFiles: detected.indexedFiles }),
      evidenceRefs: previous?.evidenceRefs ?? [], observedAt,
    });
  }

  async preview(projectId: string, requestedAt: string): Promise<CodeGraphInitializationPreview> {
    this.#open();
    const created = new Date(requestedAt);
    if (!Number.isFinite(created.getTime()) || created.toISOString() !== requestedAt) throw new Error("CODEGRAPH_PREVIEW_TIMESTAMP_INVALID");
    const repository = this.repository(projectId);
    const capability = await this.capability(projectId);
    const expiresAt = new Date(created.getTime() + PREVIEW_TTL_MS).toISOString();
    const previewId = `codegraph-preview-${identity([projectId, repository.repositoryIdentity, capability.revision, requestedAt]).slice(0, 32)}`;
    const preview: CodeGraphInitializationPreview = Object.freeze({
      schemaVersion: 1, previewId, projectId, repositoryIdentity: repository.repositoryIdentity,
      repositoryRootLabel: capability.repositoryRootLabel,
      targetDirectoryLabel: `${capability.repositoryRootLabel}/.codegraph`, expectedRevision: capability.revision,
      ...(capability.providerVersion === undefined ? {} : { providerVersion: capability.providerVersion }),
      currentStatus: capability.status,
      riskCodes: ["WRITES_CODEGRAPH_INDEX", "EXPLICIT_COMMIT_REQUIRED", "CODEX_HOOK_UNAFFECTED"],
      createdAt: requestedAt, expiresAt,
    });
    const serialized = canonical(preview);
    this.#database.prepare(`INSERT INTO codegraph_initialization_previews(preview_id,project_id,revision,expires_at,payload_json,payload_hash)
      VALUES(?,?,?,?,?,?) ON CONFLICT(preview_id) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash
      WHERE codegraph_initialization_previews.payload_hash=excluded.payload_hash`)
      .run(previewId, projectId, preview.expectedRevision, expiresAt, serialized, hash(serialized));
    return preview;
  }

  validateCommit(request: { readonly projectId: string; readonly previewId: string; readonly repositoryIdentity: string;
    readonly expectedRevision: number; readonly idempotencyKey: string; readonly requestedAt: string }): CodeGraphInitializationPreview {
    this.#open();
    const row = this.#database.prepare("SELECT payload_json,payload_hash FROM codegraph_initialization_previews WHERE preview_id=? AND project_id=?")
      .get(request.previewId, request.projectId) as StoredRow | undefined;
    const preview = readRow<CodeGraphInitializationPreview>(row, "CODEGRAPH_PREVIEW");
    if (preview === undefined) throw new Error("CODEGRAPH_PREVIEW_NOT_FOUND");
    const repository = this.repository(request.projectId);
    if (preview.repositoryIdentity !== request.repositoryIdentity || repository.repositoryIdentity !== request.repositoryIdentity
      || preview.expectedRevision !== request.expectedRevision || Date.parse(preview.expiresAt) <= Date.parse(request.requestedAt)
      || (this.storedCapability(request.projectId)?.revision ?? 0) !== request.expectedRevision) {
      throw new Error("CODEGRAPH_PREVIEW_STALE");
    }
    return preview;
  }

  getPreview(previewId: string): CodeGraphInitializationPreview {
    this.#open();
    const row = this.#database.prepare("SELECT payload_json,payload_hash FROM codegraph_initialization_previews WHERE preview_id=?")
      .get(previewId) as StoredRow | undefined;
    const preview = readRow<CodeGraphInitializationPreview>(row, "CODEGRAPH_PREVIEW");
    if (preview === undefined) throw new Error("CODEGRAPH_PREVIEW_NOT_FOUND");
    return preview;
  }

  receipt(idempotencyKey: string, fingerprint: string): string | undefined {
    const row = this.#database.prepare("SELECT fingerprint,job_id FROM codegraph_initialization_receipts WHERE idempotency_key=?")
      .get(idempotencyKey) as ReceiptRow | undefined;
    if (row === undefined) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("CODEGRAPH_INITIALIZATION_IDEMPOTENCY_CONFLICT");
    return row.job_id;
  }

  saveReceipt(idempotencyKey: string, fingerprint: string, jobId: string, createdAt: string): void {
    this.#database.prepare(`INSERT INTO codegraph_initialization_receipts(idempotency_key,fingerprint,job_id,created_at) VALUES(?,?,?,?)
      ON CONFLICT(idempotency_key) DO NOTHING`).run(idempotencyKey, fingerprint, jobId, createdAt);
    if (this.receipt(idempotencyKey, fingerprint) !== jobId) throw new Error("CODEGRAPH_INITIALIZATION_RECEIPT_CONFLICT");
  }

  publish(projectId: string, repositoryIdentity: string, capability: Omit<CodeGraphCapabilityView, "revision">): CodeGraphCapabilityView {
    const previous = this.storedCapability(projectId);
    if (capability.repositoryIdentity !== repositoryIdentity) throw new Error("CODEGRAPH_CAPABILITY_IDENTITY_CONFLICT");
    const next = Object.freeze({ ...capability, revision: (previous?.revision ?? 0) + 1 });
    const serialized = canonical(next);
    const write = previous === undefined
      ? this.#database.prepare("INSERT INTO codegraph_capabilities(project_id,revision,payload_json,payload_hash) VALUES(?,?,?,?)")
        .run(projectId, next.revision, serialized, hash(serialized))
      : this.#database.prepare("UPDATE codegraph_capabilities SET revision=?,payload_json=?,payload_hash=? WHERE project_id=? AND revision=?")
        .run(next.revision, serialized, hash(serialized), projectId, previous.revision);
    if (write.changes !== 1) throw new Error("CODEGRAPH_CAPABILITY_REVISION_CONFLICT");
    return next;
  }

  handler(): JobHandler {
    return async (context) => {
      const input = parseEvolutionJobInput(context.input);
      if (input.jobType !== "CODEGRAPH_INITIALIZE") throw new NonRetryableJobError("CODEGRAPH_JOB_INPUT_INVALID");
      const repository = this.repository(input.projectId);
      if (repository.root !== input.repositoryRoot || repository.repositoryIdentity !== input.repositoryIdentity) {
        throw new NonRetryableJobError("CODEGRAPH_REPOSITORY_IDENTITY_CHANGED");
      }
      const phase = (context.getCheckpoint()?.data as { phase?: string } | undefined)?.phase;
      if (phase !== "INITIALIZED") {
        context.throwIfCancellationRequested();
        const result = await this.#process.run({ executable: this.#executable, args: ["init", "-i"], cwd: repository.root,
          timeoutMs: INITIALIZATION_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
        if (result.timedOut) throw new RetryableJobError("CODEGRAPH_INITIALIZATION_TIMEOUT");
        if (result.outputExceeded) throw new NonRetryableJobError("CODEGRAPH_INITIALIZATION_OUTPUT_LIMIT");
        if (result.exitCode !== 0) throw new RetryableJobError("CODEGRAPH_INITIALIZATION_COMMAND_FAILED");
        context.saveCheckpoint({ phase: "INITIALIZED", effectKey: context.effectKey("initialize") }, 0.6);
      }
      context.throwIfCancellationRequested();
      const detected = await this.#adapter.capabilities({ projectRoot: repository.root, projectFingerprint: repository.repositoryIdentity }, { refresh: true });
      if (detected.status !== "READY") throw new RetryableJobError(detected.reasonCode);
      const smoke = await this.#adapter.findSymbols({ projectRoot: repository.root, projectFingerprint: repository.repositoryIdentity },
        { symbol: "__ZHILOOP_CODEGRAPH_SMOKE__", limit: 1 });
      if (smoke.capability.status !== "READY") throw new RetryableJobError("CODEGRAPH_QUERY_SMOKE_FAILED");
      const observedAt = this.#clock().toISOString();
      this.publish(input.projectId, repository.repositoryIdentity, {
        schemaVersion: 1, projectId: input.projectId, repositoryIdentity: repository.repositoryIdentity,
        repositoryRootLabel: `${basename(repository.root)} · …/${basename(dirname(repository.root))}/${basename(repository.root)}`,
        status: "READY", reasonCode: "CODEGRAPH_READY", providerVersion: detected.providerVersion ?? input.adapterVersion,
        ...(detected.indexRevision === undefined ? {} : { indexRevision: detected.indexRevision }),
        ...(detected.indexedFiles === undefined ? {} : { indexedFiles: detected.indexedFiles }),
        evidenceRefs: [`job:${context.jobId}`, "smoke:status", "smoke:version", "smoke:query"], observedAt,
      });
      context.saveCheckpoint({ phase: "CAPABILITY_PUBLISHED", effectKey: context.effectKey("publish") }, 1);
    };
  }

  close(): void { if (this.#closed) return; this.#database.close(); this.#closed = true; }
}

export function codeGraphCommitFingerprint(value: { readonly projectId: string; readonly previewId: string;
  readonly repositoryIdentity: string; readonly expectedRevision: number; readonly idempotencyKey?: string;
  readonly requestedAt?: string }): string {
  return identity({ projectId: value.projectId, previewId: value.previewId,
    repositoryIdentity: value.repositoryIdentity, expectedRevision: value.expectedRevision });
}
