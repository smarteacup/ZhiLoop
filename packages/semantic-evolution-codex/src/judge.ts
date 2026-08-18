import { createHash } from "node:crypto";

import type {
  EvolutionSemanticJudgment,
  EvolutionSemanticRequest,
  KnowledgeEvolutionSemanticPort,
} from "@zhiloop/knowledge-evolution";
import type {
  CodexExecJsonGenerationPort,
  CodexExecJsonGenerationRequest,
} from "@zhiloop/model-codex-exec";

const ACTIONS = ["SUPPLEMENT", "SUPERSEDE", "CONTRADICT", "SCOPE_SPLIT", "SKIP"] as const;
const MAX_TARGETS = 5;
const MAX_ASSERTIONS = 100;
const MAX_SOURCE_IDS = 100;
const PROMPT_VERSION = "semantic-evolution-v1";

export type SemanticEvolutionCapabilityStatus = "READY" | "DEGRADED";

export interface SemanticEvolutionCapability {
  readonly status: SemanticEvolutionCapabilityStatus;
  readonly reasonCode: "SEMANTIC_EVOLUTION_READY" | "SEMANTIC_EVOLUTION_INVALID_OUTPUT" | "SEMANTIC_EVOLUTION_UNAVAILABLE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function unique(values: readonly string[], maximum: number): readonly string[] {
  return Object.freeze([...new Set(values)].filter((value) => value.trim().length > 0).sort((a, b) => a.localeCompare(b, "en")).slice(0, maximum));
}

export function semanticEvolutionInput(request: EvolutionSemanticRequest): Readonly<Record<string, unknown>> {
  if (request.targets.length < 1 || request.targets.length > MAX_TARGETS) throw new Error("SEMANTIC_EVOLUTION_TARGET_LIMIT");
  const candidate = request.candidate;
  return Object.freeze({
    schemaVersion: 1,
    candidate: Object.freeze({
      candidateId: candidate.candidateId,
      subjectKey: candidate.subjectKey,
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      scopeHint: candidate.scopeHint,
      assertions: Object.freeze(candidate.assertions.slice(0, MAX_ASSERTIONS).map((assertion) => Object.freeze({
        assertionId: assertion.assertionId,
        kind: assertion.kind,
        parameters: assertion.parameters,
      }))),
      sourceIds: unique([
        ...candidate.sourceEpisodes,
        ...candidate.evidenceHints.map((hint) => hint.sourceRef),
      ], MAX_SOURCE_IDS),
    }),
    proposedScope: request.proposedScope,
    targets: Object.freeze(request.targets.map((target) => Object.freeze({
      id: target.id,
      version: target.version,
      subjectKey: target.subjectKey,
      kind: target.kind,
      scope: target.scope,
      status: target.status,
      title: target.title,
      summary: target.summary,
      aliases: unique(target.aliases, 100),
      symbols: unique(target.symbols, 100),
      evidenceIds: unique(target.evidence.map((evidence) => evidence.evidenceId), MAX_SOURCE_IDS),
    }))),
    allowedActions: ACTIONS,
    deterministicReasons: unique(request.deterministicReasons, 100),
  });
}

function responseSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS },
      targetKnowledgeVersions: {
        type: "array", minItems: 1, maxItems: MAX_TARGETS,
        items: {
          type: "object",
          properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } },
          required: ["id", "version"], additionalProperties: false,
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    required: ["action", "targetKnowledgeVersions", "confidence", "reason"],
    additionalProperties: false,
  });
}

function parse(value: unknown): EvolutionSemanticJudgment {
  if (!isRecord(value) || Object.keys(value).some((key) => !["action", "targetKnowledgeVersions", "confidence", "reason"].includes(key))) {
    throw new Error("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
  }
  const action = value["action"];
  const confidence = value["confidence"];
  const reason = value["reason"];
  const targets = value["targetKnowledgeVersions"];
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)
    || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
    || typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1_000 || /[\0\r\n]/u.test(reason)
    || !Array.isArray(targets) || targets.length < 1 || targets.length > MAX_TARGETS) {
    throw new Error("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
  }
  const parsed = targets.map((target) => {
    if (!isRecord(target) || Object.keys(target).some((key) => !["id", "version"].includes(key))
      || typeof target["id"] !== "string" || target["id"].trim().length === 0 || target["id"].length > 500
      || !Number.isSafeInteger(target["version"]) || (target["version"] as number) < 1) {
      throw new Error("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
    }
    return Object.freeze({ id: target["id"] as string, version: target["version"] as number });
  });
  if (new Set(parsed.map((target) => `${target.id}@${target.version}`)).size !== parsed.length) {
    throw new Error("SEMANTIC_EVOLUTION_INVALID_OUTPUT");
  }
  return Object.freeze({
    action: action as EvolutionSemanticJudgment["action"],
    targetKnowledgeVersions: Object.freeze(parsed),
    confidence,
    reason,
  });
}

export class CodexSemanticEvolutionJudge implements KnowledgeEvolutionSemanticPort {
  readonly #model: CodexExecJsonGenerationPort;
  #capability: SemanticEvolutionCapability = Object.freeze({ status: "READY", reasonCode: "SEMANTIC_EVOLUTION_READY" });

  constructor(model: CodexExecJsonGenerationPort) {
    if (typeof model.generateStructured !== "function") throw new Error("SEMANTIC_EVOLUTION_MODEL_INVALID");
    this.#model = model;
  }

  capability(): SemanticEvolutionCapability { return this.#capability; }

  async arbitrate(request: EvolutionSemanticRequest): Promise<EvolutionSemanticJudgment> {
    const input = semanticEvolutionInput(request);
    const runKey = `semantic-${createHash("sha256").update(canonical(input)).digest("hex")}`;
    const generation: CodexExecJsonGenerationRequest = {
      operation: "SEMANTIC_EVOLUTION",
      promptVersion: PROMPT_VERSION,
      trustedInstructions: [
        "Choose exactly one allowed evolution action using only the supplied summaries and assertions.",
        "Reference only supplied target versions. Never infer a wider scope or publication authority.",
        "If evidence is ambiguous, choose SKIP only when content is equivalent; otherwise use the closest non-publishing relation.",
      ].join(" "),
      untrustedInput: input,
      responseSchema: responseSchema(),
    };
    try {
      const result = parse(await this.#model.generateStructured(generation, {
        runKey,
        attempt: 1,
        signal: new AbortController().signal,
      }));
      this.#capability = Object.freeze({ status: "READY", reasonCode: "SEMANTIC_EVOLUTION_READY" });
      return result;
    } catch (error) {
      const invalidOutput = (error instanceof Error && error.message === "SEMANTIC_EVOLUTION_INVALID_OUTPUT")
        || (isRecord(error) && error["code"] === "INVALID_OUTPUT");
      this.#capability = Object.freeze({
        status: "DEGRADED",
        reasonCode: invalidOutput
          ? "SEMANTIC_EVOLUTION_INVALID_OUTPUT" : "SEMANTIC_EVOLUTION_UNAVAILABLE",
      });
      throw error;
    }
  }
}
