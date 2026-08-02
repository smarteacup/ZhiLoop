import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import { describe, expect, it } from "vitest";

import { evaluateInteractionPolicy } from "./policy.js";
import type { ConfirmationHistoryEntry, InteractionPolicyInput, InteractionTrigger } from "./types.js";

const NOW = "2026-08-02T03:00:00.000Z";

function trigger(overrides: Partial<InteractionTrigger> = {}): InteractionTrigger {
  return {
    triggerId: "trigger-conflict",
    sessionId: "session-a",
    turnId: "turn-20",
    turnOrdinal: 20,
    kind: "KNOWLEDGE_CONFLICT",
    impact: "HIGH",
    irreversible: false,
    subjectIds: ["knowledge-a"],
    summary: "缓存实现方案",
    ...overrides,
  };
}

function input(triggers: readonly InteractionTrigger[], overrides: Partial<InteractionPolicyInput> = {}): InteractionPolicyInput {
  return {
    sessionId: "session-a",
    turnId: "turn-20",
    turnOrdinal: 20,
    now: NOW,
    triggers,
    history: [],
    policy: DEFAULT_CONFIGURATION.verification.interaction,
    ...overrides,
  };
}

function history(overrides: Partial<ConfirmationHistoryEntry> = {}): ConfirmationHistoryEntry {
  return {
    confirmationId: "confirmation-old",
    triggerId: "trigger-old",
    sessionId: "session-a",
    turnId: "turn-1",
    turnOrdinal: 1,
    ...overrides,
  };
}

