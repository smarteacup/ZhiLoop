import type { KnowledgeAsset } from "@zhiloop/domain";

import type { KnowledgeFreshnessRecord } from "./types.js";

export type FreshnessGateReason =
  | "FRESHNESS_NOT_REQUIRED"
  | "FRESHNESS_CONFIRMED"
  | "FRESHNESS_PROJECTION_MISSING"
  | "FRESHNESS_PROJECTION_MISMATCH"
  | "FRESHNESS_REVALIDATION_REQUIRED"
  | "FRESHNESS_CONFLICT"
  | "FRESHNESS_UNKNOWN";

export type FreshnessEnsureReason = FreshnessGateReason
  | "FRESHNESS_CURRENT_REVISION_UNAVAILABLE"
  | "FRESHNESS_CODE_REVISION_MISMATCH"
  | "FRESHNESS_GRAPH_REVISION_MISMATCH"
  | "FRESHNESS_TARGETED_CONFIRMED"
  | "FRESHNESS_TARGETED_TIMEOUT"
  | "FRESHNESS_TARGETED_FAILED"
  | "FRESHNESS_GATE_DEGRADED";

export interface LiveKnowledgeRevision {
  readonly projectId: string;
  readonly codeRevision: string;
  readonly graphRevision?: string;
}

export interface LiveKnowledgeRevisionReadPort {
  /** Must be a cache/read-model lookup; the gate never scans Git or initializes CodeGraph. */
  read(projectId: string): LiveKnowledgeRevision | undefined;
}

export interface TargetedFreshnessVerificationPort {
  verify(request: {
    readonly projectId: string;
    readonly asset: KnowledgeAsset;
    readonly codeRevision: string;
    readonly graphRevision?: string;
  }, signal: AbortSignal): Promise<{
    readonly assetId: string;
    readonly assetVersion: number;
    readonly status: "FRESH" | "REVALIDATE" | "CONFLICT" | "UNKNOWN";
    readonly codeRevision: string;
    readonly graphRevision?: string;
  }>;
}

export interface FreshnessCompensationPort {
  schedule(request: {
    readonly projectId: string;
    readonly assetId: string;
    readonly assetVersion: number;
    readonly reasonCode: FreshnessEnsureReason;
    readonly requiredCodeRevision?: string;
    readonly requiredGraphRevision?: string;
  }): string;
}

export interface FreshnessEnsureDecision {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly eligible: boolean;
  readonly codeFact: boolean;
  readonly reasonCode: FreshnessEnsureReason;
  readonly compensationJobId?: string;
}

