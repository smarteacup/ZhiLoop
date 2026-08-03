import { createHash } from "node:crypto";

import {
  isDefaultRetrievalEligible,
  transitionKnowledgeStatus,
  type KnowledgeAsset,
  type KnowledgeRelation,
  type KnowledgeStatus,
} from "@zhiloop/domain";
import { calculateKnowledgeContentHash } from "@zhiloop/markdown-repository";
import { parseKnowledgeAsset } from "@zhiloop/schemas";

import { GovernanceError } from "./errors.js";
import type {
  CommitEditDraftRequest,
  CreateEditDraftRequest,
  EligibilityGatePort,
  GovernanceIndexPort,
  GovernanceMarkdownPort,
  GovernanceOperation,
  GovernanceOperationKind,
  GovernanceOperationStore,
  GovernanceOutboxStage,
  GovernanceStageRecord,
  KnowledgeEditDraft,
  KnowledgeFieldChange,
  KnowledgeImpactPreview,
  KnowledgeRegistryPort,
  KnowledgeRevalidationPort,
  MutationContext,
  RestoreRequest,
  RevalidationResult,
  SupersedeRequest,
  SuppressRequest,
} from "./types.js";

const STAGES: readonly GovernanceOutboxStage[] = [
  "ELIGIBILITY_EXCLUDE",
  "MARKDOWN",
  "REGISTRY",
  "INDEX",
  "ELIGIBILITY_FINALIZE",
];
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

function hash(parts: readonly unknown[]): string {
  return createHash("sha256").update(canonical(parts)).digest("hex");
}

function validateIdentity(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 500 || /[\0\r\n]/.test(value)) {
    throw new GovernanceError("INVALID_REQUEST", `${name} is invalid`);
  }
}

function validateContext(input: MutationContext): void {
  validateIdentity(input.assetId, "assetId");
  validateIdentity(input.idempotencyKey, "idempotencyKey");
  validateIdentity(input.correlationId, "correlationId");
  validateIdentity(input.actor, "actor");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new GovernanceError("INVALID_REQUEST", "expectedVersion must be a positive safe integer");
  }
  const milliseconds = Date.parse(input.now);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input.now) {
    throw new GovernanceError("INVALID_REQUEST", "now must be a canonical ISO timestamp");
  }
}

function rehash(asset: KnowledgeAsset, change: Partial<Omit<KnowledgeAsset, "contentHash">>): KnowledgeAsset {
  const draft = { ...asset, ...change, contentHash: "" };
  return { ...draft, contentHash: calculateKnowledgeContentHash(draft) };
}

function initialStages(): Record<GovernanceOutboxStage, GovernanceStageRecord> {
  return Object.fromEntries(STAGES.map((stage) => [stage, { status: "PENDING", attempts: 0 }])) as
    Record<GovernanceOutboxStage, GovernanceStageRecord>;
}

function assertOrdinaryProject(asset: KnowledgeAsset, nextScope = asset.scope): void {
  if (asset.kind === "RULE" || asset.scope.level === "GLOBAL" || nextScope.level === "GLOBAL") {
    throw new GovernanceError(
      "HIGH_RISK_GOVERNANCE_DISABLED",
      "GLOBAL and RULE governance requires the separately gated high-risk capability",
    );
  }
  if (!("projectId" in asset.scope) || asset.scope.projectId === undefined) {
    throw new GovernanceError("HIGH_RISK_GOVERNANCE_DISABLED", "ordinary governance requires project-bound knowledge");
  }
}

function statusAfterRevalidation(current: KnowledgeStatus, validation: RevalidationResult): KnowledgeStatus {
  if (validation.scopeValid && validation.evidenceSupported) return current;
  // Once knowledge has entered the authoritative repository, a failed
  // revalidation is represented as STALE. Downgrading an ACCEPTED asset back
  // to PROPOSED would make the immutable Markdown revision unpublishable and
  // strand the governance outbox between validation and persistence.
  return current === "ACCEPTED" || current === "IMPLEMENTED" || current === "VERIFIED" ? "STALE" : "PROPOSED";
}

