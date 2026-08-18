import { createHash } from "node:crypto";

import type { CapturePreview } from "@zhiloop/control-api";
import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { TranscriptCursor } from "@zhiloop/codex-session-capture";
import type { LedgerEventRecord, SqliteEventLedger } from "@zhiloop/conversation-ledger";
import {
  DEFAULT_MVP_COMPILER_VERSION,
  DEFAULT_MVP_PROMPT_VERSION,
} from "@zhiloop/knowledge-compiler";
import {
  automaticPreviewIdempotencyKey,
  type AutomaticPreviewDispatchRequest,
  type AutomaticPreviewDispatchResult,
  type CompilationDispatchPort,
  type CompilationObservationPort,
  type CompilationSessionObservation,
  type KnowledgeCompilationPipelineIdentity,
} from "@zhiloop/knowledge-compilation-scheduler";
import type { SessionCatalogEntry, SessionCatalogQueryPort } from "@zhiloop/session-catalog";
import { snapshotIdempotencyKey } from "@zhiloop/session-extraction";

import { p2PreviewRequest, type P2SidecarRuntime } from "./p2-runtime.js";

const LEDGER_PAGE_SIZE = 1_000;
const MAX_EXTRACTION_RECORDS = 5_000;
const MAX_SEQUENCE_SPAN = 50_000;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ledgerRange(ledger: SqliteEventLedger, sessionId: string, from: number, to: number) {
  const span = to - from + 1;
  if (span < 1 || span > MAX_SEQUENCE_SPAN) {
    throw Object.assign(new Error("extraction sequence span exceeds the bounded scan limit"), { code: "CONFLICT" });
  }
  const records: LedgerEventRecord[] = [];
  let cursor = from - 1;
  while (cursor < to && records.length <= MAX_EXTRACTION_RECORDS) {
    const page = ledger.readAfter(cursor, Math.min(LEDGER_PAGE_SIZE, to - cursor));
    if (page.length === 0 || page[0]!.sequence !== cursor + 1) {
      throw Object.assign(new Error("extraction ledger range is incomplete"), { code: "CONFLICT" });
    }
    for (const item of page) {
      if (item.sequence > to) break;
      if (item.event.sessionId === sessionId) records.push(item);
      if (records.length > MAX_EXTRACTION_RECORDS) break;
    }
    cursor = Math.min(page.at(-1)!.sequence, to);
  }
  if (records.length > MAX_EXTRACTION_RECORDS) {
    throw Object.assign(new Error("extraction exceeds the maximum snapshot size"), { code: "CONFLICT" });
  }
  return records;
}

export const P2_COMPILATION_PIPELINE: Readonly<KnowledgeCompilationPipelineIdentity> = Object.freeze({
  compilerVersion: DEFAULT_MVP_COMPILER_VERSION,
  promptVersion: DEFAULT_MVP_PROMPT_VERSION,
  policyHash: hash(DEFAULT_CONFIGURATION.verification),
  configurationHash: "dynamic",
});

export type PreviewCoordinationResult =
  | {
      readonly status: "ENQUEUED" | "EXISTING";
      readonly snapshotId: string;
      readonly jobId: string;
      readonly compiledThroughSequence: number;
    }
  | { readonly status: "CURRENT"; readonly compiledThroughSequence: number }
  | {
      readonly status: "STALE";
      readonly reasonCode: "CAPTURE_NOT_CURRENT" | "LEDGER_CHANGED";
    }
  | {
      readonly status: "INELIGIBLE";
      readonly reasonCode: "NO_EXTRACTABLE_EVENTS" | "UNSUPPORTED_SOURCE";
    };

export interface P2CandidatePreviewCoordinatorOptions {
  readonly runtime: P2SidecarRuntime;
  readonly ledger: SqliteEventLedger;
  readonly inspectTranscriptSource: (sessionId: string) => Promise<CapturePreview>;
  readonly configurationHash: () => string;
}

export interface P2CandidatePreviewPort {
  pipelineIdentity(): KnowledgeCompilationPipelineIdentity;
  coordinate(request: {
    readonly sessionId: string;
    readonly expectedLedgerSequence: number;
    readonly requestId: string;
  }): Promise<PreviewCoordinationResult>;
}

/** Shared immutable Snapshot + Candidate Preview flow for manual and automatic callers. */
export class P2CandidatePreviewCoordinator implements P2CandidatePreviewPort {
  constructor(private readonly options: P2CandidatePreviewCoordinatorOptions) {}

  pipelineIdentity(): KnowledgeCompilationPipelineIdentity {
    return Object.freeze({ ...P2_COMPILATION_PIPELINE, configurationHash: this.options.configurationHash() });
  }

