import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ProjectContext } from "@zhiloop/domain";
import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";
import {
  KnowledgeFreshnessScheduler,
  KnowledgeFreshnessWorker,
  type FreshnessBatchVerificationResult,
  type FreshnessRevalidationItem,
  type FreshnessSchedulerConfiguration,
  type FreshnessSchedulerState,
  type SqliteKnowledgeFreshnessStore,
} from "@zhiloop/knowledge-freshness";
import type {
  KnowledgeVerificationBatch,
  KnowledgeVerificationRequest,
  VerificationExecutionControls,
} from "@zhiloop/knowledge-verification";

const MAX_GIT_OUTPUT_BYTES = 2_000_000;
const MAX_CHANGED_PATHS = 10_000;
const MAX_VERIFICATION_CONCURRENCY = 4;

interface BaselineRow {
  readonly project_id: string;
  readonly project_root: string;
  readonly head: string;
  readonly status_fingerprint: string;
  readonly changed_paths_json: string;
}

function safeId(value: string): boolean { return /^[A-Za-z0-9._:-]{1,500}$/u.test(value); }
function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function git(cwd: string, args: readonly string[], timeoutMs = 2_000): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) reject(new Error("GIT_CHANGESET_COMMAND_FAILED"));
      else resolveOutput(stdout);
    });
  });
}

function porcelainPaths(output: string): readonly string[] {
  const records = output.split("\0").filter((value) => value.length > 0);
  const paths = records.flatMap((record) => {
    const candidate = record.length >= 4 && record[2] === " " ? record.slice(3) : record;
    return safePath(candidate) ? [candidate] : [];
  });
  const unique = [...new Set(paths)].sort();
  if (unique.length > MAX_CHANGED_PATHS) throw new Error("GIT_CHANGESET_PATH_LIMIT_EXCEEDED");
  return Object.freeze(unique);
}

async function committedPathsBetween(projectRoot: string, previousHead: string, head: string): Promise<readonly string[]> {
  try {
    return porcelainPaths(await git(projectRoot, ["diff", "--name-only", "-z", previousHead, head]));
  } catch {
    // A force-push or repository cleanup can remove the prior object. A full tracked-file scan is conservative and
    // keeps the durable baseline unchanged until every resulting knowledge batch has been acknowledged.
    return porcelainPaths(await git(projectRoot, ["ls-files", "-z"]));
  }
}

