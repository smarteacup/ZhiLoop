import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import type {
  KnowledgeVerificationRunSummary,
  KnowledgeVerificationStore,
  StoredVerificationRecipe,
  SupportingProofRef,
  VerificationRecipe,
} from "./types.js";

const SCHEMA_VERSION = 1;
const MAX_RECIPE_BYTES = 1_048_576;
const MAX_RUN_BYTES = 262_144;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;
const SUBJECT_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,99}$/u;

interface RecipeRow {
  readonly asset_id: string;
  readonly asset_version: number;
  readonly recipe_version: string;
  readonly assertions_json: string;
  readonly assertions_hash: string;
  readonly created_at: string;
}

interface RunRow {
  readonly run_id: string;
  readonly request_id: string;
  readonly purpose: string;
  readonly project_id: string;
  readonly subject_key: string;
  readonly candidate_id: string;
  readonly asset_id: string | null;
  readonly asset_version: number | null;
  readonly code_revision: string;
  readonly graph_revision: string | null;
  readonly status: string;
  readonly qualifying_proof: number;
  readonly result_summary_json: string;
  readonly result_hash: string;
  readonly started_at: string;
  readonly completed_at: string;
}

export class KnowledgeVerificationConflictError extends Error {
  override readonly name = "KnowledgeVerificationConflictError";
}

export class KnowledgeVerificationCorruptionError extends Error {
  override readonly name = "KnowledgeVerificationCorruptionError";
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function hash(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

function bounded(value: unknown, maximum: number): string {
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized, "utf8") > maximum) throw new Error("KNOWLEDGE_VERIFICATION_RECORD_TOO_LARGE");
  return serialized;
}

function timestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function identity(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${field} is invalid`);
}

function validateRecipe(recipe: VerificationRecipe): void {
  identity(recipe.assetId, "assetId");
  identity(recipe.recipeVersion, "recipeVersion");
  if (!Number.isSafeInteger(recipe.assetVersion) || recipe.assetVersion < 1 || !timestamp(recipe.createdAt)
    || recipe.assertions.length === 0 || recipe.assertions.length > 100
    || new Set(recipe.assertions.map((item) => item.assertionId)).size !== recipe.assertions.length
    || recipe.assertions.some((item) => item.assertionId.trim().length === 0 || item.candidateId.trim().length === 0)) {
    throw new Error("verification recipe is invalid");
  }
}

function validateRun(summary: KnowledgeVerificationRunSummary): void {
  for (const [field, value] of [["runId", summary.runId], ["requestId", summary.requestId], ["projectId", summary.projectId],
    ["candidateId", summary.candidateId]] as const) identity(value, field);
  if (summary.knowledgeVersion !== undefined) {
    identity(summary.knowledgeVersion.assetId, "assetId");
    if (!Number.isSafeInteger(summary.knowledgeVersion.assetVersion) || summary.knowledgeVersion.assetVersion < 1) {
      throw new Error("verification run assetVersion is invalid");
    }
  }
  const proofResults = summary.results.filter((item) => item.assertionKind !== "CROSS_PROJECT_VERIFIED");
  if (summary.schemaVersion !== 1 || !SUBJECT_KEY.test(summary.subjectKey) || summary.status !== "COMPLETED"
    || !["CANDIDATE", "FRESHNESS", "PRE_INJECTION"].includes(summary.purpose)
    || !["READY", "DEGRADED"].includes(summary.codeRevisionCapability)
    || summary.codeRevision.trim().length === 0 || summary.codeRevision.length > 1_000
    || (summary.graphRevision !== undefined && (summary.graphRevision.trim().length === 0 || summary.graphRevision.length > 1_000))
    || !timestamp(summary.startedAt) || !timestamp(summary.completedAt)
    || Date.parse(summary.completedAt) < Date.parse(summary.startedAt)
    || summary.results.length > 100
    || new Set(summary.results.map((item) => item.assertionId)).size !== summary.results.length
    || summary.results.some((item) => !SAFE_ID.test(item.assertionId)
      || !["SUPPORTED", "REFUTED", "UNKNOWN", "ERROR"].includes(item.status)
      || item.reasonCodes.length === 0 || item.reasonCodes.length > 16 || item.reasonCodes.some((reason) => !REASON.test(reason)))
    || (summary.qualifyingProof && (summary.knowledgeVersion === undefined || proofResults.length === 0
      || proofResults.some((item) => item.status !== "SUPPORTED")))) {
    throw new Error("verification run summary is invalid");
  }
}

export class SqliteKnowledgeVerificationStore implements KnowledgeVerificationStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    if (filename.trim().length === 0) throw new Error("verification database path is invalid");
    const memory = filename === ":memory:";
    const resolved = memory ? filename : path.resolve(filename);
    if (!memory) mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    try {
      if (!memory && process.platform !== "win32") chmodSync(resolved, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const checked = this.#database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      if (checked?.["quick_check"] !== "ok") throw new KnowledgeVerificationCorruptionError("verification database integrity check failed");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS verification_schema(version INTEGER PRIMARY KEY NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS verification_recipes(
          asset_id TEXT NOT NULL, asset_version INTEGER NOT NULL, recipe_version TEXT NOT NULL,
          assertions_json TEXT NOT NULL, assertions_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(asset_id,asset_version,recipe_version)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS code_verification_runs(
          run_id TEXT PRIMARY KEY NOT NULL, request_id TEXT UNIQUE NOT NULL, purpose TEXT NOT NULL,
          project_id TEXT NOT NULL, subject_key TEXT NOT NULL, candidate_id TEXT NOT NULL,
          asset_id TEXT, asset_version INTEGER, code_revision TEXT NOT NULL, graph_revision TEXT,
          status TEXT NOT NULL, qualifying_proof INTEGER NOT NULL,
          result_summary_json TEXT NOT NULL, result_hash TEXT NOT NULL,
          started_at TEXT NOT NULL, completed_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS verification_subject_idx
          ON code_verification_runs(subject_key,qualifying_proof,completed_at DESC,run_id);
      `);
      const version = this.#database.prepare("SELECT version FROM verification_schema").get() as { version: number } | undefined;
      if (version === undefined) this.#database.prepare("INSERT INTO verification_schema(version) VALUES(?)").run(SCHEMA_VERSION);
      else if (version.version !== SCHEMA_VERSION) throw new KnowledgeVerificationCorruptionError("verification database schema is unsupported");
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  saveRecipe(recipe: VerificationRecipe): StoredVerificationRecipe {
    validateRecipe(recipe);
    const assertionsJson = bounded(recipe.assertions, MAX_RECIPE_BYTES);
    const assertionsHash = hash(assertionsJson);
    const stored = Object.freeze({ ...structuredClone(recipe), assertionsHash });
    try {
      this.#database.prepare(`INSERT INTO verification_recipes
        (asset_id,asset_version,recipe_version,assertions_json,assertions_hash,created_at) VALUES(?,?,?,?,?,?)`)
        .run(recipe.assetId, recipe.assetVersion, recipe.recipeVersion, assertionsJson, assertionsHash, recipe.createdAt);
      return stored;
    } catch (error) {
      const existing = this.getRecipe(recipe.assetId, recipe.assetVersion, recipe.recipeVersion);
      if (existing !== undefined && existing.assertionsHash === assertionsHash && canonical(existing.assertions) === assertionsJson) return existing;
      if (existing === undefined) throw error;
      throw new KnowledgeVerificationConflictError("verification recipe identity already exists", { cause: error });
    }
  }

  getRecipe(assetId: string, assetVersion: number, recipeVersion: string): StoredVerificationRecipe | undefined {
    identity(assetId, "assetId"); identity(recipeVersion, "recipeVersion");
    if (!Number.isSafeInteger(assetVersion) || assetVersion < 1) throw new Error("assetVersion is invalid");
    const row = this.#database.prepare(`SELECT asset_id,asset_version,recipe_version,assertions_json,assertions_hash,created_at
      FROM verification_recipes WHERE asset_id=? AND asset_version=? AND recipe_version=?`)
      .get(assetId, assetVersion, recipeVersion) as RecipeRow | undefined;
    if (row === undefined) return undefined;
    try {
      if (Buffer.byteLength(row.assertions_json, "utf8") > MAX_RECIPE_BYTES || hash(row.assertions_json) !== row.assertions_hash) throw new Error();
      const recipe: VerificationRecipe = { assetId: row.asset_id, assetVersion: row.asset_version, recipeVersion: row.recipe_version,
        assertions: JSON.parse(row.assertions_json), createdAt: row.created_at };
      validateRecipe(recipe);
      return Object.freeze({ ...structuredClone(recipe), assertionsHash: row.assertions_hash });
    } catch { throw new KnowledgeVerificationCorruptionError("persisted verification recipe is corrupt"); }
  }

  appendRun(summary: KnowledgeVerificationRunSummary): KnowledgeVerificationRunSummary {
    validateRun(summary);
    const serialized = bounded(summary, MAX_RUN_BYTES);
    const resultHash = hash(serialized);
    try {
      this.#database.prepare(`INSERT INTO code_verification_runs
        (run_id,request_id,purpose,project_id,subject_key,candidate_id,asset_id,asset_version,code_revision,graph_revision,
         status,qualifying_proof,result_summary_json,result_hash,started_at,completed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        summary.runId, summary.requestId, summary.purpose, summary.projectId, summary.subjectKey, summary.candidateId,
        summary.knowledgeVersion?.assetId ?? null, summary.knowledgeVersion?.assetVersion ?? null,
        summary.codeRevision, summary.graphRevision ?? null, summary.status, summary.qualifyingProof ? 1 : 0,
        serialized, resultHash, summary.startedAt, summary.completedAt,
      );
      return structuredClone(summary);
    } catch (error) {
      const existing = this.getRun(summary.runId) ?? this.#getRunByRequestId(summary.requestId);
      if (existing !== undefined && canonical(existing) === serialized) return existing;
      if (existing === undefined) throw error;
      throw new KnowledgeVerificationConflictError("verification run or request identity already exists", { cause: error });
    }
  }

  getRun(runId: string): KnowledgeVerificationRunSummary | undefined {
    identity(runId, "runId");
    const row = this.#database.prepare(`SELECT run_id,request_id,purpose,project_id,subject_key,candidate_id,asset_id,asset_version,
      code_revision,graph_revision,status,qualifying_proof,result_summary_json,result_hash,started_at,completed_at
      FROM code_verification_runs WHERE run_id=?`).get(runId) as RunRow | undefined;
    return row === undefined ? undefined : this.#decodeRun(row);
  }

  #getRunByRequestId(requestId: string): KnowledgeVerificationRunSummary | undefined {
    identity(requestId, "requestId");
    const row = this.#database.prepare(`SELECT run_id,request_id,purpose,project_id,subject_key,candidate_id,asset_id,asset_version,
      code_revision,graph_revision,status,qualifying_proof,result_summary_json,result_hash,started_at,completed_at
      FROM code_verification_runs WHERE request_id=?`).get(requestId) as RunRow | undefined;
    return row === undefined ? undefined : this.#decodeRun(row);
  }

  #decodeRun(row: RunRow): KnowledgeVerificationRunSummary {
    try {
      if (Buffer.byteLength(row.result_summary_json, "utf8") > MAX_RUN_BYTES || hash(row.result_summary_json) !== row.result_hash) throw new Error();
      const summary = JSON.parse(row.result_summary_json) as KnowledgeVerificationRunSummary;
      validateRun(summary);
      if (summary.runId !== row.run_id || summary.requestId !== row.request_id || summary.purpose !== row.purpose
        || summary.projectId !== row.project_id || summary.subjectKey !== row.subject_key || summary.candidateId !== row.candidate_id
        || (summary.knowledgeVersion?.assetId ?? null) !== row.asset_id || (summary.knowledgeVersion?.assetVersion ?? null) !== row.asset_version
        || summary.codeRevision !== row.code_revision || (summary.graphRevision ?? null) !== row.graph_revision
        || summary.status !== row.status || Number(summary.qualifyingProof) !== row.qualifying_proof
        || summary.startedAt !== row.started_at || summary.completedAt !== row.completed_at) throw new Error();
      return structuredClone(summary);
    } catch { throw new KnowledgeVerificationCorruptionError("persisted verification run is corrupt"); }
  }

  listSupportingProofs(subjectKey: string, limit: number): readonly SupportingProofRef[] {
    if (!SUBJECT_KEY.test(subjectKey) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("supporting proof query is invalid");
    }
    const rows = this.#database.prepare(`SELECT run_id,request_id,purpose,project_id,subject_key,candidate_id,asset_id,asset_version,
      code_revision,graph_revision,status,qualifying_proof,result_summary_json,result_hash,started_at,completed_at
      FROM code_verification_runs WHERE subject_key=? AND qualifying_proof=1
      ORDER BY completed_at DESC,run_id LIMIT ?`).all(subjectKey, limit) as unknown as RunRow[];
    return Object.freeze(rows.map((row) => {
      const summary = this.#decodeRun(row);
      if (summary.knowledgeVersion === undefined) throw new KnowledgeVerificationCorruptionError("qualifying proof has no Knowledge version");
      return Object.freeze({ runId: summary.runId, canonicalProjectId: summary.projectId,
        knowledgeVersion: summary.knowledgeVersion, completedAt: summary.completedAt });
    }));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void { this.close(); }
}
