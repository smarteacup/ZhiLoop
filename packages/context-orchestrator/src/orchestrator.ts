import { Buffer } from "node:buffer";

import type { InjectionPolicy } from "@zhiloop/config";
import type {
  ContextAuthority,
  ContextComplexityLevel,
  ContextEnvelope,
  ContextEnvelopeItem,
  TaskContractBlock,
} from "@zhiloop/domain";
import { CONTEXT_COMPLEXITY_LEVELS } from "@zhiloop/domain";
import type { RerankedKnowledge } from "@zhiloop/knowledge-reranker";
import type { QueryContext } from "@zhiloop/query-context";
import { parseContextEnvelope } from "@zhiloop/schemas";

import type { ContextOrchestrationRequest, ContextOrchestratorPort } from "./types.js";

const ELIGIBLE_STATUSES = new Set(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);
const LEVEL_ORDER: readonly ContextComplexityLevel[] = [
  "L0_NONE", "L1_POINTER", "L2_COMPACT", "L3_EVIDENCED", "L4_EPISODE",
];

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function text(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function sentence(value: string): string {
  const normalized = value.trim();
  const match = /^(.{1,300}?[.!?。！？])(?:\s|$)/u.exec(normalized);
  return (match?.[1] ?? normalized.slice(0, 300)).trim();
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3));
}

function authority(item: RerankedKnowledge): ContextAuthority {
  if (item.asset.kind === "RULE" || item.asset.kind === "REQUIREMENT") return "BINDING_RULE";
  if (item.asset.kind === "DECISION") return "ACCEPTED_DECISION";
  if (item.asset.kind === "FACT" && item.asset.status === "VERIFIED") return "VERIFIED_FACT";
  return "REFERENCE";
}

function scopeScore(item: RerankedKnowledge, context: QueryContext): number {
  const scope = item.asset.scope;
  switch (scope.level) {
    case "TASK": return scope.taskId === context.taskId ? 7 : 0;
    case "SYMBOL": return scope.symbols.some((symbol) => context.symbols.some((term) => term.canonical === symbol)) ? 6 : 4;
    case "MODULE": return scope.modulePaths.some((modulePath) => context.paths.some((term) => (
      term.canonical === modulePath || term.canonical.startsWith(`${modulePath}/`)
    ))) ? 5 : 4;
    case "PROJECT": return 4;
    case "USER": return 3;
    case "TEAM": return 2;
    case "GLOBAL": return 1;
  }
}

function statusScore(status: RerankedKnowledge["asset"]["status"]): number {
  return status === "VERIFIED" ? 3 : status === "IMPLEMENTED" ? 2 : status === "ACCEPTED" ? 1 : 0;
}

function prioritize(
  candidates: readonly RerankedKnowledge[],
  context: QueryContext,
  policy: InjectionPolicy,
): RerankedKnowledge[] {
  const authorityScore = new Map(policy.authorityOrder.map((value, index) => [value, policy.authorityOrder.length - index]));
  return [...candidates].sort((left, right) => (
    scopeScore(right, context) - scopeScore(left, context)
    || statusScore(right.asset.status) - statusScore(left.asset.status)
    || (authorityScore.get(authority(right)) ?? 0) - (authorityScore.get(authority(left)) ?? 0)
    || left.rank - right.rank
    || left.asset.id.localeCompare(right.asset.id)
  ));
}

