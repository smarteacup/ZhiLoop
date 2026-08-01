import { parseDocument } from "yaml";
import type { z } from "zod";

import {
  closurePolicySchema,
  configurationSchema,
  DEFAULT_CONFIGURATION,
  injectionPolicySchema,
  retentionPolicySchema,
  retrievalPolicySchema,
  scopePolicySchema,
  verificationPolicySchema,
  type ClosurePolicy,
  type InjectionPolicy,
  type RetentionPolicy,
  type RetrievalPolicy,
  type ScopePolicy,
  type VerificationPolicy,
  type ZhiLoopConfiguration,
} from "./policies.js";

export interface ConfigurationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ConfigurationDiagnostic {
  readonly code:
    | "CONFIG_PARSE_FAILED"
    | "CONFIG_VALIDATION_FAILED"
    | "UNSUPPORTED_CONFIG_VERSION";
  readonly message: string;
  readonly issues: readonly ConfigurationIssue[];
}

export type ConfigurationLoadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConfigurationDiagnostic };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneConfiguration(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) throw new Error("cyclic configuration objects are not supported");
  seen.add(value);

  let clone: unknown;
  if (Array.isArray(value)) {
    clone = value.map((item) => cloneConfiguration(item, seen));
  } else if (isPlainObject(value)) {
    clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneConfiguration(item, seen)]),
    );
  } else {
    clone = value;
  }

  seen.delete(value);
  return clone;
}

function mergeConfiguration(base: unknown, override: unknown, seen = new WeakSet<object>()): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return cloneConfiguration(override);
  if (seen.has(override)) throw new Error("cyclic configuration objects are not supported");
  seen.add(override);

  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  const merged = Object.fromEntries(
    [...keys].map((key) => [
      key,
      Object.hasOwn(override, key)
        ? mergeConfiguration(base[key], override[key], seen)
        : cloneConfiguration(base[key]),
    ]),
  );
  seen.delete(override);
  return merged;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function pathOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$";
  return `$${path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
    .join("")}`;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function findForbiddenKeys(
  value: unknown,
  path: readonly PropertyKey[] = [],
  seen = new WeakSet<object>(),
): ConfigurationIssue[] {
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);

  const issues: ConfigurationIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (FORBIDDEN_KEYS.has(key)) {
      issues.push({
        path: pathOf(childPath),
        code: "dangerous_property",
        message: `${key} is not allowed in configuration`,
      });
    } else {
      issues.push(...findForbiddenKeys(child, childPath, seen));
    }
  }
  return issues;
}

function validationFailure(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string; readonly message: string }[],
): ConfigurationLoadResult<never> {
  const normalizedIssues = issues.flatMap((issue) => {
    const unknownKeys = (issue as { readonly keys?: readonly string[] }).keys;
    if (issue.code === "unrecognized_keys" && unknownKeys) {
      return unknownKeys.map((key) => ({
        path: pathOf([...issue.path, key]),
        code: issue.code,
        message: `unrecognized configuration key: ${key}`,
      }));
    }
    return [{ path: pathOf(issue.path), code: issue.code, message: issue.message }];
  });

  return {
    ok: false,
    error: {
      code: "CONFIG_VALIDATION_FAILED",
      message: "configuration violates its schema or safety invariants",
      issues: normalizedIssues,
    },
  };
}

function deserialize(input: string | unknown): ConfigurationLoadResult<unknown> {
  if (typeof input !== "string") return { ok: true, value: input ?? {} };
  if (input.trim().length === 0) return { ok: true, value: {} };

  try {
    const document = parseDocument(input, { strict: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      return {
        ok: false,
        error: {
          code: "CONFIG_PARSE_FAILED",
          message: "YAML configuration could not be parsed",
          issues: document.errors.map((error) => ({
            path: "$",
            code: error.code,
            message: error.message,
          })),
        },
      };
    }
    return { ok: true, value: document.toJS({ maxAliasCount: 0 }) ?? {} };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "CONFIG_PARSE_FAILED",
        message: "YAML configuration could not be parsed",
        issues: [
          {
            path: "$",
            code: "yaml_exception",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      },
    };
  }
}

function loadPolicy<T>(
  input: string | unknown,
  defaults: T,
  schema: z.ZodType<T>,
): ConfigurationLoadResult<T> {
  const deserialized = deserialize(input);
  if (!deserialized.ok) return deserialized;

  const forbiddenKeys = findForbiddenKeys(deserialized.value);
  if (forbiddenKeys.length > 0) {
    return {
      ok: false,
      error: {
        code: "CONFIG_VALIDATION_FAILED",
        message: "configuration contains forbidden object keys",
        issues: forbiddenKeys,
      },
    };
  }

  try {
    const result = schema.safeParse(mergeConfiguration(defaults, deserialized.value));
    if (!result.success) return validationFailure(result.error.issues);
    return { ok: true, value: deepFreeze(result.data) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "CONFIG_VALIDATION_FAILED",
        message: "configuration could not be normalized",
        issues: [
          {
            path: "$",
            code: "normalization_error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      },
    };
  }
}

export function loadConfiguration(
  input: string | unknown = {},
): ConfigurationLoadResult<ZhiLoopConfiguration> {
  const deserialized = deserialize(input);
  if (!deserialized.ok) return deserialized;

  if (isPlainObject(deserialized.value)) {
    const version = deserialized.value["version"];
    if (version !== undefined && version !== 1) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_CONFIG_VERSION",
          message: `unsupported configuration version: ${String(version)}`,
          issues: [
            {
              path: "$.version",
              code: "unsupported_version",
              message: "only version 1 is supported",
            },
          ],
        },
      };
    }
  }

  return loadPolicy(deserialized.value, DEFAULT_CONFIGURATION, configurationSchema);
}

export const loadVerificationPolicy = (input: string | unknown = {}) =>
  loadPolicy<VerificationPolicy>(input, DEFAULT_CONFIGURATION.verification, verificationPolicySchema);
export const loadRetrievalPolicy = (input: string | unknown = {}) =>
  loadPolicy<RetrievalPolicy>(input, DEFAULT_CONFIGURATION.retrieval, retrievalPolicySchema);
export const loadInjectionPolicy = (input: string | unknown = {}) =>
  loadPolicy<InjectionPolicy>(input, DEFAULT_CONFIGURATION.injection, injectionPolicySchema);
export const loadClosurePolicy = (input: string | unknown = {}) =>
  loadPolicy<ClosurePolicy>(input, DEFAULT_CONFIGURATION.closure, closurePolicySchema);
export const loadScopePolicy = (input: string | unknown = {}) =>
  loadPolicy<ScopePolicy>(input, DEFAULT_CONFIGURATION.scope, scopePolicySchema);
export const loadRetentionPolicy = (input: string | unknown = {}) =>
  loadPolicy<RetentionPolicy>(input, DEFAULT_CONFIGURATION.retention, retentionPolicySchema);
