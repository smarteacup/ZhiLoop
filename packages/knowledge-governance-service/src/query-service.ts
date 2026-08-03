import { createHash } from "node:crypto";

import { isDefaultRetrievalEligible, type KnowledgeAsset } from "@zhiloop/domain";

import { GovernanceCursorCodec } from "./cursor.js";
import { GovernanceError } from "./errors.js";
import type {
  EligibilityGatePort,
  KnowledgeDetail,
  KnowledgeFieldChange,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeListRequest,
  KnowledgeListResponse,
  KnowledgeMetadataPort,
  KnowledgeRegistryPort,
  KnowledgeVersionDetail,
} from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SCAN_CHUNK = 250;
const MAX_SCAN = 5_000;
const DETAIL_LIMIT = 500;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function queryHash(filter: KnowledgeListFilter): string {
  return createHash("sha256").update(canonical(filter)).digest("hex");
}

function hasProject(asset: KnowledgeAsset, projectId: string): boolean {
  return "projectId" in asset.scope && asset.scope.projectId === projectId;
}

function simpleFilter(asset: KnowledgeAsset, filter: KnowledgeListFilter): string | undefined {
  if (filter.scopeLevels !== undefined && !filter.scopeLevels.includes(asset.scope.level)) return "FILTER_SCOPE";
  if (filter.projectId !== undefined && !hasProject(asset, filter.projectId)) return "FILTER_PROJECT";
  if (filter.kinds !== undefined && !filter.kinds.includes(asset.kind)) return "FILTER_KIND";
  if (filter.statuses !== undefined && !filter.statuses.includes(asset.status)) return "FILTER_STATUS";
  if (filter.subject !== undefined && !asset.subjectKey.toLocaleLowerCase().includes(filter.subject.toLocaleLowerCase())) {
    return "FILTER_SUBJECT";
  }
  if (filter.symbol !== undefined && !asset.symbols.includes(filter.symbol)) return "FILTER_SYMBOL";
  if (filter.keyword !== undefined && !asset.keywords.includes(filter.keyword)) return "FILTER_KEYWORD";
  if (filter.version !== undefined && asset.version !== filter.version) return "FILTER_VERSION";
  return undefined;
}

function increment(target: Record<string, number>, reason: string): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new GovernanceError("INVALID_REQUEST", `limit must be between 1 and ${MAX_LIMIT}`);
  }
}

export class KnowledgeGovernanceQueryService {
  readonly #registry: KnowledgeRegistryPort;
  readonly #metadata: KnowledgeMetadataPort;
  readonly #eligibility: EligibilityGatePort;
  readonly #cursor: GovernanceCursorCodec;

  constructor(
    registry: KnowledgeRegistryPort,
    metadata: KnowledgeMetadataPort,
    eligibility: EligibilityGatePort,
    cursorSecret: Uint8Array,
  ) {
    this.#registry = registry;
    this.#metadata = metadata;
    this.#eligibility = eligibility;
    this.#cursor = new GovernanceCursorCodec(cursorSecret);
  }

