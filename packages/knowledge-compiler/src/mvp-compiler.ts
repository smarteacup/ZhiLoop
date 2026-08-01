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

export const DEFAULT_MVP_COMPILER_VERSION = "mvp-compiler-v1";
export const DEFAULT_MVP_PROMPT_VERSION = "mvp-extraction-prompt-v1";

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

function buildMvpResponseSchema(): Readonly<Record<string, unknown>> {
  const schema = structuredClone(schemas["knowledge-extraction-output"]) as unknown;
  if (!isRecord(schema)) throw new Error("knowledge extraction schema root is invalid");
  const definitions = schema["definitions"];
  const candidateDraft = isRecord(definitions) ? definitions["candidateDraft"] : undefined;
  const properties = isRecord(candidateDraft) ? candidateDraft["properties"] : undefined;
  const kind = isRecord(properties) ? properties["kind"] : undefined;
  if (!isRecord(kind)) throw new Error("knowledge extraction candidate kind schema is invalid");
  kind["enum"] = [...MVP_KNOWLEDGE_KINDS];
  schema["$id"] = "https://zhiloop.dev/schemas/mvp-knowledge-extraction-output/v1";
  schema["title"] = "MvpKnowledgeExtractionOutput";
  return deepFreeze(schema);
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
    const output = await this.#model.generate(request, {
      extractionKey: context.extractionKey,
      inputHash: context.inputHash,
      attempt: context.attempt,
      signal: context.signal,
    });
    const parsed = parseKnowledgeExtractionOutput(output);
    if (!parsed.ok) return output;
    if (parsed.value.candidates.some((candidate) => !MVP_KIND_SET.has(candidate.kind))) {
      throw new KnowledgeExtractionAdapterError("INVALID_OUTPUT", true, "model returned a non-MVP knowledge kind");
    }
    return output;
  }
}
