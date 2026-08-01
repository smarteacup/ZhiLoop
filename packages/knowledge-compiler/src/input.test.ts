import { describe, expect, it } from "vitest";

import type { Episode } from "@zhiloop/domain";

import { toKnowledgeExtractionInput } from "./input.js";

function episode(): Episode {
  return {
    episodeId: "episode-1",
    builderVersion: "episode-builder-v2",
    sessionIds: ["session-1"],
    turnIds: ["turn-1", "turn-2"],
    projectContext: {
      projectId: "project-1",
      repositoryRoot: "/private/workspace/repo",
      repositoryRemote: "git@example.com/repo.git",
      branch: "main",
      portable: true,
    },
    goal: "设计知识提取端口",
    goalRef: "event-goal",
    subgoals: [{
      goalId: "subgoal-1",
      turnId: "turn-2",
      sourceEventId: "event-subgoal",
      statement: "补充重试策略",
      occurredAt: "2026-08-01T08:00:02.000Z",
    }],
    userStatements: [{
      turnId: "turn-1",
      sourceEventId: "event-goal",
      kind: "GOAL",
      statement: "设计知识提取端口",
      occurredAt: "2026-08-01T08:00:00.000Z",
    }, {
      turnId: "turn-2",
      sourceEventId: "event-subgoal",
      kind: "SUBGOAL",
      statement: "补充重试策略",
      occurredAt: "2026-08-01T08:00:02.000Z",
    }, {
      turnId: "turn-2",
      sourceEventId: "event-correction",
      kind: "CORRECTION",
      statement: "必须返回结构化结果",
      occurredAt: "2026-08-01T08:00:03.000Z",
    }],
    userCorrections: [{
      correctionId: "correction-1",
      turnId: "turn-2",
      originalRef: "event-assistant",
      originalStatement: "只需返回文本",
      correctedRef: "event-correction",
      correctedStatement: "必须返回结构化结果",
      occurredAt: "2026-08-01T08:00:03.000Z",
    }],
    actions: [{
      actionId: "action-1",
      kind: "COMMAND",
      summary: "Ran tests",
      sourceEventIds: ["event-action"],
      occurredAt: "2026-08-01T08:00:04.000Z",
    }],
    artifacts: [{ artifactId: "artifact-1", kind: "FILE", uri: "/repo/a.ts", contentHash: "hash-a" }],
    outcomes: [{
      outcomeId: "outcome-1",
      kind: "SUCCESS",
      summary: "Tests passed",
      evidenceRefs: ["event-outcome", "event-action"],
    }],
    evidenceRefs: [
      "event-session-start",
      "event-goal",
      "event-subgoal",
      "event-assistant",
      "event-correction",
      "event-action",
      "event-outcome",
      "event-session-end",
    ],
    status: "COMPLETED",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:05.000Z",
  };
}

describe("toKnowledgeExtractionInput", () => {
  it("projects only semantic Episode fields and relevant evidence", () => {
    const result = toKnowledgeExtractionInput(episode());

    expect(result).toMatchObject({
      schemaVersion: 1,
      episodeId: "episode-1",
      builderVersion: "episode-builder-v2",
      projectContext: {
        projectId: "project-1",
        repositoryRemote: "git@example.com/repo.git",
        branch: "main",
        portable: true,
      },
      goal: "设计知识提取端口",
      goalRef: "event-goal",
    });
    expect(result.evidenceRefs).toEqual([
      "event-goal",
      "event-subgoal",
      "event-assistant",
      "event-correction",
      "event-action",
      "event-outcome",
    ]);
    expect(result.outcomes[0]?.evidenceRefs).toEqual(["event-outcome", "event-action"]);
    expect(Object.hasOwn(result.projectContext, "repositoryRoot")).toBe(false);
    expect(Object.hasOwn(result, "sessionIds")).toBe(false);
    expect(Object.hasOwn(result, "turnIds")).toBe(false);
    expect(Object.hasOwn(result, "status")).toBe(false);
    expect(Object.hasOwn(result.subgoals[0] ?? {}, "turnId")).toBe(false);
  });

  it("deep-freezes the projected input", () => {
    const result = toKnowledgeExtractionInput(episode());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projectContext)).toBe(true);
    expect(Object.isFrozen(result.corrections)).toBe(true);
    expect(Object.isFrozen(result.outcomes[0]?.evidenceRefs)).toBe(true);
  });

  it("rejects a semantic reference missing from Episode evidence", () => {
    const source = episode();
    expect(() => toKnowledgeExtractionInput({ ...source, goalRef: "missing" })).toThrow("does not contain");
  });

  it("rejects an OPEN Episode whose content and input hash can still change", () => {
    expect(() => toKnowledgeExtractionInput({ ...episode(), status: "OPEN" })).toThrow("OPEN Episode");
    expect(toKnowledgeExtractionInput({ ...episode(), status: "ABANDONED" }).episodeId).toBe("episode-1");
  });

  it("rejects untraceable actions and outcomes", () => {
    const source = episode();
    expect(() => toKnowledgeExtractionInput({
      ...source,
      actions: [{ ...source.actions[0]!, sourceEventIds: [] }],
    })).toThrow("has no source event");
    expect(() => toKnowledgeExtractionInput({
      ...source,
      outcomes: [{ ...source.outcomes[0]!, evidenceRefs: [] }],
    })).toThrow("has no evidence");
  });
});
