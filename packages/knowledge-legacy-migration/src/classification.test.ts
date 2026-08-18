import { describe, expect, it } from "vitest";

import type { KnowledgeAssertion, KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import type { KnowledgeFreshnessRecord } from "@zhiloop/knowledge-freshness";
import type { StoredVerificationRecipe } from "@zhiloop/knowledge-verification";

import { resolveLegacyMigrationCandidate } from "./classification.js";

const at = "2026-08-19T00:00:00.000Z";
function asset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return { schemaVersion: 1, id: "asset-1", subjectKey: "legacy.worker", kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "VERIFIED", title: "Legacy worker",
    summary: "Legacy summary", body: "Legacy body", aliases: [], keywords: [], applicability: [], nonApplicability: [],
    symbols: ["LegacyWorker"], relations: [], evidence: [], confidence: 0.9, sourceEpisodes: ["episode-1"],
    contentHash: "a".repeat(64), correlationId: "correlation-1", createdAt: at, updatedAt: at, ...overrides };
}
const assertion = { assertionId: "assertion-1", candidateId: "candidate-1", kind: "SYMBOL_EXISTS" as const,
  parameters: { projectId: "project-1", symbol: "LegacyWorker" }, createdAt: at };
function recipe(assertions: readonly KnowledgeAssertion[] = [assertion]): StoredVerificationRecipe {
  return { assetId: "asset-1", assetVersion: 1, recipeVersion: "evidence-recipe-v1", assertions,
    assertionsHash: "b".repeat(64), createdAt: at };
}

