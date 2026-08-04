import { createHash, randomUUID } from "node:crypto";

import { p2KnowledgeFilterSchema, type CapturePreview, type ProvenanceNode } from "@zhiloop/control-api";
import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { TranscriptCursor } from "@zhiloop/codex-session-capture";
import type { LedgerEventRecord, SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { EvidenceRef, KnowledgeKind, KnowledgeScope, KnowledgeStatus } from "@zhiloop/domain";
import {
  GovernanceError,
  type KnowledgeDetail,
  type KnowledgeListFilter,
  type KnowledgeProvenanceRecord,
} from "@zhiloop/knowledge-governance-service";
import {
  snapshotIdempotencyKey,
} from "@zhiloop/session-extraction";

import type { P2ProductionComposition } from "./p2-production.js";
import { p2CommitRequest, p2PreviewRequest, type P2SidecarRuntime } from "./p2-runtime.js";

const COMPILER_VERSION = "mvp-compiler-v3";
const MAX_PROVENANCE_VISITS = 1_000;
const LEDGER_PAGE_SIZE = 1_000;
const MAX_MANUAL_EXTRACTION_RECORDS = 5_000;
const MAX_MANUAL_SEQUENCE_SPAN = 50_000;

export type P2ConsoleRequest =
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.session.get"; readonly sessionId: string }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.session.preview"; readonly sessionId: string; readonly expectedRevision: number; readonly idempotencyKey: string }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.session.commit"; readonly sessionId: string; readonly previewId: string; readonly expectedPreviewRevision: number; readonly idempotencyKey: string }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.knowledge.list"; readonly filter?: P2KnowledgeFilter; readonly cursor?: string; readonly limit?: number }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.knowledge.get"; readonly knowledgeId: string }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.knowledge.edit.preview"; readonly knowledgeId: string; readonly expectedVersion: number; readonly idempotencyKey: string; readonly draft: P2KnowledgeEditDraft }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.knowledge.edit.commit"; readonly knowledgeId: string; readonly expectedVersion: number; readonly idempotencyKey: string; readonly draft: P2KnowledgeEditDraft }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.knowledge.suppress"; readonly knowledgeId: string; readonly expectedVersion: number; readonly idempotencyKey: string; readonly reason: string }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.knowledge.restore"; readonly knowledgeId: string; readonly expectedVersion: number; readonly idempotencyKey: string; readonly reason: string }
  | { readonly schemaVersion: 1; readonly requestId: string; readonly type: "p2.knowledge.index.recover"; readonly knowledgeId: string };

export type P2ScopeLevel = Extract<KnowledgeScope["level"], "TASK" | "SYMBOL" | "MODULE" | "PROJECT" | "GLOBAL">;

export interface P2KnowledgeFilter {
  readonly scope?: P2ScopeLevel;
  readonly projectId?: string;
  readonly kind?: KnowledgeKind;
  readonly status?: KnowledgeStatus;
  readonly subject?: string;
  readonly symbol?: string;
  readonly keyword?: string;
  readonly evidenceVerdict?: EvidenceRef["verdict"];
  readonly version?: number;
  readonly eligible?: boolean;
}

export interface P2KnowledgeEditDraft {
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
}