function fieldChanges(before: KnowledgeAsset, after: KnowledgeAsset): readonly KnowledgeFieldChange[] {
  return (Object.keys(before) as Array<keyof KnowledgeAsset>).flatMap((field) =>
    canonical(before[field]) === canonical(after[field]) ? [] : [{ field, before: before[field], after: after[field] }]);
}

function impact(
  current: KnowledgeAsset,
  proposed: KnowledgeAsset,
  validation: RevalidationResult,
): KnowledgeImpactPreview {
  const changes = fieldChanges(current, proposed);
  const currentEligible = isDefaultRetrievalEligible(current.status);
  const nextEligible = isDefaultRetrievalEligible(proposed.status) && validation.scopeValid && validation.evidenceSupported;
  return {
    changes,
    currentEligible,
    nextEligible,
    scopeChanged: canonical(current.scope) !== canonical(proposed.scope),
    evidenceDowngraded: current.status !== proposed.status || !validation.evidenceSupported,
    affectedRelationIds: [...new Set([
      ...current.relations.map((relation) => relation.targetId),
      ...proposed.relations.map((relation) => relation.targetId),
    ])].sort(),
    affectedSymbols: [...new Set([...current.symbols, ...proposed.symbols])].sort(),
    reasonCodes: [...new Set([
      ...validation.reasonCodes,
      ...(currentEligible && !nextEligible ? ["DEFAULT_RETRIEVAL_WILL_BE_EXCLUDED"] : []),
      ...(canonical(current.scope) !== canonical(proposed.scope) ? ["SCOPE_CHANGED"] : []),
    ])],
  };
}

function matchingOperation(
  existing: GovernanceOperation,
  kind: GovernanceOperationKind,
  input: Pick<MutationContext, "assetId" | "expectedVersion" | "idempotencyKey">,
  requestHash: string,
): void {
  if (existing.kind !== kind || existing.assetId !== input.assetId || existing.expectedVersion !== input.expectedVersion
    || existing.requestHash !== requestHash) {
    throw new GovernanceError("INVALID_REQUEST", "idempotency key is already bound to a different operation");
  }
}

export class KnowledgeGovernanceMutationService {
  readonly #registry: KnowledgeRegistryPort;
  readonly #markdown: GovernanceMarkdownPort;
  readonly #index: GovernanceIndexPort;
  readonly #eligibility: EligibilityGatePort;
  readonly #revalidation: KnowledgeRevalidationPort;
  readonly #store: GovernanceOperationStore;
  readonly #maxStageAttempts: number;

  constructor(
    ports: {
      readonly registry: KnowledgeRegistryPort;
      readonly markdown: GovernanceMarkdownPort;
      readonly index: GovernanceIndexPort;
      readonly eligibility: EligibilityGatePort;
      readonly revalidation: KnowledgeRevalidationPort;
    },
    store: GovernanceOperationStore,
    maxStageAttempts = 5,
  ) {
    if (!Number.isSafeInteger(maxStageAttempts) || maxStageAttempts < 1 || maxStageAttempts > 20) {
      throw new Error("maxStageAttempts must be between 1 and 20");
    }
    this.#registry = ports.registry;
    this.#markdown = ports.markdown;
    this.#index = ports.index;
    this.#eligibility = ports.eligibility;
    this.#revalidation = ports.revalidation;
    this.#store = store;
    this.#maxStageAttempts = maxStageAttempts;
  }