describe("legacy migration classification", () => {
  it("reconstructs a bounded candidate from an exact recipe without changing the asset", () => {
    const original = asset(); const result = resolveLegacyMigrationCandidate({ asset: original, projectId: "project-1", recipe: recipe() });
    expect(result).toMatchObject({ classification: "MIGRATABLE", source: "RECIPE", candidate: {
      candidateId: "candidate-1", body: "Legacy body", scopeHint: { level: "PROJECT", projectId: "project-1" },
    } });
    expect(result.assertions).toEqual([assertion]);
    expect(original.contentHash).toBe("a".repeat(64));
  });

  it("translates only explicit symbols and never guesses from prose", () => {
    const translated = resolveLegacyMigrationCandidate({ asset: asset(), projectId: "project-1" });
    expect(translated).toMatchObject({ classification: "MIGRATABLE", source: "SYMBOL_ANCHOR" });
    expect(translated.assertions).toHaveLength(1);
    expect(translated.assertions?.[0]).toMatchObject({ kind: "SYMBOL_EXISTS", parameters: { symbol: "LegacyWorker" } });
    const missing = resolveLegacyMigrationCandidate({ asset: asset({ symbols: [] }), projectId: "project-1" });
    expect(missing).toEqual({ classification: "SKIPPED", source: "NONE", reasonCodes: ["RECIPE_MISSING"] });
  });

  it("reuses exact Freshness provenance and detects already-current records", () => {
    const value = asset();
    const candidate: KnowledgeCandidate = { schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "v1", status: "PROPOSED",
      subjectKey: value.subjectKey, kind: value.kind, scopeHint: { projectId: "project-1", reasonCodes: [] }, title: value.title,
      summary: value.summary, body: value.body, sourceEpisodes: ["episode-1"], confidence: value.confidence,
      assertions: [assertion], evidenceHints: [], createdAt: at, correlationId: value.correlationId };
    const freshness = { schemaVersion: 1, assetId: value.id, assetVersion: 1, assetContentHash: value.contentHash,
      projectId: "project-1", lifecycleStatus: value.status, freshnessStatus: "FRESH", candidate,
      fingerprint: { schemaVersion: 1, candidateId: "candidate-1", projectId: "project-1", targets: [], createdAt: at },
      anchors: [], updatedAt: at } as unknown as KnowledgeFreshnessRecord;
    expect(resolveLegacyMigrationCandidate({ asset: value, projectId: "project-1", freshness })).toMatchObject({
      classification: "MIGRATABLE", source: "FRESHNESS",
    });
    expect(resolveLegacyMigrationCandidate({ asset: value, projectId: "project-1", freshness, recipe: recipe() })).toMatchObject({
      classification: "ALREADY_CURRENT",
    });
    expect(resolveLegacyMigrationCandidate({ asset: value, projectId: "project-1", freshness,
      recipe: recipe([{ ...assertion, assertionId: "assertion-other", parameters: { ...assertion.parameters, symbol: "Other" } }]) }))
      .toMatchObject({ classification: "SKIPPED", reasonCodes: ["RECIPE_FRESHNESS_MISMATCH"] });
  });

  it("fails closed for mixed candidate identity and cross-project/global ambiguity", () => {
    expect(resolveLegacyMigrationCandidate({ asset: asset(), projectId: "project-1", recipe: recipe([
      assertion, { ...assertion, assertionId: "assertion-2", candidateId: "candidate-2" },
    ]) })).toMatchObject({ classification: "SKIPPED", reasonCodes: ["CANDIDATE_ID_AMBIGUOUS"] });
    expect(resolveLegacyMigrationCandidate({ asset: asset(), projectId: "other", recipe: recipe() })).toMatchObject({
      classification: "SKIPPED", reasonCodes: ["PROJECT_IDENTITY_MISMATCH"],
    });
    expect(resolveLegacyMigrationCandidate({ asset: asset({ scope: { level: "GLOBAL" }, symbols: [] }),
      projectId: "project-1" })).toMatchObject({ classification: "SKIPPED" });
  });

  it("preserves exact module, symbol, task and global scopes without widening authority", () => {
    const cases: readonly [KnowledgeAsset["scope"], Partial<KnowledgeCandidate["scopeHint"]>][] = [
      [{ level: "MODULE", projectId: "project-1", repositoryRemote: "git@example/repo.git", modulePaths: ["src/runtime"] },
        { level: "MODULE", projectId: "project-1", repositoryRemote: "git@example/repo.git", modulePaths: ["src/runtime"] }],
      [{ level: "SYMBOL", projectId: "project-1", repositoryRemote: "git@example/repo.git", symbols: ["LegacyWorker"] },
        { level: "SYMBOL", projectId: "project-1", repositoryRemote: "git@example/repo.git", symbols: ["LegacyWorker"] }],
      [{ level: "TASK", taskId: "task-1", projectId: "project-1" }, { level: "TASK" }],
      [{ level: "GLOBAL" }, { level: "GLOBAL" }],
    ];
    for (const [scope, expected] of cases) {
      expect(resolveLegacyMigrationCandidate({ asset: asset({ scope }), projectId: "project-1", recipe: recipe() }))
        .toMatchObject({ classification: "MIGRATABLE", candidate: { scopeHint: expected } });
    }
  });

  it("rejects non-code, empty-code and mismatched freshness evidence", () => {
    const value = asset();
    const candidate: KnowledgeCandidate = { schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "v1", status: "PROPOSED",
      subjectKey: value.subjectKey, kind: value.kind, scopeHint: { projectId: "project-1", reasonCodes: [] }, title: value.title,
      summary: value.summary, body: value.body, sourceEpisodes: ["episode-1"], confidence: value.confidence,
      assertions: [assertion], evidenceHints: [], createdAt: at, correlationId: value.correlationId };
    const freshness = { schemaVersion: 1, assetId: value.id, assetVersion: 1, assetContentHash: value.contentHash,
      projectId: "project-1", lifecycleStatus: value.status, freshnessStatus: "FRESH", candidate,
      fingerprint: { schemaVersion: 1, candidateId: "candidate-1", projectId: "project-1", targets: [], createdAt: at },
      anchors: [], updatedAt: at } as unknown as KnowledgeFreshnessRecord;
    const nonCode: KnowledgeAssertion = { ...assertion, kind: "COMMAND_SUCCEEDED",
      parameters: { commandHash: "c".repeat(64), expectedExitCode: 0 } };
    expect(resolveLegacyMigrationCandidate({ asset: value, projectId: "project-1", recipe: recipe([nonCode]) }))
      .toMatchObject({ classification: "SKIPPED", reasonCodes: ["CODE_ASSERTION_MISSING"] });
    expect(resolveLegacyMigrationCandidate({ asset: asset({ kind: "DESIGN", symbols: [] }), projectId: "project-1" }))
      .toMatchObject({ classification: "SKIPPED", reasonCodes: ["NOT_CODE_RELATED"] });
    expect(resolveLegacyMigrationCandidate({ asset: value, projectId: "project-1",
      freshness: { ...freshness, assetContentHash: "b".repeat(64) } })).toMatchObject({
        classification: "SKIPPED", reasonCodes: ["FRESHNESS_IDENTITY_MISMATCH"],
      });
    expect(resolveLegacyMigrationCandidate({ asset: value, projectId: "project-1",
      freshness: { ...freshness, candidate: { ...candidate, assertions: [{ ...assertion,
        parameters: { projectId: "other", symbol: "LegacyWorker" } }] } } })).toMatchObject({
        classification: "SKIPPED", reasonCodes: ["PROJECT_IDENTITY_MISMATCH"],
      });
    expect(resolveLegacyMigrationCandidate({ asset: value, projectId: "project-1",
      freshness: { ...freshness, candidate: { ...candidate, assertions: [nonCode] } } })).toMatchObject({
        classification: "SKIPPED", reasonCodes: ["CODE_ASSERTION_MISSING"],
      });
  });
});
