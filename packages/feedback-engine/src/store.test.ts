import { describe, expect, it } from "vitest";

import { SqliteFeedbackStore } from "./store.js";
import type { KnowledgeFeedbackEvent } from "./types.js";

const scopeA = JSON.stringify({ level: "PROJECT", projectId: "project-a" });
const scopeB = JSON.stringify({ level: "PROJECT", projectId: "project-b" });
const at = "2026-08-02T04:00:00.000Z";

function feedback(index: number, action: KnowledgeFeedbackEvent["action"], overrides: Partial<KnowledgeFeedbackEvent> = {}): KnowledgeFeedbackEvent {
  return {
    eventId: `feedback-${index}`, assetId: "knowledge-a", scopeKey: scopeA, action,
    traceId: `trace-${index}`, actor: "user", occurredAt: `2026-08-02T04:00:${String(index).padStart(2, "0")}.000Z`, ...overrides,
  };
}

describe("SqliteFeedbackStore", () => {
  it("starts compact and records relevant/irrelevant events idempotently", () => {
    const store = new SqliteFeedbackStore(":memory:");
    expect(store.profile(scopeA)).toMatchObject({ preferredLevel: "L2_COMPACT", sampleCount: 0, assets: [] });
    expect(store.record(feedback(1, "RELEVANT"))).toBe("RECORDED");
    expect(store.record(structuredClone(feedback(1, "RELEVANT")))).toBe("EXISTING");
    expect(() => store.record(feedback(1, "IRRELEVANT"))).toThrow("identity conflict");
    expect(store.profile(scopeA).assets[0]).toMatchObject({ relevant: 1, irrelevant: 0, score: 1 });
    store.close();
  });

  it("applies pin/suppress by exact scope and lets a later explicit control reverse it", () => {
    const store = new SqliteFeedbackStore(":memory:");
    store.record(feedback(1, "SUPPRESS"));
    store.record(feedback(2, "PIN"));
    store.record(feedback(3, "SUPPRESS", { eventId: "feedback-b", scopeKey: scopeB }));
    expect(store.profile(scopeA)).toMatchObject({ pinnedAssetIds: ["knowledge-a"], suppressedAssetIds: [] });
    expect(store.profile(scopeB)).toMatchObject({ pinnedAssetIds: [], suppressedAssetIds: ["knowledge-a"] });
    store.close();
  });

  it("reduces complexity only after repeated irrelevant feedback", () => {
    const store = new SqliteFeedbackStore(":memory:");
    store.record(feedback(1, "IRRELEVANT"));
    expect(store.profile(scopeA).preferredLevel).toBe("L2_COMPACT");
    store.record(feedback(2, "IRRELEVANT"));
    expect(store.profile(scopeA)).toMatchObject({
      preferredLevel: "L1_POINTER", sampleCount: 2, reasonCodes: ["IRRELEVANT_FEEDBACK_REDUCED_DEPTH"],
    });
    store.close();
  });

  it("raises complexity to L3 only when relevant knowledge is repeatedly used after MCP expansion", () => {
    const store = new SqliteFeedbackStore(":memory:");
    for (let index = 1; index <= 3; index += 1) store.record(feedback(index, "RELEVANT"));
    store.recordExpansion({ expansionId: "expansion-1", assetId: "knowledge-a", scopeKey: scopeA, traceId: "trace-mcp-1", occurredAt: at });
    store.recordExpansion({ expansionId: "expansion-2", assetId: "knowledge-a", scopeKey: scopeA, traceId: "trace-mcp-2", occurredAt: "2026-08-02T04:01:00.000Z" });
    expect(store.profile(scopeA).preferredLevel).toBe("L2_COMPACT");
    expect(store.recordUsage({ usageEventId: "usage-1", expansionId: "expansion-1", traceId: "trace-mcp-1", occurredAt: "2026-08-02T04:02:00.000Z" })).toBe("RECORDED");
    expect(store.recordUsage({ usageEventId: "usage-1", expansionId: "expansion-1", traceId: "trace-mcp-1", occurredAt: "2026-08-02T04:02:00.000Z" })).toBe("EXISTING");
    expect(store.profile(scopeA)).toMatchObject({
      preferredLevel: "L3_EVIDENCED", mcpExpanded: 2, mcpUsed: 1,
      reasonCodes: ["RELEVANT_AND_USED_FEEDBACK_INCREASED_DEPTH"],
    });
    store.close();
  });

  it("requires usage to match an actual expansion and exact trace", () => {
    const store = new SqliteFeedbackStore(":memory:");
    expect(() => store.recordUsage({ usageEventId: "usage-1", expansionId: "missing", traceId: "trace-a", occurredAt: at })).toThrow("matching expansion");
    store.recordExpansion({ expansionId: "expansion-1", assetId: "knowledge-a", scopeKey: scopeA, traceId: "trace-a", occurredAt: at });
    expect(store.recordExpansion({ expansionId: "expansion-1", assetId: "knowledge-a", scopeKey: scopeA, traceId: "trace-a", occurredAt: at })).toBe("EXISTING");
    expect(() => store.recordExpansion({ expansionId: "expansion-1", assetId: "knowledge-other", scopeKey: scopeA, traceId: "trace-a", occurredAt: at })).toThrow("identity conflict");
    expect(() => store.recordUsage({ usageEventId: "usage-1", expansionId: "expansion-1", traceId: "trace-other", occurredAt: at })).toThrow("matching expansion");
    expect(() => store.recordUsage({ usageEventId: "bad/id", expansionId: "expansion-1", traceId: "trace-a", occurredAt: at })).toThrow("invalid");
    store.recordUsage({ usageEventId: "usage-1", expansionId: "expansion-1", traceId: "trace-a", occurredAt: at });
    expect(() => store.recordUsage({ usageEventId: "usage-1", expansionId: "expansion-1", traceId: "trace-a", occurredAt: "2026-08-02T04:03:00.000Z" })).toThrow("identity conflict");
    expect(() => store.recordUsage({ usageEventId: "usage-2", expansionId: "expansion-1", traceId: "trace-a", occurredAt: at })).toThrow("different usage");
    store.close();
  });

  it("rejects malformed events and fails after close", () => {
    const store = new SqliteFeedbackStore(":memory:");
    expect(() => store.record(feedback(1, "RELEVANT", { eventId: "unsafe/id" }))).toThrow("invalid");
    expect(() => store.recordExpansion({ expansionId: "bad/id", assetId: "a", scopeKey: scopeA, traceId: "t", occurredAt: at })).toThrow("invalid");
    expect(() => store.profile("")).toThrow("scopeKey");
    store.close(); store.close();
    expect(() => store.profile(scopeA)).toThrow("closed");
  });
});
