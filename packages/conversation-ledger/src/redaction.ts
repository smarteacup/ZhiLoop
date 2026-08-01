export const REDACTED_VALUE = "[REDACTED]" as const;

const SENSITIVE_KEY = /^(?:api[_-]?key|x[_-]?api[_-]?key|authorization|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|cookie|set-cookie|private[_-]?key)$/i;
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
] as const;

export interface RedactionResult {
  readonly value: unknown;
  readonly redactionCount: number;
}

interface MutableRedactionState {
  count: number;
  readonly ancestors: WeakSet<object>;
}

function redactString(value: string, state: MutableRedactionState): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      state.count += 1;
      return REDACTED_VALUE;
    });
  }
  return redacted;
}

function visit(value: unknown, state: MutableRedactionState, depth: number): unknown {
  if (depth > 64) throw new Error("event payload exceeds maximum JSON depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value, state);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("event payload contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (state.ancestors.has(value)) throw new Error("event payload contains a cyclic reference");
    state.ancestors.add(value);
    const result = value.map((item) => visit(item, state, depth + 1));
    state.ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("event payload contains a non-JSON object");
    }
    if (state.ancestors.has(value)) throw new Error("event payload contains a cyclic reference");
    state.ancestors.add(value);
    const result = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => {
        if (SENSITIVE_KEY.test(key)) {
          state.count += 1;
          return [key, REDACTED_VALUE];
        }
        return [key, visit(child, state, depth + 1)];
      }),
    );
    state.ancestors.delete(value);
    return result;
  }
  throw new Error("event payload contains a non-JSON value");
}

export function redactEventPayload(value: unknown): RedactionResult {
  const state: MutableRedactionState = { count: 0, ancestors: new WeakSet<object>() };
  return { value: visit(value, state, 0), redactionCount: state.count };
}
