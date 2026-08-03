import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  CANDIDATE_POLICY_DECISIONS,
  CONTROL_API_SCHEMA_VERSION,
  bidirectionalProvenanceSchema,
  candidatePreviewSchema,
  extractionSnapshotSchema,
  knowledgeVersionRefSchema,
  provenanceEdgeSchema,
  provenanceNodeSchema,
  snapshotReferenceSchema,
  type CandidatePreview,
  type ExtractionSnapshot,
  type ProvenanceEdge,
  type ProvenanceNode,
} from "@zhiloop/control-api";
import { parseStoredJobJson, serializeJobJson } from "@zhiloop/job-runtime";

import {
  ExtractionConflictError,
  ExtractionNotFoundError,
  type CandidatePreviewCompletion,
  type CandidatePreviewResult,
  type EpisodeReference,
  type KnowledgePublicationReference,
  type PolicyCommit,
  type PolicyCommitCompletion,
  type PolicyCommitResult,
  type ProvenancePage,
  type ProvenanceQuery,
  type SnapshotCreateResult,
  type SnapshotListRequest,
  type SnapshotPage,
  type SnapshotSourceReference,
} from "./types.js";

const CURRENT_MIGRATION_VERSION = 1;
const MAX_SOURCE_REFERENCES = 10_000;
const MAX_EPISODES = 1_000;

interface JsonRow {
  readonly payload_json: string;
  readonly payload_hash: string;
}

interface SnapshotRow extends JsonRow {
  readonly snapshot_id: string;
  readonly session_id: string;
  readonly identity_hash: string;
  readonly source_refs_hash: string;
  readonly compiler_version: string;
  readonly policy_hash: string;
  readonly created_at: string;
  readonly created_at_ms: number;
}

interface PreviewRow extends JsonRow {
  readonly preview_id: string;
  readonly snapshot_id: string;
  readonly effect_key: string;
}

interface CommitRow extends JsonRow {
  readonly commit_id: string;
  readonly preview_id: string;
  readonly effect_key: string;
}

interface EdgeRow extends JsonRow {
  readonly edge_id: string;
  readonly snapshot_id: string;
  readonly from_key: string;
  readonly to_key: string;
}

function assertTimestamp(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return milliseconds;
}

function assertLimit(value: number, maximum: number, field = "limit"): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be between 1 and ${maximum}`);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeEncoding(node: ProvenanceNode): { readonly json: string; readonly key: string } {
  const parsed = provenanceNodeSchema.parse(node);
  const serialized = serializeJobJson(parsed);
  return { json: serialized.json, key: serialized.hash };
}

function edgeId(snapshotId: string, relationType: ProvenanceEdge["relationType"], from: ProvenanceNode, to: ProvenanceNode): string {
  const fromKey = nodeEncoding(from).key;
  const toKey = nodeEncoding(to).key;
  return `edge_${hash(`${snapshotId}\0${relationType}\0${fromKey}\0${toKey}`).slice(0, 48)}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function parseSnapshot(row: JsonRow): ExtractionSnapshot {
  return deepFreeze(extractionSnapshotSchema.parse(parseStoredJobJson(row.payload_json, row.payload_hash)));
}

function parsePreview(row: JsonRow): CandidatePreview {
  return deepFreeze(candidatePreviewSchema.parse(parseStoredJobJson(row.payload_json, row.payload_hash)));
}

