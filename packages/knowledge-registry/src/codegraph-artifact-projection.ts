import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  calculateCodeGraphArtifactHash,
  deriveCodeGraphArtifactId,
  evaluateCodeGraphArtifactReuse,
  type CodeGraphArtifact,
  type CodeGraphArtifactReuseContext,
  type CodeGraphArtifactReuseDecision,
} from "@zhiloop/domain";

import type { CodeGraphArtifactWriteResult, ProjectedCodeGraphArtifact } from "./types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function safe(value: string, maximum = 1_000): boolean {
  return value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function assertArtifact(artifact: CodeGraphArtifact): void {
  const withoutHash = Object.fromEntries(Object.entries(artifact)
    .filter(([key]) => key !== "contentHash" && key !== "status")) as Omit<CodeGraphArtifact, "contentHash" | "status">;
  const expectedId = deriveCodeGraphArtifactId({ projectId: artifact.projectId, codeRevision: artifact.codeRevision,
    ...(artifact.graphRevision === undefined ? {} : { graphRevision: artifact.graphRevision }),
    ...(artifact.dependencyFingerprint === undefined ? {} : { dependencyFingerprint: artifact.dependencyFingerprint }),
    operation: artifact.operation, query: artifact.query });
  const factsValid = artifact.facts.every((fact) => fact.kind === "CALL_PATH"
    ? safe(fact.from) && safe(fact.to) && fact.symbols.length <= 100 && fact.paths.length <= 100
      && fact.symbols.every((item) => safe(item)) && fact.paths.every((item) => safe(item))
    : safe(fact.symbol) && safe(fact.path) && Number.isSafeInteger(fact.startLine) && fact.startLine >= 1
      && (fact.endLine === undefined || (Number.isSafeInteger(fact.endLine) && fact.endLine >= fact.startLine)));
  if (artifact.schemaVersion !== 1 || !safe(artifact.artifactId, 500) || !safe(artifact.projectId, 500)
    || !safe(artifact.codeRevision, 500) || !safe(artifact.query, 2_000) || artifact.facts.length > 50
    || artifact.artifactId !== expectedId || !factsValid || typeof artifact.bounded !== "boolean"
    || !safe(artifact.sourceRef, 4_000) || artifact.reasonCodes.length > 100
    || !artifact.reasonCodes.every((item) => /^[A-Z][A-Z0-9_]{0,99}$/u.test(item))
    || (artifact.graphRevision !== undefined && !safe(artifact.graphRevision, 500))
    || (artifact.dependencyFingerprint !== undefined && !safe(artifact.dependencyFingerprint, 500))
    || !Number.isFinite(Date.parse(artifact.observedAt)) || artifact.contentHash !== calculateCodeGraphArtifactHash(withoutHash)
    || (artifact.status !== "ACTIVE" && artifact.status !== "SUSPECT")) {
    throw new Error("CODEGRAPH_ARTIFACT_INVALID");
  }
}

