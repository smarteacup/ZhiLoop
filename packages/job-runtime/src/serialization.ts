import { createHash } from "node:crypto";

import type { JsonValue } from "./types.js";

export const MAX_JOB_JSON_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;

function canonical(value: unknown, path: string, depth: number, ancestors: Set<object>): string {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${path} exceeds the job JSON depth limit`);
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cyclic value`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => canonical(item, `${path}[${index}]`, depth + 1, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} contains a non-JSON object`);
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key], `${path}.${key}`, depth + 1, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function serializeJobJson(value: unknown): { readonly json: string; readonly hash: string; readonly value: JsonValue } {
  const json = canonical(value, "$", 0, new Set());
  if (Buffer.byteLength(json) > MAX_JOB_JSON_BYTES) throw new Error("job JSON exceeds the byte limit");
  return {
    json,
    hash: createHash("sha256").update(json).digest("hex"),
    value: JSON.parse(json) as JsonValue,
  };
}

export function parseStoredJobJson(json: string, expectedHash: string): JsonValue {
  const parsed = serializeJobJson(JSON.parse(json) as unknown);
  if (parsed.hash !== expectedHash || parsed.json !== json) throw new Error("stored job JSON failed integrity verification");
  return parsed.value;
}

export function jobEffectKey(idempotencyKey: string, step: string): string {
  if (step.length < 1 || step.length > 200 || /[\0\r\n]/u.test(step)) throw new Error("job effect step is invalid");
  return createHash("sha256").update(`zhiloop-job-effect-v1\0${idempotencyKey}\0${step}`).digest("hex");
}