  async list(request: KnowledgeListRequest = {}): Promise<KnowledgeListResponse> {
    const limit = request.limit ?? DEFAULT_LIMIT;
    validateLimit(limit);
    const filter = request.filter ?? {};
    const filterHash = queryHash(filter);
    let offset = request.cursor === undefined ? 0 : this.#cursor.decode(request.cursor, filterHash);
    const startOffset = offset;
    const items: KnowledgeListItem[] = [];
    const excludedByReason: Record<string, number> = {};
    let exhausted = false;

    while (items.length < limit && offset - startOffset < MAX_SCAN) {
      const remainingScan = MAX_SCAN - (offset - startOffset);
      const batchSize = Math.min(SCAN_CHUNK, remainingScan);
      const batch = this.#registry.listAssets({ includeTombstones: true, limit: batchSize, offset });
      if (batch.length === 0) {
        exhausted = true;
        break;
      }
      let consumed = 0;
      for (const current of batch) {
        consumed += 1;
        offset += 1;
        const reason = simpleFilter(current.asset, filter);
        if (reason !== undefined) {
          increment(excludedByReason, reason);
          continue;
        }
        const evidence = this.#registry.getEvidence(current.asset.id, current.asset.version).evidence;
        if (filter.evidenceVerdict !== undefined
          && !evidence.some((item) => item.verdict === filter.evidenceVerdict)) {
          increment(excludedByReason, "FILTER_EVIDENCE");
          continue;
        }
        const suppressed = current.tombstone || await this.#eligibility.isExcluded(current.asset.id);
        const statusEligible = isDefaultRetrievalEligible(current.asset.status);
        const eligible = !suppressed && statusEligible;
        const eligibilityReasonCodes = [
          ...(current.tombstone ? ["TOMBSTONED"] : []),
          ...(!current.tombstone && suppressed ? ["GOVERNANCE_SUPPRESSED"] : []),
          ...(statusEligible ? [] : ["STATUS_NOT_ELIGIBLE"]),
        ];
        if (filter.eligibleOnly === true && !eligible) {
          for (const eligibilityReason of eligibilityReasonCodes) increment(excludedByReason, eligibilityReason);
          continue;
        }
        if (filter.includeSuppressed !== true && suppressed) {
          increment(excludedByReason, current.tombstone ? "TOMBSTONED" : "GOVERNANCE_SUPPRESSED");
          continue;
        }
        const lastVerifiedAt = await this.#metadata.getLastVerifiedAt(current.asset.id, current.asset.version);
        items.push({
          current,
          evidenceCount: evidence.length,
          eligible,
          eligibilityReasonCodes,
          ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
        });
        if (items.length === limit) break;
      }
      if (batch.length < batchSize && consumed === batch.length) exhausted = true;
      if (exhausted) break;
    }

    const scanned = offset - startOffset;
    return {
      items,
      ...(!exhausted && scanned > 0 ? { nextCursor: this.#cursor.encode({ offset, filterHash }) } : {}),
      scanned,
      excludedByReason,
    };
  }

  async detail(assetId: string): Promise<KnowledgeDetail> {
    const current = this.#registry.getAsset(assetId, true);
    if (current === undefined) throw new GovernanceError("NOT_FOUND", `knowledge asset ${assetId} was not found`);
    const versions = this.#registry.listVersions(assetId);
    if (versions.length > DETAIL_LIMIT) {
      throw new GovernanceError("INVALID_REQUEST", `knowledge history exceeds ${DETAIL_LIMIT} versions`);
    }
    const selected = await this.version(assetId, current.asset.version);
    const lifecycle = (await this.#metadata.getLifecycle(assetId, DETAIL_LIMIT)).slice(0, DETAIL_LIMIT);
    return { current, versions, lifecycle, ...selected };
  }

  async version(assetId: string, version: number): Promise<KnowledgeVersionDetail> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new GovernanceError("INVALID_REQUEST", "version must be a positive safe integer");
    }
    const selected = this.#registry.getVersion(assetId, version);
    if (selected === undefined) throw new GovernanceError("NOT_FOUND", `knowledge version ${assetId}@${version} was not found`);
    const [provenance, usage, assertions, scopeReasonCodes] = await Promise.all([
      this.#metadata.getProvenance(assetId, version, DETAIL_LIMIT),
      this.#metadata.getUsage(assetId, version, DETAIL_LIMIT),
      this.#metadata.getAssertions(assetId, version, DETAIL_LIMIT),
      this.#metadata.getScopeReasonCodes(assetId, version),
    ]);
    return {
      version: selected,
      evidence: this.#registry.getEvidence(assetId, version).evidence,
      relations: this.#registry.getRelations(assetId, version).relations,
      provenance: {
        snapshotIds: provenance.snapshotIds.slice(0, DETAIL_LIMIT),
        episodeIds: provenance.episodeIds.slice(0, DETAIL_LIMIT),
        sessionIds: provenance.sessionIds.slice(0, DETAIL_LIMIT),
        turnIds: provenance.turnIds.slice(0, DETAIL_LIMIT),
        eventIds: provenance.eventIds.slice(0, DETAIL_LIMIT),
      },
      usage: usage.slice(0, DETAIL_LIMIT),
      assertions: assertions.slice(0, DETAIL_LIMIT),
      scopeReasonCodes: scopeReasonCodes.slice(0, DETAIL_LIMIT),
    };
  }

  diff(assetId: string, fromVersion: number, toVersion: number): readonly KnowledgeFieldChange[] {
    if (fromVersion === toVersion) throw new GovernanceError("INVALID_REQUEST", "diff versions must differ");
    const before = this.#registry.getVersion(assetId, fromVersion)?.asset;
    const after = this.#registry.getVersion(assetId, toVersion)?.asset;
    if (before === undefined || after === undefined) throw new GovernanceError("NOT_FOUND", "knowledge diff version was not found");
    return (Object.keys(before) as Array<keyof KnowledgeAsset>).flatMap((field) =>
      canonical(before[field]) === canonical(after[field]) ? [] : [{ field, before: before[field], after: after[field] }]);
  }
}
