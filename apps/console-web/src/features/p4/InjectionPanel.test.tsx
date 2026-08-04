// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { injectionAttemptViewSchema } from "../../api/p4.js";
import { InjectionPanel } from "./InjectionPanel.js";
import { p4Api } from "./test-fixtures.js";

afterEach(cleanup);

describe("InjectionPanel", () => {
  it("strictly distinguishes SHADOW plan from evidence-backed actual delivery", async () => {
    render(<InjectionPanel api={p4Api()} sessionId="session-1" />);
    expect(await screen.findByText("计划注入（未进入模型上下文）")).toBeTruthy();
    expect(screen.getByText("实际进入模型上下文")).toBeTruthy();
    expect(screen.getAllByText("已注入")).toHaveLength(1);
    expect(screen.getByText("delivery-evidence-1")).toBeTruthy();
  });

  it("rejects an INJECTED server fact without actual delivery evidence", () => {
    const result = injectionAttemptViewSchema.safeParse({ attemptId: "a", sessionId: "s", turnId: "t", runId: "r", retrievalTraceId: "trace", rolloutRevision: 1, status: "INJECTED", reasonCode: "FORGED", envelope: { mode: "SHADOW", detailLevel: "L1_POINTER", maxTokens: 100, estimatedTokens: 1, items: [], omitted: [], reasonCodes: ["SHADOW"] }, createdAt: "2026-08-04T00:00:00.000Z", mcpExpansions: [] });
    expect(result.success).toBe(false);
  });
});
