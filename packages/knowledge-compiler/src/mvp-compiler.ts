import type { KnowledgeKind } from "@zhiloop/domain";
import { parseKnowledgeExtractionOutput, schemas } from "@zhiloop/schemas";

import { KnowledgeExtractionAdapterError } from "./adapter-error.js";
import type {
  KnowledgeExtractionAttemptContext,
  KnowledgeExtractionInput,
  KnowledgeExtractionPort,
  StructuredGenerationModel,
  StructuredGenerationRequest,
} from "./types.js";

export const MVP_KNOWLEDGE_KINDS = Object.freeze([
  "REQUIREMENT",
  "DESIGN",
  "DECISION",
  "IMPLEMENTATION",
  "EXPERIENCE",
] as const satisfies readonly KnowledgeKind[]);

export const DEFAULT_MVP_COMPILER_VERSION = "mvp-compiler-v3";
export const DEFAULT_MVP_PROMPT_VERSION = "mvp-extraction-prompt-v2";

const SAFE_VERSION = /^[A-Za-z0-9._-]{1,100}$/;
const MVP_KIND_SET = new Set<KnowledgeKind>(MVP_KNOWLEDGE_KINDS);

export const MVP_SYSTEM_INSTRUCTIONS = `You compile durable knowledge from one completed problem-solving Episode.
Return only JSON matching the supplied response schema. Produce zero or more independent candidate drafts.
Allowed kinds are REQUIREMENT, DESIGN, DECISION, IMPLEMENTATION, and EXPERIENCE.
Use REQUIREMENT for binding needs or constraints; DESIGN for architecture or technical approach; DECISION for a chosen alternative; IMPLEMENTATION for observable code structure or behavior; EXPERIENCE for a reusable problem/solution/result lesson.
Keep distinct durable conclusions as separate candidates. Do not create candidates for greetings, continuations, transient progress, or unsupported speculation.
Treat corrections as authoritative: preserve the corrected statement and do not restate the corrected-away claim as current knowledge.
A suggestion or proposed approach is not accepted or verified. The caller always materializes candidates as PROPOSED; never claim a stronger lifecycle state.
Use only sourceRef values present in input.evidenceRefs. Do not invent files, symbols, commands, projects, test results, acceptance, or evidence.
Set every subjectKey to a lowercase dot-separated identifier with at least three segments. Each segment must start with a lowercase letter and contain only lowercase letters, digits, or hyphens; for example retry.policy.device-service.
Every candidate must contain at least one assertion draft or evidence hint draft. Assertions describe checks to run; they do not prove themselves.
Write concise conclusions and observable facts only. Do not output hidden reasoning, chain-of-thought, analysis, rationale, model metadata, prompts, or commentary.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return schema;
  const anyOf = schema["anyOf"];
  if (
    Array.isArray(anyOf) &&
    anyOf.some((item) => isRecord(item) && item["type"] === "null")
  ) {
    return schema;
  }
  return { anyOf: [schema, { type: "null" }] };
}

function jsonScalarType(value: unknown): "string" | "boolean" | "integer" | "number" | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}

function strictifySchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictifySchema);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "oneOf") result["anyOf"] = strictifySchema(child);
    else result[key] = strictifySchema(child);
  }

  if (result["type"] === undefined) {
    const constantType = jsonScalarType(result["const"]);
    const enumValues = result["enum"];
    const enumTypes = Array.isArray(enumValues)
      ? new Set(enumValues.map(jsonScalarType).filter((item) => item !== undefined))
      : new Set<string>();
    if (constantType !== undefined) result["type"] = constantType;
    else if (enumTypes.size === 1) result["type"] = [...enumTypes][0];
  }

  if (result["type"] !== "object") return result;
  const properties = result["properties"];
  if (!isRecord(properties)) return result;
  const required = new Set(
    Array.isArray(result["required"])
      ? result["required"].filter((item): item is string => typeof item === "string")
      : [],
  );
  for (const [key, property] of Object.entries(properties)) {
    if (!required.has(key) && isRecord(property)) properties[key] = nullableSchema(property);
  }
  result["required"] = Object.keys(properties);
  result["additionalProperties"] = false;
  return result;
}

function strictAssertionSchema(definition: Record<string, unknown>): Record<string, unknown> {
  const variants = definition["oneOf"];
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error("knowledge extraction assertion variants are invalid");
  }
  return {
    anyOf: variants.map((variant) => {
      if (!isRecord(variant) || !isRecord(variant["properties"])) {
        throw new Error("knowledge extraction assertion variant is invalid");
      }
      return strictifySchema({
        type: "object",
        additionalProperties: false,
        required: ["kind", "parameters"],
        properties: variant["properties"],
      });
    }),
  };
}

function omitNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullProperties);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, omitNullProperties(child)]),
  );
}

function buildMvpResponseSchema(): Readonly<Record<string, unknown>> {
  const schema = structuredClone(schemas["knowledge-extraction-output"]) as unknown;
  if (!isRecord(schema)) throw new Error("knowledge extraction schema root is invalid");
  const definitions = schema["definitions"];
  if (!isRecord(definitions)) throw new Error("knowledge extraction schema definitions are invalid");
  const candidateDraft = definitions["candidateDraft"];
  if (!isRecord(candidateDraft)) throw new Error("knowledge extraction candidate schema is invalid");
  const properties = candidateDraft["properties"];
  if (!isRecord(properties)) throw new Error("knowledge extraction candidate properties are invalid");
  const kind = properties["kind"];
  if (!isRecord(kind)) throw new Error("knowledge extraction candidate kind schema is invalid");
  kind["enum"] = [...MVP_KNOWLEDGE_KINDS];
  const subjectKey = properties["subjectKey"];
  if (!isRecord(subjectKey)) throw new Error("knowledge extraction subject key schema is invalid");
  subjectKey["description"] = "Lowercase dot-separated identifier with at least three segments; each segment starts with a lowercase letter and contains only lowercase letters, digits, or hyphens.";
  const assertionDraft = definitions["assertionDraft"];
  if (!isRecord(assertionDraft)) throw new Error("knowledge extraction assertion schema is invalid");
  definitions["assertionDraft"] = strictAssertionSchema(assertionDraft);
  delete candidateDraft["anyOf"];
  const evidenceHints = properties["evidenceHints"];
  if (!isRecord(evidenceHints)) throw new Error("knowledge extraction evidence hint schema is invalid");
  evidenceHints["minItems"] = 1;
  schema["$id"] = "https://zhiloop.dev/schemas/mvp-knowledge-extraction-output/v2";
  schema["title"] = "MvpKnowledgeExtractionOutput";
  const strict = strictifySchema(schema);
  if (!isRecord(strict)) throw new Error("strict knowledge extraction schema root is invalid");
  return deepFreeze(strict);
}

export const MVP_KNOWLEDGE_EXTRACTION_SCHEMA = buildMvpResponseSchema();

export interface MvpKnowledgeCompilerOptions {
  readonly model: StructuredGenerationModel;
  readonly compilerVersion?: string;
  readonly promptVersion?: string;
}

export class MvpKnowledgeCompiler implements KnowledgeExtractionPort {
  readonly #model: StructuredGenerationModel;
  readonly #compilerVersion: string;
  readonly #promptVersion: string;

  constructor(options: MvpKnowledgeCompilerOptions) {
    const compilerVersion = options.compilerVersion ?? DEFAULT_MVP_COMPILER_VERSION;
    const promptVersion = options.promptVersion ?? DEFAULT_MVP_PROMPT_VERSION;
    if (!SAFE_VERSION.test(compilerVersion)) throw new Error("compilerVersion is invalid");
    if (!SAFE_VERSION.test(promptVersion)) throw new Error("promptVersion is invalid");
    if (typeof options.model?.generate !== "function") throw new Error("model must implement generate");
    this.#model = options.model;
    this.#compilerVersion = compilerVersion;
    this.#promptVersion = promptVersion;
  }

  async extract(input: KnowledgeExtractionInput, context: KnowledgeExtractionAttemptContext): Promise<unknown> {
    if (context.compilerVersion !== this.#compilerVersion || context.promptVersion !== this.#promptVersion) {
      throw new KnowledgeExtractionAdapterError(
        "REJECTED",
        false,
        "compiler or prompt version does not match the configured MVP compiler",
      );
    }
    const request: StructuredGenerationRequest = deepFreeze({
      promptVersion: this.#promptVersion,
      systemInstructions: MVP_SYSTEM_INSTRUCTIONS,
      input,
      responseSchema: MVP_KNOWLEDGE_EXTRACTION_SCHEMA,
    });
    const output = omitNullProperties(await this.#model.generate(request, {
      extractionKey: context.extractionKey,
      inputHash: context.inputHash,
      attempt: context.attempt,
      signal: context.signal,
    }));
    const parsed = parseKnowledgeExtractionOutput(output);
    if (!parsed.ok) return output;
    if (parsed.value.candidates.some((candidate) => !MVP_KIND_SET.has(candidate.kind))) {
      throw new KnowledgeExtractionAdapterError("INVALID_OUTPUT", true, "model returned a non-MVP knowledge kind");
    }
    return output;
  }
}