export interface P2ConsoleRuntimeOptions {
  readonly runtime: P2SidecarRuntime;
  readonly production: P2ProductionComposition;
  readonly ledger: SqliteEventLedger;
  readonly inspectTranscriptSource: (sessionId: string) => Promise<CapturePreview>;
  readonly configurationHash: () => string;
  readonly clock?: () => Date;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;
const REQUEST_TYPES = new Set<P2ConsoleRequest["type"]>([
  "p2.session.get", "p2.session.preview", "p2.session.commit", "p2.knowledge.list", "p2.knowledge.get",
  "p2.knowledge.edit.preview", "p2.knowledge.edit.commit", "p2.knowledge.suppress", "p2.knowledge.restore",
  "p2.knowledge.index.recover",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !value.includes("//");
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Strict local transport contract kept outside control-api while P3 owns that package. */
export function parseP2ConsoleRequest(value: unknown): P2ConsoleRequest {
  if (!record(value) || value["schemaVersion"] !== 1 || !safeId(value["requestId"])
    || typeof value["type"] !== "string" || !REQUEST_TYPES.has(value["type"] as P2ConsoleRequest["type"])) {
    throw Object.assign(new Error("invalid P2 Console request"), { code: "INVALID_REQUEST" });
  }
  const base = ["schemaVersion", "requestId", "type"];
  const type = value["type"] as P2ConsoleRequest["type"];
  const session = type.startsWith("p2.session.");
  const knowledge = type.startsWith("p2.knowledge.");
  const required = [...base];
  const optional: string[] = [];
  if (session) required.push("sessionId");
  if (knowledge && type !== "p2.knowledge.list") required.push("knowledgeId");
  if (type === "p2.session.preview") required.push("expectedRevision", "idempotencyKey");
  if (type === "p2.session.commit") required.push("previewId", "expectedPreviewRevision", "idempotencyKey");
  if (type === "p2.knowledge.list") optional.push("filter", "cursor", "limit");
  if (type === "p2.knowledge.edit.preview" || type === "p2.knowledge.edit.commit") required.push("expectedVersion", "idempotencyKey", "draft");
  if (type === "p2.knowledge.suppress" || type === "p2.knowledge.restore") required.push("expectedVersion", "idempotencyKey", "reason");
  if (!exactFields(value, required, optional)) throw Object.assign(new Error("invalid P2 Console fields"), { code: "INVALID_REQUEST" });
  for (const field of ["sessionId", "knowledgeId", "idempotencyKey", "previewId"] as const) {
    if (field in value && !safeId(value[field])) throw Object.assign(new Error(`invalid ${field}`), { code: "INVALID_REQUEST" });
  }
  if ("expectedRevision" in value && !nonnegative(value["expectedRevision"])) throw Object.assign(new Error("invalid expectedRevision"), { code: "INVALID_REQUEST" });
  for (const field of ["expectedPreviewRevision", "expectedVersion"] as const) {
    if (field in value && (!nonnegative(value[field]) || (value[field] as number) < 1)) throw Object.assign(new Error(`invalid ${field}`), { code: "INVALID_REQUEST" });
  }
  if ("reason" in value && (typeof value["reason"] !== "string" || value["reason"].trim().length === 0 || value["reason"].length > 1_000)) {
    throw Object.assign(new Error("invalid reason"), { code: "INVALID_REQUEST" });
  }
  if ("limit" in value && (!Number.isSafeInteger(value["limit"]) || (value["limit"] as number) < 1 || (value["limit"] as number) > 100)) {
    throw Object.assign(new Error("invalid limit"), { code: "INVALID_REQUEST" });
  }
  if ("cursor" in value && (typeof value["cursor"] !== "string" || value["cursor"].length > 2_048)) {
    throw Object.assign(new Error("invalid cursor"), { code: "INVALID_REQUEST" });
  }
  if ("draft" in value) {
    const draft = value["draft"];
    if (!record(draft) || !exactFields(draft, ["title", "summary", "markdown"])
      || typeof draft["title"] !== "string" || draft["title"].trim().length === 0 || draft["title"].length > 300
      || typeof draft["summary"] !== "string" || draft["summary"].trim().length === 0 || draft["summary"].length > 2_000
      || typeof draft["markdown"] !== "string" || draft["markdown"].length === 0 || draft["markdown"].length > 32_000) {
      throw Object.assign(new Error("invalid edit draft"), { code: "INVALID_REQUEST" });
    }
  }
  if ("filter" in value && !p2KnowledgeFilterSchema.safeParse(value["filter"]).success) {
    throw Object.assign(new Error("invalid filter"), { code: "INVALID_REQUEST" });
  }
  return value as unknown as P2ConsoleRequest;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactKey(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}:${hash(parts)}`;
}

function provenanceView(record: KnowledgeProvenanceRecord, knowledgeVersions: readonly { knowledgeId: string; version: number }[] = []) {
  return Object.freeze({ ...record, knowledgeVersions });
}

function evidenceVerdict(evidence: readonly EvidenceRef[]): EvidenceRef["verdict"] {
  if (evidence.some((item) => item.verdict === "CONTRADICTS")) return "CONTRADICTS";
  if (evidence.length > 0 && evidence.every((item) => item.verdict === "SUPPORTS")) return "SUPPORTS";
  return "INCONCLUSIVE";
}

function action(enabled: boolean, expectedRevision: number, idempotencyKey: string, reasonCode: string) {
  return Object.freeze({ enabled, expectedRevision, idempotencyKey, reasonCode });
}

function projectId(scope: KnowledgeScope): string | undefined {
  return "projectId" in scope ? scope.projectId : undefined;
}

export function ordinaryP2Scope(level: KnowledgeScope["level"]): P2ScopeLevel {
  if (level === "USER" || level === "TEAM") {
    throw Object.assign(new Error("unsupported ordinary governance scope"), { code: "CONFLICT" });
  }
  return level;
}

function stage(stageName: string, status: string, reasonCode: string, retryable = false) {
  return Object.freeze({ stage: stageName, status, reasonCode, retryable });
}

function policyStatus(decision: "PUBLISH" | "KEEP_PROPOSED" | "REQUIRE_CONFIRMATION" | "REJECT"): KnowledgeStatus {
  if (decision === "PUBLISH") return "ACCEPTED";
  if (decision === "REJECT") return "REJECTED";
  return "PROPOSED";
}

function ledgerRange(ledger: SqliteEventLedger, sessionId: string, from: number, to: number) {
  const span = to - from + 1;
  if (span < 1 || span > MAX_MANUAL_SEQUENCE_SPAN) {
    throw Object.assign(new Error("manual extraction sequence span exceeds the bounded scan limit"), { code: "CONFLICT" });
  }
  const records: LedgerEventRecord[] = [];
  let cursor = from - 1;
  while (cursor < to && records.length <= MAX_MANUAL_EXTRACTION_RECORDS) {
    const page = ledger.readAfter(cursor, Math.min(LEDGER_PAGE_SIZE, to - cursor));
    if (page.length === 0 || page[0]!.sequence !== cursor + 1) {
      throw Object.assign(new Error("manual extraction ledger range is incomplete"), { code: "CONFLICT" });
    }
    for (const item of page) {
      if (item.sequence > to) break;
      if (item.event.sessionId === sessionId) records.push(item);
      if (records.length > MAX_MANUAL_EXTRACTION_RECORDS) break;
    }
    cursor = Math.min(page.at(-1)!.sequence, to);
  }
  if (records.length > MAX_MANUAL_EXTRACTION_RECORDS) {
    throw Object.assign(new Error("manual extraction exceeds the maximum snapshot size"), { code: "CONFLICT" });
  }
  return records;
}

export class P2ConsoleRuntime {
  readonly #options: P2ConsoleRuntimeOptions;
  readonly #clock: () => Date;

  constructor(options: P2ConsoleRuntimeOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
  }

  async handle(request: P2ConsoleRequest): Promise<unknown> {
    switch (request.type) {
      case "p2.session.get": return this.sessionView(request.sessionId);
      case "p2.session.preview": return await this.#startPreview(request);
      case "p2.session.commit": return await this.#commit(request);
      case "p2.knowledge.list": return await this.#knowledgeList(request);
      case "p2.knowledge.get": return await this.#knowledgeDetail(request.knowledgeId);
      case "p2.knowledge.edit.preview": return await this.#editPreview(request);
      case "p2.knowledge.edit.commit": return await this.#editCommit(request);
      case "p2.knowledge.suppress": return await this.#suppress(request);
      case "p2.knowledge.restore": return await this.#restore(request);
      case "p2.knowledge.index.recover": return await this.#recoverIndex(request.knowledgeId);
    }
  }

  sessionView(sessionId: string) {
    const snapshot = this.#options.runtime.service().listSnapshots({ sessionId, limit: 1 }).items[0];
    const preview = snapshot === undefined ? undefined : this.#options.runtime.service().getCandidatePreviewForSnapshot(snapshot.snapshotId);
    const commit = preview === undefined ? undefined : this.#options.runtime.service().getPolicyCommitForPreview(preview.previewId);
    const checkpoint = snapshot === undefined ? undefined : this.#options.production.checkpoint(snapshot.snapshotId);
    const publicationJob = preview === undefined ? undefined : this.#options.runtime.publicationJobForPreview(preview.previewId);
    const currentRevision = this.#options.ledger.latestSequenceForSession(sessionId);
    const failedStage = checkpoint === undefined ? undefined : Object.entries(checkpoint.stages)
      .find(([, value]) => value.status === "FAILED")?.[1];
    const publicationStatus = publicationJob?.status === "SUCCEEDED" && checkpoint?.status === "COMPLETED" ? "SUCCEEDED"
      : publicationJob?.status === "FAILED" || checkpoint?.status === "FAILED" ? "FAILED"
        : commit === undefined || checkpoint === undefined || checkpoint.status === "AWAITING_COMMIT" ? "PENDING" : "RUNNING";
    const stages = [
      stage("SNAPSHOT", snapshot === undefined ? "PENDING" : "SUCCEEDED", snapshot === undefined ? "SNAPSHOT_NOT_CREATED" : "SNAPSHOT_IMMUTABLE"),
      stage("CANDIDATE_PREVIEW", preview === undefined ? (snapshot === undefined ? "PENDING" : "RUNNING") : "SUCCEEDED", preview === undefined ? "CANDIDATE_PREVIEW_PENDING" : "CANDIDATE_PREVIEW_READY", preview === undefined && snapshot !== undefined),
      stage("POLICY_COMMIT", commit === undefined ? "PENDING" : "SUCCEEDED", commit === undefined ? "EXPLICIT_COMMIT_REQUIRED" : "POLICY_COMMITTED"),
      stage(
        "KNOWLEDGE_PUBLICATION",
        publicationStatus,
        publicationStatus === "SUCCEEDED" ? "MARKDOWN_REGISTRY_INDEX_AND_PROVENANCE_COMMITTED"
          : publicationJob?.lastFailure?.code ?? failedStage?.error?.code
            ?? (checkpoint?.status === "AWAITING_COMMIT" ? "EXPLICIT_COMMIT_REQUIRED" : "PUBLICATION_PENDING"),
        publicationJob?.lastFailure?.retryable ?? failedStage?.error?.retryable ?? (publicationStatus === "RUNNING"),
      ),
    ];
    const candidates = (preview?.candidates ?? []).map((candidate) => {
      const root: ProvenanceNode = { type: "CANDIDATE", candidateId: candidate.candidateId };
      const trace = this.#trace(root);
      return Object.freeze({
        candidateId: candidate.candidateId,
        subjectKey: candidate.subjectKey,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        scope: ordinaryP2Scope(candidate.scope),
        confidence: candidate.confidence,
        status: policyStatus(candidate.policyDecision),
        evidenceVerdict: candidate.evidenceVerdict,
        policy: {
          action: candidate.policyDecision,
          targetStatus: policyStatus(candidate.policyDecision),
          shouldPublish: candidate.policyDecision === "PUBLISH",
          reasonCodes: candidate.policyReasonCodes,
        },
        provenance: trace,
      });
    });
    const published = candidates.flatMap((candidate) => candidate.provenance.knowledgeVersions.map(() => candidate.provenance));
    const snapshotView = snapshot === undefined ? undefined : {
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      completeness: snapshot.completeness.status,
      sourceSequenceFrom: snapshot.sourceSequence.from,
      sourceSequenceThrough: snapshot.sourceSequence.to,
      cursor: `${snapshot.cursor.byteOffset}:${snapshot.cursor.lineNumber}`,
      compilerVersion: snapshot.compilerVersion,
      policyHash: snapshot.policyHash,
      createdAt: snapshot.createdAt,
      unsupportedEventTypes: snapshot.completeness.unsupportedEventTypes,
    };
    return Object.freeze({
      sessionId,
      revision: currentRevision,
      ...(snapshotView === undefined ? {} : { snapshot: snapshotView }),
      stages,
      candidates,
      reverseProvenance: published,
      ...(preview === undefined ? {} : { previewId: preview.previewId }),
      extractAction: action(true, currentRevision, `extract:${sessionId}:${currentRevision}`, "ACTION_READY"),
      commitAction: action(preview !== undefined && commit === undefined, preview?.revision ?? 0, preview === undefined ? "commit:unavailable" : `commit:${preview.previewId}:${preview.revision}`, preview === undefined ? "PREVIEW_NOT_READY" : commit === undefined ? "ACTION_READY" : "POLICY_ALREADY_COMMITTED"),
    });
  }

  async #startPreview(request: Extract<P2ConsoleRequest, { type: "p2.session.preview" }>) {
    const revision = this.#options.ledger.latestSequenceForSession(request.sessionId);
    if (request.expectedRevision !== revision || request.idempotencyKey !== `extract:${request.sessionId}:${revision}`) {
      throw Object.assign(new Error("session extraction revision is stale"), { code: "STALE_REVISION" });
    }
    const source = await this.#options.inspectTranscriptSource(request.sessionId);
    const captured = this.#options.ledger.loadIngestionCursor<TranscriptCursor>(`codex-transcript:${request.sessionId}`);
    if (captured === undefined || source.projectedEvents !== 0 || source.hasMore
      || captured.cursor.byteOffset !== source.cursor.byteOffset || captured.cursor.lineNumber !== source.cursor.lineNumber) {
      throw Object.assign(new Error("capture must be current before extraction"), { code: "CONFLICT" });
    }
    const previous = this.#options.runtime.service().listSnapshots({ sessionId: request.sessionId, limit: 1 }).items[0];
    const policyHash = hash(DEFAULT_CONFIGURATION.verification);
    const configurationHash = this.#options.configurationHash();
    const previousMatchesPipeline = previous !== undefined
      && previous.transcriptIdentityHash === source.transcriptIdentityHash
      && previous.compilerVersion === COMPILER_VERSION
      && previous.policyHash === policyHash
      && previous.configurationHash === configurationHash;
    const fromSequence = (previous?.sourceSequence.to ?? 0) + 1;
    if (fromSequence > revision && previousMatchesPipeline) return this.sessionView(request.sessionId);
    let records = fromSequence > revision
      ? []
      : ledgerRange(this.#options.ledger, request.sessionId, fromSequence, revision);
    if (records.length === 0 && previousMatchesPipeline) return this.sessionView(request.sessionId);
    if (records.length === 0 && previous !== undefined) {
      // A compiler/policy/configuration revision must be able to recompile the
      // same immutable source range. It creates a new snapshot identity and
      // never mutates or aliases the previous failed run.
      records = ledgerRange(
        this.#options.ledger,
        request.sessionId,
        previous.sourceSequence.from,
        previous.sourceSequence.to,
      );
    }
    if (records.length === 0) throw Object.assign(new Error("captured session contains no extractable events"), { code: "CONFLICT" });
    const from = records[0]!.sequence;
    const to = records.at(-1)!.sequence;
    const sourceClosed = records.at(-1)?.event.eventType === "session.ended" && source.ignoredRecords === 0;
    const completeness = {
      status: sourceClosed ? "COMPLETE_SNAPSHOT" as const : "PARTIAL_SNAPSHOT" as const,
      sourceClosed,
      unsupportedEventTypes: source.ignoredRecords === 0 ? [] : ["unsupported_transcript_record"],
    };
    const draft = {
      schemaVersion: 1 as const,
      requestId: request.requestId,
      type: "extraction.snapshot.create" as const,
      sessionId: request.sessionId,
      expectedCaptureRevision: revision,
      transcriptIdentityHash: source.transcriptIdentityHash,
      sourceSequence: { from, to },
      cursor: source.cursor,
      completeness,
      compilerVersion: COMPILER_VERSION,
      policyHash,
      configurationHash,
    };
    const created = await this.#options.runtime.createSnapshot({ ...draft, idempotencyKey: snapshotIdempotencyKey(draft) });
    const previewRequest = p2PreviewRequest(created.snapshot, request.requestId);
    await this.#options.runtime.enqueueCandidatePreview(previewRequest);
    return this.sessionView(request.sessionId);
  }

  async #commit(request: Extract<P2ConsoleRequest, { type: "p2.session.commit" }>) {
    const preview = this.#options.runtime.service().getCandidatePreview(request.previewId);
    if (preview === undefined || preview.revision !== request.expectedPreviewRevision
      || request.idempotencyKey !== `commit:${preview.previewId}:${preview.revision}`) {
      throw Object.assign(new Error("candidate preview revision is stale"), { code: "STALE_REVISION" });
    }
    const snapshot = this.#options.runtime.service().getSnapshot(preview.snapshot.snapshotId);
    if (snapshot === undefined || snapshot.sessionId !== request.sessionId) throw Object.assign(new Error("snapshot not found"), { code: "NOT_FOUND" });
    const commitRequest = p2CommitRequest(snapshot, preview.previewId, preview.revision, request.requestId);
    await this.#options.runtime.enqueuePolicyCommit(commitRequest);
    return this.sessionView(request.sessionId);
  }

  async #knowledgeList(request: Extract<P2ConsoleRequest, { type: "p2.knowledge.list" }>) {
    const filter: KnowledgeListFilter = {
      ...(request.filter?.scope === undefined ? {} : { scopeLevels: [request.filter.scope] }),
      ...(request.filter?.projectId === undefined ? {} : { projectId: request.filter.projectId }),
      ...(request.filter?.kind === undefined ? {} : { kinds: [request.filter.kind] }),
      ...(request.filter?.status === undefined ? {} : { statuses: [request.filter.status] }),
      ...(request.filter?.subject === undefined ? {} : { subject: request.filter.subject }),
      ...(request.filter?.symbol === undefined ? {} : { symbol: request.filter.symbol }),
      ...(request.filter?.keyword === undefined ? {} : { keyword: request.filter.keyword }),
      ...(request.filter?.evidenceVerdict === undefined ? {} : { evidenceVerdict: request.filter.evidenceVerdict }),
      ...(request.filter?.version === undefined ? {} : { version: request.filter.version }),
      ...(request.filter?.eligible === undefined ? {} : { eligibleOnly: request.filter.eligible }),
      ...(request.filter?.eligible === false ? { includeSuppressed: true } : {}),
    };
    const response = await this.#options.production.query.list({ filter, limit: request.limit ?? 50, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) });
    const items = response.items
      .filter(({ current }) => current.asset.scope.level !== "USER" && current.asset.scope.level !== "TEAM")
      .filter((item) => request.filter?.eligible !== false || !item.eligible).map(({ current, eligible, eligibilityReasonCodes }) => ({
      knowledgeId: current.asset.id,
      version: current.asset.version,
      subjectKey: current.asset.subjectKey,
      title: current.asset.title,
      summary: current.asset.summary,
      scope: ordinaryP2Scope(current.asset.scope.level),
      ...(projectId(current.asset.scope) === undefined ? {} : { projectId: projectId(current.asset.scope) }),
      kind: current.asset.kind,
      status: current.asset.status,
      confidence: current.asset.confidence,
      evidenceVerdict: evidenceVerdict(current.asset.evidence),
      eligible,
      eligibilityReasonCodes,
      updatedAt: current.asset.updatedAt,
    }));
    return Object.freeze({
      revision: this.#options.production.registry.activeIndexVersion,
      items,
      ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
      indexStatus: "READY",
      indexReasonCode: "INDEX_CURRENT",
      retryable: false,
    });
  }

  async #knowledgeDetail(knowledgeId: string) {
    const detail = await this.#options.production.query.detail(knowledgeId);
    return this.#detailView(detail);
  }

  #detailView(detail: KnowledgeDetail) {
    const asset = detail.current.asset;
    const provenance = provenanceView(detail.provenance, [{ knowledgeId: asset.id, version: asset.version }]);
    const versions = detail.versions.map((item, index) => ({
      version: item.asset.version,
      status: item.asset.status,
      createdAt: item.asset.updatedAt,
      reasonCode: item.tombstone ? "GOVERNANCE_SUPPRESSED" : index === 0 ? "KNOWLEDGE_CREATED" : "KNOWLEDGE_REVISED",
      markdown: item.asset.body,
      ...(index === 0 ? {} : { diffFromPrevious: `v${item.asset.version - 1} → v${item.asset.version}` }),
    }));
    const suppressed = detail.current.tombstone;
    const eligible = !suppressed && ["ACCEPTED", "IMPLEMENTED", "VERIFIED"].includes(asset.status)
      && !this.#options.production.governanceStore.isExcluded(asset.id);
    return Object.freeze({
      revision: detail.current.indexVersion,
      knowledgeId: asset.id,
      version: asset.version,
      title: asset.title,
      summary: asset.summary,
      subjectKey: asset.subjectKey,
      kind: asset.kind,
      scope: ordinaryP2Scope(asset.scope.level),
      ...(projectId(asset.scope) === undefined ? {} : { projectId: projectId(asset.scope) }),
      status: asset.status,
      confidence: asset.confidence,
      eligible,
      eligibilityReasonCodes: [...(suppressed ? ["GOVERNANCE_SUPPRESSED"] : []), ...(!eligible && !suppressed ? ["STATUS_NOT_ELIGIBLE"] : [])],
      markdown: asset.body,
      scopeReasonCodes: detail.scopeReasonCodes,
      assertions: detail.assertions.map((text, index) => ({ assertionId: `assertion-${index + 1}`, text, status: "INCONCLUSIVE" })),
      evidence: detail.evidence.map((item) => ({ evidenceId: item.evidenceId, verdict: item.verdict, source: item.evidenceId, reasonCode: "EVIDENCE_PROJECTED" })),
      relations: detail.relations.map((relation) => {
        const related = this.#options.production.registry.getAsset(relation.targetId, true);
        return { relation: relation.type, knowledgeId: relation.targetId, version: relation.targetVersion ?? related?.asset.version ?? 1, title: related?.asset.title ?? relation.targetId };
      }),
      provenance,
      lifecycle: versions.map((item) => ({ status: item.status, occurredAt: item.createdAt, reasonCode: item.reasonCode })),
      usage: detail.usage.map((item) => ({ sessionId: "", turnId: "", mode: item.kind, occurredAt: item.occurredAt })),
      versions,
      editAction: action(!suppressed, asset.version, `edit:${asset.id}:${asset.version}`, suppressed ? "KNOWLEDGE_SUPPRESSED" : "ACTION_READY"),
      suppressAction: action(!suppressed, asset.version, `suppress:${asset.id}:${asset.version}`, suppressed ? "ALREADY_SUPPRESSED" : "ACTION_READY"),
      restoreAction: action(suppressed, asset.version, `restore:${asset.id}:${asset.version}`, suppressed ? "ACTION_READY" : "NOT_SUPPRESSED"),
    });
  }

  async #editPreview(request: Extract<P2ConsoleRequest, { type: "p2.knowledge.edit.preview" }>) {
    const key = exactKey("edit-preview", [request.idempotencyKey, request.draft]);
    const draft = await this.#options.production.mutations.createEditDraft({
      assetId: request.knowledgeId,
      expectedVersion: request.expectedVersion,
      idempotencyKey: key,
      patch: { title: request.draft.title, summary: request.draft.summary, body: request.draft.markdown },
      correlationId: `console-edit-${randomUUID()}`,
      actor: "local-console",
      now: this.#clock().toISOString(),
    });
    return Object.freeze({
      knowledgeId: draft.assetId,
      basedOnVersion: draft.expectedVersion,
      proposedVersion: draft.proposed.version,
      changedFields: draft.impact.changes.map((item) => item.field),
      scopeChanged: draft.impact.scopeChanged,
      evidenceDowngraded: draft.impact.evidenceDowngraded,
      eligibleBefore: draft.impact.currentEligible,
      eligibleAfter: draft.impact.nextEligible,
      reasonCodes: draft.impact.reasonCodes,
      draft: request.draft,
    });
  }

  async #editCommit(request: Extract<P2ConsoleRequest, { type: "p2.knowledge.edit.commit" }>) {
    const key = exactKey("edit-preview", [request.idempotencyKey, request.draft]);
    let draft = this.#options.production.governanceStore.getDraftByIdempotencyKey(key);
    if (draft === undefined) {
      await this.#editPreview({ ...request, type: "p2.knowledge.edit.preview" });
      draft = this.#options.production.governanceStore.getDraftByIdempotencyKey(key);
    }
    if (draft === undefined) throw new GovernanceError("NOT_FOUND", "edit draft was not found");
    const operation = await this.#options.production.mutations.commitEditDraft({
      draftId: draft.draftId,
      expectedVersion: request.expectedVersion,
      idempotencyKey: exactKey("edit-commit", [request.idempotencyKey, request.draft]),
      actor: "local-console",
      now: this.#clock().toISOString(),
    });
    if (operation.status !== "COMPLETED") {
      const failed = Object.entries(operation.stages).find(([, value]) => value.status === "FAILED" || value.status === "RETRYABLE");
      throw new GovernanceError("OUTBOX_FAILED", `edit publication is incomplete${failed === undefined ? "" : `: ${failed[0]}:${failed[1].errorCode ?? "UNKNOWN"}:${failed[1].errorMessage ?? "no detail"}`}`, true);
    }
    return await this.#knowledgeDetail(request.knowledgeId);
  }

  async #suppress(request: Extract<P2ConsoleRequest, { type: "p2.knowledge.suppress" }>) {
    const operation = await this.#options.production.mutations.suppress({
      assetId: request.knowledgeId, expectedVersion: request.expectedVersion,
      idempotencyKey: exactKey("suppress", [request.idempotencyKey, request.reason]),
      correlationId: `console-suppress-${randomUUID()}`, actor: "local-console", now: this.#clock().toISOString(), reason: request.reason,
    });
    if (operation.status !== "COMPLETED") throw new GovernanceError("OUTBOX_FAILED", "suppression publication is incomplete", true);
    return await this.#knowledgeDetail(request.knowledgeId);
  }

  async #restore(request: Extract<P2ConsoleRequest, { type: "p2.knowledge.restore" }>) {
    const versions = this.#options.production.registry.listVersions(request.knowledgeId);
    const source = [...versions].reverse().find((item) => !item.tombstone);
    if (source === undefined) throw new GovernanceError("NOT_FOUND", "restoration source was not found");
    const operation = await this.#options.production.mutations.restore({
      assetId: request.knowledgeId, expectedVersion: request.expectedVersion,
      idempotencyKey: exactKey("restore", [request.idempotencyKey, request.reason, source.asset.version]),
      correlationId: `console-restore-${randomUUID()}`, actor: "local-console", now: this.#clock().toISOString(), sourceVersion: source.asset.version,
    });
    if (operation.status !== "COMPLETED") throw new GovernanceError("OUTBOX_FAILED", "restoration publication is incomplete", true);
    return await this.#knowledgeDetail(request.knowledgeId);
  }

  async #recoverIndex(knowledgeId: string) {
    const result = await this.#options.production.recoverIndex(knowledgeId);
    return Object.freeze({ knowledgeId, action: result.action, assetVersion: result.assetVersion, indexVersion: result.indexVersion, diagnostics: result.diagnostics });
  }

  #trace(root: ProvenanceNode) {
    const queue = [root];
    const seen = new Set<string>();
    const record = {
      sessionIds: new Set<string>(), turnIds: new Set<string>(), eventIds: new Set<string>(),
      snapshotIds: new Set<string>(), episodeIds: new Set<string>(), knowledgeVersions: new Map<string, { knowledgeId: string; version: number }>(),
    };
    while (queue.length > 0 && seen.size < MAX_PROVENANCE_VISITS) {
      const node = queue.shift();
      if (node === undefined) break;
      const key = JSON.stringify(node);
      if (seen.has(key)) continue;
      seen.add(key);
      if (node.type === "SESSION") record.sessionIds.add(node.sessionId);
      if (node.type === "TURN") { record.sessionIds.add(node.sessionId); record.turnIds.add(node.turnId); }
      if (node.type === "EVENT") { record.sessionIds.add(node.sessionId); record.eventIds.add(node.eventId); if (node.turnId !== undefined) record.turnIds.add(node.turnId); }
      if (node.type === "SNAPSHOT") record.snapshotIds.add(node.snapshotId);
      if (node.type === "EPISODE") record.episodeIds.add(node.episodeId);
      if (node.type === "KNOWLEDGE_VERSION") {
        const value = { knowledgeId: node.knowledge.id, version: node.knowledge.version };
        record.knowledgeVersions.set(`${value.knowledgeId}@${value.version}`, value);
      }
      const page = this.#options.runtime.service().getProvenance({ root: node, limit: 100 });
      for (const edge of page.upstream) queue.push(edge.from);
      for (const edge of page.downstream) queue.push(edge.to);
    }
    return Object.freeze({
      sessionIds: [...record.sessionIds].sort(), turnIds: [...record.turnIds].sort(), eventIds: [...record.eventIds].sort(),
      snapshotIds: [...record.snapshotIds].sort(), episodeIds: [...record.episodeIds].sort(), knowledgeVersions: [...record.knowledgeVersions.values()],
    });
  }
}
