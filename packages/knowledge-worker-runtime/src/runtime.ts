import { createHash } from "node:crypto";

import { normalizeConversations } from "@zhiloop/conversation-normalizer";
import type {
  Episode,
  EvidenceRef,
  KnowledgeAsset,
  KnowledgeCandidate,
  KnowledgeRelation,
  KnowledgeScope,
  KnowledgeStatus,
} from "@zhiloop/domain";
import { buildEpisodes } from "@zhiloop/episode-builder";
import { evaluateEvidencePolicy } from "@zhiloop/evidence-policy";
import {
  applyUserCommitments,
  detectUserCommitments,
  knowledgeExtractionInputHash,
  knowledgeExtractionKey,
  runKnowledgeExtraction,
  toKnowledgeExtractionInput,
  type KnowledgeExtractionRequest,
  type UserCommitmentAmbiguity,
  type UserCommitmentSignal,
} from "@zhiloop/knowledge-compiler";
import { decideKnowledgeEvolution, type EvolutionDecision } from "@zhiloop/knowledge-evolution";
import { calculateKnowledgeContentHash } from "@zhiloop/markdown-repository";
import { resolveKnowledgeScope } from "@zhiloop/scope-resolver";

import { KnowledgeWorkerError } from "./errors.js";
import {
  WORKER_STAGES,
  type CandidateCompilationProvenance,
  type CandidateCorrectionDraft,
  type CandidateEvolutionRecord,
  type CandidatePolicyRecord,
  type IndexRebuildResult,
  type KnowledgeExecutionMode,
  type KnowledgePublicationAuthorization,
  type KnowledgeWorkerCheckpoint,
  type KnowledgeWorkerCheckpointStore,
  type KnowledgeWorkerLimits,
  type KnowledgeWorkerPorts,
  type KnowledgeWorkerRunOptions,
  type KnowledgeWorkerRunRequest,
  type KnowledgeWorkerStage,
  type PublicationOutboxItem,
  type StageCheckpoint,
  type StageError,
} from "./types.js";

const DEFAULT_LIMITS: KnowledgeWorkerLimits = Object.freeze({
  maxLedgerRecords: 500,
  maxEpisodes: 100,
  maxCandidates: 200,
  maxPublishItems: 50,
  maxStageAttempts: 5,
  maxEvolutionCandidates: 5,
});
const HARD_LIMITS: KnowledgeWorkerLimits = Object.freeze({
  maxLedgerRecords: 5_000,
  maxEpisodes: 1_000,
  maxCandidates: 2_000,
  maxPublishItems: 500,
  maxStageAttempts: 20,
  maxEvolutionCandidates: 20,
});
const INDEX_SUCCESS = new Set(["INDEXED", "UNCHANGED", "CHUNKS_REFRESHED"]);
const EXECUTION_MODES = new Set<KnowledgeExecutionMode>([
  "PREVIEW_ONLY",
  "POLICY_EVALUATION",
  "SAFE_AUTO_PUBLICATION",
]);
const PUBLICATION_STAGES = new Set<KnowledgeWorkerStage>([
  "MARKDOWN_PUBLISH",
  "REGISTRY_PROJECT",
  "FRESHNESS_PROJECT",
  "INCREMENTAL_INDEX",
]);
const MAX_AUTHORIZATION_ID_LENGTH = 512;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function limits(input: Partial<KnowledgeWorkerLimits> | undefined): KnowledgeWorkerLimits {
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(result) as Array<keyof KnowledgeWorkerLimits>) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > HARD_LIMITS[key]) {
      throw new KnowledgeWorkerError("INVALID_BATCH_LIMIT", `${key} must be between 1 and ${HARD_LIMITS[key]}`, false);
    }
  }
  return result;
}

function identity(request: KnowledgeWorkerRunRequest, resolvedLimits: KnowledgeWorkerLimits): string {
  if (typeof request.policyHash !== "string"
    || request.policyHash.trim().length === 0
    || request.policyHash.length > 512
    || /[\0\r\n]/u.test(request.policyHash)) {
    throw new KnowledgeWorkerError("INVALID_POLICY_HASH", "policyHash must contain 1 to 512 safe characters", false);
  }
  return hash({
    workId: request.workId,
    snapshot: request.snapshot,
    asOf: request.asOf,
    project: request.project,
    compilerVersion: request.compilerVersion,
    promptVersion: request.promptVersion,
    policyHash: request.policyHash,
    verificationPolicy: request.verificationPolicy,
    allowGlobal: request.allowGlobal === true,
    projectTerms: request.projectTerms ?? [],
    limits: resolvedLimits,
    extraction: request.extraction === undefined ? undefined : {
      maxAttempts: request.extraction.maxAttempts,
      perAttemptTimeoutMs: request.extraction.perAttemptTimeoutMs,
      retryDelayMs: request.extraction.retryDelayMs,
    },
  });
}

function extractionRequest(
  episode: Episode,
  request: KnowledgeWorkerRunRequest,
  requestedAt: string,
): KnowledgeExtractionRequest {
  return {
    input: toKnowledgeExtractionInput(episode),
    compilerVersion: request.compilerVersion,
    promptVersion: request.promptVersion,
    requestedAt,
    correlationId: `${request.workId}:${episode.episodeId}`,
  };
}

function candidateProvenance(
  candidateId: string,
  extraction: Pick<
    CandidateCompilationProvenance,
    "extractionKey" | "inputHash" | "episodeId" | "builderVersion" | "compilerVersion" | "promptVersion"
  >,
  policyHash: string,
): CandidateCompilationProvenance {
  return Object.freeze({
    candidateId,
    extractionKey: extraction.extractionKey,
    inputHash: extraction.inputHash,
    episodeId: extraction.episodeId,
    builderVersion: extraction.builderVersion,
    compilerVersion: extraction.compilerVersion,
    promptVersion: extraction.promptVersion,
    policyHash,
  });
}

