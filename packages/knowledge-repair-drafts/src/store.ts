import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeCandidate } from "@zhiloop/domain";

import { canonical, knowledgeRepairDraftId, repairDigest } from "./identity.js";
import {
  KNOWLEDGE_REPAIR_DRAFT_STATUSES,
  type CreateKnowledgeRepairDraftInput,
  type KnowledgeRepairDraft,
  type KnowledgeRepairDraftStatus,
  type RepairDraftListRequest,
  type RepairDraftPage,
  type RepairDraftWriteResult,
  type RepairPromotionReceipt,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9._:@+=-]{1,1000}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CONTROL = /[\0\r\n]/u;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const STATUSES = new Set<KnowledgeRepairDraftStatus>(KNOWLEDGE_REPAIR_DRAFT_STATUSES);

interface DraftRow {
  readonly draft_id: string;
  readonly project_id: string;
  readonly asset_id: string;
  readonly asset_version: number;
  readonly conflict_run_id: string;
  readonly status: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly payload_json: string;
  readonly payload_hash: string;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function id(value: string, name: string): void {
  if (!SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`REPAIR_DRAFT_${name}_INVALID`);
}

function text(value: string, name: string, maximum = 4_096): void {
  if (value.trim().length === 0 || value.length > maximum || CONTROL.test(value)) throw new Error(`REPAIR_DRAFT_${name}_INVALID`);
}

function content(value: string, name: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum || value.includes("\0")) throw new Error(`REPAIR_DRAFT_${name}_INVALID`);
}

function timestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`REPAIR_DRAFT_${name}_INVALID`);
}

function boundedJson(value: unknown, name: string): string {
  const result = canonical(value);
  if (Buffer.byteLength(result, "utf8") > MAX_PAYLOAD_BYTES) throw new Error(`REPAIR_DRAFT_${name}_LIMIT_EXCEEDED`);
  return result;
}

function validateCandidate(candidate: KnowledgeCandidate, sourceCandidateId?: string): void {
  if (candidate.schemaVersion !== 1 || candidate.status !== "PROPOSED") throw new Error("REPAIR_DRAFT_CANDIDATE_AUTHORITY_INVALID");
  id(candidate.candidateId, "CANDIDATE_ID");
  if (sourceCandidateId !== undefined && candidate.candidateId === sourceCandidateId) throw new Error("REPAIR_DRAFT_CANDIDATE_NOT_NEW");
  text(candidate.subjectKey, "CANDIDATE_SUBJECT", 500);
  text(candidate.title, "CANDIDATE_TITLE", 2_000);
  content(candidate.summary, "CANDIDATE_SUMMARY", 20_000);
  content(candidate.body, "CANDIDATE_BODY", 500_000);
  text(candidate.correlationId, "CANDIDATE_CORRELATION", 1_000);
  timestamp(candidate.createdAt, "CANDIDATE_CREATED_AT");
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1
    || candidate.sourceEpisodes.length < 1 || candidate.sourceEpisodes.length > 1_000
    || candidate.assertions.length + candidate.evidenceHints.length < 1
    || candidate.assertions.length > 10_000 || candidate.evidenceHints.length > 10_000) {
    throw new Error("REPAIR_DRAFT_CANDIDATE_INVALID");
  }
  for (const episodeId of candidate.sourceEpisodes) id(episodeId, "SOURCE_EPISODE_ID");
  for (const assertion of candidate.assertions) {
    id(assertion.assertionId, "ASSERTION_ID");
    if (assertion.candidateId !== candidate.candidateId) throw new Error("REPAIR_DRAFT_CANDIDATE_ASSERTION_MISMATCH");
    timestamp(assertion.createdAt, "ASSERTION_CREATED_AT");
  }
  for (const hint of candidate.evidenceHints) {
    text(hint.sourceRef, "EVIDENCE_SOURCE", 4_096);
    if (hint.projectId !== undefined) id(hint.projectId, "EVIDENCE_PROJECT_ID");
    text(hint.correlationId, "EVIDENCE_CORRELATION", 1_000);
  }
  boundedJson(candidate, "CANDIDATE");
}

