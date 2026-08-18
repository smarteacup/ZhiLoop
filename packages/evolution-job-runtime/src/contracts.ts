import { isAbsolute, resolve } from "node:path";

import { serializeJobJson, type JsonValue } from "@zhiloop/job-runtime";

export const EVOLUTION_JOB_TYPES = [
  "KNOWLEDGE_COMPILE",
  "KNOWLEDGE_REVALIDATE",
  "KNOWLEDGE_REPAIR_DRAFT",
  "CODEGRAPH_INITIALIZE",
  "LEGACY_KNOWLEDGE_MIGRATION",
] as const;

export type EvolutionJobType = (typeof EVOLUTION_JOB_TYPES)[number];

interface EvolutionJobInputBase<TType extends EvolutionJobType> {
  readonly schemaVersion: 1;
  readonly jobType: TType;
}

export interface KnowledgeCompileJobInput extends EvolutionJobInputBase<"KNOWLEDGE_COMPILE"> {
  readonly sessionId: string;
  readonly sourceRange: { readonly from: number; readonly to: number };
  readonly pipelineHash: string;
}

export interface KnowledgeRevalidateJobInput extends EvolutionJobInputBase<"KNOWLEDGE_REVALIDATE"> {
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly sourceRef: string;
  readonly changeSetHash: string;
  readonly recipeSelectionHash: string;
}

export interface KnowledgeRepairDraftJobInput extends EvolutionJobInputBase<"KNOWLEDGE_REPAIR_DRAFT"> {
  readonly projectId: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly conflictRunId: string;
}

export interface CodeGraphInitializeJobInput extends EvolutionJobInputBase<"CODEGRAPH_INITIALIZE"> {
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly repositoryIdentity: string;
  readonly adapterVersion: string;
}

export interface LegacyKnowledgeMigrationJobInput extends EvolutionJobInputBase<"LEGACY_KNOWLEDGE_MIGRATION"> {
  readonly migrationVersion: string;
  readonly projectId: string;
  readonly pageCursor: string;
}

export type EvolutionJobInput =
  | KnowledgeCompileJobInput
  | KnowledgeRevalidateJobInput
  | KnowledgeRepairDraftJobInput
  | CodeGraphInitializeJobInput
  | LegacyKnowledgeMigrationJobInput;

const SAFE_ID = /^[A-Za-z0-9._:@+=-]{1,1000}$/u;
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,200}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL = /[\0\r\n]/u;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("EVOLUTION_JOB_INPUT_FIELDS_INVALID");
  }
}

function safeText(value: unknown, name: string, maximum = 1_000): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || CONTROL.test(value)) {
    throw new Error(`EVOLUTION_JOB_${name}_INVALID`);
  }
}

function safeId(value: unknown, name: string): asserts value is string {
  safeText(value, name);
  if (!SAFE_ID.test(value) || value === "." || value === "..") throw new Error(`EVOLUTION_JOB_${name}_INVALID`);
}

function hash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`EVOLUTION_JOB_${name}_INVALID`);
}

function positive(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`EVOLUTION_JOB_${name}_INVALID`);
}

function repositoryRoot(value: unknown): asserts value is string {
  safeText(value, "REPOSITORY_ROOT", 4_096);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error("EVOLUTION_JOB_REPOSITORY_ROOT_INVALID");
}

function base(value: Readonly<Record<string, unknown>>, jobType: EvolutionJobType, keys: readonly string[]): void {
  exact(value, ["schemaVersion", "jobType", ...keys]);
  if (value["schemaVersion"] !== 1 || value["jobType"] !== jobType) throw new Error("EVOLUTION_JOB_INPUT_TYPE_INVALID");
}

