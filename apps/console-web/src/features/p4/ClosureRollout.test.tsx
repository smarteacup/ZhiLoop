// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClosureRunView, RolloutView } from "../../api/p4.js";
import { ClosureDetail, ClosurePage } from "./ClosurePage.js";
import { RolloutPage } from "./RolloutPage.js";
import { p4Api } from "./test-fixtures.js";

afterEach(cleanup);

describe("P4 evidence views", () => {
  it("shows Task Contract, gate evidence, decision and recursive state", async () => {
    const user = userEvent.setup(); render(<ClosurePage api={p4Api()} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "closure-1" }));
    expect(await screen.findByRole("heading", { name: "Task Contract" })).toBeTruthy();
    expect(screen.getByText("TESTS_PASSED")).toBeTruthy();
    expect(screen.getByText("未发生")).toBeTruthy();
    expect(screen.getByText(/NOT_REQUIRED/u)).toBeTruthy();
  });

  it("renders scoped canary, eligibility fingerprints and last-known-good", async () => {
    render(<RolloutPage api={p4Api()} />);
    expect(await screen.findByRole("heading", { name: "Scoped canary" })).toBeTruthy();
    expect(screen.getByText("project-1")).toBeTruthy();
    expect(screen.getByText(`sha256:${"c".repeat(64)}`)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Last-known-good" })).toBeTruthy();
  });

  it("cancels an in-flight closure detail request", async () => {
    let observedSignal: AbortSignal | undefined;
    const detail = vi.fn((_sessionId: string, _closureRunId: string, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const user = userEvent.setup(); render(<ClosurePage api={p4Api({ closureRun: detail })} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "closure-1" }));
    await user.click(await screen.findByRole("button", { name: "取消详情加载" }));
    expect(observedSignal?.aborted).toBe(true);
  });

  it("renders disabled, empty and truncated closure facts and reports a detail error", async () => {
    const user = userEvent.setup();
    const view = await p4Api().closureRuns("session-1");
    render(<ClosurePage api={p4Api({
      closureRuns: async () => ({ ...view, capabilityStatus: "NOT_CONFIGURED", capabilityReasonCode: "CLOSURE_NOT_CONFIGURED", truncated: true }),
      closureRun: async () => { throw new Error("detail unavailable"); },
    })} sessionId="session-1" />);
    expect(await screen.findByText("CLOSURE_NOT_CONFIGURED")).toBeTruthy();
    expect(screen.getByText("列表已截断。")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "closure-1" }));
    expect((await screen.findByRole("alert")).textContent).toContain("detail unavailable");
    cleanup();
    render(<ClosurePage api={p4Api({ closureRuns: async () => ({ capabilityStatus: "READY", capabilityReasonCode: "READY", truncated: false, items: [] }) })} />);
    expect(await screen.findByText("没有闭环运行")).toBeTruthy();
  });

  it("renders closure optional defaults, correction, interaction answer and recursive rejection", () => {
    const value: ClosureRunView = {
      closureRunId: "closure-optional", sessionId: "session-1", turnId: "turn-1", createdAt: "2026-08-04T00:00:00.000Z",
      taskContract: { objective: "finish", boundaries: [], completionGates: [] }, gates: [{ gateId: "gate-1", label: "gate", status: "UNKNOWN", evidenceRefs: [], reasonCode: "UNKNOWN" }],
      decision: "ASK_USER", correctionDelta: "fix tests", continuationCount: 2, recursiveStopRejected: true,
      interaction: { required: true, question: "Continue?", answer: "yes", confirmationStatus: "CONFIRMED" },
    };
    render(<ClosureDetail value={value} />);
    expect(screen.getAllByText("无")).toHaveLength(3);
    expect(screen.getByText("fix tests")).toBeTruthy();
    expect(screen.getByText("已拦截")).toBeTruthy();
    expect(screen.getByText("回答：yes")).toBeTruthy();
  });

  it("renders a degraded rollout with no canary, transition or eligibility", async () => {
    const current = await p4Api().rollout();
    const view: RolloutView = {
      ...current, capabilityStatus: "NOT_CONFIGURED", capabilityReasonCode: "ROLLOUT_NOT_CONFIGURED",
      effective: { ...current.effective, canary: undefined, evidenceId: undefined }, eligibility: [], lastTransition: undefined,
    };
    render(<RolloutPage api={p4Api({ rollout: async () => view })} />);
    expect(await screen.findByText("ROLLOUT_NOT_CONFIGURED")).toBeTruthy();
    expect(screen.getByText("没有 scoped canary")).toBeTruthy();
    expect(screen.getByText("没有 transition 记录。")).toBeTruthy();
    expect(screen.getByText(/没有资格证据/u)).toBeTruthy();
    expect(screen.getByText("未绑定")).toBeTruthy();
  });
});