export interface FreshnessEnsureResult {
  readonly eligibleAssetVersions: readonly string[];
  readonly decisions: readonly FreshnessEnsureDecision[];
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface FreshnessGateServiceOptions {
  readonly records: { get(assetId: string, assetVersion?: number): KnowledgeFreshnessRecord | undefined };
  readonly revisions: LiveKnowledgeRevisionReadPort;
  readonly targeted?: TargetedFreshnessVerificationPort;
  readonly compensation?: FreshnessCompensationPort;
  readonly maxItems?: number;
  readonly maxTargetedItems?: number;
  readonly deadlineMs?: number;
  readonly minimumTargetedBudgetMs?: number;
  readonly monotonicClock?: () => number;
}

export interface FreshnessRecordReadPort {
  get(assetId: string): KnowledgeFreshnessRecord | undefined;
}

export interface FreshnessGateDecision {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly eligible: boolean;
  readonly freshness: KnowledgeFreshnessRecord["freshnessStatus"] | "NOT_REQUIRED";
  readonly reasonCode: FreshnessGateReason;
}

export interface FreshnessGateResult {
  readonly eligibleAssetIds: readonly string[];
  readonly eligibleAssetVersions: readonly string[];
  readonly decisions: readonly FreshnessGateDecision[];
}

export function requiresFreshness(asset: KnowledgeAsset): boolean {
  return asset.kind === "IMPLEMENTATION" || asset.symbols.length > 0;
}

function validAsset(asset: KnowledgeAsset): boolean {
  return asset.id.length > 0 && asset.id.length <= 1_000 && !/[\0\r\n]/u.test(asset.id)
    && Number.isSafeInteger(asset.version) && asset.version > 0 && asset.contentHash.length > 0 && asset.contentHash.length <= 1_000;
}

function exactReason(record: KnowledgeFreshnessRecord, revision: LiveKnowledgeRevision): FreshnessEnsureReason {
  if (record.freshnessStatus !== "FRESH") return reason(record);
  if (record.codeRevision !== revision.codeRevision) return "FRESHNESS_CODE_REVISION_MISMATCH";
  if (record.graphRevision !== undefined && record.graphRevision !== revision.graphRevision) {
    return "FRESHNESS_GRAPH_REVISION_MISMATCH";
  }
  return "FRESHNESS_CONFIRMED";
}

async function verifyWithin(
  port: TargetedFreshnessVerificationPort,
  request: Parameters<TargetedFreshnessVerificationPort["verify"]>[0],
  parent: AbortSignal,
  timeoutMs: number,
): Promise<{ readonly status: "RESULT"; readonly value: Awaited<ReturnType<TargetedFreshnessVerificationPort["verify"]>> }
  | { readonly status: "TIMEOUT" | "FAILED" }> {
  if (timeoutMs <= 0 || parent.aborted) return { status: "TIMEOUT" };
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(new Error("FRESHNESS_TARGETED_TIMEOUT")); reject(new Error("FRESHNESS_TARGETED_TIMEOUT")); }, timeoutMs);
      timer.unref?.();
    });
    const value = await Promise.race([port.verify(request, controller.signal), timeout]);
    return { status: "RESULT", value };
  } catch (error) {
    return { status: error instanceof Error && error.message === "FRESHNESS_TARGETED_TIMEOUT" ? "TIMEOUT" : "FAILED" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}

export class FreshnessGateService {
  readonly #maxItems: number;
  readonly #maxTargetedItems: number;
  readonly #deadlineMs: number;
  readonly #minimumTargetedBudgetMs: number;
  readonly #clock: () => number;

  constructor(private readonly options: FreshnessGateServiceOptions) {
    this.#maxItems = options.maxItems ?? 100;
    this.#maxTargetedItems = options.maxTargetedItems ?? 3;
    this.#deadlineMs = options.deadlineMs ?? 150;
    this.#minimumTargetedBudgetMs = options.minimumTargetedBudgetMs ?? Math.min(20, this.#deadlineMs);
    this.#clock = options.monotonicClock ?? (() => performance.now());
    if (!Number.isSafeInteger(this.#maxItems) || this.#maxItems < 1 || this.#maxItems > 1_000
      || !Number.isSafeInteger(this.#maxTargetedItems) || this.#maxTargetedItems < 0 || this.#maxTargetedItems > 20
      || !Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 1 || this.#deadlineMs > 200
      || !Number.isSafeInteger(this.#minimumTargetedBudgetMs) || this.#minimumTargetedBudgetMs < 1
      || this.#minimumTargetedBudgetMs > this.#deadlineMs) {
      throw new Error("FRESHNESS_GATE_OPTIONS_INVALID");
    }
  }

  async ensureFresh(request: {
    readonly projectId: string;
    readonly assets: readonly KnowledgeAsset[];
    readonly signal?: AbortSignal;
  }): Promise<FreshnessEnsureResult> {
    if (request.projectId.length < 1 || request.projectId.length > 1_000 || /[\0\r\n]/u.test(request.projectId)
      || request.assets.length > this.#maxItems || request.assets.some((asset) => !validAsset(asset))
      || new Set(request.assets.map((asset) => `${asset.id}\0${asset.version}`)).size !== request.assets.length) {
      throw new Error("FRESHNESS_GATE_INPUT_INVALID");
    }
    const started = this.#clock();
    const deadline = started + this.#deadlineMs;
    const signal = request.signal ?? new AbortController().signal;
    let revision: LiveKnowledgeRevision | undefined;
    try { revision = this.options.revisions.read(request.projectId); }
    catch { revision = undefined; }
    if (revision !== undefined && (revision.projectId !== request.projectId || revision.codeRevision.length < 1
      || revision.codeRevision.length > 4_096 || (revision.graphRevision !== undefined && revision.graphRevision.length > 4_096))) {
      revision = undefined;
    }
    let targetedCount = 0;
    let timedOut = false;
    const decisions: FreshnessEnsureDecision[] = [];
    for (const asset of request.assets) {
      const codeFact = requiresFreshness(asset);
      if (!codeFact) {
        decisions.push(Object.freeze({ assetId: asset.id, assetVersion: asset.version, eligible: true, codeFact,
          reasonCode: "FRESHNESS_NOT_REQUIRED" }));
        continue;
      }
      let reasonCode: FreshnessEnsureReason = "FRESHNESS_GATE_DEGRADED";
      let eligible = false;
      let record: KnowledgeFreshnessRecord | undefined;
      let readFailed = false;
      try { record = this.options.records.get(asset.id, asset.version); }
      catch { readFailed = true; }
      const projectionMatches = record !== undefined && record.assetVersion === asset.version
        && record.assetContentHash === asset.contentHash && record.projectId === request.projectId;
      if (!readFailed) {
        reasonCode = revision === undefined ? "FRESHNESS_CURRENT_REVISION_UNAVAILABLE"
          : record === undefined ? "FRESHNESS_PROJECTION_MISSING"
            : !projectionMatches
              ? "FRESHNESS_PROJECTION_MISMATCH" : exactReason(record, revision);
        eligible = reasonCode === "FRESHNESS_CONFIRMED";
      }
      if (!eligible && revision !== undefined && projectionMatches && this.options.targeted !== undefined
        && targetedCount < this.#maxTargetedItems && !signal.aborted) {
        const remaining = Math.floor(deadline - this.#clock());
        if (remaining >= this.#minimumTargetedBudgetMs) {
          targetedCount += 1;
          const verified = await verifyWithin(this.options.targeted, { projectId: request.projectId, asset,
            codeRevision: revision.codeRevision, ...(revision.graphRevision === undefined ? {} : { graphRevision: revision.graphRevision }) },
          signal, remaining);
          if (verified.status === "RESULT" && verified.value.assetId === asset.id && verified.value.assetVersion === asset.version
            && verified.value.status === "FRESH" && verified.value.codeRevision === revision.codeRevision
            && verified.value.graphRevision === revision.graphRevision) {
            eligible = true;
            reasonCode = "FRESHNESS_TARGETED_CONFIRMED";
          } else {
            reasonCode = verified.status === "TIMEOUT" ? "FRESHNESS_TARGETED_TIMEOUT" : "FRESHNESS_TARGETED_FAILED";
            timedOut ||= verified.status === "TIMEOUT";
          }
        } else { reasonCode = "FRESHNESS_TARGETED_TIMEOUT"; timedOut = true; }
      }
      let compensationJobId: string | undefined;
      if (!eligible && this.options.compensation !== undefined) {
        try { compensationJobId = this.options.compensation.schedule({ projectId: request.projectId,
          assetId: asset.id, assetVersion: asset.version, reasonCode,
          ...(revision?.codeRevision === undefined ? {} : { requiredCodeRevision: revision.codeRevision }),
          ...(revision?.graphRevision === undefined ? {} : { requiredGraphRevision: revision.graphRevision }) }); }
        catch { /* Compensation is best-effort and must never block the Hook. */ }
      }
      decisions.push(Object.freeze({ assetId: asset.id, assetVersion: asset.version, eligible, codeFact, reasonCode,
        ...(compensationJobId === undefined ? {} : { compensationJobId }) }));
    }
    return Object.freeze({
      eligibleAssetVersions: Object.freeze(decisions.filter((item) => item.eligible)
        .map((item) => `${item.assetId}@${item.assetVersion}`)),
      decisions: Object.freeze(decisions), durationMs: Math.max(0, this.#clock() - started), timedOut,
    });
  }
}

function reason(record: KnowledgeFreshnessRecord): FreshnessGateReason {
  switch (record.freshnessStatus) {
    case "FRESH": return "FRESHNESS_CONFIRMED";
    case "REVALIDATE": return "FRESHNESS_REVALIDATION_REQUIRED";
    case "CONFLICT": return "FRESHNESS_CONFLICT";
    case "UNKNOWN": return "FRESHNESS_UNKNOWN";
  }
}

export class ProjectionFreshnessGate {
  constructor(private readonly records: FreshnessRecordReadPort) {}

  inspect(projectId: string, assets: readonly KnowledgeAsset[]): FreshnessGateResult {
    if (projectId.trim().length === 0 || projectId.length > 1_000 || assets.length > 1_000) {
      throw new Error("FRESHNESS_GATE_INPUT_INVALID");
    }
    const decisions = assets.map((asset): FreshnessGateDecision => {
      if (!requiresFreshness(asset)) {
        return Object.freeze({
          assetId: asset.id, assetVersion: asset.version, eligible: true,
          freshness: "NOT_REQUIRED", reasonCode: "FRESHNESS_NOT_REQUIRED",
        });
      }
      const record = this.records.get(asset.id);
      if (record === undefined) {
        return Object.freeze({
          assetId: asset.id, assetVersion: asset.version, eligible: false,
          freshness: "UNKNOWN", reasonCode: "FRESHNESS_PROJECTION_MISSING",
        });
      }
      if (record.assetVersion !== asset.version || record.assetContentHash !== asset.contentHash || record.projectId !== projectId) {
        return Object.freeze({
          assetId: asset.id, assetVersion: asset.version, eligible: false,
          freshness: "UNKNOWN", reasonCode: "FRESHNESS_PROJECTION_MISMATCH",
        });
      }
      return Object.freeze({
        assetId: asset.id,
        assetVersion: asset.version,
        eligible: record.freshnessStatus === "FRESH",
        freshness: record.freshnessStatus,
        reasonCode: reason(record),
      });
    });
    return Object.freeze({
      eligibleAssetIds: Object.freeze(decisions.filter((item) => item.eligible).map((item) => item.assetId)),
      eligibleAssetVersions: Object.freeze(decisions.filter((item) => item.eligible)
        .map((item) => `${item.assetId}@${item.assetVersion}`)),
      decisions: Object.freeze(decisions),
    });
  }
}