export function parseEvolutionJobInput(value: unknown): EvolutionJobInput {
  if (!record(value) || value["schemaVersion"] !== 1 || !EVOLUTION_JOB_TYPES.includes(value["jobType"] as EvolutionJobType)) {
    throw new Error("EVOLUTION_JOB_INPUT_INVALID");
  }
  switch (value["jobType"]) {
    case "KNOWLEDGE_COMPILE": {
      base(value, "KNOWLEDGE_COMPILE", ["sessionId", "sourceRange", "pipelineHash"]);
      safeId(value["sessionId"], "SESSION_ID");
      hash(value["pipelineHash"], "PIPELINE_HASH");
      const range = value["sourceRange"];
      if (!record(range)) throw new Error("EVOLUTION_JOB_SOURCE_RANGE_INVALID");
      exact(range, ["from", "to"]);
      positive(range["from"], "SOURCE_RANGE");
      positive(range["to"], "SOURCE_RANGE");
      if (range["from"] > range["to"]) throw new Error("EVOLUTION_JOB_SOURCE_RANGE_INVALID");
      break;
    }
    case "KNOWLEDGE_REVALIDATE":
      base(value, "KNOWLEDGE_REVALIDATE", ["projectId", "repositoryRoot", "sourceRef", "changeSetHash", "recipeSelectionHash"]);
      safeId(value["projectId"], "PROJECT_ID");
      repositoryRoot(value["repositoryRoot"]);
      safeText(value["sourceRef"], "SOURCE_REF");
      hash(value["changeSetHash"], "CHANGE_SET_HASH");
      hash(value["recipeSelectionHash"], "RECIPE_SELECTION_HASH");
      break;
    case "KNOWLEDGE_REPAIR_DRAFT":
      base(value, "KNOWLEDGE_REPAIR_DRAFT", ["projectId", "assetId", "assetVersion", "conflictRunId"]);
      safeId(value["projectId"], "PROJECT_ID");
      safeId(value["assetId"], "ASSET_ID");
      positive(value["assetVersion"], "ASSET_VERSION");
      safeId(value["conflictRunId"], "CONFLICT_RUN_ID");
      break;
    case "CODEGRAPH_INITIALIZE":
      base(value, "CODEGRAPH_INITIALIZE", ["projectId", "repositoryRoot", "repositoryIdentity", "adapterVersion"]);
      safeId(value["projectId"], "PROJECT_ID");
      repositoryRoot(value["repositoryRoot"]);
      hash(value["repositoryIdentity"], "REPOSITORY_IDENTITY");
      safeText(value["adapterVersion"], "ADAPTER_VERSION", 200);
      if (!SAFE_VERSION.test(value["adapterVersion"])) throw new Error("EVOLUTION_JOB_ADAPTER_VERSION_INVALID");
      break;
    case "LEGACY_KNOWLEDGE_MIGRATION":
      base(value, "LEGACY_KNOWLEDGE_MIGRATION", ["migrationVersion", "projectId", "pageCursor"]);
      safeText(value["migrationVersion"], "MIGRATION_VERSION", 200);
      if (!SAFE_VERSION.test(value["migrationVersion"])) throw new Error("EVOLUTION_JOB_MIGRATION_VERSION_INVALID");
      safeId(value["projectId"], "PROJECT_ID");
      safeId(value["pageCursor"], "PAGE_CURSOR");
      break;
  }
  return deepFreeze(serializeJobJson(value).value as unknown as EvolutionJobInput);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function evolutionJobInputHash(input: EvolutionJobInput): string {
  return serializeJobJson(parseEvolutionJobInput(input)).hash;
}

export function evolutionJobIdempotencyKey(input: EvolutionJobInput): string {
  const parsed = parseEvolutionJobInput(input);
  const identity = (parsed.jobType === "KNOWLEDGE_COMPILE"
    ? [parsed.sessionId, parsed.sourceRange.from, parsed.sourceRange.to, parsed.pipelineHash]
    : parsed.jobType === "KNOWLEDGE_REVALIDATE"
      ? [parsed.projectId, parsed.sourceRef, parsed.changeSetHash, parsed.recipeSelectionHash]
      : parsed.jobType === "KNOWLEDGE_REPAIR_DRAFT"
        ? [parsed.assetId, parsed.assetVersion, parsed.conflictRunId]
        : parsed.jobType === "CODEGRAPH_INITIALIZE"
          ? [parsed.projectId, parsed.repositoryIdentity, parsed.adapterVersion]
          : [parsed.migrationVersion, parsed.projectId, parsed.pageCursor]) as JsonValue;
  const digest = serializeJobJson(["evolution-job-v1", parsed.jobType, identity]).hash;
  return `evolution:${parsed.jobType.toLowerCase()}:${digest}`;
}
