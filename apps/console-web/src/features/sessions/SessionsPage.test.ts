import { describe, expect, it, vi } from "vitest";

import { groupSessions } from "./SessionsPage.js";

describe("session time groups", () => {
  it("preserves the source order inside stable time groups", () => {
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const base = {
      schemaVersion: 1 as const,
      title: "Session",
      source: "CODEX_TRANSCRIPT" as const,
      sourceStatus: "AVAILABLE" as const,
      captureStatus: "DISCOVERED_NOT_CAPTURED" as const,
      firstActivityAt: "2026-08-03T10:00:00.000Z",
      eventCount: 0,
      turnCount: 0,
      ignoredRecords: 0,
      redactionCount: 0,
    };
    const groups = groupSessions([
      { ...base, sessionId: "b", lastActivityAt: "2026-08-03T11:00:00.000Z" },
      { ...base, sessionId: "a", lastActivityAt: "2026-08-03T10:00:00.000Z" },
      { ...base, sessionId: "old", lastActivityAt: "2026-07-20T10:00:00.000Z" },
    ]);
    expect(groups.map((group) => group.label)).toEqual(["今天", "更早"]);
    expect(groups[0]?.items.map((item) => item.sessionId)).toEqual(["b", "a"]);
    vi.useRealTimers();
  });
});