function itemFor(value: RerankedKnowledge, level: Exclude<ContextComplexityLevel, "L0_NONE">): ContextEnvelopeItem {
  const common = {
    id: value.asset.id,
    version: value.asset.version,
    subjectKey: value.asset.subjectKey,
    kind: value.asset.kind,
    status: value.asset.status,
    scope: structuredClone(value.asset.scope),
    authority: authority(value),
    detailLevel: level,
    title: text(value.asset.title, 500),
    summary: sentence(value.asset.summary),
    retrievalRank: value.rank,
  } as const;
  if (level === "L1_POINTER") return common;
  const boundaries = {
    applicability: value.asset.applicability.slice(0, 50).map((item) => text(item, 1_000)),
    failurePaths: value.asset.nonApplicability.slice(0, 50).map((item) => text(item, 1_000)),
    symbols: value.asset.symbols.slice(0, 100).map((item) => text(item, 1_000)),
  };
  if (level === "L2_COMPACT") return {
    ...common,
    ...boundaries,
    evidencePointers: [...new Set(value.asset.evidence.slice(0, 100).map((item) => item.evidenceId))],
  };
  const evidenced = {
    ...common,
    ...boundaries,
    content: value.asset.body.slice(0, 100_000),
    evidenceSummary: value.asset.evidence.slice(0, 100).map((item) => ({ ...item })),
  };
  if (level === "L3_EVIDENCED") return evidenced;
  return { ...evidenced, sourceEpisodes: [...new Set(value.asset.sourceEpisodes.slice(0, 100))] };
}

function maxItems(level: ContextComplexityLevel, policy: InjectionPolicy): number {
  if (level === "L0_NONE") return 0;
  if (level === "L4_EPISODE") return policy.levels.L3_EVIDENCED.maxItems;
  return policy.levels[level].maxItems;
}

function levelProperties(level: ContextComplexityLevel): {
  readonly depth: ContextEnvelope["complexity"]["depth"];
  readonly evidence: ContextEnvelope["complexity"]["evidence"];
} {
  switch (level) {
    case "L0_NONE": return { depth: "NONE", evidence: "NONE" };
    case "L1_POINTER": return { depth: "POINTER", evidence: "NONE" };
    case "L2_COMPACT": return { depth: "COMPACT", evidence: "POINTER" };
    case "L3_EVIDENCED": return { depth: "EVIDENCED", evidence: "SUMMARY" };
    case "L4_EPISODE": return { depth: "EPISODE", evidence: "EPISODE" };
  }
}

function chooseLevel(
  request: ContextOrchestrationRequest,
  reasons: Set<string>,
  hasEligibleCandidates: boolean,
): ContextComplexityLevel {
  if (!hasEligibleCandidates) {
    reasons.add("NO_RETRIEVED_KNOWLEDGE");
    return "L0_NONE";
  }
  let level = request.requestedLevel ?? request.feedback?.preferredLevel ?? request.policy.defaultLevel;
  reasons.add(request.requestedLevel !== undefined
    ? "REQUESTED_COMPLEXITY_LEVEL"
    : request.feedback !== undefined ? "FEEDBACK_COMPLEXITY_LEVEL" : "DEFAULT_COMPLEXITY_LEVEL");
  if (request.requestedLevel === undefined && request.feedback !== undefined) {
    for (const reason of request.feedback.reasonCodes) reasons.add(reason);
  }
  const automatic = request.automatic ?? true;
  if (level === "L4_EPISODE" && (automatic || request.explicitEpisodeExpansion !== true)) {
    level = "L3_EVIDENCED";
    reasons.add("L4_AUTOMATIC_FORBIDDEN");
  }
  if ((request.signals?.risk === "HIGH" || request.signals?.ambiguous === true || request.signals?.conflicting === true)
    && LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf("L3_EVIDENCED")) {
    level = "L3_EVIDENCED";
    reasons.add("RISK_REQUIRES_EVIDENCED_CONTEXT");
  }
  return level;
}

function contract(value: TaskContractBlock | undefined): TaskContractBlock | undefined {
  if (value === undefined) return undefined;
  if (!validText(value.contractId, 500) || !validText(value.objective, 2_000)
    || value.gates.length > 20 || value.boundaries.length > 20
    || ![...value.gates, ...value.boundaries].every((item) => validText(item, 1_000))) {
    throw new Error("taskContract is invalid");
  }
  return structuredClone(value);
}