  async coordinate(request: {
    readonly sessionId: string;
    readonly expectedLedgerSequence: number;
    readonly requestId: string;
  }): Promise<PreviewCoordinationResult> {
    const revision = this.options.ledger.latestSequenceForSession(request.sessionId);
    if (revision !== request.expectedLedgerSequence) return Object.freeze({ status: "STALE", reasonCode: "LEDGER_CHANGED" });
    let source: CapturePreview;
    try {
      source = await this.options.inspectTranscriptSource(request.sessionId);
    } catch {
      return Object.freeze({ status: "INELIGIBLE", reasonCode: "UNSUPPORTED_SOURCE" });
    }
    const captured = this.options.ledger.loadIngestionCursor<TranscriptCursor>(`codex-transcript:${request.sessionId}`);
    if (captured === undefined || source.projectedEvents !== 0 || source.hasMore
      || captured.cursor.byteOffset !== source.cursor.byteOffset || captured.cursor.lineNumber !== source.cursor.lineNumber) {
      return Object.freeze({ status: "STALE", reasonCode: "CAPTURE_NOT_CURRENT" });
    }

    const previous = this.options.runtime.service().listSnapshots({ sessionId: request.sessionId, limit: 1 }).items[0];
    const pipeline = this.pipelineIdentity();
    const previousMatchesPipeline = previous !== undefined
      && previous.transcriptIdentityHash === source.transcriptIdentityHash
      && previous.compilerVersion === pipeline.compilerVersion
      && previous.policyHash === pipeline.policyHash
      && previous.configurationHash === pipeline.configurationHash;
    const fromSequence = (previous?.sourceSequence.to ?? 0) + 1;
    if (fromSequence > revision && previousMatchesPipeline) {
      return Object.freeze({ status: "CURRENT", compiledThroughSequence: revision });
    }
    let records = fromSequence > revision
      ? []
      : ledgerRange(this.options.ledger, request.sessionId, fromSequence, revision);
    if (records.length === 0 && previousMatchesPipeline) {
      return Object.freeze({ status: "CURRENT", compiledThroughSequence: revision });
    }
    if (records.length === 0 && previous !== undefined) {
      records = ledgerRange(
        this.options.ledger,
        request.sessionId,
        previous.sourceSequence.from,
        previous.sourceSequence.to,
      );
    }
    if (records.length === 0) return Object.freeze({ status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" });
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
      compilerVersion: pipeline.compilerVersion,
      policyHash: pipeline.policyHash,
      configurationHash: pipeline.configurationHash,
    };
    const created = await this.options.runtime.createSnapshot({ ...draft, idempotencyKey: snapshotIdempotencyKey(draft) });
    const existingJob = this.options.runtime.candidatePreviewJobForSnapshot(created.snapshot.snapshotId);
    const job = await this.options.runtime.enqueueCandidatePreview(p2PreviewRequest(created.snapshot, request.requestId));
    return Object.freeze({
      status: created.status === "EXISTING" && existingJob !== undefined ? "EXISTING" : "ENQUEUED",
      snapshotId: created.snapshot.snapshotId,
      jobId: job.jobId,
      compiledThroughSequence: revision,
    });
  }
}

export class P2AutomaticCompilationAdapter implements CompilationObservationPort, CompilationDispatchPort {
  constructor(
    private readonly catalog: Pick<SessionCatalogQueryPort, "get">,
    private readonly ledger: SqliteEventLedger,
    private readonly coordinator: P2CandidatePreviewPort,
  ) {}

  async inspect(session: SessionCatalogEntry): Promise<CompilationSessionObservation> {
    const stats = this.ledger.sessionStats(session.sessionId);
    return Object.freeze({
      sessionId: session.sessionId,
      ledgerSequence: stats.latestSequence,
      effectiveEventCount: stats.eventCount,
      effectiveTurnCount: stats.turnCount,
      ...(stats.latestEventType === undefined ? {} : { latestEventType: stats.latestEventType }),
      ...(session.sourceVersion === undefined ? {} : { sourceVersion: session.sourceVersion }),
      lastActivityAt: stats.lastOccurredAt ?? session.lastActivityAt,
    });
  }

  async dispatchPreview(request: AutomaticPreviewDispatchRequest): Promise<AutomaticPreviewDispatchResult> {
    if (request.executionMode !== "PREVIEW_ONLY") throw Object.assign(new Error("automatic compilation must be PREVIEW_ONLY"), { retryable: false });
    const pipeline = this.coordinator.pipelineIdentity();
    if (request.compilerVersion !== pipeline.compilerVersion
      || request.promptVersion !== pipeline.promptVersion
      || request.policyHash !== pipeline.policyHash
      || request.configurationHash !== pipeline.configurationHash) {
      return Object.freeze({ status: "STALE", reasonCode: "SOURCE_CHANGED" });
    }
    const expectedIdempotencyKey = automaticPreviewIdempotencyKey({
      sessionId: request.sessionId,
      expectedLedgerSequence: request.expectedLedgerSequence,
      ...(request.sourceVersion === undefined ? {} : { sourceVersion: request.sourceVersion }),
      pipeline,
    });
    if (request.idempotencyKey !== expectedIdempotencyKey) {
      throw Object.assign(new Error("automatic compilation idempotency key is invalid"), { retryable: false });
    }
    const current = await this.catalog.get(request.sessionId);
    if (current === undefined || current.sourceStatus !== "AVAILABLE") {
      return Object.freeze({ status: "INELIGIBLE", reasonCode: "UNSUPPORTED_SOURCE" });
    }
    if (current.captureStatus !== "CAPTURED_CURRENT") {
      return Object.freeze({ status: "STALE", reasonCode: "CAPTURE_NOT_CURRENT" });
    }
    if ((request.sourceVersion ?? null) !== (current.sourceVersion ?? null)) {
      return Object.freeze({ status: "STALE", reasonCode: "SOURCE_CHANGED" });
    }
    const requestId = `auto-${request.idempotencyKey.slice(-64)}`;
    return await this.coordinator.coordinate({
      sessionId: request.sessionId,
      expectedLedgerSequence: request.expectedLedgerSequence,
      requestId,
    });
  }
}
