import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

const DEFAULT_MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_PATHS = 100_000;
const DEFAULT_PATH_PAGE_SIZE = 10_000;
const MAX_PROJECTS = 1_000;

const CONFIG_PATH = /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|.*\.ya?ml|.*\.toml|.*\.properties)$/u;
const DEPENDENCY_PATH = /(^|\/)(package(-lock)?\.json|pom\.xml|build\.gradle|Cargo\.toml|go\.mod)$/u;

interface BaselineRow {
  readonly project_id: string;
  readonly project_root: string;
  readonly revision: number;
  readonly head: string;
  readonly status_fingerprint: string;
  readonly changed_paths_json: string;
  readonly updated_at: string;
}

interface ObservationRow {
  readonly observation_id: string;
  readonly source_ref: string;
  readonly project_id: string;
  readonly project_root: string;
  readonly base_revision: number;
  readonly target_head: string;
  readonly target_status_fingerprint: string;
  readonly current_paths_json: string;
  readonly current_paths_hash: string;
  readonly observation_hash: string;
  readonly path_count: number;
  readonly page_count: number;
  readonly status: "PENDING" | "ACKNOWLEDGED";
  readonly observed_at: string;
  readonly acknowledgement_effect_key: string | null;
  readonly acknowledged_at: string | null;
}

export interface GitProcessPort {
  run(cwd: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number): Promise<string>;
}

class NodeGitProcess implements GitProcessPort {
  run(cwd: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: maxOutputBytes, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          const diagnostic = `${error.message}\n${stderr}`;
          const reason = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "GIT_CHANGESET_OUTPUT_LIMIT_EXCEEDED"
            : args[0] === "diff" && /(?:bad object|unknown revision|invalid object|not a valid object|ambiguous argument)/iu.test(diagnostic)
              ? "GIT_CHANGESET_BASELINE_OBJECT_MISSING"
              : "GIT_CHANGESET_COMMAND_FAILED";
          reject(Object.assign(new Error(reason), { cause: error }));
        }
        else resolveOutput(stdout);
      });
    });
  }
}

export interface GitKnowledgeChangeSourceOptions {
  readonly process?: GitProcessPort;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxTotalPaths?: number;
  readonly pathPageSize?: number;
}

export interface GitKnowledgeChangeObservation {
  readonly observationId: string;
  readonly sourceRef: string;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly baseRevision: number;
  readonly targetHead: string;
  readonly targetStatusFingerprint: string;
  readonly observationHash: string;
  readonly pathCount: number;
  readonly pageCount: number;
  readonly status: "PENDING" | "ACKNOWLEDGED";
  readonly observedAt: string;
  readonly acknowledgementEffectKey?: string;
  readonly acknowledgedAt?: string;
}

export interface GitPathPage {
  readonly observationId: string;
  readonly page: number;
  readonly paths: readonly string[];
  readonly nextPage?: number;
}

export type GitBaselineAcknowledgement =
  | { readonly status: "ACKNOWLEDGED"; readonly revision: number }
  | { readonly status: "IDEMPOTENT"; readonly revision: number };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function jsonHash(value: unknown): string { return digest(JSON.stringify(value)); }
function safeId(value: string): boolean { return /^[A-Za-z0-9._:-]{1,500}$/u.test(value) && value !== "." && value !== ".."; }
function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.startsWith("/") && !value.includes("\\") && !/[\0\r\n]/u.test(value)
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function timestamp(clock: () => Date): string {
  const value = clock().toISOString();
  if (new Date(value).toISOString() !== value) throw new Error("GIT_CHANGESET_CLOCK_INVALID");
  return value;
}
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw new Error(`${name} is invalid`);
  return selected;
}
function uniquePaths(paths: readonly string[], maximum: number): readonly string[] {
  if (paths.some((path) => !safePath(path))) throw new Error("GIT_CHANGESET_PATH_INVALID");
  const unique = [...new Set(paths)].sort();
  if (unique.length > maximum) throw new Error("GIT_CHANGESET_PATH_LIMIT_EXCEEDED");
  return Object.freeze(unique);
}
function tokens(output: string, maxOutputBytes: number): readonly string[] {
  if (Buffer.byteLength(output, "utf8") > maxOutputBytes) throw new Error("GIT_CHANGESET_OUTPUT_LIMIT_EXCEEDED");
  const values = output.split("\0");
  if (values[values.length - 1] === "") values.pop();
  if (values.some((value) => value.length === 0)) throw new Error("GIT_CHANGESET_OUTPUT_INVALID");
  return values;
}