  async createEditDraft(request: CreateEditDraftRequest): Promise<KnowledgeEditDraft> {
    validateContext(request);
    const current = await this.#alignedCurrent(request.assetId, request.expectedVersion);
    assertOrdinaryProject(current.asset, request.patch.scope ?? current.asset.scope);
    const semanticChanges = Object.entries(request.patch).filter(([, value]) => value !== undefined)
      .some(([field, value]) => canonical(current.asset[field as keyof KnowledgeAsset]) !== canonical(value));
    if (!semanticChanges) throw new GovernanceError("INVALID_REQUEST", "edit draft contains no semantic changes");
    const patched = rehash(current.asset, {
      ...request.patch,
      version: current.asset.version + 1,
      correlationId: request.correlationId,
      updatedAt: request.now,
    });
    const parsed = parseKnowledgeAsset(patched);
    if (!parsed.ok) throw new GovernanceError("REVALIDATION_FAILED", parsed.error.message);
    const validation = await this.#revalidation.revalidate(current.asset, parsed.value);
    const proposed = rehash(parsed.value, {
      status: statusAfterRevalidation(current.asset.status, validation),
      evidence: validation.evidence,
    });
    const preview = impact(current.asset, proposed, validation);
    if (preview.changes.length === 0) throw new GovernanceError("INVALID_REQUEST", "edit draft contains no changes");
    const draft: KnowledgeEditDraft = {
      draftId: hash(["knowledge-edit-draft-v1", request.idempotencyKey, request.assetId, request.expectedVersion]),
      idempotencyKey: request.idempotencyKey,
      assetId: request.assetId,
      expectedVersion: request.expectedVersion,
      baseContentHash: current.asset.contentHash,
      proposed,
      revalidation: validation,
      impact: preview,
      status: "VALIDATED",
      createdAt: request.now,
    };
    const existing = this.#store.getDraftByIdempotencyKey(request.idempotencyKey);
    if (existing !== undefined) {
      if (canonical(existing) !== canonical(draft)) {
        throw new GovernanceError("INVALID_REQUEST", "idempotency key is already bound to a different edit draft");
      }
      return existing;
    }
    this.#store.createDraft(draft);
    return draft;
  }