function authoritySummary(items: readonly ContextEnvelopeItem[]): ContextEnvelope["complexity"]["authority"] {
  const values = [...new Set(items.map((item) => item.authority))];
  return values.length === 0 ? "NONE" : values.length === 1 ? values[0] as ContextAuthority : "MIXED";
}

function draftEnvelope(
  request: ContextOrchestrationRequest,
  level: ContextComplexityLevel,
  reasons: Set<string>,
  maxTokens: number,
  items: readonly ContextEnvelopeItem[],
  taskContract: TaskContractBlock | undefined,
  truncated: boolean,
): ContextEnvelope {
  const properties = levelProperties(level);
  const base = {
    schemaVersion: 1 as const,
    runId: request.runId,
    ...(request.queryContext.project === undefined ? {} : { projectId: request.queryContext.project.projectId }),
    ...(request.queryContext.taskId === undefined ? {} : { taskId: request.queryContext.taskId }),
    complexity: {
      level,
      breadth: items.length,
      depth: properties.depth,
      authority: authoritySummary(items),
      evidence: properties.evidence,
      reasonCodes: [...reasons],
    },
    budget: { maxTokens, estimatedTokens: 1, truncated },
    items,
    ...(taskContract === undefined ? {} : { taskContract }),
  };
  let estimatedTokens = estimateTokens(base);
  let envelope: ContextEnvelope = { ...base, budget: { ...base.budget, estimatedTokens } };
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const next = estimateTokens(envelope);
    if (next === estimatedTokens) break;
    estimatedTokens = next;
    envelope = { ...envelope, budget: { ...envelope.budget, estimatedTokens } };
  }
  return envelope;
}

export class ContextOrchestrator implements ContextOrchestratorPort {
  orchestrate(request: ContextOrchestrationRequest): ContextEnvelope {
    if (!validText(request.runId, 500)) throw new Error("runId is invalid");
    if (request.requestedLevel !== undefined && !CONTEXT_COMPLEXITY_LEVELS.includes(request.requestedLevel)) {
      throw new Error("requestedLevel is invalid");
    }
    const expectedFeedbackScopeKey = request.queryContext.taskId !== undefined
      ? JSON.stringify({ level: "TASK", ...(request.queryContext.project === undefined ? {} : { projectId: request.queryContext.project.projectId }), taskId: request.queryContext.taskId })
      : request.queryContext.project === undefined
        ? JSON.stringify({ level: "GLOBAL" })
        : JSON.stringify({ level: "PROJECT", projectId: request.queryContext.project.projectId });
    if (request.feedback !== undefined && (request.feedback.scopeKey !== expectedFeedbackScopeKey
      || !["L1_POINTER", "L2_COMPACT", "L3_EVIDENCED"].includes(request.feedback.preferredLevel)
      || !Number.isSafeInteger(request.feedback.sampleCount) || request.feedback.sampleCount < 0
      || request.feedback.reasonCodes.length < 1 || request.feedback.reasonCodes.length > 10
      || !request.feedback.reasonCodes.every((reason) => /^[A-Z][A-Z0-9_]{0,99}$/u.test(reason))
      || (request.feedback.preferredLevel === "L1_POINTER"
        && (request.feedback.sampleCount < 2 || !request.feedback.reasonCodes.includes("IRRELEVANT_FEEDBACK_REDUCED_DEPTH")))
      || (request.feedback.preferredLevel === "L3_EVIDENCED"
        && (request.feedback.sampleCount < 3 || !request.feedback.reasonCodes.includes("RELEVANT_AND_USED_FEEDBACK_INCREASED_DEPTH"))))) {
      throw new Error("feedback hint is invalid");
    }
    const maxTokens = Math.min(request.maxTokens ?? request.policy.defaultMaxTokens, request.policy.defaultMaxTokens);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4_000) throw new Error("maxTokens is invalid");
    const reasons = new Set<string>();
    const eligibleCandidates = request.candidates.filter((item) => (
      item.scopeMatched && ELIGIBLE_STATUSES.has(item.asset.status)
    ));
    let level = chooseLevel(request, reasons, eligibleCandidates.length > 0);
    let selected: ContextEnvelopeItem[] = [];
    let truncated = false;
    const candidates = prioritize(eligibleCandidates, request.queryContext, request.policy);
    if (candidates.length !== request.candidates.length) reasons.add("INELIGIBLE_CANDIDATE_IGNORED");