/** Durable Git adapter. First observation establishes a baseline; later scans emit only bounded repository-relative paths. */
export class GitKnowledgeChangeSource {
  readonly #database: DatabaseSync;
  readonly #projects = new Map<string, string>();
  readonly #pending = new Map<string, { readonly sourceRef: string; readonly head: string; readonly statusFingerprint: string; readonly currentPaths: readonly string[]; readonly observedAt: string }>();
  #closed = false;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(databasePath, 0o600);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
    this.#database.exec(`CREATE TABLE IF NOT EXISTS git_freshness_baseline(
      project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, head TEXT NOT NULL,
      status_fingerprint TEXT NOT NULL, changed_paths_json TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;`);
  }

  observe(projectId: string, projectRoot: string): void {
    if (this.#closed) throw new Error("Git change source is closed");
    if (!safeId(projectId) || !isAbsolute(projectRoot) || projectRoot.includes("\0")) throw new Error("GIT_CHANGESET_PROJECT_INVALID");
    const root = resolve(projectRoot);
    const previous = this.#projects.get(projectId);
    if (previous !== undefined && previous !== root) throw new Error("GIT_CHANGESET_PROJECT_ROOT_CONFLICT");
    this.#projects.set(projectId, root);
  }

  async scan(): Promise<readonly KnowledgeChangeSet[]> {
    if (this.#closed) throw new Error("Git change source is closed");
    const changes: KnowledgeChangeSet[] = [];
    for (const [projectId, projectRoot] of [...this.#projects].sort(([left], [right]) => left.localeCompare(right))) {
      const [headOutput, status] = await Promise.all([
        git(projectRoot, ["rev-parse", "HEAD"]),
        git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      ]);
      const head = headOutput.trim();
      if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("GIT_CHANGESET_HEAD_INVALID");
      const statusFingerprint = digest(status);
      const currentPaths = porcelainPaths(status);
      const row = this.#database.prepare("SELECT * FROM git_freshness_baseline WHERE project_id = ?").get(projectId) as unknown as BaselineRow | undefined;
      const now = new Date().toISOString();
      if (row === undefined) {
        this.#database.prepare("INSERT INTO git_freshness_baseline VALUES (?, ?, ?, ?, ?, ?)")
          .run(projectId, projectRoot, head, statusFingerprint, JSON.stringify(currentPaths), now);
        continue;
      }
      if (row.project_root !== projectRoot) throw new Error("GIT_CHANGESET_PROJECT_ROOT_CONFLICT");
      if (row.head === head && row.status_fingerprint === statusFingerprint) continue;
      let committedPaths: readonly string[] = [];
      if (row.head !== head) committedPaths = await committedPathsBetween(projectRoot, row.head, head);
      const previousPaths = JSON.parse(row.changed_paths_json) as string[];
      if (!Array.isArray(previousPaths) || !previousPaths.every(safePath)) throw new Error("GIT_CHANGESET_BASELINE_CORRUPT");
      const uniquePaths = [...new Set([...previousPaths, ...currentPaths, ...committedPaths])].sort();
      if (uniquePaths.length > MAX_CHANGED_PATHS) throw new Error("GIT_CHANGESET_PATH_LIMIT_EXCEEDED");
      const changedPaths = Object.freeze(uniquePaths);
      if (changedPaths.length === 0) continue;
      const configPaths = changedPaths.filter((path) => /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|.*\.ya?ml|.*\.toml|.*\.properties)$/u.test(path));
      const dependencyPaths = changedPaths.filter((path) => /(^|\/)(package(-lock)?\.json|pom\.xml|build\.gradle|Cargo\.toml|go\.mod)$/u.test(path));
      const sourceRef = `git:${head}:${statusFingerprint}`;
      this.#pending.set(projectId, { sourceRef, head, statusFingerprint, currentPaths, observedAt: now });
      changes.push(Object.freeze({
        projectId, changedPaths, changedSymbols: Object.freeze([]),
        changedConfigs: Object.freeze(configPaths), changedDependencies: Object.freeze(dependencyPaths),
        sourceRef, observedAt: now,
      }));
    }
    return Object.freeze(changes);
  }

  acknowledge(changes: KnowledgeChangeSet): void {
    if (this.#closed) throw new Error("Git change source is closed");
    const pending = this.#pending.get(changes.projectId);
    if (pending === undefined || pending.sourceRef !== changes.sourceRef) throw new Error("GIT_CHANGESET_ACK_CONFLICT");
    this.#database.prepare(`UPDATE git_freshness_baseline SET head = ?, status_fingerprint = ?, changed_paths_json = ?, updated_at = ? WHERE project_id = ?`)
      .run(pending.head, pending.statusFingerprint, JSON.stringify(pending.currentPaths), pending.observedAt, changes.projectId);
    this.#pending.delete(changes.projectId);
  }

  close(): void { if (this.#closed) return; this.#database.close(); this.#closed = true; }
}

interface SharedVerificationPort {
  verifyBatch(request: KnowledgeVerificationRequest, controls?: VerificationExecutionControls): Promise<KnowledgeVerificationBatch>;
}

export class ProductionFreshnessVerifier {
  readonly #projects = new Map<string, string>();

  constructor(private readonly verification: SharedVerificationPort) {}
  observe(projectId: string, root: string): void { this.#projects.set(projectId, root); }

  async verifyBatch(input: {
    readonly projectId: string;
    readonly changes: KnowledgeChangeSet;
    readonly items: readonly FreshnessRevalidationItem[];
    readonly signal?: AbortSignal;
  }): Promise<FreshnessBatchVerificationResult> {
    if (input.signal?.aborted) throw new Error("FRESHNESS_REVALIDATION_ABORTED");
    const root = this.#projects.get(input.projectId);
    if (root === undefined) throw new Error("FRESHNESS_PROJECT_ROOT_UNAVAILABLE");
    const project: ProjectContext = { projectId: input.projectId, repositoryRoot: root, portable: false };
    const batches = new Array<KnowledgeVerificationBatch>(input.items.length);
    let cursor = 0;
    let failed = false;
    let failure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed) {
        const index = cursor;
        cursor += 1;
        if (index >= input.items.length) return;
        const item = input.items[index]!;
        try {
          batches[index] = await this.verification.verifyBatch({
            candidate: item.candidate, project, requestedAt: input.changes.observedAt, purpose: "FRESHNESS",
            assertionIds: item.assertionIds, expectedCodeRevision: input.changes.sourceRef,
            knowledgeVersion: { assetId: item.assetId, assetVersion: item.assetVersion },
          }, { ...(input.signal === undefined ? {} : { signal: input.signal }) });
        } catch (error) {
          failed = true;
          failure = error;
        }
        if (input.signal?.aborted) {
          failed = true;
          failure = new Error("FRESHNESS_REVALIDATION_ABORTED");
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(MAX_VERIFICATION_CONCURRENCY, input.items.length) },
      async () => worker(),
    ));
    if (failed) throw failure;

    const results: Record<string, FreshnessBatchVerificationResult["results"][string]> = {};
    let graphRevision: string | undefined;
    for (const [index, item] of input.items.entries()) {
      const batch = batches[index]!;
      if (batch.codeRevision !== input.changes.sourceRef) throw new Error("FRESHNESS_VERIFICATION_REVISION_MISMATCH");
      if (batch.graphRevision !== undefined) {
        if (graphRevision !== undefined && graphRevision !== batch.graphRevision) throw new Error("FRESHNESS_GRAPH_REVISION_MIXED");
        graphRevision = batch.graphRevision;
      }
      results[item.assetId] = batch.results;
    }
    return Object.freeze({
      projectId: input.projectId, codeRevision: input.changes.sourceRef,
      ...(graphRevision === undefined ? {} : { graphRevision }),
      observedAt: input.changes.observedAt, results: Object.freeze(results),
    });
  }
}

export class P2FreshnessRuntime {
  readonly #source: GitKnowledgeChangeSource;
  readonly #verifier: ProductionFreshnessVerifier;
  readonly #scheduler: KnowledgeFreshnessScheduler;

  constructor(options: {
    readonly statePath: string;
    readonly store: SqliteKnowledgeFreshnessStore;
    readonly configuration: FreshnessSchedulerConfiguration;
    readonly verification: SharedVerificationPort;
    readonly onState?: (state: FreshnessSchedulerState) => void;
  }) {
    this.#source = new GitKnowledgeChangeSource(options.statePath);
    this.#verifier = new ProductionFreshnessVerifier(options.verification);
    const worker = new KnowledgeFreshnessWorker(options.store, this.#verifier);
    this.#scheduler = new KnowledgeFreshnessScheduler(worker, options.configuration, {
      source: this.#source,
      onResult: () => options.onState?.(this.#scheduler.state()),
      onError: () => options.onState?.(this.#scheduler.state()),
    });
  }

  observeProject(projectId: string, projectRoot: string): void {
    this.#source.observe(projectId, projectRoot);
    this.#verifier.observe(projectId, projectRoot);
    void this.#scheduler.flush().catch(() => undefined);
  }
  start(): boolean { return this.#scheduler.start(); }
  trigger(): Promise<void> { return this.#scheduler.flush(); }
  state(): FreshnessSchedulerState { return this.#scheduler.state(); }
  applyConfiguration(configuration: FreshnessSchedulerConfiguration): Promise<() => Promise<void>> { return this.#scheduler.applyConfiguration(configuration); }
  async close(): Promise<void> { await this.#scheduler.close(); this.#source.close(); }
}
