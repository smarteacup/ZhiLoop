import { describe, expect, it } from "vitest";

import { KNOWLEDGE_STATUSES, type KnowledgeStatus } from "./knowledge.js";
import {
  getAllowedStatusTransitions,
  transitionKnowledgeStatus,
} from "./state-machine.js";

const EXPECTED_TRANSITIONS: Readonly<Record<KnowledgeStatus, readonly KnowledgeStatus[]>> = {
  PROPOSED: ["ACCEPTED", "IMPLEMENTED", "REJECTED", "SUPERSEDED"],
  ACCEPTED: ["IMPLEMENTED", "REJECTED", "SUPERSEDED"],
  IMPLEMENTED: ["VERIFIED", "STALE", "SUPERSEDED"],
  VERIFIED: ["STALE", "SUPERSEDED"],
  REJECTED: [],
  STALE: ["VERIFIED", "SUPERSEDED"],
  SUPERSEDED: [],
};

describe("knowledge status state machine", () => {
  it("exposes immutable transition definitions", () => {
    for (const status of KNOWLEDGE_STATUSES) {
      expect(getAllowedStatusTransitions(status)).toEqual(EXPECTED_TRANSITIONS[status]);
      expect(Object.isFrozen(getAllowedStatusTransitions(status))).toBe(true);
    }
  });

  it("covers every allowed, rejected and idempotent path", () => {
    for (const from of KNOWLEDGE_STATUSES) {
      for (const to of KNOWLEDGE_STATUSES) {
        const result = transitionKnowledgeStatus(from, to);
        if (from === to) {
          expect(result).toEqual({ ok: true, from, to, changed: false });
        } else if (EXPECTED_TRANSITIONS[from].includes(to)) {
          expect(result).toEqual({ ok: true, from, to, changed: true });
        } else {
          expect(result).toEqual({
            ok: false,
            from,
            to,
            code: "INVALID_STATUS_TRANSITION",
          });
        }
      }
    }
  });
});