export function parseGitStatusPaths(
  output: string,
  maxOutputBytes = DEFAULT_MAX_GIT_OUTPUT_BYTES,
  maxTotalPaths = DEFAULT_MAX_TOTAL_PATHS,
): readonly string[] {
  const values = tokens(output, maxOutputBytes);
  const paths: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index]!;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("GIT_CHANGESET_STATUS_INVALID");
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const original = values[index + 1];
      if (original === undefined) throw new Error("GIT_CHANGESET_RENAME_INVALID");
      paths.push(original);
      index += 1;
    }
  }
  return uniquePaths(paths, maxTotalPaths);
}

export function parseGitNameStatusPaths(
  output: string,
  maxOutputBytes = DEFAULT_MAX_GIT_OUTPUT_BYTES,
  maxTotalPaths = DEFAULT_MAX_TOTAL_PATHS,
): readonly string[] {
  const values = tokens(output, maxOutputBytes);
  const paths: string[] = [];
  for (let index = 0; index < values.length;) {
    const status = values[index++];
    if (status === undefined || !/^(?:[ACDMRTUXB]|R\d{1,3}|C\d{1,3})$/u.test(status)) {
      throw new Error("GIT_CHANGESET_DIFF_STATUS_INVALID");
    }
    const first = values[index++];
    if (first === undefined) throw new Error("GIT_CHANGESET_DIFF_PATH_INVALID");
    paths.push(first);
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = values[index++];
      if (second === undefined) throw new Error("GIT_CHANGESET_RENAME_INVALID");
      paths.push(second);
    }
  }
  return uniquePaths(paths, maxTotalPaths);
}

function parsePlainPaths(output: string, maxOutputBytes: number, maxTotalPaths: number): readonly string[] {
  return uniquePaths(tokens(output, maxOutputBytes), maxTotalPaths);
}

function parseJsonPaths(value: string, expectedHash?: string): readonly string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw new Error("GIT_CHANGESET_STORED_PATHS_CORRUPT"); }
  if (expectedHash !== undefined && jsonHash(parsed) !== expectedHash) throw new Error("GIT_CHANGESET_STORED_PATHS_CORRUPT");
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string" && safePath(item))) {
    throw new Error("GIT_CHANGESET_STORED_PATHS_CORRUPT");
  }
  return uniquePaths(parsed, DEFAULT_MAX_TOTAL_PATHS);
}

function observation(row: ObservationRow): GitKnowledgeChangeObservation {
  return Object.freeze({
    observationId: row.observation_id,
    sourceRef: row.source_ref,
    projectId: row.project_id,
    repositoryRoot: row.project_root,
    baseRevision: row.base_revision,
    targetHead: row.target_head,
    targetStatusFingerprint: row.target_status_fingerprint,
    observationHash: row.observation_hash,
    pathCount: row.path_count,
    pageCount: row.page_count,
    status: row.status,
    observedAt: row.observed_at,
    ...(row.acknowledgement_effect_key === null ? {} : { acknowledgementEffectKey: row.acknowledgement_effect_key }),
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
  });
}

export class GitKnowledgeChangeSource {
  readonly #database: DatabaseSync;
  readonly #process: GitProcessPort;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #maxTotalPaths: number;
  readonly #pathPageSize: number;
  #closed = false;

