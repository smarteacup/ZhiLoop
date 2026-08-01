import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_STATUSES,
  isDefaultRetrievalEligible,
  isValidSubjectKey,
} from "./knowledge.js";

describe("knowledge invariants", () => {
  it.each([
    "decision.codex.primary-source",
    "experience.order.database-idempotency",
    "implementation.context.stop-hook-v2",
  ])("accepts stable subject key %s", (subjectKey) => {
    expect(isValidSubjectKey(subjectKey)).toBe(true);
  });

  it.each(["decision", "Decision.codex.source", "decision.codex.bad_key", ".codex.source"])(
    "rejects unstable subject key %s",
    (subjectKey) => {
      expect(isValidSubjectKey(subjectKey)).toBe(false);
    },
  );

  it("only enables accepted or evidence-backed states by default", () => {
    const eligible = KNOWLEDGE_STATUSES.filter(isDefaultRetrievalEligible);
    expect(eligible).toEqual(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);
  });
});

