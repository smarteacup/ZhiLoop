import { createHash } from "node:crypto";

import { normalizeConversations } from "@zhiloop/conversation-normalizer";
import type { EvidenceRef, KnowledgeAsset, KnowledgeCandidate, KnowledgeScope, KnowledgeStatus } from "@zhiloop/domain";
import { buildEpisodes } from "@zhiloop/episode-builder";
import { evaluateEvidencePolicy } from "@zhiloop/evidence-policy";
import { runKnowledgeExtraction, toKnowledgeExtractionInput } from "@zhiloop/knowledge-compiler";
import { calculateKnowledgeContentHash } from "@zhiloop/markdown-repository";
import { resolveKnowledgeScope } from "@zhiloop/scope-resolver";

import { KnowledgeWorkerError } from "./errors.js";
import {
  WORKER_STAGES,
  type CandidatePolicyRecord,
  type IndexRebuildResult,
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
});
const HARD_LIMITS: KnowledgeWorkerLimits = Object.freeze({
  maxLedgerRecords: 5_000,
  maxEpisodes: 1_000,
  maxCandidates: 2_000,
  maxPublishItems: 500,
  maxStageAttempts: 20,
});
const INDEX_SUCCESS = new Set(["INDEXED", "UNCHANGED", "CHUNKS_REFRESHED"]);

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
  return hash({
    workId: request.workId,
    snapshot: request.snapshot,
    asOf: request.asOf,
    project: request.project,
    compilerVersion: request.compilerVersion,
    promptVersion: request.promptVersion,
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

function buildAsset(
  policy: CandidatePolicyRecord,
  assetId: string,
  version: number,
  createdAt: string,
  updatedAt: string,
): KnowledgeAsset {
  const candidate = policy.candidate;
  const base: KnowledgeAsset = {
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
    aliases: [],
    keywords: [...new Set(candidate.subjectKey.split("."))],
    applicability: [],
    nonApplicability: [],
    symbols: candidateSymbols(candidate),
    relations: [],
    evidence: evidenceRefs(policy),
    confidence: candidate.confidence,
    sourceEpisodes: candidate.sourceEpisodes,
    contentHash: "",
    correlationId: candidate.correlationId,
    createdAt,
    updatedAt,
  };
  return { ...base, contentHash: calculateKnowledgeContentHash(base) };
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
    let checkpoint = this.#store.load(request.workId);
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
        stages: pendingStages(),
        payload: {},
      };
      this.#store.create(checkpoint);
    } else if (checkpoint.identityHash !== identityHash) {
      throw new KnowledgeWorkerError(
        "WORK_IDENTITY_CONFLICT",
        `work ${request.workId} cannot be replayed with different input or policy`,
        false,
      );
    }

    if (checkpoint.payload.ledger !== undefined && this.#ports.ledger.inspectSnapshot !== undefined) {
      const inspected = await external("LEDGER_SNAPSHOT_INSPECTION_FAILED", () =>
        this.#ports.ledger.inspectSnapshot?.(request.snapshot));
      if (inspected === undefined || inspected.contentHash !== checkpoint.payload.ledger.contentHash
        || inspected.sourceVersion !== checkpoint.payload.ledger.sourceVersion) {
        throw new KnowledgeWorkerError("LEDGER_SNAPSHOT_CHANGED", "immutable ledger snapshot changed during replay", false);
      }
    }
    if (checkpoint.status === "COMPLETED") return checkpoint;
    if (checkpoint.status === "FAILED") {
      if (options.retryFailed !== true) return checkpoint;
      const failedStage = WORKER_STAGES.find((stage) =>
        checkpoint?.stages[stage].status === "FAILED" && checkpoint.stages[stage].error?.retryable === true);
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
      for (const episode of episodes) {
        const result = await runKnowledgeExtraction({
          input: toKnowledgeExtractionInput(episode),
          compilerVersion: request.compilerVersion,
          promptVersion: request.promptVersion,
          requestedAt: (checkpoint as KnowledgeWorkerCheckpoint).createdAt,
          correlationId: `${request.workId}:${episode.episodeId}`,
        }, this.#ports.compiler, request.extraction);
        if (result.status !== "SUCCEEDED") {
          throw new KnowledgeWorkerError(
            `COMPILER_${result.reason}`,
            `knowledge compilation ${result.status.toLowerCase()}: ${result.reason}`,
            result.status === "RETRYABLE",
          );
        }
        compiled.push(...result.candidates);
        if (compiled.length > resolvedLimits.maxCandidates) {
          throw new KnowledgeWorkerError("CANDIDATE_BATCH_LIMIT_EXCEEDED", "candidate batch limit exceeded", false);
        }
      }
      const candidates = deduplicateCandidates(compiled);
      checkpoint = this.#persist(checkpoint as KnowledgeWorkerCheckpoint, {
        payload: { ...(checkpoint as KnowledgeWorkerCheckpoint).payload, candidates },
      });
    })) return checkpoint;

    if (!await execute("CANDIDATE_POLICY", async () => {
      const candidates = checkpoint?.payload.candidates;
      if (candidates === undefined) throw new KnowledgeWorkerError("MISSING_CANDIDATE_CHECKPOINT", "candidate checkpoint is missing", false);
      const policies: CandidatePolicyRecord[] = [];
      const outbox: PublicationOutboxItem[] = [];
      const claimedAssetIds = new Map<string, string>();
      for (const candidate of candidates) {
        const scope = resolveKnowledgeScope({
          candidate,
          projectContext: request.project,
          ...(request.allowGlobal === undefined ? {} : { allowGlobal: request.allowGlobal }),
          ...(request.projectTerms === undefined ? {} : { projectTerms: request.projectTerms }),
        });
        const verificationResults = await external("EVIDENCE_VERIFICATION_FAILED", () =>
          this.#ports.evidence.verify(candidate, request.project, (checkpoint as KnowledgeWorkerCheckpoint).createdAt));
        const preliminaryAssetId = assetIdentity(candidate, scope.scope);
        let current = await external("MARKDOWN_CURRENT_READ_FAILED", () =>
          this.#ports.markdown.readCurrent(preliminaryAssetId));
        if (!current.ok && current.error.code !== "NOT_FOUND") {
          throw new KnowledgeWorkerError("MARKDOWN_CURRENT_INVALID", current.error.message, false);
        }
        const currentStatus: KnowledgeStatus = current.ok ? current.value.asset.status : "PROPOSED";
        let record: CandidatePolicyRecord = {
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
          }),
        };
        const effectiveAssetId = assetIdentity(candidate, record.decision.effectiveScope);
        if (effectiveAssetId !== preliminaryAssetId) {
          current = await external("MARKDOWN_CURRENT_READ_FAILED", () =>
            this.#ports.markdown.readCurrent(effectiveAssetId));
          if (!current.ok && current.error.code !== "NOT_FOUND") {
            throw new KnowledgeWorkerError("MARKDOWN_CURRENT_INVALID", current.error.message, false);
          }
          const effectiveCurrentStatus: KnowledgeStatus = current.ok ? current.value.asset.status : "PROPOSED";
          record = {
            ...record,
            currentStatus: effectiveCurrentStatus,
            decision: evaluateEvidencePolicy({
              candidate,
              currentStatus: effectiveCurrentStatus,
              resolvedScope: scope.scope,
              projectScope: {
                level: "PROJECT",
                projectId: request.project.projectId,
                ...(request.project.repositoryRemote === undefined
                  ? {}
                  : { repositoryRemote: request.project.repositoryRemote }),
              },
              projectSpecificSignals: scope.projectSpecificSignals,
              verificationResults,
              verificationPolicy: request.verificationPolicy,
            }),
          };
        }
        policies.push(record);
        if (record.decision.shouldPublish) {
          const assetId = assetIdentity(candidate, record.decision.effectiveScope);
          const claimedBy = claimedAssetIds.get(assetId);
          if (claimedBy !== undefined && claimedBy !== candidate.candidateId) {
            throw new KnowledgeWorkerError(
              "ASSET_IDENTITY_COLLISION",
              `candidates ${claimedBy} and ${candidate.candidateId} resolve to the same asset identity`,
              false,
            );
          }
          claimedAssetIds.set(assetId, candidate.candidateId);
          const version = current.ok ? current.value.asset.version + 1 : 1;
          outbox.push({
            candidateId: candidate.candidateId,
            asset: buildAsset(
              record,
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

    if (options.stopAfterCandidatePolicy === true) {
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

    if (!await execute("INCREMENTAL_INDEX", async () => {
      const outbox = [...(checkpoint?.payload.outbox ?? [])];
      for (let index = 0; index < outbox.length; index += 1) {
        const item = outbox[index];
        if (item === undefined || item.index !== undefined) continue;
        if (item.projection === undefined) throw new KnowledgeWorkerError("MISSING_REGISTRY_OUTBOX", "Registry outbox is incomplete", false);
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
