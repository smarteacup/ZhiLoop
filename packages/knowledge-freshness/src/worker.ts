import type { KnowledgeCandidate } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";
import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";

import { planKnowledgeFreshness } from "./freshness.js";
import type {
  FreshnessPlan,
  FreshnessStateTransitionInput,
  KnowledgeFreshnessRecord,
  KnowledgeFreshnessState,
} from "./types.js";

export interface FreshnessWorkerStorePort {
  affected(changes: KnowledgeChangeSet, limit: number): {
    readonly items: readonly { readonly assetId: string; readonly assetVersion: number }[];
    readonly bounded: boolean;
  };
  get(assetId: string, assetVersion?: number): KnowledgeFreshnessRecord | undefined;
  getState(assetId: string, assetVersion?: number): KnowledgeFreshnessState | undefined;
  transition(input: FreshnessStateTransitionInput): { readonly status: "TRANSITIONED" | "IDEMPOTENT"; readonly state: KnowledgeFreshnessState };
}

export interface FreshnessRevalidationItem {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly candidate: KnowledgeCandidate;
  readonly assertionIds: readonly string[];
}

export interface FreshnessBatchVerificationResult {
  readonly projectId: string;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly observedAt: string;
  readonly results: Readonly<Record<string, readonly VerificationResult[]>>;
}

export interface FreshnessRevalidationPort {
  verifyBatch(input: {
    readonly projectId: string;
    readonly changes: KnowledgeChangeSet;
    readonly items: readonly FreshnessRevalidationItem[];
    readonly signal?: AbortSignal;
  }): Promise<FreshnessBatchVerificationResult>;
}

export interface FreshnessWorkerResultItem {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly state: KnowledgeFreshnessState;
  readonly plan: FreshnessPlan;
  readonly writeStatus: "TRANSITIONED" | "IDEMPOTENT";
}

export interface FreshnessWorkerRunResult {
  readonly projectId: string;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly bounded: boolean;
  readonly affectedCount: number;
  readonly items: readonly FreshnessWorkerResultItem[];
}