function parsePolicyCommit(row: JsonRow): PolicyCommit {
  const value = parseStoredJobJson(row.payload_json, row.payload_hash);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("stored policy commit is invalid");
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "commitId", "compilerVersion", "createdAt", "decisions", "policyHash", "previewId", "previewRevision", "revision", "snapshot",
  ];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.sort().join("\0")) throw new Error("stored policy commit fields are invalid");
  if (typeof record["commitId"] !== "string" || typeof record["previewId"] !== "string"
    || typeof record["compilerVersion"] !== "string" || typeof record["policyHash"] !== "string"
    || typeof record["createdAt"] !== "string" || record["revision"] !== 1
    || !Number.isSafeInteger(record["previewRevision"]) || (record["previewRevision"] as number) < 1
    || !Array.isArray(record["decisions"])) {
    throw new Error("stored policy commit is invalid");
  }
  assertTimestamp(record["createdAt"], "policy commit createdAt");
  snapshotReferenceSchema.parse(record["snapshot"]);
  if (!/^commit_[a-f0-9]{48}$/u.test(record["commitId"])
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u.test(record["compilerVersion"])
    || !/^[a-f0-9]{64}$/u.test(record["policyHash"])) throw new Error("stored policy commit identity is invalid");
  for (const decision of record["decisions"]) {
    if (typeof decision !== "object" || decision === null || Array.isArray(decision)) throw new Error("stored policy decision is invalid");
    const item = decision as Record<string, unknown>;
    if (Object.keys(item).sort().join("\0") !== ["candidateId", "disposition", "reasonCodes"].join("\0")
      || typeof item["candidateId"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,499}$/u.test(item["candidateId"])
      || typeof item["disposition"] !== "string"
      || !(CANDIDATE_POLICY_DECISIONS as readonly string[]).includes(item["disposition"])
      || !Array.isArray(item["reasonCodes"])
      || item["reasonCodes"].length > 20
      || item["reasonCodes"].some((reason) => typeof reason !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u.test(reason))
      || new Set(item["reasonCodes"]).size !== item["reasonCodes"].length) {
      throw new Error("stored policy decision is invalid");
    }
  }
  return deepFreeze(value as unknown as PolicyCommit);
}

export class SessionExtractionStore {
  readonly #database: DatabaseSync;
  #closed = false;