describe("Interaction Policy", () => {
  it("does nothing when the turn has no confirmation trigger", () => {
    expect(evaluateInteractionPolicy(input([]))).toEqual({
      action: "NONE", defaults: [], deferredTriggerIds: [], reviewTasksCreated: 0,
      reasonCodes: ["NO_CONFIRMATION_TRIGGER"],
    });
  });

  it("creates one deterministic micro-confirmation with a conservative unanswered default", () => {
    const result = evaluateInteractionPolicy(input([trigger()]));
    expect(result).toMatchObject({
      action: "ASK_USER", defaults: [], deferredTriggerIds: [], reviewTasksCreated: 0,
      request: {
        kind: "KNOWLEDGE_CONFLICT", subjectIds: ["knowledge-a"], safeDefaultOptionId: "keep-proposed",
      },
    });
    expect(result.request?.options).toEqual([
      { optionId: "keep-proposed", label: "保持候选，不覆盖当前结论", effect: "KEEP_PROPOSED" },
      { optionId: "reject-candidate", label: "明确拒绝该候选", effect: "REJECT_CANDIDATE" },
      { optionId: "accept-candidate", label: "采用该候选", effect: "ACCEPT_CANDIDATE" },
    ]);
    expect(result.request?.question).toContain(JSON.stringify("缓存实现方案"));
    expect(evaluateInteractionPolicy(input([trigger()])).request?.confirmationId).toBe(result.request?.confirmationId);
    const reordered = evaluateInteractionPolicy(input([trigger({ subjectIds: ["knowledge-b", "knowledge-a"] })]));
    const canonical = evaluateInteractionPolicy(input([trigger({ subjectIds: ["knowledge-a", "knowledge-b"] })]));
    expect(reordered.request?.confirmationId).toBe(canonical.request?.confirmationId);
    expect(reordered.request?.subjectIds).toEqual(["knowledge-a", "knowledge-b"]);
    expect(Object.isFrozen(result.request?.options)).toBe(true);
  });

  it("asks only the highest-priority trigger and safely defers every other trigger", () => {
    const result = evaluateInteractionPolicy(input([
      trigger(),
      trigger({ triggerId: "trigger-scope", kind: "SCOPE_PROMOTION", impact: "MEDIUM", subjectIds: ["knowledge-b"] }),
      trigger({ triggerId: "trigger-rule", kind: "RULE_OVERRIDE", impact: "LOW", irreversible: true, subjectIds: ["rule-a"] }),
      trigger({ triggerId: "trigger-closure", kind: "CLOSURE_ASK_USER", impact: "HIGH", subjectIds: ["verification-a"] }),
    ]));
    expect(result.action).toBe("ASK_USER");
    expect(result.request?.triggerId).toBe("trigger-rule");
    expect(result.defaults).toEqual(expect.arrayContaining([
      expect.objectContaining({ triggerId: "trigger-conflict", effect: "KEEP_PROPOSED", reasonCode: "LOWER_PRIORITY_DEFERRED" }),
      expect.objectContaining({ triggerId: "trigger-scope", effect: "KEEP_PROJECT" }),
      expect.objectContaining({ triggerId: "trigger-closure", effect: "STOP_WITHOUT_EXPANSION" }),
    ]));
    expect(result.reviewTasksCreated).toBe(0);
  });

  it("keeps low-impact unknown knowledge PROPOSED without a question or review task", () => {
    const unknown = trigger({
      triggerId: "trigger-unknown", kind: "LOW_IMPACT_UNKNOWN", impact: "LOW", irreversible: false,
    });
    expect(evaluateInteractionPolicy(input([unknown]))).toEqual({
      action: "DEFER",
      defaults: [{
        triggerId: "trigger-unknown", subjectIds: ["knowledge-a"], effect: "KEEP_PROPOSED",
        reasonCode: "LOW_IMPACT_UNKNOWN",
      }],
      deferredTriggerIds: ["trigger-unknown"], reviewTasksCreated: 0,
      reasonCodes: ["LOW_IMPACT_UNKNOWN_REMAINS_PROPOSED"],
    });
  });

  it("enforces at most one question in every rolling twenty-turn window", () => {
    const recent = evaluateInteractionPolicy(input([trigger()], {
      history: [history({ turnId: "turn-1", turnOrdinal: 1 })],
    }));
    expect(recent).toMatchObject({
      action: "DEFER", reasonCodes: ["QUESTION_WINDOW_BUDGET_EXHAUSTED"],
      defaults: [expect.objectContaining({ effect: "KEEP_PROPOSED", reasonCode: "QUESTION_BUDGET_EXHAUSTED" })],
    });
    const outsideWindow = evaluateInteractionPolicy(input([trigger()], {
      turnOrdinal: 21,
      turnId: "turn-21",
      triggers: [trigger({ turnId: "turn-21", turnOrdinal: 21 })],
      history: [history({ turnId: "turn-1", turnOrdinal: 1 })],
    }));
    expect(outsideWindow.action).toBe("ASK_USER");
  });

  it("never asks the same trigger again even after the rolling window expires", () => {
    const result = evaluateInteractionPolicy(input([trigger()], {
      history: [history({ triggerId: "trigger-conflict", turnId: "turn-0", turnOrdinal: 0 })],
    }));
    expect(result).toMatchObject({
      action: "DEFER", reasonCodes: ["TRIGGER_ALREADY_ASKED"],
      defaults: [expect.objectContaining({ reasonCode: "TRIGGER_ALREADY_ASKED", effect: "KEEP_PROPOSED" })],
    });
  });

  it("uses non-expanding safe defaults for every confirmation kind", () => {
    const cases = [
      ["KNOWLEDGE_CONFLICT", "keep-proposed", "KEEP_PROPOSED"],
      ["SCOPE_PROMOTION", "keep-project", "KEEP_PROJECT"],
      ["RULE_OVERRIDE", "keep-rule", "KEEP_RULE"],
      ["CLOSURE_ASK_USER", "stop-safe", "STOP_WITHOUT_EXPANSION"],
    ] as const;
    for (const [kind, optionId, effect] of cases) {
      const result = evaluateInteractionPolicy(input([trigger({ kind })]));
      expect(result.request?.safeDefaultOptionId).toBe(optionId);
      expect(result.request?.options.find((item) => item.optionId === optionId)?.effect).toBe(effect);
    }
  });

  it("fails closed without a question for malformed identity, unsafe policy, or low-unknown escalation", () => {
    const malformed = [
      input([trigger({ turnId: "other" })]),
      input([trigger({ kind: "LOW_IMPACT_UNKNOWN", impact: "HIGH" })]),
      input([trigger({ kind: "LOW_IMPACT_UNKNOWN", impact: "LOW", irreversible: true })]),
      input([trigger()], { now: "not-a-date" }),
      input([trigger()], { now: "2026-08-02T03:00:00Z" }),
      input([trigger()], { policy: { ...DEFAULT_CONFIGURATION.verification.interaction, questionWindowTurns: 1 as 20 } }),
      input([trigger()], { policy: { ...DEFAULT_CONFIGURATION.verification.interaction, maxQuestionsPerTurn: 2 as 1 } }),
      input([trigger()], { policy: { ...DEFAULT_CONFIGURATION.verification.interaction, defaultScope: "GLOBAL" as "PROJECT" } }),
      input([trigger()], { policy: { ...DEFAULT_CONFIGURATION.verification.interaction, unansweredBehavior: "ASK" as "SAFE_DEFAULT" } }),
      input([trigger()], { policy: { ...DEFAULT_CONFIGURATION.verification.interaction, createReviewTasks: true as false } }),
      input([trigger({ subjectIds: ["duplicate", "duplicate"] })]),
      input([trigger({ subjectIds: [] })]),
      input([trigger({ subjectIds: Array.from({ length: 21 }, (_, index) => `subject-${index}`) })]),
      input([trigger({ subjectIds: ["unsafe/subject"] })]),
      input([trigger({ triggerId: "unsafe/trigger" })]),
      input([trigger({ summary: "unsafe\nsummary" })]),
      input([trigger(), trigger()]),
      input([{ ...trigger(), kind: "UNKNOWN_KIND" } as unknown as InteractionTrigger]),
      input([{ ...trigger(), impact: "UNKNOWN_IMPACT" } as unknown as InteractionTrigger]),
      input([trigger()], { sessionId: "unsafe/session" }),
      input([trigger()], { turnOrdinal: -1 }),
      input([trigger()], { history: [history({ confirmationId: "unsafe/id" })] }),
      input([trigger()], { history: [history({ sessionId: "other" })] }),
      input([trigger()], { history: [history({ turnId: "unsafe/turn" })] }),
      input([trigger()], { history: [history({ turnOrdinal: 21 })] }),
      input([trigger()], { history: [history(), history()] }),
      new Proxy({} as InteractionPolicyInput, { get: () => { throw new Error("hostile input"); } }),
    ];
    for (const value of malformed) {
      expect(evaluateInteractionPolicy(value)).toEqual({
        action: "DEFER", defaults: [], deferredTriggerIds: [], reviewTasksCreated: 0,
        reasonCodes: ["INVALID_INTERACTION_POLICY_INPUT", "SAFE_DEFAULTS_REQUIRED"],
      });
    }
  });
});