    const select = (selectedLevel: Exclude<ContextComplexityLevel, "L0_NONE">): ContextEnvelopeItem[] => {
      const output: ContextEnvelopeItem[] = [];
      for (const candidate of candidates.slice(0, maxItems(selectedLevel, request.policy))) {
        const next = [...output, itemFor(candidate, selectedLevel)];
        const trial = draftEnvelope(request, selectedLevel, reasons, maxTokens, next, undefined, false);
        if (trial.budget.estimatedTokens > maxTokens) {
          truncated = true;
          break;
        }
        output.push(next.at(-1) as ContextEnvelopeItem);
      }
      if (candidates.length > output.length) truncated = true;
      return output;
    };

    if (level !== "L0_NONE") selected = select(level);
    if (level !== "L0_NONE" && candidates.length > 0 && selected.length === 0 && level !== "L1_POINTER") {
      level = "L1_POINTER";
      reasons.add("TOKEN_BUDGET_LEVEL_DOWNGRADE");
      selected = select("L1_POINTER");
    }
    if (level !== "L0_NONE" && candidates.length > 0 && selected.length === 0) {
      level = "L0_NONE";
      reasons.add("TOKEN_BUDGET_EXHAUSTED");
    }

    let taskContract = contract(request.taskContract);
    if (taskContract !== undefined) {
      if (candidates.length > 0 && selected.length === 0) {
        taskContract = undefined;
        reasons.add("TASK_CONTRACT_OMITTED_FOR_DYNAMIC_KNOWLEDGE");
        truncated = true;
      } else {
        const trial = draftEnvelope(request, level, reasons, maxTokens, selected, taskContract, truncated);
        if (trial.budget.estimatedTokens > maxTokens) {
          taskContract = undefined;
          reasons.add("TASK_CONTRACT_OMITTED_BY_BUDGET");
          truncated = true;
        }
      }
    }

    let envelope = draftEnvelope(request, level, reasons, maxTokens, selected, taskContract, truncated);
    if (envelope.budget.estimatedTokens > maxTokens && taskContract === undefined
      && reasons.has("TASK_CONTRACT_OMITTED_BY_BUDGET")) {
      reasons.delete(request.requestedLevel !== undefined
        ? "REQUESTED_COMPLEXITY_LEVEL"
        : request.feedback !== undefined ? "FEEDBACK_COMPLEXITY_LEVEL" : "DEFAULT_COMPLEXITY_LEVEL");
      envelope = draftEnvelope(request, level, reasons, maxTokens, selected, undefined, truncated);
    }
    while (envelope.budget.estimatedTokens > maxTokens && selected.length > 0) {
      selected = selected.slice(0, -1);
      truncated = true;
      reasons.add("TOKEN_BUDGET_TRUNCATED");
      envelope = draftEnvelope(request, selected.length === 0 ? "L0_NONE" : level, reasons, maxTokens, selected, undefined, truncated);
    }
    if (envelope.budget.estimatedTokens > maxTokens) throw new Error("ContextEnvelope metadata exceeds token budget");
    const parsed = parseContextEnvelope(envelope);
    if (!parsed.ok) throw new Error(`ContextEnvelope failed schema validation: ${parsed.error.issues[0]?.instancePath ?? "$"}`);
    return freeze(structuredClone(parsed.value));
  }
}
