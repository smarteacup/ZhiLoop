import { describe, expect, it } from "vitest";

import { evaluateGlobalPromotion } from "./promotion.js";

describe("GLOBAL promotion invariant", () => {
  it("allows an explicit user decision", () => {
    expect(
      evaluateGlobalPromotion({
        kind: "RULE",
        verifiedProjectIds: [],
        hasProjectSpecificMarkers: true,
        userExplicitlyApprovedGlobal: true,
      }),
    ).toEqual({ allowed: true, reason: "USER_EXPLICITLY_APPROVED" });
  });

  it("allows two distinct verified projects without project markers", () => {
    expect(
      evaluateGlobalPromotion({
        kind: "EXPERIENCE",
        verifiedProjectIds: ["project-a", "project-b"],
        hasProjectSpecificMarkers: false,
        userExplicitlyApprovedGlobal: false,
      }),
    ).toEqual({ allowed: true, reason: "CROSS_PROJECT_VERIFIED" });
  });

  it("deduplicates project evidence", () => {
    expect(
      evaluateGlobalPromotion({
        kind: "EXPERIENCE",
        verifiedProjectIds: ["project-a", " project-a ", ""],
        hasProjectSpecificMarkers: false,
        userExplicitlyApprovedGlobal: false,
      }),
    ).toEqual({ allowed: false, reason: "INSUFFICIENT_DISTINCT_PROJECTS" });
  });

  it("rejects implicit promotion of project-specific content", () => {
    expect(
      evaluateGlobalPromotion({
        kind: "EXPERIENCE",
        verifiedProjectIds: ["project-a", "project-b"],
        hasProjectSpecificMarkers: true,
        userExplicitlyApprovedGlobal: false,
      }),
    ).toEqual({ allowed: false, reason: "PROJECT_SPECIFIC_CONTENT" });
  });

  it.each(["RULE", "PREFERENCE"] as const)(
    "requires explicit approval for global %s knowledge",
    (kind) => {
      expect(
        evaluateGlobalPromotion({
          kind,
          verifiedProjectIds: ["project-a", "project-b"],
          hasProjectSpecificMarkers: false,
          userExplicitlyApprovedGlobal: false,
        }),
      ).toEqual({ allowed: false, reason: "EXPLICIT_APPROVAL_REQUIRED" });
    },
  );
});
