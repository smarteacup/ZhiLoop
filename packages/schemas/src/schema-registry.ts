import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type {
  EventEnvelope,
  KnowledgeAsset,
  KnowledgeCandidate,
  ContextEnvelope,
  KnowledgeExtractionOutput,
} from "@zhiloop/domain";

import eventSchema from "./json/event.schema.json" with { type: "json" };
import knowledgeAssetSchema from "./json/knowledge-asset.schema.json" with { type: "json" };
import knowledgeCandidateSchema from "./json/knowledge-candidate.schema.json" with { type: "json" };
import knowledgeExtractionOutputSchema from "./json/knowledge-extraction-output.schema.json" with { type: "json" };
import contextEnvelopeSchema from "./json/context-envelope.schema.json" with { type: "json" };

export const CURRENT_SCHEMA_VERSION = 1 as const;

export const SCHEMA_NAMES = [
  "event",
  "knowledge-candidate",
  "knowledge-extraction-output",
  "knowledge-asset",
  "context-envelope",
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export interface SchemaIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

export interface SchemaDiagnostic {
  readonly code: "SCHEMA_VALIDATION_FAILED" | "UNSUPPORTED_SCHEMA_VERSION";
  readonly schema: SchemaName;
  readonly message: string;
  readonly receivedVersion?: unknown;
  readonly issues: readonly SchemaIssue[];
}

export type ParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly extensions: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly error: SchemaDiagnostic };

export const schemas = Object.freeze({
  event: eventSchema,
  "knowledge-candidate": knowledgeCandidateSchema,
  "knowledge-extraction-output": knowledgeExtractionOutputSchema,
  "knowledge-asset": knowledgeAssetSchema,
  "context-envelope": contextEnvelopeSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true });
(addFormatsModule as unknown as (instance: Ajv) => void)(ajv);
const validators = {
  event: ajv.compile(eventSchema),
  "knowledge-candidate": ajv.compile(knowledgeCandidateSchema),
  "knowledge-extraction-output": ajv.compile(knowledgeExtractionOutputSchema),
  "knowledge-asset": ajv.compile(knowledgeAssetSchema),
  "context-envelope": ajv.compile(contextEnvelopeSchema),
} satisfies Record<SchemaName, ValidateFunction>;

function toIssues(errors: ErrorObject[] | null | undefined): readonly SchemaIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  }));
}

function parse<T>(
  schema: SchemaName,
  validator: ValidateFunction,
  input: unknown,
  knownKeys: readonly string[],
): ParseResult<T> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const receivedVersion = (input as Record<string, unknown>)["schemaVersion"];
    if (receivedVersion !== undefined && receivedVersion !== CURRENT_SCHEMA_VERSION) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_SCHEMA_VERSION",
          schema,
          message: `unsupported ${schema} schemaVersion: ${String(receivedVersion)}`,
          receivedVersion,
          issues: [],
        },
      };
    }
  }

  if (!validator(input)) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
        schema,
        message: `${schema} does not match schema version ${CURRENT_SCHEMA_VERSION}`,
        issues: toIssues(validator.errors),
      },
    };
  }

  const record = input as Record<string, unknown>;
  const known = new Set(knownKeys);
  const value = Object.fromEntries(
    knownKeys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]),
  ) as T;
  const extensions = Object.fromEntries(
    Object.entries(record).filter(([key]) => !known.has(key)),
  );

  return {
    ok: true,
    value: Object.freeze(value),
    extensions: Object.freeze(extensions),
  };
}

export function parseEventEnvelope(input: unknown): ParseResult<EventEnvelope> {
  return parse("event", validators.event, input, Object.keys(eventSchema.properties));
}

export function parseKnowledgeCandidate(input: unknown): ParseResult<KnowledgeCandidate> {
  const result = parse<KnowledgeCandidate>(
    "knowledge-candidate",
    validators["knowledge-candidate"],
    input,
    Object.keys(knowledgeCandidateSchema.properties),
  );
  if (!result.ok) return result;

  const mismatchIndex = result.value.assertions.findIndex(
    (assertion) => assertion.candidateId !== result.value.candidateId,
  );
  if (mismatchIndex >= 0) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
        schema: "knowledge-candidate",
        message: "knowledge-candidate contains an assertion for another candidate",
        issues: [
          {
            instancePath: `/assertions/${mismatchIndex}/candidateId`,
            keyword: "candidateIdMatch",
            message: "must match the enclosing candidateId",
          },
        ],
      },
    };
  }

  return result;
}

export function parseKnowledgeExtractionOutput(input: unknown): ParseResult<KnowledgeExtractionOutput> {
  return parse(
    "knowledge-extraction-output",
    validators["knowledge-extraction-output"],
    input,
    Object.keys(knowledgeExtractionOutputSchema.properties),
  );
}

export function parseKnowledgeAsset(input: unknown): ParseResult<KnowledgeAsset> {
  return parse(
    "knowledge-asset",
    validators["knowledge-asset"],
    input,
    Object.keys(knowledgeAssetSchema.properties),
  );
}

export function parseContextEnvelope(input: unknown): ParseResult<ContextEnvelope> {
  return parse(
    "context-envelope",
    validators["context-envelope"],
    input,
    Object.keys(contextEnvelopeSchema.properties),
  );
}
