import type { KnowledgeAsset, KnowledgeRelation } from "@zhiloop/domain";
import { transitionKnowledgeStatus } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset, SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import { calculateKnowledgeContentHash } from "@zhiloop/markdown-repository";
import type { MarkdownKnowledgeRepository } from "@zhiloop/markdown-repository";

import type { SqliteGovernanceStore } from "./audit-store.js";
import type {
  DoctorDiagnostic,
  DoctorReport,
  GovernanceMutationContext,
  KnowledgeDiff,
  KnowledgeFieldDiff,
  KnowledgeTrace,
  MarkStaleInput,
  MutationResult,
  SuppressInput,
  SuppressionRecord,
} from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function positiveVersion(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function rehash(asset: KnowledgeAsset, overrides: Partial<Omit<KnowledgeAsset, "contentHash">>): KnowledgeAsset {
  const draft = { ...asset, ...overrides, contentHash: "" };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

function stableValue(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

export class KnowledgeGovernanceService {
  readonly #markdown: MarkdownKnowledgeRepository;
  readonly #registry: SqliteKnowledgeRegistryProjection;
  readonly #store: SqliteGovernanceStore;

  constructor(
    markdown: MarkdownKnowledgeRepository,
    registry: SqliteKnowledgeRegistryProjection,
    store: SqliteGovernanceStore,
  ) {
    this.#markdown = markdown;
    this.#registry = registry;
    this.#store = store;
  }

  list(includeTombstones = false): readonly ProjectedKnowledgeAsset[] {
    return this.#registry.listAssets({ includeTombstones, limit: 1_000 });
  }

  show(assetId: string): ProjectedKnowledgeAsset {
    const value = this.#registry.getAsset(assetId, true);
    if (value === undefined) throw new Error(`knowledge asset ${assetId} was not found`);
    return value;
  }

  diff(assetId: string, fromVersion: number, toVersion: number): KnowledgeDiff {
    positiveVersion(fromVersion, "fromVersion");
    positiveVersion(toVersion, "toVersion");
    if (fromVersion === toVersion) throw new Error("diff versions must be different");
    const before = this.#registry.getVersion(assetId, fromVersion)?.asset;
    const after = this.#registry.getVersion(assetId, toVersion)?.asset;
    if (before === undefined) throw new Error(`knowledge version ${assetId}@${fromVersion} was not found`);
    if (after === undefined) throw new Error(`knowledge version ${assetId}@${toVersion} was not found`);
    const changes: KnowledgeFieldDiff[] = [];
    for (const field of Object.keys(before) as Array<keyof KnowledgeAsset>) {
      if (stableValue(before[field]) !== stableValue(after[field])) {
        changes.push({ field, before: before[field], after: after[field] });
      }
    }
    return Object.freeze({ assetId, fromVersion, toVersion, changes: Object.freeze(changes) });
  }

  trace(assetId: string, version?: number): KnowledgeTrace {
    const selectedVersion = version ?? this.show(assetId).asset.version;
    positiveVersion(selectedVersion, "version");
    const value = this.#registry.getVersion(assetId, selectedVersion);
    if (value === undefined) throw new Error(`knowledge version ${assetId}@${selectedVersion} was not found`);
    return Object.freeze({
      assetId,
      version: selectedVersion,
      sourceEpisodes: Object.freeze([...value.asset.sourceEpisodes]),
      evidence: this.#registry.getEvidence(assetId, selectedVersion).evidence,
      relations: this.#registry.getRelations(assetId, selectedVersion).relations,
    });
  }

  async markStale(input: MarkStaleInput): Promise<MutationResult<ProjectedKnowledgeAsset>> {
    const auditId = this.#store.begin("MARK_STALE", input.assetId, input, input.reason);
    try {
      const current = this.show(input.assetId);
      if (current.tombstone) throw new Error("tombstoned knowledge cannot be marked stale");
      const transition = transitionKnowledgeStatus(current.asset.status, "STALE");
      if (!transition.ok || !transition.changed) throw new Error(`cannot mark ${current.asset.status} knowledge stale`);
      const supersedes: KnowledgeRelation = {
        type: "SUPERSEDES",
        targetId: current.asset.id,
        targetVersion: current.asset.version,
        reason: input.reason.trim(),
      };
      const next = rehash(current.asset, {
        version: current.asset.version + 1,
        status: "STALE",
        relations: [...current.asset.relations, supersedes],
        correlationId: input.correlationId,
        updatedAt: input.now,
      });
      const published = await this.#markdown.publish(next, { expectedCurrentVersion: current.asset.version });
      this.#registry.projectCurrent(published.value);
      const projected = this.#registry.getAsset(next.id, true);
      if (projected === undefined) throw new Error("projected stale asset disappeared");
      this.#store.complete(auditId, "SUCCEEDED", input.now);
      return Object.freeze({ auditId, value: projected });
    } catch (error) {
      try {
        this.#store.complete(auditId, "FAILED", input.now, errorMessage(error));
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError], "knowledge mutation and failure audit both failed", { cause: auditError },
        );
      }
      throw error;
    }
  }

  suppress(input: SuppressInput): MutationResult<SuppressionRecord> {
    const asset = this.show(input.assetId);
    const value: SuppressionRecord = Object.freeze({
      assetId: input.assetId,
      scopeKey: input.scopeKey ?? JSON.stringify(asset.asset.scope),
      reason: input.reason,
      actor: input.actor,
      correlationId: input.correlationId,
      createdAt: input.now,
    });
    const auditId = this.#store.suppress(value);
    return Object.freeze({ auditId, value });
  }

  async rebuild(context: GovernanceMutationContext): Promise<MutationResult<Awaited<ReturnType<SqliteKnowledgeRegistryProjection["rebuildFromMarkdown"]>>>> {
    const auditId = this.#store.begin("REBUILD", "knowledge-registry", context);
    try {
      const value = await this.#registry.rebuildFromMarkdown(this.#markdown);
      this.#store.complete(auditId, "SUCCEEDED", context.now);
      return Object.freeze({ auditId, value });
    } catch (error) {
      try {
        this.#store.complete(auditId, "FAILED", context.now, errorMessage(error));
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError], "registry rebuild and failure audit both failed", { cause: auditError },
        );
      }
      throw error;
    }
  }

  async doctor(): Promise<DoctorReport> {
    const markdownIds = await this.#markdown.listAssetIds();
    const projected: ProjectedKnowledgeAsset[] = [];
    for (let offset = 0; ; offset += 1_000) {
      const page = this.#registry.listAssets({ includeTombstones: true, limit: 1_000, offset });
      projected.push(...page);
      if (page.length < 1_000) break;
    }
    const projectedById = new Map(projected.map((item) => [item.asset.id, item]));
    const diagnostics: DoctorDiagnostic[] = [];

    for (const assetId of markdownIds) {
      const registry = projectedById.get(assetId);
      projectedById.delete(assetId);
      const current = await this.#markdown.readCurrent(assetId);
      if (!current.ok) {
        diagnostics.push({
          severity: "ERROR", code: "INVALID_MARKDOWN_CURRENT", assetId,
          message: current.error.message,
        });
        continue;
      }
      if (registry === undefined) {
        diagnostics.push({
          severity: "ERROR", code: "MISSING_PROJECTION", assetId,
          message: "Markdown current has no registry projection",
        });
        continue;
      }
      if (registry.asset.version !== current.value.asset.version) {
        diagnostics.push({
          severity: "ERROR", code: "VERSION_MISMATCH", assetId,
          message: `Markdown version ${current.value.asset.version} differs from registry version ${registry.asset.version}`,
        });
      }
      if (registry.asset.contentHash !== current.value.asset.contentHash) {
        diagnostics.push({
          severity: "ERROR", code: "HASH_MISMATCH", assetId,
          message: `Markdown hash ${current.value.asset.contentHash} differs from registry hash ${registry.asset.contentHash}`,
        });
      }
      if (registry.tombstone !== current.value.tombstone) {
        diagnostics.push({
          severity: "ERROR", code: "TOMBSTONE_MISMATCH", assetId,
          message: "Markdown and registry tombstone state differ",
        });
      }
    }
    for (const assetId of [...projectedById.keys()].sort()) {
      diagnostics.push({
        severity: "ERROR", code: "ORPHAN_PROJECTION", assetId,
        message: "registry projection has no Markdown asset directory",
      });
    }
    return Object.freeze({
      healthy: diagnostics.length === 0,
      markdownAssets: markdownIds.length,
      projectedAssets: projected.length,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}
