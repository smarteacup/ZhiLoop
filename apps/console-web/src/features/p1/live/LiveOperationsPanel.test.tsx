// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RevisionActionGate } from "../actionGuard.js";
import { LiveOperationsPanel, type LiveOperationsViewModel, type LiveRefreshPort } from "./LiveOperationsPanel.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function gate(overrides: Partial<RevisionActionGate> = {}): RevisionActionGate {
  return {
    capability: { status: "READY", reasonCode: "READY", observedAt: timestamp },
    allowed: true,
    expectedRevision: 42,
    currentRevision: 42,
    idempotencyKey: "live-refresh-42",
    ...overrides,
  };
}

function model(overrides: Partial<LiveOperationsViewModel> = {}): LiveOperationsViewModel {
  return {
    live: {
      connection: "POLLING",
      revision: 42,
      lastEventId: "event-42",
      lastEventAt: timestamp,
      pollingIntervalMs: 5_000,
      invalidatedResources: ["JOBS", "SESSIONS"],
      refresh: gate(),
    },
    alerts: [{
      alertId: "alert-1",
      severity: "CRITICAL",
      code: "HOOK_SILENCE",
      title: "Hook 长时间无事件",
      detail: "健康状态仍为 FAILED",
      healthState: "FAILED",
      triggeredAt: timestamp,
      quietHoursSuppressed: true,
    }],
    notifications: [{
      notificationId: "notice-1",
      area: "真实 Codex 验收",
      state: "NOT_VERIFIED",
      reasonCode: "REAL_CODEX_TASK_NOT_VERIFIED",
      detail: "尚无完整 Hook 到 cursor 证据",
      observedAt: timestamp,
      nextAction: "创建真实 task 后重新验收",
    }],
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("LiveOperationsPanel", () => {
  it("shows polling degradation, alerts during quiet hours, and NOT_VERIFIED notifications without hiding health", () => {
    render(<LiveOperationsPanel viewModel={model()} />);
    expect(screen.getByText(/5000ms 轮询/u)).toBeTruthy();
    expect(screen.getByText(/静默时段，但健康状态仍可见/u)).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
    expect(screen.getByText("REAL_CODEX_TASK_NOT_VERIFIED", { exact: false })).toBeTruthy();
    expect(screen.getByText("NOT_VERIFIED")).toBeTruthy();
  });

  it("refreshes only invalidated resources with matching revision and idempotency key", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn(async () => undefined);
    const commands: LiveRefreshPort = { refresh };
    render(<LiveOperationsPanel viewModel={model()} commands={commands} />);
    await user.click(screen.getByRole("button", { name: "刷新失效视图" }));
    expect(refresh).toHaveBeenCalledWith({ expectedRevision: 42, resources: ["JOBS", "SESSIONS"], idempotencyKey: "live-refresh-42" });
  });

  it("blocks refresh for stale revisions, unavailable capabilities, or an empty invalidation set", () => {
    const stale = model({ live: { ...model().live, refresh: gate({ expectedRevision: 41 }) } });
    const { rerender } = render(<LiveOperationsPanel viewModel={stale} commands={{ refresh: async () => undefined }} />);
    let button = screen.getByRole("button", { name: "刷新失效视图" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("revision 已变化");

    rerender(<LiveOperationsPanel viewModel={model({ live: { ...model().live, invalidatedResources: [] } })} commands={{ refresh: async () => undefined }} />);
    button = screen.getByRole("button", { name: "刷新失效视图" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("没有待刷新");
  });

  it("renders healthy live and empty notification branches without inventing alerts", () => {
    render(<LiveOperationsPanel viewModel={model({
      live: { ...model().live, connection: "LIVE", lastEventId: undefined, lastEventAt: undefined, invalidatedResources: [] },
      alerts: [],
      notifications: [],
    })} commands={{ refresh: async () => undefined }} />);
    expect(screen.getByText(/SSE 正常/u)).toBeTruthy();
    expect(screen.getByText("当前没有活动告警。")).toBeTruthy();
    expect(screen.getByText("没有降级通知。")).toBeTruthy();
    expect(screen.getByText(/尚无事件时间/u)).toBeTruthy();
  });

  it("keeps degraded state visible when a refresh command fails", async () => {
    const user = userEvent.setup();
    render(<LiveOperationsPanel viewModel={model()} commands={{ refresh: async () => { throw new Error("resync window expired"); } }} />);
    await user.click(screen.getByRole("button", { name: "刷新失效视图" }));
    expect(await screen.findByText("resync window expired")).toBeTruthy();
    expect(screen.getByText("POLLING")).toBeTruthy();
    expect(screen.getByText("REAL_CODEX_TASK_NOT_VERIFIED", { exact: false })).toBeTruthy();
  });
});