  async commitEditDraft(request: CommitEditDraftRequest): Promise<GovernanceOperation> {
    validateIdentity(request.draftId, "draftId");
    validateIdentity(request.idempotencyKey, "idempotencyKey");
    validateIdentity(request.actor, "actor");
    const milliseconds = Date.parse(request.now);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== request.now) {
      throw new GovernanceError("INVALID_REQUEST", "now must be a canonical ISO timestamp");
    }
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) {
      throw new GovernanceError("INVALID_REQUEST", "expectedVersion must be a positive safe integer");
    }
    const draft = this.#store.getDraft(request.draftId);
    if (draft === undefined) throw new GovernanceError("NOT_FOUND", "knowledge edit draft was not found");
    if (request.expectedVersion !== draft.expectedVersion) {
      throw new GovernanceError("STALE_EXPECTED_VERSION", "draft expected version does not match commit request");
    }
    if (draft.status === "COMMITTED") {
      const committed = draft.committedOperationId === undefined ? undefined : this.#store.getOperation(draft.committedOperationId);
      if (committed === undefined) throw new GovernanceError("DRAFT_ALREADY_COMMITTED", "draft commit record is incomplete", true);
      return this.#execute(committed);
    }
    await this.#alignedCurrent(draft.assetId, draft.expectedVersion, draft.baseContentHash);
    const requestHash = hash([
      "knowledge-governance-request-v1", "EDIT", request.idempotencyKey, draft.draftId,
      draft.expectedVersion, draft.baseContentHash, draft.proposed.contentHash, request.actor,
    ]);
    const operation = this.#newOperation("EDIT", {
      assetId: draft.assetId,
      expectedVersion: draft.expectedVersion,
      idempotencyKey: request.idempotencyKey,
      correlationId: draft.proposed.correlationId,
      actor: request.actor,
      now: request.now,
    }, draft.proposed, requestHash);
    const existing = this.#store.getOperationByIdempotencyKey(request.idempotencyKey);
    if (existing === undefined) this.#store.createOperation(operation);
    else matchingOperation(existing, "EDIT", operation, requestHash);
    const selected = existing ?? operation;
    this.#store.markDraftCommitted(draft.draftId, selected.operationId);
    return this.#execute(selected);
  }

  async suppress(request: SuppressRequest): Promise<GovernanceOperation> {
    validateContext(request);
    if (request.reason.trim().length === 0) throw new GovernanceError("INVALID_REQUEST", "suppression reason is required");
    const requestHash = hash([
      "knowledge-governance-request-v1", "SUPPRESS", request.idempotencyKey, request.assetId,
      request.expectedVersion, request.correlationId, request.actor, request.reason,
    ]);
    const existing = this.#store.getOperationByIdempotencyKey(request.idempotencyKey);
    if (existing !== undefined) {
      matchingOperation(existing, "SUPPRESS", request, requestHash);
      return this.#execute(existing);
    }
    const current = await this.#alignedCurrent(request.assetId, request.expectedVersion);
    assertOrdinaryProject(current.asset);
    if (current.tombstone) throw new GovernanceError("INVALID_REQUEST", "knowledge is already suppressed");
    const target = rehash(current.asset, {
      version: current.asset.version + 1,
      correlationId: request.correlationId,
      updatedAt: request.now,
    });
    const operation = this.#newOperation("SUPPRESS", request, target, requestHash, true, request.reason);
    this.#store.createOperation(operation);
    return this.#execute(operation);
  }

  async restore(request: RestoreRequest): Promise<GovernanceOperation> {
    validateContext(request);
    if (!Number.isSafeInteger(request.sourceVersion) || request.sourceVersion < 1) {
      throw new GovernanceError("INVALID_REQUEST", "sourceVersion must be a positive safe integer");
    }
    const requestHash = hash([
      "knowledge-governance-request-v1", "RESTORE", request.idempotencyKey, request.assetId,
      request.expectedVersion, request.correlationId, request.actor, request.sourceVersion,
    ]);
    const existing = this.#store.getOperationByIdempotencyKey(request.idempotencyKey);
    if (existing !== undefined) {
      matchingOperation(existing, "RESTORE", request, requestHash);
      return this.#execute(existing);
    }
    const current = await this.#alignedCurrent(request.assetId, request.expectedVersion);
    assertOrdinaryProject(current.asset);
    if (!current.tombstone) throw new GovernanceError("INVALID_REQUEST", "only suppressed knowledge can be restored");
    const source = await this.#markdown.readVersion(request.assetId, request.sourceVersion);
    if (!source.ok || source.value.tombstone) throw new GovernanceError("NOT_FOUND", "restoration source version is unavailable");
    const supersedes: KnowledgeRelation = {
      type: "SUPERSEDES",
      targetId: request.assetId,
      targetVersion: current.asset.version,
      reason: `restored from version ${request.sourceVersion}`,
    };
    const target = rehash(source.value.asset, {
      version: current.asset.version + 1,
      relations: [...source.value.asset.relations.filter((relation) => !(
        relation.type === supersedes.type && relation.targetId === supersedes.targetId
        && relation.targetVersion === supersedes.targetVersion
      )), supersedes],
      correlationId: request.correlationId,
      updatedAt: request.now,
    });
    const validation = await this.#revalidation.revalidate(current.asset, target);
    if (!validation.scopeValid || !validation.evidenceSupported) {
      throw new GovernanceError("RESTORE_REVALIDATION_FAILED", "suppressed knowledge no longer satisfies restoration policy");
    }
    const validated = rehash(target, { evidence: validation.evidence });
    const operation = this.#newOperation("RESTORE", request, validated, requestHash);
    this.#store.createOperation(operation);
    return this.#execute(operation);
  }

  async supersede(request: SupersedeRequest): Promise<GovernanceOperation> {
    validateContext(request);
    validateIdentity(request.replacementAssetId, "replacementAssetId");
    if (request.replacementAssetId === request.assetId || request.reason.trim().length === 0) {
      throw new GovernanceError("INVALID_REQUEST", "supersede replacement and reason are invalid");
    }
    const requestHash = hash([
      "knowledge-governance-request-v1", "SUPERSEDE", request.idempotencyKey, request.assetId,
      request.expectedVersion, request.correlationId, request.actor, request.replacementAssetId, request.reason,
    ]);
    const existing = this.#store.getOperationByIdempotencyKey(request.idempotencyKey);
    if (existing !== undefined) {
      matchingOperation(existing, "SUPERSEDE", request, requestHash);
      return this.#execute(existing);
    }
    const current = await this.#alignedCurrent(request.assetId, request.expectedVersion);
    const replacement = this.#registry.getAsset(request.replacementAssetId, false);
    if (replacement === undefined || !isDefaultRetrievalEligible(replacement.asset.status)) {
      throw new GovernanceError("INVALID_REQUEST", "replacement knowledge must exist and be retrieval eligible");
    }
    assertOrdinaryProject(current.asset);
    assertOrdinaryProject(replacement.asset);
    if (canonical(current.asset.scope) !== canonical(replacement.asset.scope)) {
      throw new GovernanceError("INVALID_REQUEST", "replacement knowledge must use the same ordinary project scope");
    }
    const transition = transitionKnowledgeStatus(current.asset.status, "SUPERSEDED");
    if (!transition.ok) throw new GovernanceError("INVALID_REQUEST", `cannot supersede ${current.asset.status} knowledge`);
    const target = rehash(current.asset, {
      version: current.asset.version + 1,
      status: "SUPERSEDED",
      relations: [
        ...current.asset.relations,
        { type: "SUPERSEDES", targetId: current.asset.id, targetVersion: current.asset.version, reason: request.reason },
        { type: "RELATED_TO", targetId: replacement.asset.id, targetVersion: replacement.asset.version, reason: "replacement" },
      ],
      correlationId: request.correlationId,
      updatedAt: request.now,
    });
    const operation = this.#newOperation("SUPERSEDE", request, target, requestHash);
    this.#store.createOperation(operation);
    return this.#execute(operation);
  }

  async retry(operationId: string): Promise<GovernanceOperation> {
    const operation = this.#store.getOperation(operationId);
    if (operation === undefined) throw new GovernanceError("NOT_FOUND", "governance operation was not found");
    if (operation.status === "FAILED") throw new GovernanceError("OUTBOX_FAILED", "terminal governance operation cannot be retried");
    return this.#execute(operation);
  }

  #newOperation(
    kind: GovernanceOperationKind,
    input: MutationContext,
    target: KnowledgeAsset,
    requestHash: string,
    targetTombstone = false,
    tombstoneReason?: string,
  ): GovernanceOperation {
    return {
      schemaVersion: 1,
      operationId: hash(["knowledge-governance-operation-v1", kind, input.idempotencyKey]),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      kind,
      assetId: input.assetId,
      expectedVersion: input.expectedVersion,
      actor: input.actor,
      correlationId: input.correlationId,
      target,
      targetTombstone,
      ...(tombstoneReason === undefined ? {} : { tombstoneReason }),
      status: "PENDING",
      revision: 0,
      stages: initialStages(),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  async #alignedCurrent(assetId: string, expectedVersion: number, expectedHash?: string) {
    const [markdown, projected] = await Promise.all([
      this.#markdown.readCurrent(assetId),
      Promise.resolve(this.#registry.getAsset(assetId, true)),
    ]);
    if (projected === undefined) throw new GovernanceError("NOT_FOUND", `knowledge asset ${assetId} was not found`);
    if (!markdown.ok) {
      if (markdown.error.code === "NOT_FOUND" && markdown.lastValid === undefined) {
        throw new GovernanceError("NOT_FOUND", `knowledge asset ${assetId} was not found`);
      }
      throw new GovernanceError(
        "MANUAL_MARKDOWN_CONFLICT",
        "current Markdown is invalid or externally modified; the external content was preserved",
      );
    }
    if (markdown.value.historyState !== "COMMITTED") {
      throw new GovernanceError(
        "MANUAL_MARKDOWN_CONFLICT",
        "current Markdown was edited externally; refresh and resolve the diff before Console writes",
      );
    }
    if (markdown.value.asset.version !== projected.asset.version
      || markdown.value.asset.contentHash !== projected.asset.contentHash
      || markdown.value.tombstone !== projected.tombstone) {
      throw new GovernanceError("PROJECTION_NOT_CURRENT", "Markdown and Registry current projections are not aligned", true);
    }
    if (markdown.value.asset.version !== expectedVersion
      || (expectedHash !== undefined && markdown.value.asset.contentHash !== expectedHash)) {
      throw new GovernanceError("STALE_EXPECTED_VERSION", "expected knowledge version is stale");
    }
    return markdown.value;
  }

  async #execute(initial: GovernanceOperation): Promise<GovernanceOperation> {
    let operation = initial;
    if (operation.status === "COMPLETED" || operation.status === "FAILED") return operation;
    for (const stage of STAGES) {
      if (operation.stages[stage].status === "SUCCEEDED") continue;
      const attempts = operation.stages[stage].attempts + 1;
      operation = this.#save(operation, {
        status: "PENDING",
        stages: { ...operation.stages, [stage]: { status: "PENDING", attempts } },
      });
      try {
        operation = await this.#runStage(operation, stage);
        operation = this.#save(operation, {
          stages: { ...operation.stages, [stage]: { status: "SUCCEEDED", attempts } },
        });
      } catch (error) {
        const retryable = !(error instanceof GovernanceError) || error.retryable;
        const canRetry = retryable && attempts < this.#maxStageAttempts;
        operation = this.#save(operation, {
          status: canRetry ? "DEGRADED" : "FAILED",
          stages: {
            ...operation.stages,
            [stage]: {
              status: canRetry ? "RETRYABLE" : "FAILED",
              attempts,
              errorCode: error instanceof GovernanceError ? error.code : "OUTBOX_STAGE_FAILED",
              errorMessage: error instanceof Error ? error.message : "governance stage failed",
            },
          },
        });
        return operation;
      }
    }
    return this.#save(operation, { status: "COMPLETED" });
  }

  async #runStage(operation: GovernanceOperation, stage: GovernanceOutboxStage): Promise<GovernanceOperation> {
    if (stage === "ELIGIBILITY_EXCLUDE") {
      await this.#eligibility.exclude(operation.assetId, operation.operationId);
      return operation;
    }
    if (stage === "MARKDOWN") {
      const current = await this.#markdown.readCurrent(operation.assetId);
      if (current.ok && current.value.historyState !== "COMMITTED") {
        throw new GovernanceError(
          "MANUAL_MARKDOWN_CONFLICT",
          "current Markdown was edited externally; the external content was preserved",
        );
      }
      if (current.ok && current.value.historyState === "COMMITTED"
        && current.value.asset.version === operation.target.version
        && current.value.asset.contentHash === operation.target.contentHash
        && current.value.tombstone === operation.targetTombstone) {
        return this.#save(operation, { markdown: current.value });
      }
      await this.#alignedCurrent(operation.assetId, operation.expectedVersion);
      const published = operation.targetTombstone
        ? await this.#markdown.tombstone(operation.assetId, {
            expectedCurrentVersion: operation.expectedVersion,
            reason: operation.tombstoneReason ?? "suppressed",
            updatedAt: operation.target.updatedAt,
            correlationId: operation.target.correlationId,
          })
        : await this.#markdown.publish(operation.target, { expectedCurrentVersion: operation.expectedVersion });
      if (published.value.asset.version !== operation.target.version
        || published.value.asset.contentHash !== operation.target.contentHash
        || published.value.tombstone !== operation.targetTombstone) {
        throw new GovernanceError("OUTBOX_FAILED", "Markdown committed an unexpected governance revision");
      }
      return this.#save(operation, { markdown: published.value });
    }
    if (stage === "REGISTRY") {
      if (operation.markdown === undefined) throw new GovernanceError("OUTBOX_FAILED", "Markdown stage is incomplete");
      const projection = await this.#registry.projectCurrent(operation.markdown);
      if (projection.assetId !== operation.assetId || projection.assetVersion !== operation.target.version) {
        throw new GovernanceError("OUTBOX_FAILED", "Registry projected an unexpected governance revision");
      }
      return this.#save(operation, { projection });
    }
    if (stage === "INDEX") {
      if (operation.projection === undefined) throw new GovernanceError("OUTBOX_FAILED", "Registry stage is incomplete");
      const index = await this.#index.syncAsset(operation.assetId);
      if (!INDEX_SUCCESS.has(index.action) || index.assetVersion !== operation.target.version) {
        throw new GovernanceError("OUTBOX_FAILED", "search index did not activate the governance revision", true);
      }
      return this.#save(operation, { index });
    }
    if (!operation.targetTombstone && isDefaultRetrievalEligible(operation.target.status)) {
      await this.#eligibility.include(operation.assetId, operation.operationId);
    }
    return operation;
  }

  #save(
    current: GovernanceOperation,
    change: Partial<Omit<GovernanceOperation, "schemaVersion" | "operationId" | "idempotencyKey" | "requestHash" | "kind" | "assetId"
      | "expectedVersion" | "actor" | "correlationId" | "target" | "targetTombstone" | "createdAt" | "revision">>,
  ): GovernanceOperation {
    const next: GovernanceOperation = {
      ...current,
      ...change,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#store.saveOperation(next, current.revision);
    return next;
  }
}
