import { describe, expect, it } from "vitest";

import { classifyEpisodePrompt } from "./classifier.js";

const active = { hasEpisode: true, currentGoal: "实现知识层", turnId: "turn-2" } as const;

describe("classifyEpisodePrompt", () => {
  it("uses the first prompt as the primary goal", () => {
    expect(classifyEpisodePrompt("  实现 Episode Builder  ", { hasEpisode: false, turnId: "turn-1" }))
      .toEqual({ kind: "PRIMARY", statement: "实现 Episode Builder" });
  });

  it.each([
    ["不对，应该保留原结论", "CORRECTION"],
    ["新任务：实现提炼器", "NEW_GOAL"],
    ["回到知识库更新问题", "NEW_GOAL"],
    ["另外补充性能测试", "SUBGOAL"],
    ["继续", "CONTINUATION"],
    ["请增加一个边界测试", "SUBGOAL"],
  ] as const)("classifies %s as %s", (prompt, kind) => {
    expect(classifyEpisodePrompt(prompt, active).kind).toBe(kind);
  });

  it("rejects an empty prompt", () => {
    expect(() => classifyEpisodePrompt("  ", active)).toThrow("non-whitespace");
  });
});
