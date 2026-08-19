import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type {
  ClosureVerificationResult,
  ConfirmationRequest,
  ConfirmationResolution,
  EventEnvelope,
  KnowledgeAsset,
  KnowledgeCandidate,
  ContextEnvelope,
  KnowledgeExtractionOutput,
} from "@zhiloop/domain";
import {
  CONFIRMATION_EFFECTS_BY_KIND,
  CONFIRMATION_RELATION_BY_EFFECT,
  SAFE_CONFIRMATION_EFFECT_BY_KIND,
  validateKnowledgeLocator,
} from "@zhiloop/domain";

import eventSchema from "./json/event.schema.json" with { type: "json" };
import knowledgeAssetSchema from "./json/knowledge-asset.schema.json" with { type: "json" };
import knowledgeCandidateSchema from "./json/knowledge-candidate.schema.json" with { type: "json" };
import knowledgeExtractionOutputSchema from "./json/knowledge-extraction-output.schema.json" with { type: "json" };
import contextEnvelopeSchema from "./json/context-envelope.schema.json" with { type: "json" };
import closureVerificationResultSchema from "./json/closure-verification-result.schema.json" with { type: "json" };
import confirmationRequestSchema from "./json/confirmation-request.schema.json" with { type: "json" };
import confirmationResolutionSchema from "./json/confirmation-resolution.schema.json" with { type: "json" };

export const CURRENT_SCHEMA_VERSION = 1 as const;
const SUPPORTED_SCHEMA_VERSIONS: Readonly<Partial<Record<SchemaName, readonly number[]>>> = Object.freeze({
  "knowledge-candidate": [1, 2],
  "knowledge-asset": [1, 2],
});

export const SCHEMA_NAMES = [
  "event",
  "knowledge-candidate",
  "knowledge-extraction-output",
  "knowledge-asset",
  "context-envelope",
  "closure-verification-result",
  "confirmation-request",
  "confirmation-resolution",
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
  "closure-verification-result": closureVerificationResultSchema,
  "confirmation-request": confirmationRequestSchema,
  "confirmation-resolution": confirmationResolutionSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true });
(addFormatsModule as unknown as (instance: Ajv) => void)(ajv);
const validators = {
  event: ajv.compile(eventSchema),
  "knowledge-candidate": ajv.compile(knowledgeCandidateSchema),
  "knowledge-extraction-output": ajv.compile(knowledgeExtractionOutputSchema),
  "knowledge-asset": ajv.compile(knowledgeAssetSchema),
  "context-envelope": ajv.compile(contextEnvelopeSchema),
  "closure-verification-result": ajv.compile(closureVerificationResultSchema),
  "confirmation-request": ajv.compile(confirmationRequestSchema),
  "confirmation-resolution": ajv.compile(confirmationResolutionSchema),
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
    const supportedVersions = SUPPORTED_SCHEMA_VERSIONS[schema] ?? [CURRENT_SCHEMA_VERSION];
    if (receivedVersion !== undefined && !supportedVersions.includes(receivedVersion as number)) {
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

  if (result.value.schemaVersion === 2 && (
    result.value.claimMode === undefined
    || result.value.locator === undefined
    || !validateKnowledgeLocator(result.value.locator).valid
  )) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
        schema: "knowledge-candidate",
        message: "knowledge-candidate has an invalid v2 locator",
        issues: [{ instancePath: "/locator", keyword: "locatorIntegrity", message: "must match authoritative locator invariants" }],
      },
    };
  }

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
  const result = parse<KnowledgeAsset>(
    "knowledge-asset",
    validators["knowledge-asset"],
    input,
    Object.keys(knowledgeAssetSchema.properties),
  );
  if (!result.ok) return result;
  if (result.value.schemaVersion === 2 && (
    result.value.claimMode === undefined
    || result.value.locator === undefined
    || !validateKnowledgeLocator(result.value.locator).valid
  )) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
        schema: "knowledge-asset",
        message: "knowledge-asset has an invalid v2 locator",
        issues: [{ instancePath: "/locator", keyword: "locatorIntegrity", message: "must match authoritative locator invariants" }],
      },
    };
  }
  return result;
}

export function parseContextEnvelope(input: unknown): ParseResult<ContextEnvelope> {
  return parse(
    "context-envelope",
    validators["context-envelope"],
    input,
    Object.keys(contextEnvelopeSchema.properties),
  );
}

export function parseClosureVerificationResult(input: unknown): ParseResult<ClosureVerificationResult> {
  return parse(
    "closure-verification-result",
    validators["closure-verification-result"],
    input,
    Object.keys(closureVerificationResultSchema.properties),
  );
}

export function parseConfirmationRequest(input: unknown): ParseResult<ConfirmationRequest> {
  const result = parse<ConfirmationRequest>(
    "confirmation-request",
    validators["confirmation-request"],
    input,
    Object.keys(confirmationRequestSchema.properties),
  );
  if (!result.ok) return result;
  const optionIds = result.value.options.map((item) => item.optionId);
  const effects = result.value.options.map((item) => item.effect);
  const allowedEffects = CONFIRMATION_EFFECTS_BY_KIND[result.value.kind];
  const selected = result.value.options.find((item) => item.optionId === result.value.safeDefaultOptionId);
  if (new Set(optionIds).size !== optionIds.length
    || new Set(effects).size !== effects.length
    || effects.length !== allowedEffects.length
    || allowedEffects.some((effect) => !effects.includes(effect))
    || selected?.effect !== SAFE_CONFIRMATION_EFFECT_BY_KIND[result.value.kind]) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
        schema: "confirmation-request",
        message: "confirmation-request has an invalid or unsafe default option",
        issues: [{
          instancePath: "/safeDefaultOptionId",
          keyword: "safeDefault",
          message: "must select the unique conservative option for the confirmation kind",
        }],
      },
    };
  }
  return result;
}

export function parseConfirmationResolution(input: unknown): ParseResult<ConfirmationResolution> {
  const result = parse<ConfirmationResolution>(
    "confirmation-resolution",
    validators["confirmation-resolution"],
    input,
    Object.keys(confirmationResolutionSchema.properties),
  );
  if (!result.ok) return result;
  const relationIds = result.value.relations.map((item) => item.subjectId);
  const expectedRelation = result.value.responseKind === "CORRECTION"
    ? "CORRECTS"
    : CONFIRMATION_RELATION_BY_EFFECT[result.value.effect];
  if (new Set(relationIds).size !== relationIds.length
    || relationIds.length !== result.value.subjectIds.length
    || result.value.subjectIds.some((id) => !relationIds.includes(id))
    || result.value.relations.some((item) => item.relation !== expectedRelation)
    || (result.value.responseKind === "CORRECTION"
      && (result.value.effect !== "REJECT_CANDIDATE" || result.value.correctionStatementRef !== result.value.responseEventId))
    || result.value.requestTurnId === result.value.responseTurnId) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_VALIDATION_FAILED", schema: "confirmation-resolution",
        message: "confirmation-resolution lineage is inconsistent",
        issues: [{ instancePath: "/relations", keyword: "subjectCoverage", message: "must cover every subject exactly once" }],
      },
    };
  }
  return result;
}
