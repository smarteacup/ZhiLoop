import { fingerprintRetrievalConfiguration } from "@zhiloop/retrieval-evaluation";

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;
export const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || /[\\]/u.test(value)) throw new Error(`${label} is invalid`);
}

export function requireFingerprint(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
}

export function uniqueIds(values: readonly string[], label: string, maximum = 10_000): void {
  if (values.length > maximum || new Set(values).size !== values.length) {
    throw new Error(`${label} is too large or contains duplicates`);
  }
  for (const value of values) requireId(value, label);
}

export function fingerprint(value: unknown): string {
  return fingerprintRetrievalConfiguration(value);
}

export function freezeClone<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (candidate: unknown, seen = new WeakSet<object>()): void => {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Object.values(candidate)) visit(child, seen);
    Object.freeze(candidate);
  };
  visit(copy);
  return copy;
}