function safe(value: string, maximum = 4_096): boolean {
  return value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function validateBatch(
  batch: FreshnessBatchVerificationResult,
  changes: KnowledgeChangeSet,
  requestedItems: readonly FreshnessRevalidationItem[],
): ReadonlyMap<string, readonly VerificationResult[]> {
  if (batch.projectId !== changes.projectId || batch.codeRevision !== changes.sourceRef || !safe(batch.codeRevision)
    || (batch.graphRevision !== undefined && !safe(batch.graphRevision))
    || !Number.isFinite(Date.parse(batch.observedAt))) throw new Error("FRESHNESS_BATCH_IDENTITY_INVALID");
  const requested = new Map(requestedItems.map((item) => [item.assetId,
    new Map(item.candidate.assertions.filter((assertion) => item.assertionIds.includes(assertion.assertionId))
      .map((assertion) => [assertion.assertionId, assertion.kind] as const))] as const));
  const verified = new Map<string, readonly VerificationResult[]>();
  for (const [assetId, results] of Object.entries(batch.results)) {
    const allowed = requested.get(assetId);
    if (allowed === undefined) throw new Error("FRESHNESS_BATCH_RESULT_UNREQUESTED");
    const seen = new Set<string>();
    for (const result of results) {
      const assertionKind = allowed.get(result.assertionId);
      if (assertionKind === undefined) throw new Error("FRESHNESS_BATCH_RESULT_UNREQUESTED");
      if (seen.has(result.assertionId)) throw new Error("FRESHNESS_BATCH_RESULT_DUPLICATE");
      if (result.assertionKind !== assertionKind || result.observedAt !== batch.observedAt
        || (result.evidence !== undefined && (result.evidence.projectId !== changes.projectId
          || result.evidence.observedAt !== batch.observedAt))) throw new Error("FRESHNESS_BATCH_RESULT_IDENTITY_INVALID");
      seen.add(result.assertionId);
    }
    if (seen.size !== allowed.size) throw new Error("FRESHNESS_BATCH_RESULT_INCOMPLETE");
    verified.set(assetId, results);
  }
  if (verified.size !== requested.size) throw new Error("FRESHNESS_BATCH_RESULT_INCOMPLETE");
  return verified;
}

export function selectAffectedAssertionIds(record: KnowledgeFreshnessRecord, changes: KnowledgeChangeSet): readonly string[] {
  const paths = new Set(changes.changedPaths);
  const symbols = new Set(changes.changedSymbols);
  const configs = new Set(changes.changedConfigs);
  const dependencies = new Set(changes.changedDependencies);
  return Object.freeze([...new Set(record.anchors.filter((anchor) => {
    if (anchor.path !== undefined && paths.has(anchor.path)) return true;
    if (anchor.kind === "PATH") return paths.has(anchor.key);
    if (anchor.kind === "SYMBOL") return symbols.has(anchor.key);
    if (anchor.kind === "CONFIG") return configs.has(anchor.key);
    return anchor.kind === "DEPENDENCY" && dependencies.has(anchor.key);
  }).map((anchor) => anchor.assertionId))].sort());
}

export class KnowledgeFreshnessWorker {
  constructor(private readonly store: FreshnessWorkerStorePort, private readonly verifier: FreshnessRevalidationPort) {}

  async run(changes: KnowledgeChangeSet, maxAffected = 500, signal?: AbortSignal): Promise<FreshnessWorkerRunResult> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("FRESHNESS_WORKER_ABORTED");
    if (!Number.isSafeInteger(maxAffected) || maxAffected < 1 || maxAffected > 10_000) {
      throw new Error("FRESHNESS_WORKER_LIMIT_INVALID");
    }
    const affected = this.store.affected(changes, maxAffected);
    const records = affected.items.map((item) => this.store.get(item.assetId, item.assetVersion));
    if (records.some((record) => record === undefined)) throw new Error("FRESHNESS_WORKER_RECORD_MISSING");
    const requestedItems = (records as KnowledgeFreshnessRecord[]).flatMap((record) => {
      const assertionIds = selectAffectedAssertionIds(record, changes);
      return assertionIds.length === 0 ? [] : [{
        assetId: record.assetId, assetVersion: record.assetVersion, candidate: record.candidate,
        assertionIds,
      }];
    });
    if (requestedItems.length === 0) return Object.freeze({
      projectId: changes.projectId, codeRevision: changes.sourceRef, bounded: affected.bounded,
      affectedCount: affected.items.length, items: Object.freeze([]),
    });
    const batch = await this.verifier.verifyBatch({
      projectId: changes.projectId, changes, items: Object.freeze(requestedItems), ...(signal === undefined ? {} : { signal }),
    });
    const verified = validateBatch(batch, changes, requestedItems);
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("FRESHNESS_WORKER_ABORTED");
    const output: FreshnessWorkerResultItem[] = [];
    for (const item of requestedItems) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("FRESHNESS_WORKER_ABORTED");
      const record = this.store.get(item.assetId, item.assetVersion);
      const current = this.store.getState(item.assetId, item.assetVersion);
      if (record === undefined || current === undefined) throw new Error("FRESHNESS_WORKER_STATE_MISSING");
      const plan = planKnowledgeFreshness({ record, changes, revalidationResults: verified.get(item.assetId) ?? [] });
      const written = this.store.transition({
        assetId: item.assetId, assetVersion: item.assetVersion, expectedRevision: current.revision,
        projectId: changes.projectId, status: plan.freshnessStatus, codeRevision: batch.codeRevision,
        ...(batch.graphRevision === undefined ? {} : { graphRevision: batch.graphRevision }),
        reasonCodes: plan.reasonCodes, affectedAssertionIds: plan.affectedAssertionIds, updatedAt: batch.observedAt,
      });
      output.push(Object.freeze({ assetId: item.assetId, assetVersion: item.assetVersion, state: written.state, plan, writeStatus: written.status }));
    }
    return Object.freeze({
      projectId: changes.projectId, codeRevision: batch.codeRevision,
      ...(batch.graphRevision === undefined ? {} : { graphRevision: batch.graphRevision }),
      bounded: affected.bounded, affectedCount: affected.items.length, items: Object.freeze(output),
    });
  }
}
