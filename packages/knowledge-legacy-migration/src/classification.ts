import type { KnowledgeAssertion, KnowledgeAsset, KnowledgeCandidate, ScopeHint } from "@zhiloop/domain";
import type { KnowledgeFreshnessRecord } from "@zhiloop/knowledge-freshness";
import type { StoredVerificationRecipe } from "@zhiloop/knowledge-verification";

import { migrationHash } from "./identity.js";
import type { LegacyMigrationCandidateResolution } from "./types.js";

const CODE_ASSERTIONS = new Set<KnowledgeAssertion["kind"]>([
  "SYMBOL_EXISTS", "FILE_CONTAINS", "DEPENDENCY_PRESENT", "CONFIG_EQUALS", "CALL_PATH_EXISTS", "IMPACT_CONTAINS",
]);

function scopeProject(asset: KnowledgeAsset, assertions: readonly KnowledgeAssertion[], requestedProjectId: string): string | undefined {
  const projects = new Set(assertions.flatMap((assertion) => {
    if (assertion.kind === "SYMBOL_EXISTS" || assertion.kind === "CALL_PATH_EXISTS" || assertion.kind === "IMPACT_CONTAINS") {
      return [assertion.parameters.projectId];
    }
    return [];
  }));
  if ([...projects].some((projectId) => projectId !== requestedProjectId)) return undefined;
  if ("projectId" in asset.scope && asset.scope.projectId !== undefined) {
    return asset.scope.projectId === requestedProjectId ? requestedProjectId : undefined;
  }
  if (asset.scope.level !== "GLOBAL") return undefined;
  return projects.size === 1 && projects.has(requestedProjectId) ? requestedProjectId : undefined;
}

function scopeHint(asset: KnowledgeAsset, projectId: string): ScopeHint {
  switch (asset.scope.level) {
    case "PROJECT": return { level: "PROJECT", projectId, ...(asset.scope.repositoryRemote === undefined ? {} : {
      repositoryRemote: asset.scope.repositoryRemote,
    }), reasonCodes: ["LEGACY_MIGRATION_EXACT_SCOPE"] };
    case "MODULE": return { level: "MODULE", projectId, modulePaths: [...asset.scope.modulePaths],
      ...(asset.scope.repositoryRemote === undefined ? {} : { repositoryRemote: asset.scope.repositoryRemote }),
      reasonCodes: ["LEGACY_MIGRATION_EXACT_SCOPE"] };
    case "SYMBOL": return { level: "SYMBOL", projectId, symbols: [...asset.scope.symbols],
      ...(asset.scope.repositoryRemote === undefined ? {} : { repositoryRemote: asset.scope.repositoryRemote }),
      reasonCodes: ["LEGACY_MIGRATION_EXACT_SCOPE"] };
    case "GLOBAL": return { level: "GLOBAL", reasonCodes: ["LEGACY_MIGRATION_PROJECT_ANCHORED_GLOBAL"] };
    default: return { level: asset.scope.level, reasonCodes: ["LEGACY_MIGRATION_UNSUPPORTED_SCOPE"] };
  }
}

function candidateFrom(asset: KnowledgeAsset, projectId: string, candidateId: string,
  assertions: readonly KnowledgeAssertion[], compilerVersion: string): KnowledgeCandidate {
  if (assertions.length < 1) throw new Error("LEGACY_MIGRATION_ASSERTIONS_MISSING");
  return Object.freeze({
    schemaVersion: 1, candidateId, compilerVersion, status: "PROPOSED", subjectKey: asset.subjectKey, kind: asset.kind,
    scopeHint: scopeHint(asset, projectId), title: asset.title, summary: asset.summary, body: asset.body,
    sourceEpisodes: [...asset.sourceEpisodes] as KnowledgeCandidate["sourceEpisodes"], confidence: asset.confidence,
    assertions: Object.freeze(structuredClone(assertions)) as readonly [KnowledgeAssertion, ...KnowledgeAssertion[]], evidenceHints: [],
    createdAt: asset.updatedAt, correlationId: asset.correlationId,
  } as KnowledgeCandidate);
}

function exactCodeAssertions(assertions: readonly KnowledgeAssertion[]): readonly KnowledgeAssertion[] {
  return Object.freeze(assertions.filter((assertion) => CODE_ASSERTIONS.has(assertion.kind))
    .sort((left, right) => left.assertionId.localeCompare(right.assertionId)));
}

