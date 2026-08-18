import { createHash } from "node:crypto";
import { join } from "node:path";

import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { LedgerEventRecord, SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { KnowledgeAssertion, KnowledgeAsset, KnowledgeCandidate, ProjectContext } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";
import {
  KnowledgeGovernanceMutationService,
  KnowledgeGovernanceQueryService,
  SqliteGovernanceOperationStore,
  type KnowledgeMetadataPort,
  type KnowledgeProvenanceRecord,
  type KnowledgeRevalidationPort,
} from "@zhiloop/knowledge-governance-service";
import { IncrementalKnowledgeIndexer } from "@zhiloop/knowledge-indexer";
import { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import {
  DEFAULT_MVP_COMPILER_VERSION,
  DEFAULT_MVP_PROMPT_VERSION,
  MvpKnowledgeCompiler,
  type KnowledgeExtractionPort,
} from "@zhiloop/knowledge-compiler";
import {
  KnowledgeWorkerRuntime,
  SqliteKnowledgeWorkerCheckpointStore,
  type EvidenceVerificationPort,
  type KnowledgeWorkerRunRequest,
  type LedgerSnapshotPort,
} from "@zhiloop/knowledge-worker-runtime";
import { MarkdownKnowledgeRepository } from "@zhiloop/markdown-repository";
import { CodexExecStructuredGenerationModel } from "@zhiloop/model-codex-exec";
import type { ExtractionSnapshot, ProvenanceNode } from "@zhiloop/control-api";
import type { SessionExtractionService } from "@zhiloop/session-extraction";

import type { P2KnowledgeWorkerComposition } from "./p2-runtime.js";

const LEDGER_PAGE_SIZE = 1_000;
const MAX_SNAPSHOT_RECORDS = 5_000;
const MAX_SNAPSHOT_SEQUENCE_SPAN = 50_000;
const MAX_PROVENANCE_VISITS = 1_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workId(snapshotId: string): string {
  return `knowledge-${snapshotId}`;
}

export function readP2SnapshotRecords(
  ledger: SqliteEventLedger,
  snapshot: Pick<ExtractionSnapshot, "sessionId" | "sourceSequence">,
  resultLimit: number,
): readonly LedgerEventRecord[] {
  if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > MAX_SNAPSHOT_RECORDS + 1) {
    throw Object.assign(new Error("snapshot result limit is invalid"), { retryable: false, code: "SNAPSHOT_LIMIT_INVALID" });
  }
  const span = snapshot.sourceSequence.to - snapshot.sourceSequence.from + 1;
  if (span < 1 || span > MAX_SNAPSHOT_SEQUENCE_SPAN) {
    throw Object.assign(new Error("snapshot sequence span exceeds the bounded scan limit"), { retryable: false, code: "SNAPSHOT_SPAN_EXCEEDED" });
  }
  const records: LedgerEventRecord[] = [];
  let cursor = snapshot.sourceSequence.from - 1;
  while (cursor < snapshot.sourceSequence.to && records.length < resultLimit) {
    const page = ledger.readAfter(cursor, Math.min(LEDGER_PAGE_SIZE, snapshot.sourceSequence.to - cursor));
    if (page.length === 0 || page[0]!.sequence !== cursor + 1) {
      throw Object.assign(new Error("snapshot ledger range is incomplete"), { retryable: false, code: "SNAPSHOT_RANGE_INCOMPLETE" });
    }
    for (const record of page) {
      if (record.sequence > snapshot.sourceSequence.to) break;
      if (record.event.sessionId === snapshot.sessionId) records.push(record);
      if (records.length === resultLimit) break;
    }
    cursor = Math.min(page.at(-1)!.sequence, snapshot.sourceSequence.to);
  }
  return records;
}

export function deriveP2ProjectContext(snapshot: ExtractionSnapshot, ledger: SqliteEventLedger, fallbackRoot: string): ProjectContext {
  const records = readP2SnapshotRecords(ledger, snapshot, MAX_SNAPSHOT_RECORDS + 1);
  if (records.length > MAX_SNAPSHOT_RECORDS) {
    throw Object.assign(new Error("snapshot contains more records than the bounded compiler input"), {
      retryable: false,
      code: "SNAPSHOT_RECORD_LIMIT_EXCEEDED",
    });
  }
  const projectHint = records.find(({ event }) => event.projectHint !== undefined)?.event.projectHint;
  const cwd = records.find(({ event }) => event.cwd !== undefined)?.event.cwd;
  const repositoryRoot = cwd ?? fallbackRoot;
  const identitySource = projectHint === undefined
    ? cwd === undefined ? ["fallback-state-root", fallbackRoot] : ["event-cwd", cwd]
    : ["event-project-hint", projectHint];
  return Object.freeze({
    projectId: `project-${sha256(JSON.stringify(identitySource)).slice(0, 24)}`,
    repositoryRoot,
    portable: false,
  });
}

function evidenceFor(assertion: KnowledgeAssertion, candidate: KnowledgeCandidate, project: ProjectContext, at: string): VerificationResult {
  const userAssertion = assertion.kind === "USER_ACCEPTED" || assertion.kind === "USER_REJECTED";
  const status = userAssertion ? (assertion.kind === "USER_ACCEPTED" ? "SUPPORTED" : "REFUTED") : "UNKNOWN";
  const sourceRef = userAssertion ? assertion.parameters.statementRef : assertion.assertionId;
  const verdict = status === "SUPPORTED" ? "SUPPORTS" as const : status === "REFUTED" ? "CONTRADICTS" as const : "INCONCLUSIVE" as const;
  return Object.freeze({
    assertionId: assertion.assertionId,
    assertionKind: assertion.kind,
    verifierId: userAssertion ? "snapshot-user-statement-v1" : "snapshot-bounded-v1",
    status,
    target: sourceRef,
    observedAt: at,
    reasonCodes: [userAssertion ? "SNAPSHOT_SOURCE_OBSERVED" : "VERIFICATION_SOURCE_UNAVAILABLE"],
    ...(userAssertion ? {
      evidence: {
        evidenceId: `ev_${sha256(JSON.stringify([assertion.assertionId, sourceRef, project.projectId, at]))}`,
        assertionId: assertion.assertionId,
        type: "USER_STATEMENT" as const,
        verdict,
        sourceRef,
        projectId: project.projectId,
        observedAt: at,
        correlationId: candidate.correlationId,
      },
    } : {}),
  });
}

function extractionMetadata(service: () => SessionExtractionService): KnowledgeMetadataPort {
  const traverse = (assetId: string, version: number): KnowledgeProvenanceRecord => {
    const queue: ProvenanceNode[] = [{ type: "KNOWLEDGE_VERSION", knowledge: { id: assetId, version } }];
    const seen = new Set<string>();
    const values = {
      snapshotIds: new Set<string>(), episodeIds: new Set<string>(), sessionIds: new Set<string>(),
      turnIds: new Set<string>(), eventIds: new Set<string>(),
    };
    while (queue.length > 0 && seen.size < MAX_PROVENANCE_VISITS) {
      const node = queue.shift();
      if (node === undefined) break;
      const key = JSON.stringify(node);
      if (seen.has(key)) continue;
      seen.add(key);
      if (node.type === "SNAPSHOT") values.snapshotIds.add(node.snapshotId);
      if (node.type === "EPISODE") values.episodeIds.add(node.episodeId);
      if (node.type === "SESSION") values.sessionIds.add(node.sessionId);
      if (node.type === "TURN") { values.sessionIds.add(node.sessionId); values.turnIds.add(node.turnId); }
      if (node.type === "EVENT") {
        values.sessionIds.add(node.sessionId);
        values.eventIds.add(node.eventId);
        if (node.turnId !== undefined) values.turnIds.add(node.turnId);
      }
      const page = service().getProvenance({ root: node, limit: 100 });
      for (const edge of page.upstream) queue.push(edge.from);
      for (const edge of page.downstream) queue.push(edge.to);
    }
    return Object.freeze({
      snapshotIds: [...values.snapshotIds].sort(), episodeIds: [...values.episodeIds].sort(),
      sessionIds: [...values.sessionIds].sort(), turnIds: [...values.turnIds].sort(), eventIds: [...values.eventIds].sort(),
    });
  };
  return {
    getProvenance: (assetId, version) => traverse(assetId, version),
    getUsage: () => [],
    getAssertions: () => [],
    getScopeReasonCodes: () => ["PROJECT_BOUND_SNAPSHOT"],
    getLifecycle: () => [],
    getLastVerifiedAt: () => undefined,
  };
}

function revalidation(): KnowledgeRevalidationPort {
  return {
    revalidate: async (current: KnowledgeAsset, draft: KnowledgeAsset) => {
      const projectBound = "projectId" in draft.scope && draft.scope.projectId !== undefined;
      const contentChanged = current.title !== draft.title || current.summary !== draft.summary || current.body !== draft.body;
      const hasSupportingEvidence = draft.evidence.some(({ verdict }) => verdict === "SUPPORTS");
      const hasContradictingEvidence = draft.evidence.some(({ verdict }) => verdict === "CONTRADICTS");
      // Existing evidence proves the content it was collected for. A manual
      // content edit must be reverified before it can remain retrieval eligible.
      const evidenceSupported = !contentChanged && hasSupportingEvidence && !hasContradictingEvidence;
      return Object.freeze({
        scopeValid: projectBound,
        evidenceSupported,
        evidence: draft.evidence,
        reasonCodes: [
          projectBound ? "PROJECT_SCOPE_REVALIDATED" : "PROJECT_SCOPE_REQUIRED",
          ...(contentChanged ? ["CONTENT_CHANGED_REQUIRES_REVALIDATION"] : []),
          ...(hasContradictingEvidence ? ["CONTRADICTING_EVIDENCE_PRESENT"] : []),
          evidenceSupported ? "SUPPORTING_EVIDENCE_REVALIDATED" : "EVIDENCE_NOT_SUFFICIENT",
        ],
      });
    },
  };
}

export interface P2ProductionCompositionOptions {
  readonly stateDirectory: string;
  readonly ledger: SqliteEventLedger;
  readonly extraction: () => SessionExtractionService;
  readonly compilerTimeoutMs: number;
  readonly compilerBatchSize: number;
  readonly compiler?: KnowledgeExtractionPort;
  readonly compilerExecutable?: string;
  readonly compilerModel?: string;
  readonly compilerIgnoreUserConfig?: boolean;
}

/** Owns the P2 Markdown/Registry/index boundary shared by compile and governance. */
export class P2ProductionComposition {
  readonly worker: P2KnowledgeWorkerComposition;
  readonly query: KnowledgeGovernanceQueryService;
  readonly mutations: KnowledgeGovernanceMutationService;
  readonly markdown: MarkdownKnowledgeRepository;
  readonly registry: SqliteKnowledgeRegistryProjection;
  readonly index: IncrementalKnowledgeIndexer;
  readonly governanceStore: SqliteGovernanceOperationStore;
  readonly #checkpointStore: SqliteKnowledgeWorkerCheckpointStore;

  private constructor(options: P2ProductionCompositionOptions, compiler: KnowledgeExtractionPort) {
    const knowledgeRoot = join(options.stateDirectory, "knowledge");
    this.markdown = new MarkdownKnowledgeRepository(knowledgeRoot);
    this.registry = new SqliteKnowledgeRegistryProjection(join(options.stateDirectory, "knowledge-registry.sqlite"));
    this.index = new IncrementalKnowledgeIndexer(this.markdown, this.registry);
    this.governanceStore = new SqliteGovernanceOperationStore(join(options.stateDirectory, "knowledge-governance.sqlite"));
    this.#checkpointStore = new SqliteKnowledgeWorkerCheckpointStore(join(options.stateDirectory, "knowledge-worker.sqlite"));

    const ledgerPort: LedgerSnapshotPort = {
      loadSnapshot: async (request, limit) => {
        const snapshot = options.extraction().getSnapshot(request.snapshotId);
        if (snapshot === undefined || snapshot.sessionId !== request.sessionId || snapshot.identityHash !== request.sourceVersion) {
          throw Object.assign(new Error("snapshot identity is unavailable"), { retryable: false, code: "SNAPSHOT_IDENTITY_MISMATCH" });
        }
        // The worker requests max+1 as an overflow sentinel so this adapter can
        // distinguish an exact-boundary snapshot from a truncated oversized one.
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_RECORDS + 1) {
          throw Object.assign(new Error("knowledge worker snapshot limit is invalid"), { retryable: false, code: "SNAPSHOT_LIMIT_INVALID" });
        }
        const boundedRecords = readP2SnapshotRecords(
          options.ledger,
          snapshot,
          limit === MAX_SNAPSHOT_RECORDS + 1 ? limit : limit + 1,
        );
        if (boundedRecords.length > limit) {
          throw Object.assign(new Error("snapshot exceeds the bounded knowledge worker input"), {
            retryable: false,
            code: "SNAPSHOT_RECORD_LIMIT_EXCEEDED",
          });
        }
        const records = boundedRecords;
        const contentHash = sha256(JSON.stringify(records));
        return Object.freeze({ snapshotId: snapshot.snapshotId, sourceVersion: snapshot.identityHash, contentHash, records });
      },
      inspectSnapshot: async (request) => {
        const loaded = await ledgerPort.loadSnapshot(request, MAX_SNAPSHOT_RECORDS);
        return Object.freeze({ snapshotId: loaded.snapshotId, sourceVersion: loaded.sourceVersion, contentHash: loaded.contentHash });
      },
    };
    const evidence: EvidenceVerificationPort = {
      verify: async (candidate, project, requestedAt) => candidate.assertions.map((assertion) =>
        evidenceFor(assertion, candidate, project, requestedAt)),
    };
    const runtime = new KnowledgeWorkerRuntime({
      ledger: ledgerPort,
      compiler,
      evidence,
      evolution: {
        search: (queries, limit) => {
          const assets = new Map<string, KnowledgeAsset>();
          for (const query of queries.slice(0, 5)) {
            for (const result of this.registry.search(query, { limit, includeInactive: true })) {
              assets.set(result.asset.id, result.asset);
            }
          }
          return [...assets.values()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
        },
      },
      markdown: this.markdown,
      registry: this.registry,
      index: this.index,
    }, this.#checkpointStore);
    this.worker = Object.freeze({
      runtime,
      requestFor: (snapshot: ExtractionSnapshot): KnowledgeWorkerRunRequest => ({
        workId: workId(snapshot.snapshotId),
        snapshot: { snapshotId: snapshot.snapshotId, sessionId: snapshot.sessionId, sourceVersion: snapshot.identityHash },
        asOf: snapshot.createdAt,
        project: deriveP2ProjectContext(snapshot, options.ledger, options.stateDirectory),
        compilerVersion: DEFAULT_MVP_COMPILER_VERSION,
        promptVersion: DEFAULT_MVP_PROMPT_VERSION,
        policyHash: snapshot.policyHash,
        verificationPolicy: DEFAULT_CONFIGURATION.verification,
        extraction: { maxAttempts: 2, perAttemptTimeoutMs: options.compilerTimeoutMs, retryDelayMs: 250 },
        limits: {
          maxLedgerRecords: MAX_SNAPSHOT_RECORDS,
          maxCandidates: options.compilerBatchSize,
          maxPublishItems: options.compilerBatchSize,
        },
      }),
    });
    const metadata = extractionMetadata(options.extraction);
    this.query = new KnowledgeGovernanceQueryService(this.registry, metadata, this.governanceStore, Buffer.from(sha256(options.stateDirectory), "hex"));
    this.mutations = new KnowledgeGovernanceMutationService({
      registry: this.registry,
      markdown: this.markdown,
      index: this.index,
      eligibility: this.governanceStore,
      revalidation: revalidation(),
    }, this.governanceStore);
  }

  static async create(options: P2ProductionCompositionOptions): Promise<P2ProductionComposition> {
    if (options.compiler !== undefined) return new P2ProductionComposition(options, options.compiler);
    const model = await CodexExecStructuredGenerationModel.create({
      cwd: options.stateDirectory,
      timeoutMs: options.compilerTimeoutMs,
      maxDiagnosticRuns: 100,
      ...(options.compilerExecutable === undefined ? {} : { executable: options.compilerExecutable }),
      ...(options.compilerModel === undefined ? {} : { model: options.compilerModel }),
      ...(options.compilerIgnoreUserConfig === undefined ? {} : { ignoreUserConfig: options.compilerIgnoreUserConfig }),
    });
    return new P2ProductionComposition(options, new MvpKnowledgeCompiler({ model }));
  }

  async recoverIndex(assetId: string) {
    return await this.index.syncAsset(assetId);
  }

  checkpoint(snapshotId: string) {
    return this.#checkpointStore.load(workId(snapshotId));
  }

  close(): void {
    this.governanceStore.close();
    this.#checkpointStore.close();
    this.registry.close();
  }
}
