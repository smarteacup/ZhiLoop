// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertsPage } from "./AlertsPage.js";
import { observedAt, testApi } from "./test-api.js";

afterEach(() => cleanup());

describe("AlertsPage", () => {
  it("localizes durable alerts, preserves raw codes, and does not hide critical alerts when suppressing", async () => {
    const suppress = vi.fn(async () => ({ alertId: "alert-1", alertRevision: 2,
      operatorState: { revision: 1, suppressedUntil: "2026-08-19T03:00:00.000Z", updatedAt: observedAt } }));
    render(<AlertsPage api={testApi({ operationalAlerts: async () => ({ revision: 2, bounded: false, observedAt, items: [{ schemaVersion: 1,
      alertId: "alert-1", severity: "CRITICAL", type: "MIGRATION_FAILED", projectId: "project-1", entityRef: "migration-1",
      reasonCodes: ["LEGACY_MIGRATION_TARGET_DRIFT"], occurrenceCount: 3, firstObservedAt: observedAt, lastObservedAt: observedAt,
      alertRevision: 2, revision: 0, deliveryState: "LOCAL_ONLY", diagnostic: { reasonCode: "LEGACY_MIGRATION_TARGET_DRIFT", message: "目标已变化",
        retryable: false, suggestedAction: "重新生成预览" } }] }), suppressOperationalAlert: suppress })} />);
    expect(await screen.findByRole("heading", { name: "历史知识迁移失败" })).toBeTruthy();
    expect(screen.getByTitle("MIGRATION_FAILED")).toBeTruthy(); expect(screen.getByText("严重")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "静默 1 小时" }));
    expect(suppress).toHaveBeenCalled(); expect(screen.getByRole("heading", { name: "历史知识迁移失败" })).toBeTruthy();
  });

  it("applies a project filter explicitly, acknowledges an alert, and renders persisted operator state", async () => {
    let acknowledged = false; const query = vi.fn(async (projectId?: string) => ({ revision: 2, bounded: false, observedAt,
      items: [{ schemaVersion: 1 as const, alertId: "alert-2", severity: "WARNING" as const, type: "CODEGRAPH_UNAVAILABLE" as const,
        projectId, entityRef: "run-2", reasonCodes: ["CODEGRAPH_UNAVAILABLE"], occurrenceCount: 1,
        firstObservedAt: observedAt, lastObservedAt: observedAt, alertRevision: 2, revision: acknowledged ? 1 : 0, deliveryState: "LOCAL_ONLY" as const,
        ...(acknowledged ? { operatorState: { revision: 1, acknowledgedAt: observedAt, acknowledgedBy: "local-console", updatedAt: observedAt } } : {}),
        diagnostic: { reasonCode: "CODEGRAPH_UNAVAILABLE", message: "图不可用", retryable: true, attempt: 1, maxAttempts: 3,
          suggestedAction: "初始化索引" } }] }));
    const acknowledge = vi.fn(async () => { acknowledged = true; return { alertId: "alert-2", alertRevision: 2,
      operatorState: { revision: 1, acknowledgedAt: observedAt, acknowledgedBy: "local-console", updatedAt: observedAt } }; });
    render(<AlertsPage api={testApi({ operationalAlerts: query, acknowledgeOperationalAlert: acknowledge })} />);
    const user = userEvent.setup(); await screen.findByRole("heading", { name: "CodeGraph 当前不可用" });
    await user.type(screen.getByPlaceholderText("留空查看全部"), "project-1");
    expect(query).toHaveBeenCalledTimes(1); await user.click(screen.getByRole("button", { name: "应用筛选" }));
    expect(query).toHaveBeenLastCalledWith("project-1", undefined, expect.any(AbortSignal));
    await user.click(screen.getByRole("button", { name: "确认已知" })); expect(acknowledge).toHaveBeenCalled();
    expect(await screen.findByText(/已于/u)).toBeTruthy(); expect(screen.getByRole("link", { name: "查看关联对象" }).getAttribute("href")).toBe("#/codegraph");
  });

  it("shows empty, query failure, and command failure states without hiding the alert", async () => {
    const { rerender } = render(<AlertsPage api={testApi({ operationalAlerts: async () => ({ revision: 0, items: [], bounded: false, observedAt }) })} />);
    expect(await screen.findByText("当前没有持久化告警")).toBeTruthy();
    rerender(<AlertsPage api={testApi({ operationalAlerts: async () => { throw new Error("alert query failed"); } })} />);
    expect(await screen.findByText(/alert query failed/u)).toBeTruthy();
    rerender(<AlertsPage api={testApi({ operationalAlerts: async () => ({ revision: 1, bounded: false, observedAt, items: [{ schemaVersion: 1,
      alertId: "alert-3", severity: "INFO", type: "STALE_KNOWLEDGE", entityRef: "knowledge-1@2", reasonCodes: ["STALE"],
      occurrenceCount: 1, firstObservedAt: observedAt, lastObservedAt: observedAt, alertRevision: 1, revision: 0, deliveryState: "LOCAL_ONLY",
      diagnostic: { reasonCode: "STALE", message: "旧知识", retryable: true } }] }),
      acknowledgeOperationalAlert: async () => { throw new Error("revision conflict"); } })} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "确认已知" }));
    expect(await screen.findByText(/revision conflict/u)).toBeTruthy();
  });

  it("follows the server-issued bounded alert cursor", async () => {
    const query = vi.fn(async (_projectId?: string, cursor?: string) => ({ revision: 1, bounded: cursor === undefined,
      ...(cursor === undefined ? { nextCursor: "cursor-page-2" } : {}), observedAt, items: [] }));
    render(<AlertsPage api={testApi({ operationalAlerts: query })} />);
    const next = await screen.findByRole("button", { name: "查看下一页告警" });
    expect(screen.getByText("当前结果已按安全上限分页。")).toBeTruthy();
    await userEvent.setup().click(next);
    expect(query).toHaveBeenLastCalledWith(undefined, "cursor-page-2", expect.any(AbortSignal));
  });
});