export class SqliteCodeGraphArtifactProjection {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    const resolved = filename === ":memory:" ? filename : path.resolve(filename);
    if (filename !== ":memory:") mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(resolved, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode=WAL;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS codegraph_artifacts (
          artifact_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          code_revision TEXT NOT NULL,
          graph_revision TEXT,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS codegraph_artifact_compatibility_idx
          ON codegraph_artifacts(project_id, code_revision, graph_revision, status);
        CREATE TABLE IF NOT EXISTS codegraph_artifact_bindings (
          artifact_id TEXT NOT NULL,
          knowledge_version TEXT NOT NULL,
          PRIMARY KEY(artifact_id, knowledge_version),
          FOREIGN KEY(artifact_id) REFERENCES codegraph_artifacts(artifact_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS codegraph_artifact_binding_knowledge_idx
          ON codegraph_artifact_bindings(knowledge_version);
      `);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("CodeGraph artifact projection is closed");
  }

  project(artifact: CodeGraphArtifact, knowledgeVersions: readonly string[] = []): CodeGraphArtifactWriteResult {
    this.#assertOpen();
    assertArtifact(artifact);
    if (knowledgeVersions.length > 10_000 || new Set(knowledgeVersions).size !== knowledgeVersions.length
      || knowledgeVersions.some((item) => !safe(item))) throw new Error("CODEGRAPH_ARTIFACT_BINDING_INVALID");
    const payload = canonical(artifact);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(
        "SELECT content_hash, payload_json FROM codegraph_artifacts WHERE artifact_id=?",
      ).get(artifact.artifactId) as { content_hash: string; payload_json: string } | undefined;
      if (existing !== undefined) {
        const stored = JSON.parse(existing.payload_json) as CodeGraphArtifact;
        assertArtifact(stored);
        if (existing.content_hash !== artifact.contentHash || stored.contentHash !== artifact.contentHash) {
          throw new Error("CODEGRAPH_ARTIFACT_ID_COLLISION");
        }
      }
      if (existing === undefined) {
        this.#database.prepare(`
          INSERT INTO codegraph_artifacts(artifact_id, project_id, code_revision, graph_revision, operation, status,
            payload_json, content_hash, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(artifact.artifactId, artifact.projectId, artifact.codeRevision, artifact.graphRevision ?? null,
          artifact.operation, artifact.status, payload, artifact.contentHash, artifact.observedAt);
      }
      const bind = this.#database.prepare(
        "INSERT OR IGNORE INTO codegraph_artifact_bindings(artifact_id, knowledge_version) VALUES (?, ?)",
      );
      for (const knowledge of [...knowledgeVersions].sort()) bind.run(artifact.artifactId, knowledge);
      this.#database.exec("COMMIT");
      return Object.freeze({ status: existing === undefined ? "PROJECTED" : "IDEMPOTENT", artifactId: artifact.artifactId });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  get(artifactId: string): ProjectedCodeGraphArtifact | undefined {
    this.#assertOpen();
    if (!safe(artifactId, 500)) return undefined;
    const row = this.#database.prepare("SELECT payload_json FROM codegraph_artifacts WHERE artifact_id=?")
      .get(artifactId) as { payload_json: string } | undefined;
    if (row === undefined) return undefined;
    const artifact = JSON.parse(row.payload_json) as CodeGraphArtifact;
    assertArtifact(artifact);
    const bindings = this.#database.prepare(
      "SELECT knowledge_version FROM codegraph_artifact_bindings WHERE artifact_id=? ORDER BY knowledge_version",
    ).all(artifactId) as Array<{ knowledge_version: string }>;
    return Object.freeze({ artifact: Object.freeze(artifact),
      knowledgeVersions: Object.freeze(bindings.map((item) => item.knowledge_version)) });
  }

  forKnowledge(knowledgeVersion: string): readonly ProjectedCodeGraphArtifact[] {
    this.#assertOpen();
    if (!safe(knowledgeVersion)) return [];
    const rows = this.#database.prepare(`
      SELECT artifact_id FROM codegraph_artifact_bindings WHERE knowledge_version=? ORDER BY artifact_id LIMIT 1000
    `).all(knowledgeVersion) as Array<{ artifact_id: string }>;
    return Object.freeze(rows.flatMap((row) => {
      const item = this.get(row.artifact_id);
      return item === undefined ? [] : [item];
    }));
  }

  reuse(artifactId: string, context: CodeGraphArtifactReuseContext): CodeGraphArtifactReuseDecision {
    this.#assertOpen();
    const projected = this.get(artifactId);
    if (projected === undefined) return Object.freeze({ reusable: false, markSuspect: false,
      reasonCodes: Object.freeze(["ARTIFACT_NOT_FOUND"]) });
    const decision = evaluateCodeGraphArtifactReuse(projected.artifact, context);
    if (decision.markSuspect && projected.artifact.status !== "SUSPECT") {
      const suspect = { ...projected.artifact, status: "SUSPECT" as const };
      this.#database.prepare("UPDATE codegraph_artifacts SET status=?, payload_json=? WHERE artifact_id=?")
        .run("SUSPECT", canonical(suspect), artifactId);
    }
    return decision;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
