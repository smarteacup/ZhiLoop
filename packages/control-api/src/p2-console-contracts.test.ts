import { describe, expect, it } from "vitest";

import {
  p2KnowledgeFilterSchema,
  p2SessionExtractionViewSchema,
} from "./p2-console-contracts.js";

describe("P2 Console transport contracts", () => {
  it("accepts only exact domain filters", () => {
    expect(p2KnowledgeFilterSchema.parse({ scope: "PROJECT", status: "STALE", version: 2, eligible: false }))
      .toEqual({ scope: "PROJECT", status: "STALE", version: 2, eligible: false });
    expect(p2KnowledgeFilterSchema.safeParse({ scope: "SESSION" }).success).toBe(false);
    expect(p2KnowledgeFilterSchema.safeParse({ eligible: "true" }).success).toBe(false);
    expect(p2KnowledgeFilterSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(p2KnowledgeFilterSchema.safeParse({ eligible: true, unknown: true }).success).toBe(false);
  });

  it("rejects shallow objects that previously crossed the Sidecar boundary", () => {
    expect(p2SessionExtractionViewSchema.safeParse({ sessionId: "session-1", stages: [] }).success).toBe(false);
    expect(p2SessionExtractionViewSchema.safeParse({ sessionId: "session-1", stages: "invalid" }).success).toBe(false);
  });
});
