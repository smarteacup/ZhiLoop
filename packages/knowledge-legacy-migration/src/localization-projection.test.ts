import { describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "@zhiloop/domain";

import { SqliteLegacyLocalizationProjection, deriveLegacyLocalizationDraft } from "./localization-projection.js";

const at = "2026-08-20T00:00:00.000Z";
const asset: KnowledgeAsset = { schemaVersion: 1, id: "knowledge-legacy", subjectKey: "implementation.order.create",
  kind: "IMPLEMENTATION", scope: { level: "PROJECT", projectId: "project-a" }, version: 1, status: "IMPLEMENTED",
  title: "创建订单", summary: "旧版订单创建流程", body: "body", aliases: [], keywords: ["订单"],
  applicability: ["旧版 API"], nonApplicability: ["批量导入"], symbols: ["OrderService"], relations: [], evidence: [],
  confidence: 0.9, sourceEpisodes: ["episode-a"], contentHash: "a".repeat(64), correlationId: "correlation-a",
  createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z" };

describe("legacy localization projection", () => {
  it("creates non-authoritative drafts without mutating legacy assets and rolls them back", () => {
    const before = structuredClone(asset);
    const draft = deriveLegacyLocalizationDraft(asset);
    expect(draft).toMatchObject({ state: "DRAFT", locator: { projectId: "project-a",
      branchApplicability: { mode: "ALL_BRANCHES", reason: "LEGACY_REVISION_UNKNOWN" } } });
    expect(draft?.locator.observedRevision.commit).toBeUndefined();
    expect(asset).toEqual(before);
    using projection = new SqliteLegacyLocalizationProjection(":memory:");
    const rebuilt = projection.rebuild({ projectId: "project-a", sourceRevision: 7,
      assets: [asset, { ...asset, id: "global", scope: { level: "GLOBAL" } }], createdAt: "2026-08-20T00:00:00.000Z" });
    expect(rebuilt).toMatchObject({ projected: 1, skipped: 1 });
    expect(projection.list(rebuilt.rebuildId)).toEqual([draft]);
    expect(projection.rebuild({ projectId: "project-a", sourceRevision: 7,
      assets: [asset, { ...asset, id: "global", scope: { level: "GLOBAL" } }], createdAt: "2026-08-20T00:00:00.000Z" }))
      .toEqual(rebuilt);
    expect(projection.rollback(rebuilt.rebuildId)).toBe(1);
    expect(projection.list(rebuilt.rebuildId)).toEqual([]);
  });

  it("derives module/symbol coordinates, skips unsupported assets, and fails closed after disposal", () => {
    expect(deriveLegacyLocalizationDraft({ ...asset, schemaVersion: 2 })).toBeUndefined();
    expect(deriveLegacyLocalizationDraft({ ...asset, scope: { level: "GLOBAL" } })).toBeUndefined();
    expect(deriveLegacyLocalizationDraft({ ...asset, subjectKey: "Legacy Name",
      scope: { level: "MODULE", projectId: "project-a", repositoryRemote: "example.com/a", modulePaths: ["src/order"] } }))
      .toMatchObject({ locator: { scenarioKey: "legacy.legacy-name", repositoryRemote: "example.com/a",
        modulePaths: ["src/order"] } });
    expect(deriveLegacyLocalizationDraft({ ...asset, subjectKey: "---",
      scope: { level: "SYMBOL", projectId: "project-a", symbols: ["OrderController", "OrderService"] } }))
      .toMatchObject({ locator: { scenarioKey: "legacy.knowledge", symbols: ["OrderController", "OrderService"] } });

    const projection = new SqliteLegacyLocalizationProjection(":memory:");
    expect(() => projection.rebuild({ projectId: "project-a", sourceRevision: -1, assets: [], createdAt: at }))
      .toThrow("REBUILD_INVALID");
    expect(() => projection.rebuild({ projectId: "project-a", sourceRevision: 1, assets: [], createdAt: "invalid" }))
      .toThrow("REBUILD_INVALID");
    expect(projection.rollback("missing-rebuild")).toBe(0);
    projection.close();
    projection.close();
    expect(() => projection.list("missing")).toThrow("PROJECTION_CLOSED");
    expect(() => projection.rollback("missing")).toThrow("PROJECTION_CLOSED");
    expect(() => projection.rebuild({ projectId: "project-a", sourceRevision: 1, assets: [], createdAt: at }))
      .toThrow("PROJECTION_CLOSED");
  });
});