function backfillCandidateProvenance(
  candidates: readonly KnowledgeCandidate[],
  episodes: readonly Episode[],
  request: KnowledgeWorkerRunRequest,
  requestedAt: string,
): readonly CandidateCompilationProvenance[] {
  const byEpisode = new Map(episodes.map((episode) => [episode.episodeId, episode]));
  return candidates.map((candidate) => {
    const localEpisodes = candidate.sourceEpisodes.map((episodeId) => byEpisode.get(episodeId)).filter((episode) => episode !== undefined);
    const localEpisode = localEpisodes[0];
    if (localEpisodes.length !== 1 || localEpisode === undefined) {
      throw new KnowledgeWorkerError(
        "CANDIDATE_PROVENANCE_UNRESOLVED",
        `candidate ${candidate.candidateId} does not resolve to exactly one compiled Episode`,
        false,
      );
    }
    const source = extractionRequest(localEpisode, request, requestedAt);
    return candidateProvenance(candidate.candidateId, {
      extractionKey: knowledgeExtractionKey(source),
      inputHash: knowledgeExtractionInputHash(source),
      episodeId: source.input.episodeId,
      builderVersion: source.input.builderVersion,
      compilerVersion: source.compilerVersion,
      promptVersion: source.promptVersion,
    }, request.policyHash);
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function compileUserCommitments(
  episodes: readonly Episode[],
  candidates: readonly KnowledgeCandidate[],
): {
  readonly candidates: readonly KnowledgeCandidate[];
  readonly signals: readonly UserCommitmentSignal[];
  readonly ambiguities: readonly UserCommitmentAmbiguity[];
  readonly correctionDrafts: readonly CandidateCorrectionDraft[];
} {
  // Model output may cite a user statement, but only the deterministic
  // commitment detector is allowed to classify it as accepted or rejected.
  const neutralCandidates = candidates.map((candidate) => ({
    ...structuredClone(candidate),
    assertions: candidate.assertions.filter((assertion) =>
      assertion.kind !== "USER_ACCEPTED" && assertion.kind !== "USER_REJECTED"),
  }) as KnowledgeCandidate);
  const signals = new Map<string, UserCommitmentSignal>();
  const ambiguities = new Map<string, UserCommitmentAmbiguity>();
  for (const episode of [...episodes].sort((left, right) => left.episodeId.localeCompare(right.episodeId))) {
    const detection = detectUserCommitments(episode, neutralCandidates);
    for (const signal of detection.signals) {
      const existing = signals.get(signal.signalId);
      if (existing !== undefined && canonical(existing) !== canonical(signal)) {
        throw new KnowledgeWorkerError("USER_COMMITMENT_COLLISION", `signal ${signal.signalId} is inconsistent`, false);
      }
      signals.set(signal.signalId, signal);
    }
    for (const ambiguity of detection.ambiguities) {
      ambiguities.set(hash({ identityVersion: 1, episodeId: episode.episodeId, ambiguity }), ambiguity);
    }
  }
  const stableSignals = [...signals.values()].sort((left, right) => left.signalId.localeCompare(right.signalId));
  const stableAmbiguities = [...ambiguities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, ambiguity]) => ambiguity);
  const enriched = applyUserCommitments(neutralCandidates, { signals: stableSignals, ambiguities: stableAmbiguities });
  for (const candidate of enriched) {
    if (candidate.assertions.length === 0 && candidate.evidenceHints.length === 0) {
      throw new KnowledgeWorkerError(
        "CANDIDATE_GROUNDING_REMOVED",
        `candidate ${candidate.candidateId} has no trusted grounding after commitment validation`,
        false,
      );
    }
  }
  const correctionDrafts: CandidateCorrectionDraft[] = [];
  for (const signal of stableSignals.filter((item) => item.kind === "CORRECTION")) {
    if (signal.originalRef === undefined || signal.originalStatement === undefined
      || signal.correctedRef === undefined || signal.correctedStatement === undefined) {
      throw new KnowledgeWorkerError("USER_COMMITMENT_INVALID", `correction signal ${signal.signalId} is incomplete`, false);
    }
    for (const candidateId of [...signal.candidateIds].sort()) {
      correctionDrafts.push(Object.freeze({
        draftId: hash({ identityVersion: 1, signalId: signal.signalId, candidateId, relationHint: "CONTRADICTS" }),
        signalId: signal.signalId,
        candidateId,
        relationHint: "CONTRADICTS",
        originalRef: signal.originalRef,
        originalStatement: signal.originalStatement,
        correctedRef: signal.correctedRef,
        correctedStatement: signal.correctedStatement,
        occurredAt: signal.occurredAt,
      }));
    }
  }
  return Object.freeze({
    candidates: enriched,
    signals: Object.freeze(stableSignals),
    ambiguities: Object.freeze(stableAmbiguities),
    correctionDrafts: Object.freeze(correctionDrafts),
  });
}

function executionMode(options: KnowledgeWorkerRunOptions): KnowledgeExecutionMode {
  const selected = options.executionMode ?? "PREVIEW_ONLY";
  if (!EXECUTION_MODES.has(selected)) {
    throw new KnowledgeWorkerError("INVALID_EXECUTION_MODE", "knowledge execution mode is invalid", false);
  }
  return selected;
}

function normalizedAuthorization(
  mode: KnowledgeExecutionMode,
  value: KnowledgePublicationAuthorization | undefined,
): KnowledgePublicationAuthorization | undefined {
  if (mode !== "SAFE_AUTO_PUBLICATION") {
    if (value !== undefined) {
      throw new KnowledgeWorkerError(
        "UNEXPECTED_PUBLICATION_AUTHORIZATION",
        "publication authorization is only accepted in SAFE_AUTO_PUBLICATION mode",
        false,
      );
    }
    return undefined;
  }
  if (value === undefined) {
    throw new KnowledgeWorkerError(
      "PUBLICATION_AUTHORIZATION_REQUIRED",
      "SAFE_AUTO_PUBLICATION requires a publication authorization",
      false,
    );
  }
  if (typeof value.authorizationId !== "string") {
    throw new KnowledgeWorkerError(
      "INVALID_PUBLICATION_AUTHORIZATION",
      "authorizationId must be a string",
      false,
    );
  }
  const authorizationId = value.authorizationId.trim();
  if (authorizationId.length === 0 || authorizationId.length > MAX_AUTHORIZATION_ID_LENGTH) {
    throw new KnowledgeWorkerError(
      "INVALID_PUBLICATION_AUTHORIZATION",
      `authorizationId must contain between 1 and ${MAX_AUTHORIZATION_ID_LENGTH} characters`,
      false,
    );
  }
  if (value.kind === "EXPLICIT_COMMIT") return Object.freeze({ kind: value.kind, authorizationId });
  if (value.kind !== "SAFE_POLICY") {
    throw new KnowledgeWorkerError("INVALID_PUBLICATION_AUTHORIZATION", "publication authorization kind is invalid", false);
  }
  if (typeof value.policyHash !== "string") {
    throw new KnowledgeWorkerError("INVALID_PUBLICATION_AUTHORIZATION", "policyHash must be a string", false);
  }
  const policyHash = value.policyHash.trim();
  if (policyHash.length === 0 || policyHash.length > MAX_AUTHORIZATION_ID_LENGTH) {
    throw new KnowledgeWorkerError(
      "INVALID_PUBLICATION_AUTHORIZATION",
      `policyHash must contain between 1 and ${MAX_AUTHORIZATION_ID_LENGTH} characters`,
      false,
    );
  }
  return Object.freeze({ kind: value.kind, authorizationId, policyHash });
}

function publicationStarted(checkpoint: KnowledgeWorkerCheckpoint): boolean {
  return WORKER_STAGES.some((stage) => PUBLICATION_STAGES.has(stage) && (checkpoint.stages[stage]?.attempts ?? 0) > 0);
}

function modeAllowsStage(mode: KnowledgeExecutionMode, stage: KnowledgeWorkerStage): boolean {
  return mode === "SAFE_AUTO_PUBLICATION" || !PUBLICATION_STAGES.has(stage);
}

function pendingStages(): Record<KnowledgeWorkerStage, StageCheckpoint> {
  return Object.fromEntries(WORKER_STAGES.map((stage) => [stage, { status: "PENDING", attempts: 0 }])) as
    Record<KnowledgeWorkerStage, StageCheckpoint>;
}

function errorDetails(error: unknown, occurredAt: string): StageError {
  if (error instanceof KnowledgeWorkerError) {
    return { code: error.code, message: error.message, retryable: error.retryable, occurredAt };
  }
  return {
    code: "UNEXPECTED_WORKER_FAILURE",
    message: error instanceof Error ? error.message : "unknown worker failure",
    retryable: false,
    occurredAt,
  };
}

async function external<T>(code: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof KnowledgeWorkerError) throw error;
    const classified = error as { readonly retryable?: unknown; readonly code?: unknown };
    throw new KnowledgeWorkerError(
      typeof classified.code === "string" ? classified.code : code,
      error instanceof Error ? error.message : code,
      classified.retryable !== false,
      { cause: error },
    );
  }
}

