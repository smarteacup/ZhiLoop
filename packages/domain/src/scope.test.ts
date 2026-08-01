import { describe, expect, it } from "vitest";

import {
  hasProjectSpecificScopeFields,
  validateKnowledgeScope,
  type ScopeInput,
} from "./scope.js";

describe("knowledge scope validation", () => {
  const validScopes: readonly ScopeInput[] = [
    { level: "TASK", taskId: "task-1", projectId: "project-1" },
    { level: "SYMBOL", projectId: "project-1", symbols: ["OrderService"] },
    { level: "MODULE", projectId: "project-1", modulePaths: ["src/order"] },
    { level: "PROJECT", projectId: "project-1" },
    { level: "USER", userId: "user-1" },
    { level: "TEAM", teamId: "team-1" },
    { level: "GLOBAL" },
  ];

  it.each(validScopes)("accepts a valid $level scope", (scope) => {
    expect(validateKnowledgeScope(scope)).toEqual({ valid: true, scope });
  });

  it.each([
    [{ level: "TASK" }, "TASK scope requires taskId"],
    [{ level: "SYMBOL", projectId: "p" }, "SYMBOL scope requires symbols"],
    [{ level: "MODULE", modulePaths: ["src"] }, "MODULE scope requires projectId"],
    [{ level: "PROJECT" }, "PROJECT scope requires projectId"],
    [{ level: "USER" }, "USER scope requires userId"],
    [{ level: "TEAM" }, "TEAM scope requires teamId"],
    [{ level: "GLOBAL", projectId: "p" }, "GLOBAL scope must not define projectId"],
    [{ level: "UNKNOWN" }, "unsupported scope level: UNKNOWN"],
    [{}, "unsupported scope level: missing"],
  ] as const)("rejects invalid scope %#", (scope, expectedError) => {
    const result = validateKnowledgeScope(scope);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContain(expectedError);
  });

  it("detects fields that prevent implicit global scope", () => {
    expect(hasProjectSpecificScopeFields({ level: "PROJECT", projectId: "p" })).toBe(true);
    expect(hasProjectSpecificScopeFields({ level: "GLOBAL" })).toBe(false);
  });
});

