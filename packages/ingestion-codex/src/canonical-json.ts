import type { JsonValue } from "./types.js";

const MAX_JSON_DEPTH = 32;

export function normalizeJson(
  value: unknown,
  path = "$",
  depth = 0,
  ancestors = new WeakSet<object>(),
): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${path} exceeds maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain a finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${path} contains a cyclic reference`);
    ancestors.add(value);
    const normalized = value.map((item, index) => normalizeJson(item, `${path}[${index}]`, depth + 1, ancestors));
    ancestors.delete(value);
    return normalized;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    if (ancestors.has(value)) throw new Error(`${path} contains a cyclic reference`);
    ancestors.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, normalizeJson(item, `${path}.${key}`, depth + 1, ancestors)] as const);
    ancestors.delete(value);
    return Object.fromEntries(entries);
  }
  throw new Error(`${path} contains a non-JSON value`);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}