function deduplicateCandidates(candidates: readonly KnowledgeCandidate[]): readonly KnowledgeCandidate[] {
  const unique = new Map<string, KnowledgeCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.candidateId);
    if (existing === undefined) unique.set(candidate.candidateId, candidate);
    else if (canonical(existing) !== canonical(candidate)) {
      throw new KnowledgeWorkerError(
        "CANDIDATE_ID_COLLISION",
        `candidate ${candidate.candidateId} has conflicting payloads`,
        false,
      );
    }
  }
  return [...unique.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function evidenceRefs(policy: CandidatePolicyRecord): readonly EvidenceRef[] {
  return policy.verificationResults
    .flatMap((result) => result.evidence === undefined
      ? []
      : [{ evidenceId: result.evidence.evidenceId, verdict: result.evidence.verdict }])
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function candidateSymbols(candidate: KnowledgeCandidate): readonly string[] {
  return [...new Set(candidate.assertions.flatMap((assertion) =>
    assertion.kind === "SYMBOL_EXISTS" ? [assertion.parameters.symbol] : []))].sort();
}

function assetIdentity(candidate: KnowledgeCandidate, scope: KnowledgeScope): string {
  return hash({ identityVersion: 1, subjectKey: candidate.subjectKey, kind: candidate.kind, scope });
}

function evolutionQueries(candidate: KnowledgeCandidate): readonly string[] {
  return [...new Set([candidate.subjectKey, candidate.title, ...candidateSymbols(candidate)])]
    .filter((value) => value.trim().length > 0 && /[\p{L}\p{N}_.$:-]/u.test(value))
    .slice(0, 5)
    .map((value) => value.slice(0, 512));
}

function evolutionTargetIds(decision: EvolutionDecision): readonly string[] {
  return [...new Set(decision.targetKnowledgeVersions.map((target) => target.id))].sort();
}

function evolutionAllowsPublication(decision: EvolutionDecision): boolean {
  const allowed = new Set(["STORE", "SUPPLEMENT", "SUPERSEDE", "SCOPE_SPLIT"]);
  return decision.status === "DECIDED"
    && !decision.requiresConfirmation
    && allowed.has(decision.action);
}

function mergeEvidence(base: readonly EvidenceRef[], fresh: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const values = new Map(base.map((item) => [item.evidenceId, item]));
  for (const item of fresh) values.set(item.evidenceId, item);
  return [...values.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function evolutionRelations(
  decision: EvolutionDecision,
  base: KnowledgeAsset | undefined,
): readonly KnowledgeRelation[] {
  const relations = [...(base?.relations ?? [])];
  if (decision.status !== "DECIDED") return relations;
  const type = decision.action === "SUPERSEDE"
    ? "SUPERSEDES"
    : decision.action === "SUPPLEMENT"
      ? "DERIVED_FROM"
      : decision.action === "SCOPE_SPLIT"
        ? "RELATED_TO"
        : undefined;
  if (type === undefined) return relations;
  for (const target of decision.targetKnowledgeVersions) {
    relations.push({ type, targetId: target.id, targetVersion: target.version, reason: `EVOLUTION_${decision.action}` });
  }
  const unique = new Map(relations.map((relation) => [canonical(relation), relation]));
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, relation]) => relation);
}

function buildAsset(
  policy: CandidatePolicyRecord,
  evolution: CandidateEvolutionRecord,
  previous: KnowledgeAsset | undefined,
  assetId: string,
  version: number,
  createdAt: string,
  updatedAt: string,
): KnowledgeAsset {
  const candidate = policy.candidate;
  const draft: KnowledgeAsset = {
    schemaVersion: 1,
    id: assetId,
    subjectKey: candidate.subjectKey,
    kind: candidate.kind,
    scope: policy.decision.effectiveScope,
    version,
    status: policy.decision.targetStatus,
    title: candidate.title,
    summary: candidate.summary,
    body: candidate.body,
    aliases: [...(previous?.aliases ?? [])],
    keywords: [...new Set([...(previous?.keywords ?? []), ...candidate.subjectKey.split(".")])].sort(),
    applicability: [...(previous?.applicability ?? [])],
    nonApplicability: [...(previous?.nonApplicability ?? [])],
    symbols: [...new Set([...(previous?.symbols ?? []), ...candidateSymbols(candidate)])].sort(),
    relations: evolutionRelations(evolution.decision, previous),
    evidence: mergeEvidence(previous?.evidence ?? [], evidenceRefs(policy)),
    confidence: candidate.confidence,
    sourceEpisodes: [...new Set([...(previous?.sourceEpisodes ?? []), ...candidate.sourceEpisodes])].sort() as unknown as
      KnowledgeAsset["sourceEpisodes"],
    contentHash: "",
    correlationId: candidate.correlationId,
    createdAt,
    updatedAt,
  };
  return { ...draft, contentHash: calculateKnowledgeContentHash(draft) };
}

export class KnowledgeWorkerRuntime {
  readonly #ports: KnowledgeWorkerPorts;
  readonly #store: KnowledgeWorkerCheckpointStore;
  readonly #clock: () => Date;

  constructor(ports: KnowledgeWorkerPorts, store: KnowledgeWorkerCheckpointStore, clock: () => Date = () => new Date()) {
    this.#ports = ports;
    this.#store = store;
    this.#clock = clock;
  }

  async run(
    request: KnowledgeWorkerRunRequest,
    options: KnowledgeWorkerRunOptions = {},
  ): Promise<KnowledgeWorkerCheckpoint> {
    const resolvedLimits = limits(request.limits);
    const identityHash = identity(request, resolvedLimits);
    const mode = executionMode(options);
    let checkpoint = this.#store.load(request.workId);
    if (checkpoint !== undefined && checkpoint.identityHash !== identityHash) {
      throw new KnowledgeWorkerError(
        "WORK_IDENTITY_CONFLICT",
        `work ${request.workId} cannot be replayed with different input or policy`,
        false,
      );
    }
    const completedReplay = checkpoint?.status === "COMPLETED";
    const authorization = completedReplay ? undefined : normalizedAuthorization(mode, options.publicationAuthorization);
    if (checkpoint === undefined) {
      const now = this.#clock().toISOString();
      checkpoint = {
        schemaVersion: 1,
        workId: request.workId,
        identityHash,
        revision: 0,
        status: "RUNNING",
        createdAt: now,
        updatedAt: now,
        lastExecutionMode: mode,
        ...(authorization === undefined ? {} : { publicationAuthorization: authorization }),
        stages: pendingStages(),
        payload: {},
      };
      this.#store.create(checkpoint);
    }
    if (authorization !== undefined
      && checkpoint.publicationAuthorization !== undefined
      && canonical(authorization) !== canonical(checkpoint.publicationAuthorization)
      && publicationStarted(checkpoint)) {
      throw new KnowledgeWorkerError(
        "PUBLICATION_AUTHORIZATION_CONFLICT",
        "publication authorization cannot change after publication has started",
        false,
      );
    }
    if (!completedReplay && (checkpoint.lastExecutionMode !== mode
      || (authorization !== undefined && canonical(authorization) !== canonical(checkpoint.publicationAuthorization)))) {
      checkpoint = this.#persist(checkpoint, {
        lastExecutionMode: mode,
        ...(authorization === undefined ? {} : { publicationAuthorization: authorization }),
      });
    }

    if (checkpoint.payload.ledger !== undefined && this.#ports.ledger.inspectSnapshot !== undefined) {
      const inspected = await external("LEDGER_SNAPSHOT_INSPECTION_FAILED", () =>
        this.#ports.ledger.inspectSnapshot?.(request.snapshot));
      if (inspected === undefined || inspected.contentHash !== checkpoint.payload.ledger.contentHash
        || inspected.sourceVersion !== checkpoint.payload.ledger.sourceVersion) {
        throw new KnowledgeWorkerError("LEDGER_SNAPSHOT_CHANGED", "immutable ledger snapshot changed during replay", false);
      }
    }
    if (completedReplay) return checkpoint;
    if (checkpoint.status === "FAILED") {
      if (options.retryFailed !== true) return checkpoint;
      const failedStage = WORKER_STAGES.find((stage) =>
        modeAllowsStage(mode, stage)
        && checkpoint?.stages[stage]?.status === "FAILED"
        && checkpoint.stages[stage]?.error?.retryable === true);
      if (failedStage === undefined) return checkpoint;
      const previous = checkpoint.stages[failedStage];
      checkpoint = this.#persist(checkpoint, {
        status: "RUNNING",
        stages: {
          ...checkpoint.stages,
          [failedStage]: {
            status: "RETRYABLE",
            attempts: Math.max(0, resolvedLimits.maxStageAttempts - 1),
            startedAt: previous.startedAt,
            error: previous.error,
          },
        },
      });
    }

    const execute = async (
      stage: KnowledgeWorkerStage,
      operation: () => Promise<void>,
    ): Promise<boolean> => {
      const currentStage = checkpoint?.stages[stage];
      if (currentStage?.status === "SUCCEEDED") return true;
      if (currentStage?.status === "FAILED") return false;
      const now = this.#clock().toISOString();
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        status: "RUNNING",
        stages: {
          ...(checkpoint as KnowledgeWorkerCheckpoint).stages,
          [stage]: { status: "RUNNING", attempts: (currentStage?.attempts ?? 0) + 1, startedAt: now },
        },
      });
      try {
        await operation();
        const completedAt = this.#clock().toISOString();
        checkpoint = this.#persist(checkpoint, {
          stages: {
            ...checkpoint.stages,
            [stage]: {
              status: "SUCCEEDED",
              attempts: checkpoint.stages[stage].attempts,
              startedAt: checkpoint.stages[stage].startedAt,
              completedAt,
            },
          },
        });
        return true;
      } catch (error) {
        const failure = errorDetails(error, this.#clock().toISOString());
        const attempts = checkpoint.stages[stage].attempts;
        const retryable = failure.retryable && attempts < resolvedLimits.maxStageAttempts;
        checkpoint = this.#persist(checkpoint, {
          status: retryable ? "RETRYABLE" : "FAILED",
          stages: {
            ...checkpoint.stages,
            [stage]: {
              status: retryable ? "RETRYABLE" : "FAILED",
              attempts,
              startedAt: checkpoint.stages[stage].startedAt,
              // Keep the cause classification even when the automatic attempt
              // budget is exhausted. The FAILED status is the budget fence;
              // retryable remains the operator recovery signal.
              error: failure,
            },
          },
        });
        return false;
      }
    };

    if (!await execute("LEDGER_READ", async () => {
      const loaded = await external("LEDGER_READ_FAILED", () =>
        this.#ports.ledger.loadSnapshot(request.snapshot, resolvedLimits.maxLedgerRecords + 1));
      if (loaded.snapshotId !== request.snapshot.snapshotId || loaded.sourceVersion !== request.snapshot.sourceVersion) {
        throw new KnowledgeWorkerError("LEDGER_SNAPSHOT_IDENTITY_MISMATCH", "ledger returned a different snapshot", false);
      }
      if (loaded.records.length > resolvedLimits.maxLedgerRecords) {
        throw new KnowledgeWorkerError("LEDGER_BATCH_LIMIT_EXCEEDED", "ledger snapshot exceeds record batch limit", false);
      }
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, ledger: loaded },
      });
    })) return checkpoint;

    if (!await execute("NORMALIZE", async () => {
      const records = checkpoint?.payload.ledger?.records;
      if (records === undefined) throw new KnowledgeWorkerError("MISSING_LEDGER_CHECKPOINT", "ledger checkpoint is missing", false);
      const normalization = normalizeConversations(records, { asOf: request.asOf });
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, normalization },
      });
    })) return checkpoint;

    if (!await execute("EPISODE_BUILD", async () => {
      const ledger = checkpoint?.payload.ledger;
      const normalization = checkpoint?.payload.normalization;
      if (ledger === undefined || normalization === undefined) {
        throw new KnowledgeWorkerError("MISSING_NORMALIZATION_CHECKPOINT", "normalization checkpoint is missing", false);
      }
      const episodeBuild = buildEpisodes(ledger.records, normalization.sessions, {
        projectResolver: () => request.project,
      });
      const episodes = episodeBuild.episodes.filter((episode) => episode.status === "COMPLETED");
      if (episodes.length > resolvedLimits.maxEpisodes) {
        throw new KnowledgeWorkerError("EPISODE_BATCH_LIMIT_EXCEEDED", "episode batch limit exceeded", false);
      }
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, episodeBuild, episodes },
      });
    })) return checkpoint;

    if (!await execute("COMPILE", async () => {
      const episodes = checkpoint?.payload.episodes;
      if (episodes === undefined) throw new KnowledgeWorkerError("MISSING_EPISODE_CHECKPOINT", "episode checkpoint is missing", false);
      const compiled: KnowledgeCandidate[] = [];
      const provenance = new Map<string, CandidateCompilationProvenance>();
      for (const episode of episodes) {
        const result = await runKnowledgeExtraction(
          extractionRequest(episode, request, (checkpoint as KnowledgeWorkerCheckpoint).createdAt),
          this.#ports.compiler,
          request.extraction,
        );
        if (result.status !== "SUCCEEDED") {
          throw new KnowledgeWorkerError(
            `COMPILER_${result.reason}`,
            `knowledge compilation ${result.status.toLowerCase()}: ${result.reason}`,
            result.status === "RETRYABLE",
          );
        }
        for (const candidate of result.candidates) {
          const record = candidateProvenance(candidate.candidateId, result, request.policyHash);
          const existing = provenance.get(candidate.candidateId);
          if (existing !== undefined && canonical(existing) !== canonical(record)) {
            throw new KnowledgeWorkerError(
              "CANDIDATE_PROVENANCE_COLLISION",
              `candidate ${candidate.candidateId} has conflicting compilation provenance`,
              false,
            );
          }
          provenance.set(candidate.candidateId, record);
          compiled.push(candidate);
        }
        if (compiled.length > resolvedLimits.maxCandidates) {
          throw new KnowledgeWorkerError("CANDIDATE_BATCH_LIMIT_EXCEEDED", "candidate batch limit exceeded", false);
        }
      }
      const candidates = deduplicateCandidates(compiled);
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        payload: {
          ...(checkpoint as KnowledgeWorkerCheckpoint).payload,
          candidates,
          candidateProvenance: [...provenance.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        },
      });
    })) return checkpoint;

    if (!await execute("USER_COMMITMENT", async () => {
      const episodes = checkpoint?.payload.episodes;
      const candidates = checkpoint?.payload.candidates;
      if (episodes === undefined || candidates === undefined) {
        throw new KnowledgeWorkerError("MISSING_COMMITMENT_INPUT", "commitment input checkpoint is missing", false);
      }
      let provenance = checkpoint?.payload.candidateProvenance;
      try {
        provenance ??= backfillCandidateProvenance(
          candidates,
          episodes,
          request,
          (checkpoint as KnowledgeWorkerCheckpoint).createdAt,
        );
        const compilation = compileUserCommitments(episodes, candidates);
        checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
          payload: {
            ...(checkpoint as KnowledgeWorkerCheckpoint).payload,
            candidates: compilation.candidates,
            candidateProvenance: provenance,
            userCommitments: {
              signals: compilation.signals,
              ambiguities: compilation.ambiguities,
              correctionDrafts: compilation.correctionDrafts,
            },
          },
        });
      } catch (error) {
        if (error instanceof KnowledgeWorkerError) throw error;
        throw new KnowledgeWorkerError(
          "USER_COMMITMENT_INVALID",
          error instanceof Error ? error.message : "user commitment compilation failed",
          false,
          { cause: error },
        );
      }
    })) return checkpoint;

    if (!await execute("EVOLUTION_MATCH", async () => {
      const candidates = checkpoint?.payload.candidates;
      if (candidates === undefined) throw new KnowledgeWorkerError("MISSING_EVOLUTION_INPUT", "evolution input checkpoint is missing", false);
      const correctionDrafts = checkpoint?.payload.userCommitments?.correctionDrafts ?? [];
      const records: CandidateEvolutionRecord[] = [];
      for (const candidate of candidates) {
        const scope = resolveKnowledgeScope({
          candidate,
          projectContext: request.project,
          ...(request.allowGlobal === undefined ? {} : { allowGlobal: request.allowGlobal }),
          ...(request.projectTerms === undefined ? {} : { projectTerms: request.projectTerms }),
        });
        const exactId = assetIdentity(candidate, scope.scope);
        const exact = await external("EVOLUTION_EXACT_READ_FAILED", () => this.#ports.markdown.readCurrent(exactId));
        if (!exact.ok && exact.error.code !== "NOT_FOUND") {
          throw new KnowledgeWorkerError("EVOLUTION_EXACT_READ_INVALID", exact.error.message, false);
        }
        const retrievedTargets = await external("EVOLUTION_LOOKUP_FAILED", () =>
          this.#ports.evolution.search(evolutionQueries(candidate), resolvedLimits.maxEvolutionCandidates));
        try {
          const decision = await decideKnowledgeEvolution({
            candidate,
            proposedScope: scope.scope,
            ...(exact.ok ? { exactTarget: exact.value.asset } : {}),
            retrievedTargets,
            correctionRefs: correctionDrafts
              .filter((draft) => draft.candidateId === candidate.candidateId)
              .map((draft) => ({
                candidateId: draft.candidateId,
                relationHint: draft.relationHint,
                originalRef: draft.originalRef,
                correctedRef: draft.correctedRef,
              })),
          }, this.#ports.evolutionSemantic);
          records.push({ candidate, scope, decision });
        } catch (error) {
          throw new KnowledgeWorkerError(
            "EVOLUTION_DECISION_INVALID",
            error instanceof Error ? error.message : "knowledge evolution decision failed",
            false,
            { cause: error },
          );
        }
      }
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        payload: {
          ...(checkpoint as KnowledgeWorkerCheckpoint).payload,
          evolution: records.sort((left, right) => left.candidate.candidateId.localeCompare(right.candidate.candidateId)),
        },
      });
    })) return checkpoint;

    if (!await execute("CANDIDATE_POLICY", async () => {
      const evolutionRecords = checkpoint?.payload.evolution;
      if (evolutionRecords === undefined) throw new KnowledgeWorkerError("MISSING_EVOLUTION_CHECKPOINT", "evolution checkpoint is missing", false);
      const policies: CandidatePolicyRecord[] = [];
      const outbox: PublicationOutboxItem[] = [];
      const claimedAssetIds = new Map<string, string>();
      for (const evolution of evolutionRecords) {
        const { candidate, scope, decision: evolutionDecision } = evolution;
        const verificationResults = await external("EVIDENCE_VERIFICATION_FAILED", () =>
          this.#ports.evidence.verify(candidate, request.project, (checkpoint as KnowledgeWorkerCheckpoint).createdAt));
        const targetRef = evolutionDecision.targetKnowledgeVersions[0];
        let target: KnowledgeAsset | undefined;
        if (targetRef !== undefined) {
          const currentTarget = await external("EVOLUTION_TARGET_READ_FAILED", () =>
            this.#ports.markdown.readCurrent(targetRef.id));
          if (!currentTarget.ok) {
            throw new KnowledgeWorkerError(
              currentTarget.error.code === "NOT_FOUND" ? "EVOLUTION_TARGET_STALE" : "EVOLUTION_TARGET_READ_INVALID",
              currentTarget.error.message,
              currentTarget.error.code === "NOT_FOUND",
            );
          }
          if (currentTarget.value.asset.version !== targetRef.version) {
            throw new KnowledgeWorkerError("EVOLUTION_TARGET_STALE", `evolution target ${targetRef.id} changed version`, true);
          }
          target = currentTarget.value.asset;
        }
        const continuesLineage = evolutionDecision.status === "DECIDED"
          && (evolutionDecision.action === "SUPPLEMENT" || evolutionDecision.action === "SUPERSEDE"
            || evolutionDecision.action === "CONTRADICT" || evolutionDecision.action === "SKIP");
        const currentStatus: KnowledgeStatus = continuesLineage && target !== undefined ? target.status : "PROPOSED";
        const supportedRejection = candidate.assertions.some((assertion) =>
          assertion.kind === "USER_REJECTED"
          && verificationResults.some((result) => result.assertionId === assertion.assertionId && result.status === "SUPPORTED"));
        const revisionRequested = evolutionDecision.status === "DECIDED"
          && (evolutionDecision.action === "SUPPLEMENT" || evolutionDecision.action === "SUPERSEDE");
        const restrictiveTargetIds = evolutionDecision.status === "PENDING"
          || (evolutionDecision.requiresConfirmation && !supportedRejection)
          || (evolutionDecision.status === "DECIDED" && evolutionDecision.action === "CONTRADICT" && !supportedRejection)
          ? (evolutionTargetIds(evolutionDecision).length > 0
              ? evolutionTargetIds(evolutionDecision)
              : [`evolution:${candidate.candidateId}`])
          : [];
        const record: CandidatePolicyRecord = {
          candidate,
          currentStatus,
          scope,
          verificationResults,
          decision: evaluateEvidencePolicy({
            candidate,
            currentStatus,
            resolvedScope: scope.scope,
            projectScope: {
              level: "PROJECT",
              projectId: request.project.projectId,
              ...(request.project.repositoryRemote === undefined ? {} : { repositoryRemote: request.project.repositoryRemote }),
            },
            projectSpecificSignals: scope.projectSpecificSignals,
            verificationResults,
            verificationPolicy: request.verificationPolicy,
            ...(restrictiveTargetIds.length === 0 ? {} : { conflictIds: restrictiveTargetIds }),
            ...(evolutionDecision.status === "PENDING" ? { adoptionAmbiguous: true } : {}),
            ...(revisionRequested ? { contentRevisionRequested: true } : {}),
          }),
        };
        policies.push(record);
        const stableScope = canonical(record.decision.effectiveScope) === canonical(evolutionDecision.proposedScope);
        if (record.decision.shouldPublish && stableScope && evolutionAllowsPublication(evolutionDecision)) {
          const extendsLineage = evolutionDecision.status === "DECIDED"
            && (evolutionDecision.action === "SUPPLEMENT" || evolutionDecision.action === "SUPERSEDE");
          const assetId = extendsLineage && target !== undefined
            ? target.id
            : assetIdentity(candidate, record.decision.effectiveScope);
          const claimedBy = claimedAssetIds.get(assetId);
          if (claimedBy !== undefined && claimedBy !== candidate.candidateId) {
            throw new KnowledgeWorkerError(
              "ASSET_IDENTITY_COLLISION",
              `candidates ${claimedBy} and ${candidate.candidateId} resolve to the same asset identity`,
              false,
            );
          }
          claimedAssetIds.set(assetId, candidate.candidateId);
          const current = await external("MARKDOWN_CURRENT_READ_FAILED", () => this.#ports.markdown.readCurrent(assetId));
          if (!current.ok && current.error.code !== "NOT_FOUND") {
            throw new KnowledgeWorkerError("MARKDOWN_CURRENT_INVALID", current.error.message, false);
          }
          if (extendsLineage && (!current.ok || target === undefined || current.value.asset.version !== target.version)) {
            throw new KnowledgeWorkerError("EVOLUTION_TARGET_STALE", `lineage ${assetId} changed before publication planning`, true);
          }
          const version = current.ok ? current.value.asset.version + 1 : 1;
          outbox.push({
            candidateId: candidate.candidateId,
            asset: buildAsset(
              record,
              evolution,
              extendsLineage ? target : undefined,
              assetId,
              version,
              current.ok ? current.value.asset.createdAt : candidate.createdAt,
              (checkpoint as KnowledgeWorkerCheckpoint).createdAt,
            ),
            ...(current.ok ? { expectedCurrentVersion: current.value.asset.version } : {}),
          });
        }
      }
      if (outbox.length > resolvedLimits.maxPublishItems) {
        throw new KnowledgeWorkerError("PUBLISH_BATCH_LIMIT_EXCEEDED", "publish batch limit exceeded", false);
      }
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, policies, outbox },
      });
    })) return checkpoint;

    if (mode !== "SAFE_AUTO_PUBLICATION") {
      if (checkpoint.status !== "AWAITING_COMMIT") {
        checkpoint = this.#persist(checkpoint, { status: "AWAITING_COMMIT" });
      }
      return checkpoint;
    }

    if (!await execute("MARKDOWN_PUBLISH", async () => {
      const outbox = [...(checkpoint?.payload.outbox ?? [])];
      for (let index = 0; index < outbox.length; index += 1) {
        const item = outbox[index];
        if (item === undefined || item.markdown !== undefined) continue;
        const published = await external("MARKDOWN_PUBLISH_FAILED", () =>
          this.#ports.markdown.publish(
            item.asset,
            item.expectedCurrentVersion === undefined ? {} : { expectedCurrentVersion: item.expectedCurrentVersion },
          ));
        if (published.value.asset.version !== item.asset.version
          || published.value.asset.contentHash !== item.asset.contentHash) {
          throw new KnowledgeWorkerError("MARKDOWN_VERSION_MISMATCH", "Markdown published a different asset version", false);
        }
        outbox[index] = { ...item, markdown: published.value };
        checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
          payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, outbox: [...outbox] },
        });
      }
    })) return checkpoint;

    if (!await execute("REGISTRY_PROJECT", async () => {
      const outbox = [...(checkpoint?.payload.outbox ?? [])];
      for (let index = 0; index < outbox.length; index += 1) {
        const item = outbox[index];
        if (item === undefined || item.projection !== undefined) continue;
        if (item.markdown === undefined) throw new KnowledgeWorkerError("MISSING_MARKDOWN_OUTBOX", "Markdown outbox is incomplete", false);
        const projection = await external("REGISTRY_PROJECTION_FAILED", () => this.#ports.registry.projectCurrent(item.markdown!));
        if (projection.assetId !== item.asset.id || projection.assetVersion !== item.asset.version) {
          throw new KnowledgeWorkerError("REGISTRY_VERSION_MISMATCH", "Registry projected a different asset version", false);
        }
        outbox[index] = { ...item, projection };
        checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
          payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, outbox: [...outbox] },
        });
      }
    })) return checkpoint;

    if (!await execute("FRESHNESS_PROJECT", async () => {
      const outbox = [...(checkpoint?.payload.outbox ?? [])];
      const policies = new Map((checkpoint?.payload.policies ?? []).map((policy) => [policy.candidate.candidateId, policy]));
      for (let index = 0; index < outbox.length; index += 1) {
        const item = outbox[index];
        if (item === undefined || item.freshness !== undefined) continue;
        if (item.projection === undefined) throw new KnowledgeWorkerError("MISSING_REGISTRY_OUTBOX", "Registry outbox is incomplete", false);
        const policy = policies.get(item.candidateId);
        if (policy === undefined) throw new KnowledgeWorkerError("MISSING_POLICY_OUTBOX", "Policy outbox is incomplete", false);
        const freshness = await external("FRESHNESS_PROJECTION_FAILED", () => this.#ports.freshness.project({
          asset: item.asset,
          candidate: policy.candidate,
          verificationResults: policy.verificationResults,
          projectId: request.project.projectId,
          observedAt: (checkpoint as KnowledgeWorkerCheckpoint).createdAt,
        }));
        if (freshness.assetId !== item.asset.id || freshness.assetVersion !== item.asset.version) {
          throw new KnowledgeWorkerError("FRESHNESS_VERSION_MISMATCH", "Freshness projected a different asset version", false);
        }
        outbox[index] = { ...item, freshness };
        checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
          payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, outbox: [...outbox] },
        });
      }
    })) return checkpoint;

    if (!await execute("INCREMENTAL_INDEX", async () => {
      const outbox = [...(checkpoint?.payload.outbox ?? [])];
      for (let index = 0; index < outbox.length; index += 1) {
        const item = outbox[index];
        if (item === undefined || item.index !== undefined) continue;
        if (item.projection === undefined) throw new KnowledgeWorkerError("MISSING_REGISTRY_OUTBOX", "Registry outbox is incomplete", false);
        if (item.freshness === undefined) throw new KnowledgeWorkerError("MISSING_FRESHNESS_OUTBOX", "Freshness outbox is incomplete", false);
        const indexed = await external("INCREMENTAL_INDEX_FAILED", () => this.#ports.index.syncAsset(item.asset.id));
        if (!INDEX_SUCCESS.has(indexed.action)) {
          throw new KnowledgeWorkerError(
            `INDEX_${indexed.action}`,
            indexed.diagnostics.map((diagnostic) => diagnostic.message).join("; ") || indexed.action,
            true,
          );
        }
        if (indexed.assetVersion !== item.asset.version) {
          throw new KnowledgeWorkerError("INDEX_VERSION_MISMATCH", "index current version differs from Markdown", true);
        }
        outbox[index] = { ...item, index: indexed };
        checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
          payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, outbox: [...outbox] },
        });
      }
    })) return checkpoint;

    checkpoint = this.#persist(checkpoint, { status: "COMPLETED" });
    return checkpoint;
  }

  async rebuildIndex(limit = 1_000): Promise<IndexRebuildResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new KnowledgeWorkerError("INVALID_INDEX_REBUILD_LIMIT", "index rebuild limit must be between 1 and 10000", false);
    }
    const assetIds = [...new Set(await external("MARKDOWN_LIST_FAILED", () => this.#ports.markdown.listAssetIds()))].sort();
    if (assetIds.length > limit) {
      throw new KnowledgeWorkerError("INDEX_REBUILD_LIMIT_EXCEEDED", "Markdown assets exceed index rebuild limit", false);
    }
    const results = [];
    let indexed = 0;
    let unchanged = 0;
    for (const assetId of assetIds) {
      const current = await external("MARKDOWN_CURRENT_READ_FAILED", () => this.#ports.markdown.readCurrent(assetId));
      if (!current.ok) throw new KnowledgeWorkerError("INDEX_REBUILD_CURRENT_INVALID", current.error.message, false);
      const result = await external("INCREMENTAL_INDEX_FAILED", () => this.#ports.index.syncAsset(assetId));
      if (!INDEX_SUCCESS.has(result.action) || result.assetVersion !== current.value.asset.version) {
        throw new KnowledgeWorkerError("INDEX_REBUILD_INCONSISTENT", `index rebuild failed for ${assetId}`, true);
      }
      results.push(result);
      if (result.action === "UNCHANGED") unchanged += 1;
      else indexed += 1;
    }
    return { requested: assetIds.length, indexed, unchanged, results };
  }

  #persist(
    current: KnowledgeWorkerCheckpoint,
    change: Partial<Omit<KnowledgeWorkerCheckpoint, "schemaVersion" | "workId" | "identityHash" | "revision" | "createdAt">>,
  ): KnowledgeWorkerCheckpoint {
    const next: KnowledgeWorkerCheckpoint = {
      ...current,
      ...change,
      revision: current.revision + 1,
      updatedAt: this.#clock().toISOString(),
    };
    try {
      this.#store.save(next, current.revision);
    } catch (error) {
      throw new KnowledgeWorkerError(
        "CHECKPOINT_SAVE_FAILED",
        error instanceof Error ? error.message : "checkpoint save failed",
        true,
        { cause: error },
      );
    }
    return next;
  }
}
