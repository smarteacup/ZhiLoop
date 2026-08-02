import { createHash } from "node:crypto";

import type { ConfirmationEffect, ConfirmationKind, ConfirmationOption, ConfirmationRequest } from "@zhiloop/domain";

import type {
  InteractionPolicyDecision,
  InteractionPolicyInput,
  InteractionTrigger,
  SafeDefaultDecision,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const KINDS = new Set<ConfirmationKind>([
  "KNOWLEDGE_CONFLICT", "SCOPE_PROMOTION", "RULE_OVERRIDE", "CLOSURE_ASK_USER", "LOW_IMPACT_UNKNOWN",
]);
const IMPACTS = new Set(["LOW", "MEDIUM", "HIGH"]);
const IMPACT_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
const KIND_RANK: Readonly<Record<ConfirmationKind, number>> = {
  LOW_IMPACT_UNKNOWN: 0,
  CLOSURE_ASK_USER: 1,
  SCOPE_PROMOTION: 2,
  KNOWLEDGE_CONFLICT: 3,
  RULE_OVERRIDE: 4,
};

const OPTIONS: Readonly<Record<Exclude<ConfirmationKind, "LOW_IMPACT_UNKNOWN">, readonly ConfirmationOption[]>> = {
  KNOWLEDGE_CONFLICT: [
    { optionId: "keep-proposed", label: "保持候选，不覆盖当前结论", effect: "KEEP_PROPOSED" },
    { optionId: "reject-candidate", label: "明确拒绝该候选", effect: "REJECT_CANDIDATE" },
    { optionId: "accept-candidate", label: "采用该候选", effect: "ACCEPT_CANDIDATE" },
  ],
  SCOPE_PROMOTION: [
    { optionId: "keep-project", label: "仅保留在当前项目", effect: "KEEP_PROJECT" },
    { optionId: "promote-global", label: "提升为全局知识", effect: "PROMOTE_GLOBAL" },
  ],
  RULE_OVERRIDE: [
    { optionId: "keep-rule", label: "保留现有规则", effect: "KEEP_RULE" },
    { optionId: "apply-override", label: "应用本次覆盖", effect: "APPLY_OVERRIDE" },
  ],
  CLOSURE_ASK_USER: [
    { optionId: "stop-safe", label: "停止且不扩大原任务", effect: "STOP_WITHOUT_EXPANSION" },
    { optionId: "continue-original", label: "只按原任务范围继续", effect: "CONTINUE_ORIGINAL_SCOPE" },
  ],
};

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function validInput(input: InteractionPolicyInput): boolean {
  if (!SAFE_ID.test(input.sessionId) || !SAFE_ID.test(input.turnId)
    || !Number.isSafeInteger(input.turnOrdinal) || input.turnOrdinal < 0
    || !Number.isFinite(Date.parse(input.now)) || new Date(input.now).toISOString() !== input.now
    || input.triggers.length > 100 || input.history.length > 10_000
    || input.policy.maxQuestionsPerTurn !== 1 || input.policy.questionWindowTurns !== 20
    || input.policy.defaultScope !== "PROJECT" || input.policy.unansweredBehavior !== "SAFE_DEFAULT"
    || input.policy.createReviewTasks !== false) return false;
  const triggerIds = input.triggers.map((item) => item.triggerId);
  const confirmationIds = input.history.map((item) => item.confirmationId);
  if (new Set(triggerIds).size !== triggerIds.length || new Set(confirmationIds).size !== confirmationIds.length) return false;
  if (input.triggers.some((trigger) => !SAFE_ID.test(trigger.triggerId) || !KINDS.has(trigger.kind) || !IMPACTS.has(trigger.impact)
    || trigger.sessionId !== input.sessionId || trigger.turnId !== input.turnId || trigger.turnOrdinal !== input.turnOrdinal
    || !validText(trigger.summary, 500) || trigger.subjectIds.length < 1 || trigger.subjectIds.length > 20
    || new Set(trigger.subjectIds).size !== trigger.subjectIds.length || !trigger.subjectIds.every((id) => SAFE_ID.test(id))
    || (trigger.kind === "LOW_IMPACT_UNKNOWN" && (trigger.impact !== "LOW" || trigger.irreversible)))) return false;
  return input.history.every((item) => SAFE_ID.test(item.confirmationId) && SAFE_ID.test(item.triggerId)
    && item.sessionId === input.sessionId && SAFE_ID.test(item.turnId)
    && Number.isSafeInteger(item.turnOrdinal) && item.turnOrdinal >= 0 && item.turnOrdinal <= input.turnOrdinal);
}

function safeEffect(kind: ConfirmationKind): ConfirmationEffect {
  switch (kind) {
    case "KNOWLEDGE_CONFLICT":
    case "LOW_IMPACT_UNKNOWN": return "KEEP_PROPOSED";
    case "SCOPE_PROMOTION": return "KEEP_PROJECT";
    case "RULE_OVERRIDE": return "KEEP_RULE";
    case "CLOSURE_ASK_USER": return "STOP_WITHOUT_EXPANSION";
  }
}

function question(trigger: InteractionTrigger): string {
  const subject = JSON.stringify(trigger.summary);
  switch (trigger.kind) {
    case "KNOWLEDGE_CONFLICT": return `候选知识 ${subject} 与当前结论冲突，要暂不处理、明确拒绝还是采用它？`;
    case "SCOPE_PROMOTION": return `是否将 ${subject} 从当前项目范围提升为全局知识？`;
    case "RULE_OVERRIDE": return `本次请求将覆盖现有规则 ${subject}，是否允许？`;
    case "CLOSURE_ASK_USER": return `任务闭环信息 ${subject} 仍不确定，是否只按原任务范围继续？`;
    case "LOW_IMPACT_UNKNOWN": throw new Error("low-impact unknown must not create a question");
  }
}

function request(trigger: InteractionTrigger, now: string): ConfirmationRequest {
  if (trigger.kind === "LOW_IMPACT_UNKNOWN") throw new Error("low-impact unknown must remain deferred");
  const options = OPTIONS[trigger.kind].map((item) => ({ ...item }));
  const safe = safeEffect(trigger.kind);
  const safeOption = options.find((item) => item.effect === safe);
  if (safeOption === undefined) throw new Error("confirmation kind has no safe default");
  const digest = createHash("sha256").update(JSON.stringify([
    trigger.sessionId, trigger.turnId, trigger.turnOrdinal, trigger.triggerId, trigger.kind, [...trigger.subjectIds].sort(),
  ])).digest("hex").slice(0, 32);
  return freeze({
    schemaVersion: 1,
    confirmationId: `confirmation-${digest}`,
    sessionId: trigger.sessionId,
    turnId: trigger.turnId,
    turnOrdinal: trigger.turnOrdinal,
    triggerId: trigger.triggerId,
    kind: trigger.kind,
    subjectIds: [...trigger.subjectIds].sort(),
    question: question(trigger),
    options,
    safeDefaultOptionId: safeOption.optionId,
    createdAt: now,
  });
}

function fallback(trigger: InteractionTrigger, reasonCode: SafeDefaultDecision["reasonCode"]): SafeDefaultDecision {
  return freeze({
    triggerId: trigger.triggerId,
    subjectIds: [...trigger.subjectIds].sort(),
    effect: safeEffect(trigger.kind),
    reasonCode,
  });
}

function priority(left: InteractionTrigger, right: InteractionTrigger): number {
  return Number(right.irreversible) - Number(left.irreversible)
    || IMPACT_RANK[right.impact] - IMPACT_RANK[left.impact]
    || KIND_RANK[right.kind] - KIND_RANK[left.kind]
    || (left.triggerId < right.triggerId ? -1 : left.triggerId > right.triggerId ? 1 : 0);
}

function safelyValidInput(input: InteractionPolicyInput): boolean {
  try {
    return validInput(input);
  } catch {
    return false;
  }
}

export function evaluateInteractionPolicy(input: InteractionPolicyInput): InteractionPolicyDecision {
  if (!safelyValidInput(input)) return freeze({
    action: "DEFER", defaults: [], deferredTriggerIds: [], reviewTasksCreated: 0,
    reasonCodes: ["INVALID_INTERACTION_POLICY_INPUT", "SAFE_DEFAULTS_REQUIRED"],
  });
  if (input.triggers.length === 0) return freeze({
    action: "NONE", defaults: [], deferredTriggerIds: [], reviewTasksCreated: 0,
    reasonCodes: ["NO_CONFIRMATION_TRIGGER"],
  });

  const askedTriggerIds = new Set(input.history.map((item) => item.triggerId));
  const byId = (left: InteractionTrigger, right: InteractionTrigger): number => left.triggerId < right.triggerId ? -1 : left.triggerId > right.triggerId ? 1 : 0;
  const lowUnknown = input.triggers.filter((item) => item.kind === "LOW_IMPACT_UNKNOWN").sort(byId);
  const repeated = input.triggers.filter((item) => item.kind !== "LOW_IMPACT_UNKNOWN" && askedTriggerIds.has(item.triggerId)).sort(byId);
  const eligible = input.triggers.filter((item) => item.kind !== "LOW_IMPACT_UNKNOWN" && !askedTriggerIds.has(item.triggerId)).sort(priority);
  const recentFloor = input.turnOrdinal - input.policy.questionWindowTurns + 1;
  const questionBudgetExhausted = input.history.some((item) => item.turnOrdinal >= recentFloor);

  const defaults: SafeDefaultDecision[] = [
    ...lowUnknown.map((item) => fallback(item, "LOW_IMPACT_UNKNOWN")),
    ...repeated.map((item) => fallback(item, "TRIGGER_ALREADY_ASKED")),
  ];
  if (questionBudgetExhausted || eligible.length === 0) {
    defaults.push(...eligible.map((item) => fallback(item, "QUESTION_BUDGET_EXHAUSTED")));
    return freeze({
      action: "DEFER", defaults, deferredTriggerIds: defaults.map((item) => item.triggerId), reviewTasksCreated: 0,
      reasonCodes: [
        ...(lowUnknown.length > 0 ? ["LOW_IMPACT_UNKNOWN_REMAINS_PROPOSED"] : []),
        ...(questionBudgetExhausted ? ["QUESTION_WINDOW_BUDGET_EXHAUSTED"] : []),
        ...(repeated.length > 0 ? ["TRIGGER_ALREADY_ASKED"] : []),
      ],
    });
  }

  const selected = eligible[0];
  if (selected === undefined) throw new Error("eligible confirmation unexpectedly empty");
  defaults.push(...eligible.slice(1).map((item) => fallback(item, "LOWER_PRIORITY_DEFERRED")));
  return freeze({
    action: "ASK_USER", request: request(selected, input.now), defaults,
    deferredTriggerIds: defaults.map((item) => item.triggerId), reviewTasksCreated: 0,
    reasonCodes: [
      "ONE_MICRO_CONFIRMATION_SELECTED",
      ...(lowUnknown.length > 0 ? ["LOW_IMPACT_UNKNOWN_REMAINS_PROPOSED"] : []),
      ...(eligible.length > 1 ? ["LOWER_PRIORITY_TRIGGERS_DEFERRED"] : []),
    ],
  });
}