  constructor(databasePath: string, options: GitKnowledgeChangeSourceOptions = {}) {
    this.#process = options.process ?? new NodeGitProcess();
    this.#clock = options.clock ?? (() => new Date());
    this.#timeoutMs = bounded(options.timeoutMs, 2_000, 10, 60_000, "timeoutMs");
    this.#maxOutputBytes = bounded(options.maxOutputBytes, DEFAULT_MAX_GIT_OUTPUT_BYTES, 1_024, 64 * 1024 * 1024, "maxOutputBytes");
    this.#maxTotalPaths = bounded(options.maxTotalPaths, DEFAULT_MAX_TOTAL_PATHS, 1, 1_000_000, "maxTotalPaths");
    this.#pathPageSize = bounded(options.pathPageSize, DEFAULT_PATH_PAGE_SIZE, 1, 10_000, "pathPageSize");
    this.#database = new DatabaseSync(databasePath);
    try {
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(databasePath, 0o600);
      this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS git_freshness_baseline(
        project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, head TEXT NOT NULL,
        status_fingerprint TEXT NOT NULL, changed_paths_json TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const columns = this.#database.prepare("PRAGMA table_info(git_freshness_baseline)").all() as unknown as Array<{ readonly name: string }>;
    if (!columns.some((column) => column.name === "revision")) {
      this.#database.exec("ALTER TABLE git_freshness_baseline ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);");
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS git_observed_projects(
        project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, observed_at TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO git_observed_projects(project_id, project_root, observed_at)
        SELECT project_id, project_root, updated_at FROM git_freshness_baseline;
      CREATE TABLE IF NOT EXISTS git_change_observations(
        observation_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, project_id TEXT NOT NULL,
        project_root TEXT NOT NULL, base_revision INTEGER NOT NULL CHECK(base_revision > 0),
        target_head TEXT NOT NULL, target_status_fingerprint TEXT NOT NULL,
        current_paths_json TEXT NOT NULL, current_paths_hash TEXT NOT NULL,
        observation_hash TEXT NOT NULL, path_count INTEGER NOT NULL CHECK(path_count > 0),
        page_count INTEGER NOT NULL CHECK(page_count > 0),
        status TEXT NOT NULL CHECK(status IN ('PENDING','ACKNOWLEDGED')),
        observed_at TEXT NOT NULL, acknowledgement_effect_key TEXT, acknowledged_at TEXT,
        UNIQUE(project_id, observation_hash),
        FOREIGN KEY(project_id) REFERENCES git_observed_projects(project_id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS git_change_observations_pending_idx
        ON git_change_observations(status, observed_at, observation_id);
      CREATE TABLE IF NOT EXISTS git_change_paths(
        observation_id TEXT NOT NULL REFERENCES git_change_observations(observation_id) ON DELETE RESTRICT,
        page_number INTEGER NOT NULL CHECK(page_number >= 0),
        path_index INTEGER NOT NULL CHECK(path_index >= 0), path TEXT NOT NULL,
        PRIMARY KEY(observation_id, path_index), UNIQUE(observation_id, path)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS git_change_paths_page_idx
        ON git_change_paths(observation_id, page_number, path_index);
      CREATE TABLE IF NOT EXISTS knowledge_change_intake_meta(
        component TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0)
      ) STRICT;
      INSERT INTO knowledge_change_intake_meta(component, version) VALUES ('git-source', 1)
        ON CONFLICT(component) DO UPDATE SET version=MAX(version, excluded.version);
    `);
  }

  #assertOpen(): void { if (this.#closed) throw new Error("Git change source is closed"); }
  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#database.exec("COMMIT"); return result; }
    catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  async #git(root: string, args: readonly string[]): Promise<string> {
    let output: string;
    try { output = await this.#process.run(root, args, this.#timeoutMs, this.#maxOutputBytes); }
    catch (cause) {
      if (cause instanceof Error && ["GIT_CHANGESET_OUTPUT_LIMIT_EXCEEDED", "GIT_CHANGESET_BASELINE_OBJECT_MISSING"]
        .includes(cause.message)) throw cause;
      throw Object.assign(new Error("GIT_CHANGESET_COMMAND_FAILED"), { cause });
    }
    if (Buffer.byteLength(output, "utf8") > this.#maxOutputBytes) throw new Error("GIT_CHANGESET_OUTPUT_LIMIT_EXCEEDED");
    return output;
  }

  observe(projectId: string, projectRoot: string): void {
    this.#assertOpen();
    if (!safeId(projectId) || !isAbsolute(projectRoot) || projectRoot.includes("\0")) throw new Error("GIT_CHANGESET_PROJECT_INVALID");
    const root = resolve(projectRoot);
    const existing = this.#database.prepare("SELECT project_root FROM git_observed_projects WHERE project_id = ?")
      .get(projectId) as { readonly project_root: string } | undefined;
    if (existing !== undefined && existing.project_root !== root) throw new Error("GIT_CHANGESET_PROJECT_ROOT_CONFLICT");
    if (existing === undefined) {
      if ((this.#database.prepare("SELECT COUNT(*) AS count FROM git_observed_projects").get() as { count: number }).count >= MAX_PROJECTS) {
        throw new Error("GIT_CHANGESET_PROJECT_LIMIT_EXCEEDED");
      }
      this.#database.prepare("INSERT INTO git_observed_projects VALUES (?, ?, ?)").run(projectId, root, timestamp(this.#clock));
    }
  }

  observedProjects(): readonly { readonly projectId: string; readonly repositoryRoot: string }[] {
    this.#assertOpen();
    const rows = this.#database.prepare("SELECT project_id, project_root FROM git_observed_projects ORDER BY project_id ASC LIMIT 1001")
      .all() as unknown as Array<{ readonly project_id: string; readonly project_root: string }>;
    if (rows.length > MAX_PROJECTS) throw new Error("GIT_CHANGESET_PROJECT_LIMIT_EXCEEDED");
    return Object.freeze(rows.map((row) => Object.freeze({ projectId: row.project_id, repositoryRoot: row.project_root })));
  }

  async #committedPaths(root: string, previousHead: string, head: string): Promise<readonly string[]> {
    try {
      return parseGitNameStatusPaths(
        await this.#git(root, ["diff", "--name-status", "-z", previousHead, head]),
        this.#maxOutputBytes,
        this.#maxTotalPaths,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "GIT_CHANGESET_BASELINE_OBJECT_MISSING") throw error;
      return parsePlainPaths(await this.#git(root, ["ls-files", "-z"]), this.#maxOutputBytes, this.#maxTotalPaths);
    }
  }

  async #scanProject(projectId: string, projectRoot: string): Promise<KnowledgeChangeSet | undefined> {
    const [headOutput, statusOutput] = await Promise.all([
      this.#git(projectRoot, ["rev-parse", "HEAD"]),
      this.#git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const head = headOutput.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("GIT_CHANGESET_HEAD_INVALID");
    const statusFingerprint = digest(statusOutput);
    const currentPaths = parseGitStatusPaths(statusOutput, this.#maxOutputBytes, this.#maxTotalPaths);
    const row = this.#database.prepare("SELECT * FROM git_freshness_baseline WHERE project_id = ?")
      .get(projectId) as unknown as BaselineRow | undefined;
    const observedAt = timestamp(this.#clock);
    if (row === undefined) {
      this.#database.prepare(`INSERT INTO git_freshness_baseline
        (project_id, project_root, head, status_fingerprint, changed_paths_json, updated_at, revision)
        VALUES (?, ?, ?, ?, ?, ?, 1)`)
        .run(projectId, projectRoot, head, statusFingerprint, JSON.stringify(currentPaths), observedAt);
      return undefined;
    }
    if (row.project_root !== projectRoot) throw new Error("GIT_CHANGESET_PROJECT_ROOT_CONFLICT");
    if (row.head === head && row.status_fingerprint === statusFingerprint) return undefined;
    const previousPaths = parseJsonPaths(row.changed_paths_json);
    const committed = row.head === head ? [] : await this.#committedPaths(projectRoot, row.head, head);
    const changedPaths = uniquePaths([...previousPaths, ...currentPaths, ...committed], this.#maxTotalPaths);
    if (changedPaths.length === 0) {
      const update = this.#database.prepare(`UPDATE git_freshness_baseline SET head=?, status_fingerprint=?, changed_paths_json=?,
        revision=revision+1, updated_at=? WHERE project_id=? AND revision=?`)
        .run(head, statusFingerprint, JSON.stringify(currentPaths), observedAt, projectId, row.revision);
      if (update.changes !== 1) throw new Error("GIT_CHANGESET_BASELINE_CAS_CONFLICT");
      return undefined;
    }
    // Keep this identity aligned with GitProjectRevisionPort so verification
    // and change intake bind evidence to exactly the same code revision.
    const sourceRef = `git:${head}:${statusFingerprint}`;
    const identity = ["git-observation-v1", projectId, projectRoot, row.revision, head, statusFingerprint, currentPaths, changedPaths];
    const observationHash = jsonHash(identity);
    const observationId = `gitobs_${observationHash.slice(0, 48)}`;
    const existing = this.#database.prepare("SELECT * FROM git_change_observations WHERE project_id=? AND observation_hash=?")
      .get(projectId, observationHash) as unknown as ObservationRow | undefined;
    if (existing !== undefined) {
      return this.changeSet(existing.source_ref, projectId, existing.observation_hash);
    }
    const currentJson = JSON.stringify(currentPaths);
    const pageCount = Math.ceil(changedPaths.length / this.#pathPageSize);
    this.#transaction(() => {
      this.#database.prepare(`INSERT INTO git_change_observations
        (observation_id, source_ref, project_id, project_root, base_revision, target_head,
         target_status_fingerprint, current_paths_json, current_paths_hash, observation_hash,
         path_count, page_count, status, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
        .run(observationId, sourceRef, projectId, projectRoot, row.revision, head, statusFingerprint,
          currentJson, jsonHash(currentPaths), observationHash, changedPaths.length, pageCount, observedAt);
      const insert = this.#database.prepare("INSERT INTO git_change_paths VALUES (?, ?, ?, ?)");
      changedPaths.forEach((path, index) => insert.run(observationId, Math.floor(index / this.#pathPageSize), index, path));
    });
    return Object.freeze({
      projectId, changedPaths, changedSymbols: Object.freeze([]),
      changedConfigs: Object.freeze(changedPaths.filter((path) => CONFIG_PATH.test(path))),
      changedDependencies: Object.freeze(changedPaths.filter((path) => DEPENDENCY_PATH.test(path))),
      sourceRef, observedAt,
    });
  }

  async scan(): Promise<readonly KnowledgeChangeSet[]> {
    this.#assertOpen();
    const changes: KnowledgeChangeSet[] = [];
    for (const project of this.observedProjects()) {
      const result = await this.#scanProject(project.projectId, project.repositoryRoot);
      if (result !== undefined) changes.push(result);
    }
    return Object.freeze(changes);
  }

  async scanProject(projectId: string): Promise<KnowledgeChangeSet | undefined> {
    this.#assertOpen();
    if (!safeId(projectId)) throw new Error("GIT_CHANGESET_PROJECT_INVALID");
    const row = this.#database.prepare("SELECT project_root FROM git_observed_projects WHERE project_id=?")
      .get(projectId) as { readonly project_root: string } | undefined;
    if (row === undefined) throw new Error("GIT_CHANGESET_PROJECT_NOT_OBSERVED");
    return await this.#scanProject(projectId, row.project_root);
  }

  getObservation(sourceRef: string, projectId?: string, observationHash?: string): GitKnowledgeChangeObservation | undefined {
    this.#assertOpen();
    if (sourceRef.length < 1 || sourceRef.length > 1_000 || /[\0\r\n]/u.test(sourceRef)) throw new Error("GIT_CHANGESET_SOURCE_REF_INVALID");
    if (projectId !== undefined && !safeId(projectId)) throw new Error("GIT_CHANGESET_PROJECT_INVALID");
    if (observationHash !== undefined && !/^[a-f0-9]{64}$/u.test(observationHash)) throw new Error("GIT_CHANGESET_OBSERVATION_HASH_INVALID");
    const rawRows = observationHash !== undefined && projectId !== undefined
      ? this.#database.prepare("SELECT * FROM git_change_observations WHERE source_ref=? AND project_id=? AND observation_hash=? LIMIT 1")
        .all(sourceRef, projectId, observationHash)
      : projectId === undefined
        ? this.#database.prepare("SELECT * FROM git_change_observations WHERE source_ref=? ORDER BY project_id, observation_id LIMIT 2").all(sourceRef)
        : this.#database.prepare("SELECT * FROM git_change_observations WHERE source_ref=? AND project_id=? ORDER BY observation_id LIMIT 2").all(sourceRef, projectId);
    const rows = rawRows as unknown as ObservationRow[];
    if (rows.length > 1) throw new Error("GIT_CHANGESET_SOURCE_REF_AMBIGUOUS");
    const row = rows[0];
    return row === undefined ? undefined : observation(row);
  }

  listPending(limit = 100, projectId?: string, afterObservationId?: string): readonly GitKnowledgeChangeObservation[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("GIT_CHANGESET_PENDING_LIMIT_INVALID");
    if (projectId !== undefined && !safeId(projectId)) throw new Error("GIT_CHANGESET_PROJECT_INVALID");
    if (afterObservationId !== undefined && !safeId(afterObservationId)) throw new Error("GIT_CHANGESET_OBSERVATION_CURSOR_INVALID");
    const cursor = afterObservationId ?? "";
    const rawRows = projectId === undefined
      ? this.#database.prepare("SELECT * FROM git_change_observations WHERE status='PENDING' AND observation_id>? ORDER BY observation_id LIMIT ?").all(cursor, limit)
      : this.#database.prepare("SELECT * FROM git_change_observations WHERE status='PENDING' AND project_id=? AND observation_id>? ORDER BY observation_id LIMIT ?").all(projectId, cursor, limit);
    const rows = rawRows as unknown as ObservationRow[];
    return Object.freeze(rows.map(observation));
  }

  readPathPage(sourceRef: string, page: number, projectId?: string, observationHash?: string): GitPathPage {
    this.#assertOpen();
    const resolved = this.getObservation(sourceRef, projectId, observationHash);
    const found = resolved === undefined ? undefined : this.#database.prepare("SELECT * FROM git_change_observations WHERE observation_id=?")
      .get(resolved.observationId) as unknown as ObservationRow | undefined;
    if (found === undefined) throw new Error("GIT_CHANGESET_OBSERVATION_NOT_FOUND");
    if (!Number.isSafeInteger(page) || page < 0 || page >= found.page_count) throw new Error("GIT_CHANGESET_PAGE_INVALID");
    const rows = this.#database.prepare("SELECT path FROM git_change_paths WHERE observation_id=? AND page_number=? ORDER BY path_index")
      .all(found.observation_id, page) as unknown as Array<{ readonly path: string }>;
    if (rows.length < 1 || rows.length > this.#pathPageSize || rows.some((row) => !safePath(row.path))) {
      throw new Error("GIT_CHANGESET_PATH_PAGE_CORRUPT");
    }
    return Object.freeze({ observationId: found.observation_id, page, paths: Object.freeze(rows.map((row) => row.path)),
      ...(page + 1 >= found.page_count ? {} : { nextPage: page + 1 }) });
  }

  changeSet(sourceRef: string, projectId?: string, observationHash?: string): KnowledgeChangeSet {
    this.#assertOpen();
    const found = this.getObservation(sourceRef, projectId, observationHash);
    if (found === undefined) throw new Error("GIT_CHANGESET_OBSERVATION_NOT_FOUND");
    const rows = this.#database.prepare("SELECT path FROM git_change_paths WHERE observation_id=? ORDER BY path_index")
      .all(found.observationId) as unknown as Array<{ readonly path: string }>;
    const changedPaths = uniquePaths(rows.map((row) => row.path), this.#maxTotalPaths);
    if (changedPaths.length !== found.pathCount) throw new Error("GIT_CHANGESET_PATH_COUNT_CORRUPT");
    return Object.freeze({
      projectId: found.projectId, changedPaths, changedSymbols: Object.freeze([]),
      changedConfigs: Object.freeze(changedPaths.filter((path) => CONFIG_PATH.test(path))),
      changedDependencies: Object.freeze(changedPaths.filter((path) => DEPENDENCY_PATH.test(path))),
      sourceRef: found.sourceRef, observedAt: found.observedAt,
    });
  }

  acknowledgeSource(projectId: string, sourceRef: string, effectKey: string, observationHash?: string): GitBaselineAcknowledgement {
    this.#assertOpen();
    if (!safeId(projectId) || !/^[a-f0-9]{64}$/u.test(effectKey)) throw new Error("GIT_CHANGESET_ACK_INPUT_INVALID");
    return this.#transaction(() => {
      if (observationHash !== undefined && !/^[a-f0-9]{64}$/u.test(observationHash)) throw new Error("GIT_CHANGESET_ACK_INPUT_INVALID");
      const rows = (observationHash === undefined
        ? this.#database.prepare("SELECT * FROM git_change_observations WHERE project_id=? AND source_ref=? ORDER BY observation_id LIMIT 2").all(projectId, sourceRef)
        : this.#database.prepare("SELECT * FROM git_change_observations WHERE project_id=? AND source_ref=? AND observation_hash=? LIMIT 1")
          .all(projectId, sourceRef, observationHash)) as unknown as ObservationRow[];
      if (rows.length > 1) throw new Error("GIT_CHANGESET_SOURCE_REF_AMBIGUOUS");
      const found = rows[0];
      if (found === undefined) throw new Error("GIT_CHANGESET_ACK_CONFLICT");
      const baseline = this.#database.prepare("SELECT * FROM git_freshness_baseline WHERE project_id=?")
        .get(projectId) as unknown as BaselineRow | undefined;
      if (baseline === undefined) throw new Error("GIT_CHANGESET_BASELINE_MISSING");
      if (found.status === "ACKNOWLEDGED") {
        if (found.acknowledgement_effect_key !== effectKey) throw new Error("GIT_CHANGESET_ACK_CONFLICT");
        return Object.freeze({ status: "IDEMPOTENT" as const, revision: found.base_revision + 1 });
      }
      if (baseline.revision !== found.base_revision || baseline.project_root !== found.project_root) {
        throw new Error("GIT_CHANGESET_BASELINE_CAS_CONFLICT");
      }
      const currentPaths = parseJsonPaths(found.current_paths_json, found.current_paths_hash);
      const at = timestamp(this.#clock);
      const update = this.#database.prepare(`UPDATE git_freshness_baseline SET head=?, status_fingerprint=?, changed_paths_json=?,
        revision=revision+1, updated_at=? WHERE project_id=? AND revision=?`)
        .run(found.target_head, found.target_status_fingerprint, JSON.stringify(currentPaths), at, projectId, found.base_revision);
      if (update.changes !== 1) throw new Error("GIT_CHANGESET_BASELINE_CAS_CONFLICT");
      const acknowledged = this.#database.prepare(`UPDATE git_change_observations SET status='ACKNOWLEDGED', acknowledgement_effect_key=?,
        acknowledged_at=? WHERE observation_id=? AND status='PENDING'`).run(effectKey, at, found.observation_id);
      if (acknowledged.changes !== 1) throw new Error("GIT_CHANGESET_ACK_CONFLICT");
      return Object.freeze({ status: "ACKNOWLEDGED" as const, revision: found.base_revision + 1 });
    });
  }

  acknowledge(changes: KnowledgeChangeSet, effectKey = digest(`legacy-ack\0${changes.projectId}\0${changes.sourceRef}`)): void {
    let stored: KnowledgeChangeSet;
    try { stored = this.changeSet(changes.sourceRef, changes.projectId); }
    catch { throw new Error("GIT_CHANGESET_ACK_CONFLICT"); }
    if (stored.projectId !== changes.projectId || jsonHash(stored) !== jsonHash(changes)) throw new Error("GIT_CHANGESET_ACK_CONFLICT");
    this.acknowledgeSource(changes.projectId, changes.sourceRef, effectKey);
  }

  baseline(projectId: string): { readonly projectId: string; readonly repositoryRoot: string; readonly revision: number; readonly head: string; readonly statusFingerprint: string } | undefined {
    this.#assertOpen();
    if (!safeId(projectId)) throw new Error("GIT_CHANGESET_PROJECT_INVALID");
    const row = this.#database.prepare("SELECT * FROM git_freshness_baseline WHERE project_id=?").get(projectId) as unknown as BaselineRow | undefined;
    return row === undefined ? undefined : Object.freeze({ projectId: row.project_id, repositoryRoot: row.project_root,
      revision: row.revision, head: row.head, statusFingerprint: row.status_fingerprint });
  }

  close(): void { if (this.#closed) return; this.#database.close(); this.#closed = true; }
}
