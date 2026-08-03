import { SqliteFeedbackStore } from "@zhiloop/feedback-engine";
import { describe, expect, it } from "vitest";

import { KnowledgeFeedbackRuntime } from "./feedback-runtime.js";
import { fixedNow } from "./test-fixtures.js";
import type { KnowledgeEligibilityPort } from "./types.js";

const scopeKey = JSON.stringify({ level: "PROJECT", projectId: "project-a" });

describe("KnowledgeFeedbackRuntime", () => {
  it("records retrieval use, pin and suppress without permitting feedback to widen eligibility", async () => {
    const store = new SqliteFeedbackStore(":memory:");
    const state = { eligible: true, suppressed: false, current: true };
    const eligibility: KnowledgeEligibilityPort = {
      inspect: () => ({
        exists: true, currentVersion: 3, current: state.current, scopeMatched: true,
        statusEligible: state.eligible, suppressed: state.suppressed,
      }),
    };
    const runtime = new KnowledgeFeedbackRuntime({ store, eligibility });
    expect(await runtime.record({
      eventId: "feedback-pin", assetId: "knowledge-1", scopeKey,
      action: "PIN", traceId: "trace-1", actor: "operator", occurredAt: fixedNow,
    }, 3)).toEqual({ result: "RECORDED", eligibleAfterWrite: true });

    state.eligible = false;
    await expect(runtime.record({
      eventId: "feedback-relevant", assetId: "knowledge-1", scopeKey,
      action: "RELEVANT", traceId: "trace-2", actor: "operator", occurredAt: fixedNow,
    }, 3)).rejects.toThrow("cannot make ineligible");
    state.eligible = true;
    expect(await runtime.record({
      eventId: "feedback-suppress", assetId: "knowledge-1", scopeKey,
      action: "SUPPRESS", traceId: "trace-3", actor: "operator", occurredAt: fixedNow,
    }, 3)).toEqual({ result: "RECORDED", eligibleAfterWrite: false });
    expect(runtime.profile(scopeKey)).toMatchObject({ suppressedAssetIds: ["knowledge-1"] });

    state.current = false;
    await expect(runtime.record({
      eventId: "feedback-stale", assetId: "knowledge-1", scopeKey,
      action: "IRRELEVANT", traceId: "trace-4", actor: "operator", occurredAt: fixedNow,
    }, 2)).rejects.toThrow("stale");
    store.close();
  });

  it("honors cancellation before any feedback side effect", async () => {
    const store = new SqliteFeedbackStore(":memory:");
    const runtime = new KnowledgeFeedbackRuntime({
      store,
      eligibility: { inspect: () => ({ exists: true, current: true, scopeMatched: true, statusEligible: true, suppressed: false }) },
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(runtime.record({
      eventId: "feedback-cancel", assetId: "knowledge-1", scopeKey,
      action: "PIN", traceId: "trace-1", actor: "operator", occurredAt: fixedNow,
    }, 3, controller.signal)).rejects.toThrow("cancelled");
    expect(runtime.profile(scopeKey).sampleCount).toBe(0);
    store.close();
  });
});
