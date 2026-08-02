import { createHash } from "node:crypto";

function canonical(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("configuration contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("configuration contains a non-JSON value");
  if (seen.has(value)) throw new Error("configuration contains a cycle");
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("configuration contains a non-plain object");
  }
  const output = Array.isArray(value)
    ? `[${value.map((item) => canonical(item, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return output;
}

export function fingerprintRetrievalConfiguration(configuration: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(configuration), "utf8").digest("hex")}`;
}