function fromRecipe(asset: KnowledgeAsset, projectId: string, recipe: StoredVerificationRecipe): LegacyMigrationCandidateResolution {
  const assertions = exactCodeAssertions(recipe.assertions);
  if (assertions.length === 0) return { classification: "SKIPPED", source: "RECIPE", reasonCodes: ["CODE_ASSERTION_MISSING"] };
  const candidateIds = new Set(assertions.map((assertion) => assertion.candidateId));
  if (candidateIds.size !== 1) return { classification: "SKIPPED", source: "RECIPE", reasonCodes: ["CANDIDATE_ID_AMBIGUOUS"] };
  if (scopeProject(asset, assertions, projectId) === undefined) {
    return { classification: "SKIPPED", source: "RECIPE", reasonCodes: ["PROJECT_IDENTITY_MISMATCH"] };
  }
  const candidateId = [...candidateIds][0]!;
  return { classification: "MIGRATABLE", source: "RECIPE", reasonCodes: ["CURRENT_RECIPE_REUSED"], assertions,
    candidate: candidateFrom(asset, projectId, candidateId, assertions, "legacy-recipe-reconstruction-v1") };
}

function fromSymbols(asset: KnowledgeAsset, projectId: string): LegacyMigrationCandidateResolution {
  if (asset.symbols.length === 0 || scopeProject(asset, [], projectId) === undefined) {
    return { classification: "SKIPPED", source: "NONE", reasonCodes: ["RECIPE_MISSING"] };
  }
  const candidateId = `legacy-candidate-${migrationHash([asset.id, asset.version, asset.contentHash, projectId]).slice(0, 40)}`;
  const assertions = [...new Set(asset.symbols)].sort((left, right) => left.localeCompare(right)).map((symbol): KnowledgeAssertion => ({
    assertionId: `legacy-assertion-${migrationHash([candidateId, "SYMBOL_EXISTS", projectId, symbol]).slice(0, 40)}`,
    candidateId, kind: "SYMBOL_EXISTS", parameters: { projectId, symbol }, createdAt: asset.updatedAt,
  }));
  return { classification: "MIGRATABLE", source: "SYMBOL_ANCHOR", reasonCodes: ["EXPLICIT_SYMBOL_ANCHOR_TRANSLATED"], assertions,
    candidate: candidateFrom(asset, projectId, candidateId, assertions, "legacy-symbol-anchor-v1") };
}

export function resolveLegacyMigrationCandidate(input: {
  readonly asset: KnowledgeAsset;
  readonly projectId: string;
  readonly recipe?: StoredVerificationRecipe;
  readonly freshness?: KnowledgeFreshnessRecord;
}): LegacyMigrationCandidateResolution {
  const { asset, projectId, recipe, freshness } = input;
  if (freshness !== undefined) {
    if (freshness.assetId !== asset.id || freshness.assetVersion !== asset.version
      || freshness.assetContentHash !== asset.contentHash || freshness.projectId !== projectId) {
      return { classification: "SKIPPED", source: "FRESHNESS", reasonCodes: ["FRESHNESS_IDENTITY_MISMATCH"] };
    }
    const assertions = exactCodeAssertions(freshness.candidate.assertions);
    if (scopeProject(asset, assertions, projectId) === undefined) {
      return { classification: "SKIPPED", source: "FRESHNESS", reasonCodes: ["PROJECT_IDENTITY_MISMATCH"] };
    }
    if (recipe !== undefined) {
      const recipeAssertions = exactCodeAssertions(recipe.assertions);
      if (assertions.length === 0 || migrationHash(recipeAssertions) !== migrationHash(assertions)) {
        return { classification: "SKIPPED", source: "FRESHNESS", reasonCodes: ["RECIPE_FRESHNESS_MISMATCH"] };
      }
      return { classification: "ALREADY_CURRENT", source: "FRESHNESS", reasonCodes: ["RECIPE_AND_FRESHNESS_CURRENT"] };
    }
    if (assertions.length === 0) return { classification: "SKIPPED", source: "FRESHNESS", reasonCodes: ["CODE_ASSERTION_MISSING"] };
    return { classification: "MIGRATABLE", source: "FRESHNESS", reasonCodes: ["FRESHNESS_CANDIDATE_REUSED"],
      candidate: freshness.candidate, assertions };
  }
  if (recipe !== undefined) return fromRecipe(asset, projectId, recipe);
  if (asset.kind === "IMPLEMENTATION" || asset.symbols.length > 0) return fromSymbols(asset, projectId);
  return { classification: "SKIPPED", source: "NONE", reasonCodes: ["NOT_CODE_RELATED"] };
}
