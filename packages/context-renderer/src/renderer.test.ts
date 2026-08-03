import type { ContextEnvelope } from "@zhiloop/domain";
import { describe, expect, it } from "vitest";

import {
  estimateAdditionalContextTokens,
  renderAdditionalContext,
  withAdditionalContextTokenEstimate,
} from "./renderer.js";

function envelope(omittedItems = 0): ContextEnvelope {
  return {
    schemaVersion: 1,
    runId: "run-renderer",
    complexity: {
      level: "L0_NONE", breadth: 0, depth: "NONE", authority: "NONE", evidence: "NONE",
      reasonCodes: ["NO_RETRIEVED_KNOWLEDGE"],
    },
    budget: {
      maxTokens: 800, estimatedTokens: 1, truncated: omittedItems > 0,
      disclosedItems: 0, omittedItems,
    },
    items: [],
  };
}

describe("Context Renderer", () => {
  it("converges the estimate against the complete stable additionalContext", () => {
    const finalized = withAdditionalContextTokenEstimate(envelope(), "trace-renderer");
    expect(finalized.budget.estimatedTokens).toBe(estimateAdditionalContextTokens(finalized, "trace-renderer"));
    expect(renderAdditionalContext(finalized, "trace-renderer")).not.toContain("progressiveDisclosure");
  });

  it("keeps omitted knowledge discoverable even when no pointer fits", () => {
    const finalized = withAdditionalContextTokenEstimate(envelope(2), "trace-renderer");
    const rendered = renderAdditionalContext(finalized, "trace-renderer");
    expect(rendered).toContain('"eligibleItems":2');
    expect(rendered).toContain('"omittedItems":2');
    expect(rendered).toContain('"tool":"ckl.search"');
  });

  it("renders a disclosed L1 pointer as progressive data", () => {
    const initial: ContextEnvelope = {
      ...envelope(),
      complexity: {
        level: "L1_POINTER", breadth: 1, depth: "POINTER", authority: "REFERENCE", evidence: "NONE",
        reasonCodes: ["REQUESTED_COMPLEXITY_LEVEL"],
      },
      budget: { ...envelope().budget, disclosedItems: 1 },
      items: [{
        id: "knowledge-renderer", version: 1, subjectKey: "knowledge-renderer", kind: "FACT", status: "VERIFIED",
        scope: { level: "GLOBAL" }, authority: "REFERENCE", detailLevel: "L1_POINTER",
        title: "Renderer fact", summary: "A scoped introduction.", retrievalRank: 1,
      }],
    };
    const rendered = renderAdditionalContext(
      withAdditionalContextTokenEstimate(initial, "trace-renderer"),
      "trace-renderer",
    );
    expect(rendered).toContain('"mode":"DYNAMIC_POINTERS"');
    expect(rendered).toContain('"id":"knowledge-renderer"');
  });
});
