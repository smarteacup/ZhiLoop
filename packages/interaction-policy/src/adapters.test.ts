import type { ClosureVerificationResult } from "@zhiloop/domain";
import type { EvidencePolicyDecision } from "@zhiloop/evidence-policy";
import { describe, expect, it } from "vitest";

import { closureInteractionTrigger, evidencePolicyTriggers, ruleOverrideTrigger } from "./adapters.js";

const identity = { sessionId: "session-a", turnId: "turn-20", turnOrdinal: 20 } as const;

function evidence(reasonCodes: readonly string[], overrides: Partial<EvidencePolicyDecision> = {}): EvidencePolicyDecision {
  return {
    action: "KEEP", interaction: "NONE", currentStatus: "PROPOSED", targetStatus: "PROPOSED",
    transitionPath: [], effectiveScope: { level: "PROJECT", projectId: "project-a" },
    shouldPublish: false, evidenceIds: [], reasonCodes, ...overrides,
  };
}

function closure(decision: ClosureVerificationResult["decision"]): ClosureVerificationResult {
  return {
    schemaVersion: 1, verificationId: "verification-a", taskId: "turn-20", decision,
    reasonCodes: [decision === "ASK_USER" ? "SEMANTIC_GATE_UNKNOWN" : "ALL_DECLARED_GATES_SATISFIED"],
    missingKnowledgeIds: [], unmetGateIds: [], violatedBoundaryIds: [],
    gateResults: [{ gateId: "gate-a", status: decision === "ASK_USER" ? "UNKNOWN" : "SATISFIED", reasonCodes: ["FIXTURE"], evidenceRefs: [] }],
  };
}

describe("Interaction trigger adapters", () => {
  it("maps evidence conflict and denied GLOBAL promotion into separate typed triggers", () => {
    const triggers = evidencePolicyTriggers(identity, "knowledge-a", "缓存方案", evidence([
      "KNOWLEDGE_CONFLICT_REQUIRES_CONFIRMATION", "GLOBAL_FALLBACK_PROJECT",
    ], { action: "ASK_USER", interaction: "ASK_USER" }));
    expect(triggers.map((item) => item.kind)).toEqual(["KNOWLEDGE_CONFLICT", "SCOPE_PROMOTION"]);
    expect(triggers.every((item) => item.subjectIds[0] === "knowledge-a")).toBe(true);
    expect(Object.isFrozen(triggers)).toBe(true);
  });

  it("maps verification unknown at PROPOSED to a low-impact non-question trigger", () => {
    expect(evidencePolicyTriggers(identity, "knowledge-a", "缓存方案", evidence([
      "AUTO_PUBLISH_ASSERTIONS_INCOMPLETE", "VERIFICATION_UNKNOWN", "MODEL_ONLY_REMAINS_PROPOSED",
    ]))).toEqual([expect.objectContaining({
      kind: "LOW_IMPACT_UNKNOWN", impact: "LOW", irreversible: false, subjectIds: ["knowledge-a"],
    })]);
    expect(evidencePolicyTriggers(identity, "knowledge-a", "缓存方案", evidence(["MODEL_ONLY_REMAINS_PROPOSED"]))).toEqual([]);
  });

  it("maps Closure ASK_USER only and keeps its verification identity", () => {
    expect(closureInteractionTrigger(identity, "语义证据不确定", closure("ASK_USER"))).toMatchObject({
      kind: "CLOSURE_ASK_USER", subjectIds: ["verification-a"], impact: "MEDIUM",
    });
    expect(closureInteractionTrigger(identity, "已完成", closure("PASS"))).toBeUndefined();
  });

  it("creates a dedicated high-impact irreversible rule override trigger", () => {
    const value = ruleOverrideTrigger(identity, "rule-a", "禁止写入凭证");
    expect(value).toMatchObject({
      kind: "RULE_OVERRIDE", subjectIds: ["rule-a"], impact: "HIGH", irreversible: true,
    });
    expect(ruleOverrideTrigger(identity, "rule-a", "临时格式规则", false).impact).toBe("MEDIUM");
  });

  it("generates stable trigger IDs for the same source identity", () => {
    const first = ruleOverrideTrigger(identity, "rule-a", "first summary");
    const second = ruleOverrideTrigger(identity, "rule-a", "changed display summary");
    expect(first.triggerId).toBe(second.triggerId);
  });
});
