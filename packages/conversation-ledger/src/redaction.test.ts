import { describe, expect, it } from "vitest";

import { redactEventPayload } from "./redaction.js";

describe("event payload redaction", () => {
  it("preserves ordinary JSON primitives and arrays", () => {
    expect(redactEventPayload({ enabled: true, retries: 2, note: null, values: [false, 3] })).toEqual({
      value: { enabled: true, retries: 2, note: null, values: [false, 3] },
      redactionCount: 0,
    });
  });

  it("redacts cloud credentials and private key blocks inside strings", () => {
    const result = redactEventPayload({
      log: "credential AKIAABCDEFGHIJKLMNOP was rejected",
      key: "-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----",
    });
    expect(result).toEqual({
      value: { log: "credential [REDACTED] was rejected", key: "[REDACTED]" },
      redactionCount: 2,
    });
  });

  it("allows shared object references but rejects excessive depth", () => {
    const shared = { safe: "value" };
    expect(redactEventPayload({ left: shared, right: shared }).redactionCount).toBe(0);
    const deep = Array.from({ length: 34 }).reduce<unknown>((value) => [value], null);
    expect(() => redactEventPayload(deep)).toThrow("maximum JSON depth");
  });
});
