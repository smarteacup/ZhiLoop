import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import { CodeGraphCliAdapter } from "@zhiloop/codegraph-adapter";
import type { LedgerEventRecord, SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { KnowledgeAsset, ProjectContext } from "@zhiloop/domain";
import {
  KnowledgeGovernanceMutationService,
  KnowledgeGovernanceQueryService,
  SqliteGovernanceOperationStore,
  type KnowledgeMetadataPort,
  type KnowledgeProvenanceRecord,
  type KnowledgeRevalidationPort,
} from "@zhiloop/knowledge-governance-service";
import { IncrementalKnowledgeIndexer } from "@zhiloop/knowledge-indexer";
import { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import {
  GitProjectRevisionPort,
  KnowledgeVerificationService,
  SqliteKnowledgeVerificationStore,
  type KnowledgeVerificationBatch,
  type KnowledgeVerificationRequest,
  type VerificationExecutionControls,
} from "@zhiloop/knowledge-verification";
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
import { resolveProjectIdentity } from "@zhiloop/project-identity";
import {
  CodexSemanticEvolutionJudge,
  type SemanticEvolutionCapability,
} from "@zhiloop/semantic-evolution-codex";
import type { KnowledgeEvolutionSemanticPort } from "@zhiloop/knowledge-evolution";
import type { ExtractionSnapshot, ProvenanceNode } from "@zhiloop/control-api";
import type { SessionExtractionService } from "@zhiloop/session-extraction";

import type { P2KnowledgeWorkerComposition } from "./p2-runtime.js";

const LEDGER_PAGE_SIZE = 1_000;
const MAX_SNAPSHOT_RECORDS = 5_000;
const MAX_SNAPSHOT_SEQUENCE_SPAN = 50_000;
const MAX_PROVENANCE_VISITS = 1_000;
const MAX_EPISODE_PROJECTS_PER_SNAPSHOT = 16;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workId(snapshotId: string): string {
  return `knowledge-${snapshotId}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containedBy(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function nearestGitRoot(value: string, boundary: string): string | undefined {
  if (!isAbsolute(value) || value.length > 16_384) return undefined;
  let resolved: string;
  try {
    resolved = realpathSync(value);
  } catch {
    return undefined;
  }
  if (!containedBy(boundary, resolved)) return undefined;
  let cursor = resolved;
  while (containedBy(boundary, cursor)) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

/**
 * Resolves an Episode from explicit structured tool working-directory hints.
 * Free-form commands/responses are deliberately ignored: they are ambiguous
 * and must never be able to escape the captured session boundary.
 */
export function deriveP2EpisodeProjectContext(
  openingTurnRecords: readonly LedgerEventRecord[],
  fallback: ProjectContext,
  resolvedProjects: ReadonlyMap<string, ProjectContext> = new Map(),
): ProjectContext {
  if (fallback.repositoryRoot === undefined) return fallback;
  let boundary: string;
  try {
    boundary = realpathSync(fallback.repositoryRoot);
  } catch {
    return fallback;
  }
  const counts = new Map<string, number>();
  for (const { event } of openingTurnRecords) {
    if (event.eventType !== "tool.completed" || !isRecord(event.payload)) continue;
    const input = event.payload["toolInput"];
    if (!isRecord(input)) continue;
    for (const key of ["projectPath", "workdir", "cwd"] as const) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const root = nearestGitRoot(value, boundary);
      if (root !== undefined) counts.set(root, (counts.get(root) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const winner = ranked[0];
  if (winner === undefined || (ranked[1]?.[1] ?? -1) === winner[1]) return fallback;
  const resolved = resolvedProjects.get(winner[0]);
  if (resolved !== undefined) return resolved;
  return Object.freeze({
    projectId: `project-${sha256(JSON.stringify(["episode-project-root", winner[0]])).slice(0, 24)}`,
    repositoryRoot: winner[0],
    portable: false,
  });
}

function explicitEpisodeProjectRoots(records: readonly LedgerEventRecord[], boundaryRoot: string): readonly string[] {
  let boundary: string;
  try {
    boundary = realpathSync(boundaryRoot);
  } catch {
    return [];
  }
  const roots = new Set<string>();
  for (const { event } of records) {
    if (event.eventType !== "tool.completed" || !isRecord(event.payload)) continue;
    const input = event.payload["toolInput"];
    if (!isRecord(input)) continue;
    for (const key of ["projectPath", "workdir", "cwd"] as const) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const root = nearestGitRoot(value, boundary);
      if (root !== undefined) roots.add(root);
      if (roots.size >= MAX_EPISODE_PROJECTS_PER_SNAPSHOT) return [...roots].sort();
    }
  }
  return [...roots].sort();
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
    // SQLite AUTOINCREMENT values may contain legal gaps after an ignored
    // duplicate insert. Snapshot boundaries refer to persisted records, not
    // to every integer in the sequence range, so a gap is not corruption.
    if (page.length === 0) {
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

function deriveP2ProjectContextFromRecords(records: readonly LedgerEventRecord[], fallbackRoot: string): ProjectContext {
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

export function deriveP2ProjectContext(snapshot: ExtractionSnapshot, ledger: SqliteEventLedger, fallbackRoot: string): ProjectContext {
  return deriveP2ProjectContextFromRecords(
    readP2SnapshotRecords(ledger, snapshot, MAX_SNAPSHOT_RECORDS + 1),
    fallbackRoot,
  );
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
  readonly evolutionMaxCandidates?: number;
  readonly semanticJudgeEnabled?: boolean;
  readonly semanticJudge?: KnowledgeEvolutionSemanticPort;
  readonly compiler?: KnowledgeExtractionPort;
  readonly compilerExecutable?: string;
  readonly compilerModel?: string;
  readonly compilerIgnoreUserConfig?: boolean;
  readonly codeGraphTimeoutMs?: number;
  readonly verificationTimeoutMs?: number;
}

export class P2ProductionVerificationRuntime implements EvidenceVerificationPort {
  #service: KnowledgeVerificationService;

  constructor(service: KnowledgeVerificationService) { this.#service = service; }

  verify(request: KnowledgeVerificationRequest) { return this.#service.verify(request); }

  verifyBatch(request: KnowledgeVerificationRequest, controls?: VerificationExecutionControls): Promise<KnowledgeVerificationBatch> {
    return this.#service.verifyBatch(request, controls);
  }

  replace(service: KnowledgeVerificationService): () => void {
    const previous = this.#service;
    this.#service = service;
    let restored = false;
    return () => { if (restored) return; restored = true; if (this.#service === service) this.#service = previous; };
  }
}

/** Owns the P2 Markdown/Registry/index boundary shared by compile and governance. */
export class P2ProductionComposition {
  readonly worker: P2KnowledgeWorkerComposition;
  readonly #episodeProjectContexts = new Map<string, ProjectContext>();
  readonly query: KnowledgeGovernanceQueryService;
  readonly mutations: KnowledgeGovernanceMutationService;
  readonly markdown: MarkdownKnowledgeRepository;
  readonly registry: SqliteKnowledgeRegistryProjection;
  readonly index: IncrementalKnowledgeIndexer;
  readonly governanceStore: SqliteGovernanceOperationStore;
  readonly freshnessStore: SqliteKnowledgeFreshnessStore;
  readonly verificationStore: SqliteKnowledgeVerificationStore;
  readonly verification: P2ProductionVerificationRuntime;
  readonly #semanticJudge: KnowledgeEvolutionSemanticPort | undefined;
  readonly #semanticJudgeEnabled: boolean;
  readonly #semanticJudgeInitializationFailed: boolean;
  readonly #checkpointStore: SqliteKnowledgeWorkerCheckpointStore;

  private constructor(
    options: P2ProductionCompositionOptions,
    compiler: KnowledgeExtractionPort,
    semanticJudge?: KnowledgeEvolutionSemanticPort,
    semanticJudgeInitializationFailed = false,
  ) {
    const knowledgeRoot = join(options.stateDirectory, "knowledge");
    this.markdown = new MarkdownKnowledgeRepository(knowledgeRoot);
    this.registry = new SqliteKnowledgeRegistryProjection(join(options.stateDirectory, "knowledge-registry.sqlite"));
    this.index = new IncrementalKnowledgeIndexer(this.markdown, this.registry);
    this.governanceStore = new SqliteGovernanceOperationStore(join(options.stateDirectory, "knowledge-governance.sqlite"));
    this.freshnessStore = new SqliteKnowledgeFreshnessStore(join(options.stateDirectory, "knowledge-freshness.sqlite"));
    this.verificationStore = new SqliteKnowledgeVerificationStore(join(options.stateDirectory, "knowledge-verification.sqlite"));
    this.#checkpointStore = new SqliteKnowledgeWorkerCheckpointStore(join(options.stateDirectory, "knowledge-worker.sqlite"));
    this.#semanticJudgeEnabled = options.semanticJudgeEnabled ?? false;
    this.#semanticJudge = semanticJudge;
    this.#semanticJudgeInitializationFailed = semanticJudgeInitializationFailed;

    this.verification = new P2ProductionVerificationRuntime(this.createVerification(
      options.codeGraphTimeoutMs ?? 300,
      options.verificationTimeoutMs ?? 5_000,
    ));

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
    const runtime = new KnowledgeWorkerRuntime({
      ledger: ledgerPort,
      compiler,
      evidence: this.verification,
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
      projectResolution: {
        resolve: (_session, openingTurnRecords, fallback) =>
          deriveP2EpisodeProjectContext(openingTurnRecords, fallback, this.#episodeProjectContexts),
      },
      ...(semanticJudge === undefined ? {} : { evolutionSemantic: semanticJudge }),
      markdown: this.markdown,
      registry: this.registry,
      freshness: {
        project: (input) => {
          this.verificationStore.saveRecipe({ assetId: input.asset.id, assetVersion: input.asset.version,
            recipeVersion: "evidence-recipe-v1", assertions: input.candidate.assertions, createdAt: input.observedAt });
          return this.freshnessStore.project(input);
        },
      },
      index: this.index,
    }, this.#checkpointStore);
    this.worker = Object.freeze({
      runtime,
      requestFor: async (snapshot: ExtractionSnapshot): Promise<KnowledgeWorkerRunRequest> => {
        const records = readP2SnapshotRecords(options.ledger, snapshot, MAX_SNAPSHOT_RECORDS + 1);
        const project = deriveP2ProjectContextFromRecords(records, options.stateDirectory);
        if (project.repositoryRoot !== undefined) {
          const roots = explicitEpisodeProjectRoots(records, project.repositoryRoot);
          const resolved = await Promise.all(roots.map(async (root) => {
            try {
              return [root, (await resolveProjectIdentity(root)).context] as const;
            } catch {
              return undefined;
            }
          }));
          for (const item of resolved) if (item !== undefined) this.#episodeProjectContexts.set(item[0], item[1]);
        }
        return {
          workId: workId(snapshot.snapshotId),
          snapshot: { snapshotId: snapshot.snapshotId, sessionId: snapshot.sessionId, sourceVersion: snapshot.identityHash },
          asOf: snapshot.createdAt,
          project,
          compilerVersion: DEFAULT_MVP_COMPILER_VERSION,
          promptVersion: DEFAULT_MVP_PROMPT_VERSION,
          policyHash: snapshot.policyHash,
          verificationPolicy: DEFAULT_CONFIGURATION.verification,
          extraction: { maxAttempts: 2, perAttemptTimeoutMs: options.compilerTimeoutMs, retryDelayMs: 250 },
          limits: {
            maxLedgerRecords: MAX_SNAPSHOT_RECORDS,
            maxCandidates: options.compilerBatchSize,
            maxPublishItems: options.compilerBatchSize,
            maxEvolutionCandidates: options.evolutionMaxCandidates ?? 5,
          },
        };
      },
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
    let model: CodexExecStructuredGenerationModel | undefined;
    const createModel = async (): Promise<CodexExecStructuredGenerationModel> => await CodexExecStructuredGenerationModel.create({
      cwd: options.stateDirectory, timeoutMs: options.compilerTimeoutMs, maxDiagnosticRuns: 100,
      ...(options.compilerExecutable === undefined ? {} : { executable: options.compilerExecutable }),
      ...(options.compilerModel === undefined ? {} : { model: options.compilerModel }),
      ...(options.compilerIgnoreUserConfig === undefined ? {} : { ignoreUserConfig: options.compilerIgnoreUserConfig }),
    });
    if (options.compiler === undefined) model = await createModel();
    const compiler = options.compiler ?? new MvpKnowledgeCompiler({ model: model as CodexExecStructuredGenerationModel });
    if (!(options.semanticJudgeEnabled ?? false)) return new P2ProductionComposition(options, compiler);
    if (options.semanticJudge !== undefined) return new P2ProductionComposition(options, compiler, options.semanticJudge);
    try {
      model ??= await createModel();
      return new P2ProductionComposition(options, compiler, new CodexSemanticEvolutionJudge(model));
    } catch {
      return new P2ProductionComposition(options, compiler, undefined, true);
    }
  }

  semanticEvolutionCapability(): SemanticEvolutionCapability | { readonly status: "DISABLED"; readonly reasonCode: "SEMANTIC_EVOLUTION_DISABLED" } {
    if (!this.#semanticJudgeEnabled) return Object.freeze({ status: "DISABLED", reasonCode: "SEMANTIC_EVOLUTION_DISABLED" });
    if (this.#semanticJudgeInitializationFailed || this.#semanticJudge === undefined) {
      return Object.freeze({ status: "DEGRADED", reasonCode: "SEMANTIC_EVOLUTION_UNAVAILABLE" });
    }
    return this.#semanticJudge instanceof CodexSemanticEvolutionJudge
      ? this.#semanticJudge.capability()
      : Object.freeze({ status: "READY", reasonCode: "SEMANTIC_EVOLUTION_READY" });
  }

  async recoverIndex(assetId: string) {
    return await this.index.syncAsset(assetId);
  }

  checkpoint(snapshotId: string) {
    return this.#checkpointStore.load(workId(snapshotId));
  }

  private createVerification(codeGraphTimeoutMs: number, timeoutMs: number): KnowledgeVerificationService {
    return new KnowledgeVerificationService({
      revisions: new GitProjectRevisionPort(), store: this.verificationStore,
      codeIntelligence: new CodeGraphCliAdapter(undefined, { timeoutMs: codeGraphTimeoutMs }),
      timeoutMs,
      crossProject: {
        store: this.verificationStore,
        eligibility: {
          classify: (proof) => {
            const asset = this.registry.getAsset(proof.knowledgeVersion.assetId, true);
            if (asset === undefined) return "UNKNOWN";
            if (asset.tombstone || asset.asset.version !== proof.knowledgeVersion.assetVersion) return "STALE";
            const freshness = this.freshnessStore.getState(proof.knowledgeVersion.assetId, proof.knowledgeVersion.assetVersion);
            if (freshness === undefined) return "UNKNOWN";
            return freshness.projectId === proof.canonicalProjectId && freshness.status === "FRESH" ? "CURRENT" : "STALE";
          },
        },
      },
    });
  }

  applyVerificationConfiguration(configuration: { readonly codeGraphTimeoutMs: number; readonly timeoutMs: number }): () => void {
    return this.verification.replace(this.createVerification(configuration.codeGraphTimeoutMs, configuration.timeoutMs));
  }

  close(): void {
    this.governanceStore.close();
    this.verificationStore.close();
    this.freshnessStore.close();
    this.#checkpointStore.close();
    this.registry.close();
  }
}