  public constructor(filename: string) {
    this.#database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("session extraction store is closed");
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_extraction_meta (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version >= 0)
      );
    `);
    const current = this.#database.prepare(
      "SELECT version FROM session_extraction_meta WHERE component = 'session-extraction'",
    ).get() as { readonly version: number } | undefined;
    if (current !== undefined && current.version > CURRENT_MIGRATION_VERSION) {
      throw new Error(`session extraction migration ${current.version} is newer than supported version ${CURRENT_MIGRATION_VERSION}`);
    }
    if (current?.version === CURRENT_MIGRATION_VERSION) return;
    if (current !== undefined) throw new Error(`session extraction migration ${current.version} is not supported`);
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      const locked = this.#database.prepare(
        "SELECT version FROM session_extraction_meta WHERE component = 'session-extraction'",
      ).get() as { readonly version: number } | undefined;
      if (locked?.version === CURRENT_MIGRATION_VERSION) {
        this.#database.exec("COMMIT");
        return;
      }
      if (locked !== undefined) throw new Error(`session extraction migration ${locked.version} is not supported`);
      this.#database.exec(`
        CREATE TABLE extraction_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          identity_hash TEXT NOT NULL UNIQUE,
          source_refs_hash TEXT NOT NULL,
          session_id TEXT NOT NULL,
          compiler_version TEXT NOT NULL,
          policy_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL
        );
        CREATE INDEX extraction_snapshots_session_order_idx
          ON extraction_snapshots(session_id, created_at_ms DESC, snapshot_id ASC);
        CREATE TABLE extraction_candidate_previews (
          preview_id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL REFERENCES extraction_snapshots(snapshot_id) ON DELETE RESTRICT,
          job_id TEXT NOT NULL UNIQUE,
          effect_key TEXT NOT NULL UNIQUE,
          compiler_version TEXT NOT NULL,
          policy_hash TEXT NOT NULL,
          preview_revision INTEGER NOT NULL CHECK(preview_revision > 0),
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          UNIQUE(snapshot_id, compiler_version, policy_hash)
        );
        CREATE TABLE extraction_policy_commits (
          commit_id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL REFERENCES extraction_snapshots(snapshot_id) ON DELETE RESTRICT,
          preview_id TEXT NOT NULL REFERENCES extraction_candidate_previews(preview_id) ON DELETE RESTRICT,
          job_id TEXT NOT NULL UNIQUE,
          effect_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          UNIQUE(snapshot_id, preview_id)
        );
        CREATE TABLE extraction_provenance_edges (
          edge_id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL REFERENCES extraction_snapshots(snapshot_id) ON DELETE RESTRICT,
          from_key TEXT NOT NULL,
          to_key TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL
        );
        CREATE INDEX extraction_provenance_from_idx ON extraction_provenance_edges(from_key, edge_id);
        CREATE INDEX extraction_provenance_to_idx ON extraction_provenance_edges(to_key, edge_id);
        CREATE INDEX extraction_provenance_snapshot_idx ON extraction_provenance_edges(snapshot_id, edge_id);
        INSERT INTO session_extraction_meta(component, version) VALUES ('session-extraction', 1);
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #snapshotRow(snapshotId: string): SnapshotRow | undefined {
    return this.#database.prepare("SELECT * FROM extraction_snapshots WHERE snapshot_id = ?").get(snapshotId) as SnapshotRow | undefined;
  }

  #insertEdge(snapshotId: string, relationType: ProvenanceEdge["relationType"], from: ProvenanceNode, to: ProvenanceNode, observedAt: string): void {
    const parsed = provenanceEdgeSchema.parse({
      edgeId: edgeId(snapshotId, relationType, from, to),
      relationType,
      from,
      to,
      observedAt,
    });
    const serialized = serializeJobJson(parsed);
    const fromKey = nodeEncoding(parsed.from).key;
    const toKey = nodeEncoding(parsed.to).key;
    const existing = this.#database.prepare("SELECT payload_json, payload_hash FROM extraction_provenance_edges WHERE edge_id = ?")
      .get(parsed.edgeId) as JsonRow | undefined;
    if (existing !== undefined) {
      if (existing.payload_json !== serialized.json || existing.payload_hash !== serialized.hash) {
        throw new ExtractionConflictError("provenance edge identity collision");
      }
      return;
    }
    this.#database.prepare(`
      INSERT INTO extraction_provenance_edges(
        edge_id, snapshot_id, from_key, to_key, observed_at, payload_json, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(parsed.edgeId, snapshotId, fromKey, toKey, observedAt, serialized.json, serialized.hash);
  }

  public putSnapshot(snapshotInput: ExtractionSnapshot, sourceReferences: readonly SnapshotSourceReference[]): SnapshotCreateResult {
    this.#assertOpen();
    const snapshot = extractionSnapshotSchema.parse(snapshotInput);
    if (sourceReferences.length > MAX_SOURCE_REFERENCES) throw new Error(`sourceReferences exceeds ${MAX_SOURCE_REFERENCES}`);
    const seenEvents = new Set<string>();
    const orderedReferences = sourceReferences.map((reference): SnapshotSourceReference => ({
      eventId: reference.eventId,
      sourceSequence: reference.sourceSequence,
      ...(reference.turnId === undefined ? {} : { turnId: reference.turnId }),
    })).sort((left, right) =>
      left.sourceSequence - right.sourceSequence || left.eventId.localeCompare(right.eventId));
    for (const reference of orderedReferences) {
      if (seenEvents.has(reference.eventId)) throw new ExtractionConflictError("source event IDs must be unique");
      seenEvents.add(reference.eventId);
      if (!Number.isSafeInteger(reference.sourceSequence)
        || reference.sourceSequence < snapshot.sourceSequence.from
        || reference.sourceSequence > snapshot.sourceSequence.to) {
        throw new ExtractionConflictError("source reference is outside snapshot sequence range");
      }
    }
    const serialized = serializeJobJson(snapshot);
    const sourceReferencesHash = serializeJobJson(orderedReferences).hash;
    const createdAtMs = assertTimestamp(snapshot.createdAt, "snapshot.createdAt");
    return this.#transaction(() => {
      const existing = this.#database.prepare("SELECT * FROM extraction_snapshots WHERE identity_hash = ?")
        .get(snapshot.identityHash) as SnapshotRow | undefined;
      if (existing !== undefined) {
        if (existing.payload_json !== serialized.json || existing.payload_hash !== serialized.hash
          || existing.source_refs_hash !== sourceReferencesHash) {
          throw new ExtractionConflictError("snapshot identity is already bound to different content");
        }
        return deepFreeze({ status: "EXISTING" as const, snapshot: parseSnapshot(existing) });
      }
      this.#database.prepare(`
        INSERT INTO extraction_snapshots(
          snapshot_id, identity_hash, source_refs_hash, session_id, compiler_version, policy_hash,
          created_at, created_at_ms, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.snapshotId, snapshot.identityHash, sourceReferencesHash, snapshot.sessionId, snapshot.compilerVersion, snapshot.policyHash,
        snapshot.createdAt, createdAtMs, serialized.json, serialized.hash,
      );
      const session: ProvenanceNode = { type: "SESSION", sessionId: snapshot.sessionId };
      const snapshotNode: ProvenanceNode = { type: "SNAPSHOT", snapshotId: snapshot.snapshotId, revision: 1 };
      for (const reference of orderedReferences) {
        const event: ProvenanceNode = {
          type: "EVENT",
          sessionId: snapshot.sessionId,
          eventId: reference.eventId,
          sourceSequence: reference.sourceSequence,
          ...(reference.turnId === undefined ? {} : { turnId: reference.turnId }),
        };
        if (reference.turnId !== undefined) {
          const turn: ProvenanceNode = { type: "TURN", sessionId: snapshot.sessionId, turnId: reference.turnId };
          this.#insertEdge(snapshot.snapshotId, "SESSION_CONTAINS_TURN", session, turn, snapshot.createdAt);
          this.#insertEdge(snapshot.snapshotId, "TURN_CONTAINS_EVENT", turn, event, snapshot.createdAt);
        }
        this.#insertEdge(snapshot.snapshotId, "SNAPSHOT_INCLUDES_EVENT", event, snapshotNode, snapshot.createdAt);
      }
      return deepFreeze({ status: "CREATED" as const, snapshot });
    });
  }

  public getSnapshot(snapshotId: string): ExtractionSnapshot | undefined {
    this.#assertOpen();
    const parsed = provenanceNodeSchema.safeParse({ type: "SNAPSHOT", snapshotId, revision: 1 });
    if (!parsed.success) throw new Error("snapshotId is invalid");
    const row = this.#snapshotRow(snapshotId);
    return row === undefined ? undefined : parseSnapshot(row);
  }

  public listSnapshots(request: SnapshotListRequest): SnapshotPage {
    this.#assertOpen();
    assertLimit(request.limit, 100);
    let afterMs: number | undefined;
    if (request.after !== undefined) afterMs = assertTimestamp(request.after.createdAt, "after.createdAt");
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (request.sessionId !== undefined) {
      if (!provenanceNodeSchema.safeParse({ type: "SESSION", sessionId: request.sessionId }).success) throw new Error("sessionId is invalid");
      clauses.push("session_id = ?");
      parameters.push(request.sessionId);
    }
    if (request.after !== undefined && afterMs !== undefined) {
      if (!provenanceNodeSchema.safeParse({ type: "SNAPSHOT", snapshotId: request.after.snapshotId, revision: 1 }).success) {
        throw new Error("after.snapshotId is invalid");
      }
      clauses.push("(created_at_ms < ? OR (created_at_ms = ? AND snapshot_id > ?))");
      parameters.push(afterMs, afterMs, request.after.snapshotId);
    }
    const rows = this.#database.prepare(`
      SELECT * FROM extraction_snapshots
      ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
      ORDER BY created_at_ms DESC, snapshot_id ASC LIMIT ?
    `).all(...parameters, request.limit + 1) as unknown as SnapshotRow[];
    const hasMore = rows.length > request.limit;
    const page = hasMore ? rows.slice(0, request.limit) : rows;
    const last = page.at(-1);
    return deepFreeze({
      items: page.map(parseSnapshot),
      ...(hasMore && last !== undefined ? { next: { createdAt: last.created_at, snapshotId: last.snapshot_id } } : {}),
    });
  }

  public recordEpisodes(snapshotId: string, episodes: readonly EpisodeReference[], observedAt: string): void {
    this.#assertOpen();
    if (episodes.length > MAX_EPISODES) throw new Error(`episodes exceeds ${MAX_EPISODES}`);
    assertTimestamp(observedAt, "observedAt");
    if (this.#snapshotRow(snapshotId) === undefined) throw new ExtractionNotFoundError("snapshot was not found");
    const ids = episodes.map((episode) => episode.episodeId);
    if (new Set(ids).size !== ids.length) throw new ExtractionConflictError("episode IDs must be unique");
    this.#transaction(() => {
      const snapshotNode: ProvenanceNode = { type: "SNAPSHOT", snapshotId, revision: 1 };
      for (const episode of episodes) {
        this.#insertEdge(snapshotId, "SNAPSHOT_DERIVED_EPISODE", snapshotNode, {
          type: "EPISODE",
          episodeId: episode.episodeId,
        }, observedAt);
      }
    });
  }

  public getCandidatePreview(previewId: string): CandidatePreview | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM extraction_candidate_previews WHERE preview_id = ?")
      .get(previewId) as PreviewRow | undefined;
    return row === undefined ? undefined : parsePreview(row);
  }

  public getCandidatePreviewForSnapshot(snapshotId: string): CandidatePreview | undefined {
    this.#assertOpen();
    if (this.#snapshotRow(snapshotId) === undefined) throw new ExtractionNotFoundError("snapshot was not found");
    const row = this.#database.prepare("SELECT * FROM extraction_candidate_previews WHERE snapshot_id = ?")
      .get(snapshotId) as PreviewRow | undefined;
    return row === undefined ? undefined : parsePreview(row);
  }

  public recordCandidatePreview(
    snapshot: ExtractionSnapshot,
    request: { readonly compilerVersion: string; readonly policyHash: string },
    completion: CandidatePreviewCompletion,
  ): CandidatePreviewResult {
    this.#assertOpen();
    const previewIdentity = serializeJobJson({
      snapshotId: snapshot.snapshotId,
      snapshotIdentityHash: snapshot.identityHash,
      compilerVersion: request.compilerVersion,
      policyHash: request.policyHash,
    }).hash;
    const preview = candidatePreviewSchema.parse({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      previewId: `preview_${previewIdentity.slice(0, 48)}`,
      revision: 1,
      snapshot: { snapshotId: snapshot.snapshotId, revision: 1, identityHash: snapshot.identityHash },
      extractionKey: previewIdentity,
      compilerVersion: request.compilerVersion,
      policyHash: request.policyHash,
      status: completion.status,
      candidates: completion.candidates,
      diagnostics: completion.diagnostics,
      createdAt: completion.createdAt,
      expiresAt: completion.expiresAt,
    });
    const serialized = serializeJobJson(preview);
    assertTimestamp(preview.createdAt, "preview.createdAt");
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM extraction_candidate_previews WHERE effect_key = ? OR preview_id = ?",
      ).get(completion.effectKey, preview.previewId) as PreviewRow | undefined;
      if (existing !== undefined) {
        if (existing.payload_json !== serialized.json || existing.payload_hash !== serialized.hash) {
          throw new ExtractionConflictError("candidate preview replay has different output");
        }
        return deepFreeze({ status: "EXISTING" as const, preview: parsePreview(existing) });
      }
      for (const candidate of preview.candidates) {
        for (const episodeId of candidate.episodeIds) {
          const episodeNode: ProvenanceNode = { type: "EPISODE", episodeId };
          const episodeKey = nodeEncoding(episodeNode).key;
          const found = this.#database.prepare(`
            SELECT 1 FROM extraction_provenance_edges
            WHERE snapshot_id = ? AND to_key = ? LIMIT 1
          `).get(snapshot.snapshotId, episodeKey);
          if (found === undefined) throw new ExtractionConflictError(`candidate episode is not registered: ${episodeId}`);
        }
      }
      this.#database.prepare(`
        INSERT INTO extraction_candidate_previews(
          preview_id, snapshot_id, job_id, effect_key, compiler_version, policy_hash,
          preview_revision, created_at, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        preview.previewId, snapshot.snapshotId, completion.jobId, completion.effectKey,
        preview.compilerVersion, preview.policyHash, preview.revision, preview.createdAt, serialized.json, serialized.hash,
      );
      for (const candidate of preview.candidates) {
        for (const episodeId of candidate.episodeIds) {
          this.#insertEdge(snapshot.snapshotId, "EPISODE_COMPILED_CANDIDATE", {
            type: "EPISODE",
            episodeId,
          }, {
            type: "CANDIDATE",
            candidateId: candidate.candidateId,
          }, preview.createdAt);
        }
      }
      return deepFreeze({ status: "CREATED" as const, preview });
    });
  }

  public recordPolicyCommit(
    preview: CandidatePreview,
    completion: PolicyCommitCompletion,
  ): PolicyCommitResult {
    this.#assertOpen();
    const candidateIds = preview.candidates.map((candidate) => candidate.candidateId).sort();
    const decisionIds = completion.decisions.map((decision) => decision.candidateId).sort();
    if (new Set(decisionIds).size !== decisionIds.length || candidateIds.join("\0") !== decisionIds.join("\0")) {
      throw new ExtractionConflictError("policy decisions must cover each preview candidate exactly once");
    }
    for (const decision of completion.decisions) {
      const candidate = preview.candidates.find((item) => item.candidateId === decision.candidateId);
      if (candidate === undefined
        || candidate.policyDecision !== decision.disposition
        || [...candidate.policyReasonCodes].sort().join("\0") !== [...decision.reasonCodes].sort().join("\0")) {
        throw new ExtractionConflictError("policy decision does not match the immutable candidate preview");
      }
      if (!(CANDIDATE_POLICY_DECISIONS as readonly string[]).includes(decision.disposition)
        || decision.reasonCodes.length > 20
        || decision.reasonCodes.some((reason) => !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u.test(reason))
        || new Set(decision.reasonCodes).size !== decision.reasonCodes.length) {
        throw new ExtractionConflictError("policy decision is invalid");
      }
    }
    const commitHash = serializeJobJson({
      snapshot: preview.snapshot,
      previewId: preview.previewId,
      previewRevision: preview.revision,
      compilerVersion: preview.compilerVersion,
      policyHash: preview.policyHash,
    }).hash;
    const commit: PolicyCommit = deepFreeze({
      commitId: `commit_${commitHash.slice(0, 48)}`,
      revision: 1,
      snapshot: preview.snapshot,
      previewId: preview.previewId,
      previewRevision: preview.revision,
      compilerVersion: preview.compilerVersion,
      policyHash: preview.policyHash,
      decisions: [...completion.decisions].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
      createdAt: completion.createdAt,
    });
    assertTimestamp(commit.createdAt, "commit.createdAt");
    const serialized = serializeJobJson(commit);
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM extraction_policy_commits WHERE effect_key = ? OR commit_id = ?",
      ).get(completion.effectKey, commit.commitId) as CommitRow | undefined;
      if (existing !== undefined) {
        if (existing.payload_json !== serialized.json || existing.payload_hash !== serialized.hash) {
          throw new ExtractionConflictError("policy commit replay has different output");
        }
        return deepFreeze({ status: "EXISTING" as const, commit: parsePolicyCommit(existing) });
      }
      this.#database.prepare(`
        INSERT INTO extraction_policy_commits(
          commit_id, snapshot_id, preview_id, job_id, effect_key, created_at, payload_json, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        commit.commitId, commit.snapshot.snapshotId, commit.previewId, completion.jobId,
        completion.effectKey, commit.createdAt, serialized.json, serialized.hash,
      );
      return deepFreeze({ status: "CREATED" as const, commit });
    });
  }

  public getPolicyCommit(commitId: string): PolicyCommit | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM extraction_policy_commits WHERE commit_id = ?")
      .get(commitId) as CommitRow | undefined;
    return row === undefined ? undefined : parsePolicyCommit(row);
  }

  public getPolicyCommitForPreview(previewId: string): PolicyCommit | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM extraction_policy_commits WHERE preview_id = ?")
      .get(previewId) as CommitRow | undefined;
    return row === undefined ? undefined : parsePolicyCommit(row);
  }

  public recordKnowledgeVersion(reference: KnowledgePublicationReference): void {
    this.#assertOpen();
    const knowledge = knowledgeVersionRefSchema.parse({ id: reference.knowledgeId, version: reference.version });
    assertTimestamp(reference.observedAt, "observedAt");
    const candidateNode: ProvenanceNode = { type: "CANDIDATE", candidateId: reference.candidateId };
    const candidateKey = nodeEncoding(candidateNode).key;
    const found = this.#database.prepare(`
      SELECT 1 FROM extraction_provenance_edges
      WHERE snapshot_id = ? AND to_key = ? LIMIT 1
    `).get(reference.snapshotId, candidateKey);
    if (found === undefined) throw new ExtractionNotFoundError("candidate provenance was not found");
    const commitRow = this.#database.prepare(`
      SELECT policy_commit.* FROM extraction_policy_commits policy_commit
      WHERE policy_commit.snapshot_id = ?
    `).get(reference.snapshotId) as CommitRow | undefined;
    if (commitRow === undefined) throw new ExtractionConflictError("knowledge publication requires a durable policy commit");
    const commit = parsePolicyCommit(commitRow);
    const decision = commit.decisions.find((item) => item.candidateId === reference.candidateId);
    if (decision?.disposition !== "PUBLISH") {
      throw new ExtractionConflictError("candidate policy does not permit publication");
    }
    this.#transaction(() => this.#insertEdge(reference.snapshotId, "CANDIDATE_PUBLISHED_AS", candidateNode, {
      type: "KNOWLEDGE_VERSION",
      knowledge,
    }, reference.observedAt));
  }

  #unsupportedEventTypes(snapshotIds: readonly string[]): readonly string[] {
    const output = new Set<string>();
    const statement = this.#database.prepare("SELECT payload_json, payload_hash FROM extraction_snapshots WHERE snapshot_id = ?");
    for (const snapshotId of snapshotIds) {
      const row = statement.get(snapshotId) as JsonRow | undefined;
      if (row === undefined) continue;
      for (const eventType of parseSnapshot(row).completeness.unsupportedEventTypes) output.add(eventType);
    }
    return [...output].sort();
  }

  public getProvenance(request: ProvenanceQuery): ProvenancePage {
    this.#assertOpen();
    const root = provenanceNodeSchema.parse(request.root);
    assertLimit(request.limit, 100);
    if (request.afterEdgeId !== undefined && !/^edge_[a-f0-9]{48}$/u.test(request.afterEdgeId)) throw new Error("afterEdgeId is invalid");
    const rootKey = nodeEncoding(root).key;
    const rows = this.#database.prepare(`
      SELECT * FROM extraction_provenance_edges
      WHERE (from_key = ? OR to_key = ?) ${request.afterEdgeId === undefined ? "" : "AND edge_id > ?"}
      ORDER BY edge_id ASC LIMIT ?
    `).all(
      rootKey,
      rootKey,
      ...(request.afterEdgeId === undefined ? [] : [request.afterEdgeId]),
      request.limit + 1,
    ) as unknown as EdgeRow[];
    const hasMore = rows.length > request.limit;
    const page = hasMore ? rows.slice(0, request.limit) : rows;
    const upstream: ProvenanceEdge[] = [];
    const downstream: ProvenanceEdge[] = [];
    for (const row of page) {
      const edge = provenanceEdgeSchema.parse(parseStoredJobJson(row.payload_json, row.payload_hash));
      if (row.to_key === rootKey) upstream.push(edge);
      if (row.from_key === rootKey) downstream.push(edge);
    }
    const snapshotIds = new Set(page.map((row) => row.snapshot_id));
    if (root.type === "SNAPSHOT") snapshotIds.add(root.snapshotId);
    const unsupportedEventTypes = this.#unsupportedEventTypes([...snapshotIds]);
    const last = page.at(-1);
    return deepFreeze(bidirectionalProvenanceSchema.parse({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      root,
      upstream,
      downstream,
      completeness: hasMore
        ? "TRUNCATED"
        : unsupportedEventTypes.length > 0 ? "PARTIAL_UNSUPPORTED_EVENT_TYPES" : "COMPLETE",
      unsupportedEventTypes,
      ...(hasMore && last !== undefined ? { nextCursor: last.edge_id } : {}),
    }));
  }

  /** Test/repair hook that proves newer schemas fail closed before any write. */
  public migrationVersion(): number {
    this.#assertOpen();
    const row = this.#database.prepare(
      "SELECT version FROM session_extraction_meta WHERE component = 'session-extraction'",
    ).get() as { readonly version: number } | undefined;
    if (row === undefined) throw new Error("session extraction migration metadata is missing");
    return row.version;
  }

  public close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