function validateCreate(input: CreateKnowledgeRepairDraftInput): void {
  id(input.projectId, "PROJECT_ID");
  id(input.sourceKnowledge.assetId, "ASSET_ID");
  id(input.sourceKnowledge.candidate.candidateId, "SOURCE_CANDIDATE_ID");
  id(input.conflict.runId, "CONFLICT_RUN_ID");
  if (!Number.isSafeInteger(input.sourceKnowledge.assetVersion) || input.sourceKnowledge.assetVersion < 1
    || !HASH.test(input.sourceKnowledge.contentHash)) throw new Error("REPAIR_DRAFT_SOURCE_INVALID");
  if (input.sourceKnowledge.candidate.status !== "PROPOSED") throw new Error("REPAIR_DRAFT_SOURCE_CANDIDATE_INVALID");
  validateCandidate(input.sourceKnowledge.candidate);
  text(input.conflict.codeRevision, "CODE_REVISION");
  if (input.conflict.graphRevision !== undefined) text(input.conflict.graphRevision, "GRAPH_REVISION");
  timestamp(input.conflict.completedAt, "COMPLETED_AT");
  timestamp(input.createdAt, "CREATED_AT");
  if (input.changedAssertions.length < 1 || input.changedAssertions.length > 10_000
    || new Set(input.changedAssertions.map((item) => item.assertionId)).size !== input.changedAssertions.length
    || input.reasonCodes.length < 1 || input.reasonCodes.length > 10_000) throw new Error("REPAIR_DRAFT_ASSERTIONS_INVALID");
  for (const assertion of input.changedAssertions) {
    id(assertion.assertionId, "ASSERTION_ID");
    if (assertion.verificationStatus !== "UNSUPPORTED" || assertion.reasonCodes.length < 1
      || assertion.reasonCodes.length > 1_000) throw new Error("REPAIR_DRAFT_ASSERTIONS_INVALID");
    assertion.reasonCodes.forEach((reason) => text(reason, "REASON_CODE", 500));
    if (assertion.evidenceId !== undefined) id(assertion.evidenceId, "EVIDENCE_ID");
  }
  input.reasonCodes.forEach((reason) => text(reason, "REASON_CODE", 500));
  boundedJson(input, "PAYLOAD");
}

function baseDraft(input: CreateKnowledgeRepairDraftInput): KnowledgeRepairDraft {
  return freeze({ schemaVersion: 1, draftId: knowledgeRepairDraftId(input), projectId: input.projectId,
    sourceKnowledge: structuredClone(input.sourceKnowledge), conflict: structuredClone(input.conflict), status: "PENDING",
    revision: 0, changedAssertions: [...input.changedAssertions], reasonCodes: [...new Set(input.reasonCodes)].sort(),
    inheritedAuthorization: false, createdAt: input.createdAt, updatedAt: input.createdAt });
}

export class SqliteKnowledgeRepairDraftStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    const target = filename === ":memory:" ? filename : resolve(filename);
    if (filename !== ":memory:") mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(target);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(target, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_repair_drafts(
          draft_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, asset_id TEXT NOT NULL,
          asset_version INTEGER NOT NULL CHECK(asset_version > 0), conflict_run_id TEXT NOT NULL,
          status TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
          UNIQUE(asset_id, asset_version, conflict_run_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS repair_drafts_project_page
          ON knowledge_repair_drafts(project_id, created_at DESC, draft_id DESC);
        CREATE INDEX IF NOT EXISTS repair_drafts_status_page
          ON knowledge_repair_drafts(status, created_at DESC, draft_id DESC);
        CREATE TABLE IF NOT EXISTS knowledge_repair_draft_effects(
          effect_key TEXT PRIMARY KEY, draft_id TEXT NOT NULL, operation TEXT NOT NULL,
          input_hash TEXT NOT NULL, result_json TEXT NOT NULL, result_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(draft_id) REFERENCES knowledge_repair_drafts(draft_id) ON DELETE RESTRICT
        ) STRICT;
      `);
    } catch (error) { this.#database.close(); throw error; }
  }

  #open(): void { if (this.#closed) throw new Error("REPAIR_DRAFT_STORE_CLOSED"); }

  #decode(row: DraftRow): KnowledgeRepairDraft {
    if (!STATUSES.has(row.status as KnowledgeRepairDraftStatus) || !HASH.test(row.payload_hash)
      || repairDigest(row.payload_json) !== row.payload_hash) throw new Error("REPAIR_DRAFT_CORRUPT");
    let draft: KnowledgeRepairDraft;
    try { draft = JSON.parse(row.payload_json) as KnowledgeRepairDraft; }
    catch { throw new Error("REPAIR_DRAFT_CORRUPT"); }
    if (draft.schemaVersion !== 1 || draft.draftId !== row.draft_id || draft.projectId !== row.project_id
      || draft.sourceKnowledge.assetId !== row.asset_id || draft.sourceKnowledge.assetVersion !== row.asset_version
      || draft.conflict.runId !== row.conflict_run_id || draft.status !== row.status || draft.revision !== row.revision
      || draft.createdAt !== row.created_at || draft.updatedAt !== row.updated_at || draft.inheritedAuthorization !== false
      || knowledgeRepairDraftId(draft) !== draft.draftId) throw new Error("REPAIR_DRAFT_CORRUPT");
    boundedJson(draft, "PAYLOAD");
    return freeze(draft);
  }

  #row(draftId: string): DraftRow | undefined {
    return this.#database.prepare("SELECT * FROM knowledge_repair_drafts WHERE draft_id=?").get(draftId) as unknown as DraftRow | undefined;
  }

  create(input: CreateKnowledgeRepairDraftInput): RepairDraftWriteResult {
    this.#open(); validateCreate(input);
    const draft = baseDraft(input); const payload = canonical(draft); const payloadHash = repairDigest(payload);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(`SELECT * FROM knowledge_repair_drafts
        WHERE asset_id=? AND asset_version=? AND conflict_run_id=?`).get(input.sourceKnowledge.assetId,
          input.sourceKnowledge.assetVersion, input.conflict.runId) as unknown as DraftRow | undefined;
      if (existing !== undefined) {
        const decoded = this.#decode(existing);
        if (canonical(decoded) !== payload) throw new Error("REPAIR_DRAFT_IDEMPOTENCY_CONFLICT");
        this.#database.exec("COMMIT"); return { status: "IDEMPOTENT", draft: decoded };
      }
      this.#database.prepare(`INSERT INTO knowledge_repair_drafts
        (draft_id,project_id,asset_id,asset_version,conflict_run_id,status,revision,created_at,updated_at,payload_json,payload_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(draft.draftId, draft.projectId, draft.sourceKnowledge.assetId,
          draft.sourceKnowledge.assetVersion, draft.conflict.runId, draft.status, draft.revision,
          draft.createdAt, draft.updatedAt, payload, payloadHash);
      this.#database.exec("COMMIT"); return { status: "CREATED", draft };
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  get(draftId: string): KnowledgeRepairDraft | undefined {
    this.#open(); id(draftId, "ID"); const row = this.#row(draftId); return row === undefined ? undefined : this.#decode(row);
  }

  getByConflict(assetId: string, assetVersion: number, conflictRunId: string): KnowledgeRepairDraft | undefined {
    this.#open(); id(assetId, "ASSET_ID"); id(conflictRunId, "CONFLICT_RUN_ID");
    if (!Number.isSafeInteger(assetVersion) || assetVersion < 1) throw new Error("REPAIR_DRAFT_ASSET_VERSION_INVALID");
    const row = this.#database.prepare(`SELECT * FROM knowledge_repair_drafts WHERE asset_id=? AND asset_version=? AND conflict_run_id=?`)
      .get(assetId, assetVersion, conflictRunId) as unknown as DraftRow | undefined;
    return row === undefined ? undefined : this.#decode(row);
  }

  list(request: RepairDraftListRequest): RepairDraftPage {
    this.#open();
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) throw new Error("REPAIR_DRAFT_LIST_LIMIT_INVALID");
    if (request.projectId !== undefined) id(request.projectId, "PROJECT_ID");
    if (request.assetId !== undefined) id(request.assetId, "ASSET_ID");
    if ((request.assetVersion === undefined) !== (request.assetId === undefined)
      || (request.assetVersion !== undefined && (!Number.isSafeInteger(request.assetVersion) || request.assetVersion < 1))) {
      throw new Error("REPAIR_DRAFT_LIST_ASSET_INVALID");
    }
    if (request.statuses !== undefined && (request.statuses.length < 1 || request.statuses.length > STATUSES.size
      || new Set(request.statuses).size !== request.statuses.length || request.statuses.some((item) => !STATUSES.has(item)))) {
      throw new Error("REPAIR_DRAFT_LIST_STATUS_INVALID");
    }
    if (request.after !== undefined) { timestamp(request.after.createdAt, "CURSOR_TIME"); id(request.after.draftId, "CURSOR_ID"); }
    const conditions: string[] = []; const values: Array<string | number> = [];
    if (request.projectId !== undefined) { conditions.push("project_id=?"); values.push(request.projectId); }
    if (request.assetId !== undefined) { conditions.push("asset_id=? AND asset_version=?"); values.push(request.assetId, request.assetVersion!); }
    if (request.statuses !== undefined) {
      conditions.push(`status IN (${request.statuses.map(() => "?").join(",")})`); values.push(...request.statuses);
    }
    if (request.after !== undefined) {
      conditions.push("(created_at < ? OR (created_at = ? AND draft_id < ?))");
      values.push(request.after.createdAt, request.after.createdAt, request.after.draftId);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#database.prepare(`SELECT * FROM knowledge_repair_drafts ${where}
      ORDER BY created_at DESC,draft_id DESC LIMIT ?`).all(...values, request.limit + 1) as unknown as DraftRow[];
    const hasMore = rows.length > request.limit; const selected = rows.slice(0, request.limit).map((row) => this.#decode(row));
    const last = selected.at(-1);
    return freeze({ items: selected, ...(hasMore && last !== undefined ? { next: { createdAt: last.createdAt, draftId: last.draftId } } : {}) });
  }

  #transition(input: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly operation: "ATTACH_CANDIDATE" | "DISMISS" | "FAIL" | "PROMOTE"; readonly updatedAt: string; readonly semantic: unknown;
    readonly mutate: (draft: KnowledgeRepairDraft) => KnowledgeRepairDraft }): RepairDraftWriteResult {
    this.#open(); id(input.draftId, "ID"); id(input.effectKey, "EFFECT_KEY"); timestamp(input.updatedAt, "UPDATED_AT");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("REPAIR_DRAFT_REVISION_INVALID");
    const inputHash = repairDigest([input.operation, input.draftId, input.expectedRevision, input.updatedAt, input.semantic]);
    const replay = (): RepairDraftWriteResult | undefined => {
      const row = this.#database.prepare("SELECT * FROM knowledge_repair_draft_effects WHERE effect_key=?").get(input.effectKey) as
        { draft_id: string; operation: string; input_hash: string; result_json: string; result_hash: string } | undefined;
      if (row === undefined) return undefined;
      if (row.draft_id !== input.draftId || row.operation !== input.operation || row.input_hash !== inputHash
        || repairDigest(row.result_json) !== row.result_hash) throw new Error("REPAIR_DRAFT_EFFECT_CONFLICT");
      let result: RepairDraftWriteResult; try { result = JSON.parse(row.result_json) as RepairDraftWriteResult; }
      catch { throw new Error("REPAIR_DRAFT_EFFECT_CORRUPT"); }
      if (result.status !== "TRANSITIONED" || result.draft.draftId !== input.draftId
        || result.draft.revision !== input.expectedRevision + 1 || result.draft.inheritedAuthorization !== false
        || knowledgeRepairDraftId(result.draft) !== result.draft.draftId) {
        throw new Error("REPAIR_DRAFT_EFFECT_CORRUPT");
      }
      return freeze(result);
    };
    const existing = replay(); if (existing !== undefined) return existing;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(input.draftId); if (row === undefined) throw new Error("REPAIR_DRAFT_NOT_FOUND");
      const current = this.#decode(row);
      if (current.revision !== input.expectedRevision) throw new Error("REPAIR_DRAFT_REVISION_CONFLICT");
      if (Date.parse(input.updatedAt) < Date.parse(current.updatedAt)) throw new Error("REPAIR_DRAFT_TIME_REGRESSION");
      const next = freeze(input.mutate(current));
      if (next.draftId !== current.draftId || next.revision !== current.revision + 1 || next.updatedAt !== input.updatedAt
        || canonical(next.sourceKnowledge) !== canonical(current.sourceKnowledge) || canonical(next.conflict) !== canonical(current.conflict)
        || next.inheritedAuthorization !== false) throw new Error("REPAIR_DRAFT_TRANSITION_INVALID");
      const payload = boundedJson(next, "PAYLOAD"); const payloadHash = repairDigest(payload);
      const updated = this.#database.prepare(`UPDATE knowledge_repair_drafts SET status=?,revision=?,updated_at=?,payload_json=?,payload_hash=?
        WHERE draft_id=? AND revision=?`).run(next.status, next.revision, next.updatedAt, payload, payloadHash,
          input.draftId, input.expectedRevision);
      if (Number(updated.changes) !== 1) throw new Error("REPAIR_DRAFT_REVISION_CONFLICT");
      const result = freeze({ status: "TRANSITIONED" as const, draft: next }); const resultJson = canonical(result);
      this.#database.prepare(`INSERT INTO knowledge_repair_draft_effects
        (effect_key,draft_id,operation,input_hash,result_json,result_hash,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(input.effectKey, input.draftId, input.operation, inputHash, resultJson, repairDigest(resultJson), input.updatedAt);
      this.#database.exec("COMMIT"); return result;
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  attachCandidate(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly candidate: KnowledgeCandidate; readonly updatedAt: string }): RepairDraftWriteResult {
    const current = this.get(request.draftId); if (current === undefined) throw new Error("REPAIR_DRAFT_NOT_FOUND");
    validateCandidate(request.candidate, current.sourceKnowledge.candidate.candidateId);
    const candidate = freeze(structuredClone(request.candidate)); const candidateHash = repairDigest(candidate);
    return this.#transition({ ...request, operation: "ATTACH_CANDIDATE", semantic: { candidateHash }, mutate: (draft) => {
      if (draft.status !== "PENDING") throw new Error("REPAIR_DRAFT_STATUS_CONFLICT");
      return { ...draft, status: "READY", revision: draft.revision + 1, proposedCandidate: candidate,
        proposedCandidateHash: candidateHash, updatedAt: request.updatedAt };
    } });
  }

  dismiss(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly reason: string; readonly updatedAt: string }): RepairDraftWriteResult {
    text(request.reason, "DISMISSAL_REASON", 2_000);
    return this.#transition({ ...request, operation: "DISMISS", semantic: { reason: request.reason }, mutate: (draft) => {
      if (draft.status !== "PENDING" && draft.status !== "READY") throw new Error("REPAIR_DRAFT_STATUS_CONFLICT");
      return { ...draft, status: "DISMISSED", revision: draft.revision + 1, dismissalReason: request.reason,
        updatedAt: request.updatedAt };
    } });
  }

  fail(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly code: string; readonly updatedAt: string }): RepairDraftWriteResult {
    text(request.code, "FAILURE_CODE", 500);
    return this.#transition({ ...request, operation: "FAIL", semantic: { code: request.code }, mutate: (draft) => {
      if (draft.status !== "PENDING") throw new Error("REPAIR_DRAFT_STATUS_CONFLICT");
      return { ...draft, status: "FAILED", revision: draft.revision + 1,
        failure: { code: request.code, retryable: false, occurredAt: request.updatedAt }, updatedAt: request.updatedAt };
    } });
  }

  promote(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly receipt: RepairPromotionReceipt; readonly updatedAt: string }): RepairDraftWriteResult {
    id(request.receipt.receiptId, "RECEIPT_ID"); id(request.receipt.candidateId, "CANDIDATE_ID");
    timestamp(request.receipt.acceptedAt, "RECEIPT_TIME");
    return this.#transition({ ...request, operation: "PROMOTE", semantic: { receipt: request.receipt }, mutate: (draft) => {
      if (draft.status !== "READY" || draft.proposedCandidate === undefined
        || draft.proposedCandidate.candidateId !== request.receipt.candidateId) throw new Error("REPAIR_DRAFT_PROMOTION_INVALID");
      return { ...draft, status: "PROMOTED", revision: draft.revision + 1,
        promotionReceipt: structuredClone(request.receipt), updatedAt: request.updatedAt };
    } });
  }

  close(): void { if (this.#closed) return; this.#database.close(); this.#closed = true; }
}
