// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleApi } from "../api/client.js";
import { App } from "./App.js";

const timestamp = "2026-08-03T12:00:00.000Z";
const capability = {
  schemaVersion: 1 as const,
  capabilityId: "conversation.ledger",
  status: "READY" as const,
  reasonCode: "COMPONENT_READY" as const,
  observedAt: timestamp,
  lastTransitionAt: timestamp,
  retryable: false,
  evidenceRefs: ["sidecar:ready"],
};
const session = {
  schemaVersion: 1 as const,
  sessionId: "session-1",
  title: "Console planning",
  source: "CODEX_TRANSCRIPT" as const,
  sourceStatus: "AVAILABLE" as const,
  captureStatus: "DISCOVERED_NOT_CAPTURED" as const,
  firstActivityAt: timestamp,
  lastActivityAt: timestamp,
  eventCount: 0,
  turnCount: 0,
  ignoredRecords: 0,
  redactionCount: 0,
};
const api: ConsoleApi = {
  overview: async () => ({ schemaVersion: 1, observedAt: timestamp, rolloutMode: "SHADOW", sidecarVersion: "0.1.4", capabilities: [capability], recentSessions: [session], jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 }, alertCount: 0 }),
  capabilities: async () => ({ items: [capability] }),
  sessions: async () => ({ items: [session] }),
  session: async () => ({ summary: session, stages: [], injections: [] }),
  events: async () => ({ items: [] }),
  jobs: async () => ({ items: [] }),
  diagnostics: async () => ({ schemaVersion: 1, observedAt: timestamp, ledgerSequence: 0, spoolDepth: 0, consumerLags: [], worker: { healthy: true, consumed: 0, produced: 0, retryableFailures: 0 }, storage: { healthy: true, databaseBytes: 4096 } }),
};

afterEach(() => cleanup());

describe("Console application shell", () => {
  it("renders accessible navigation and evidence-backed overview", async () => {
    window.location.hash = "#/overview";
    render(<App api={api} />);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "运行总览" })).toBeTruthy();
    expect(screen.getByText("conversation.ledger")).toBeTruthy();
    expect(screen.getByText("SHADOW")).toBeTruthy();
  });

  it("supports keyboard navigation and shows honest disabled capability state", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/overview";
    render(<App api={api} />);
    const link = screen.getByRole("link", { name: "知识库" });
    link.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "知识库尚未接通" })).toBeTruthy();
    expect(screen.getByText(/KNOWLEDGE_WORKER_NOT_COMPOSED/)).toBeTruthy();
  });

  it("shows read-only event metadata without rendering raw payload", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/sessions/session-1";
    render(<App api={{ ...api, events: async () => ({ items: [{ schemaVersion: 1, sequence: 1, eventId: "event-1", eventType: "USER_PROMPT", source: "CODEX", sessionId: "session-1", occurredAt: timestamp, correlationId: "corr-1", contentHash: "a".repeat(64), redactionCount: 1, payloadPurged: false }] }) }} />);
    await user.click(await screen.findByRole("tab", { name: "事件元数据" }));
    expect(screen.getByText("#1 · USER_PROMPT")).toBeTruthy();
    expect(screen.getByText("仅展示脱敏索引，不展示原始 Prompt")).toBeTruthy();
    expect(document.body.textContent).not.toContain("raw payload");
  });

  it("renders session filtering, operations and deployment from typed fixtures", async () => {
    window.location.hash = "#/sessions";
    const { unmount } = render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "会话与采集" })).toBeTruthy();
    expect(screen.getByLabelText("项目")).toBeTruthy();
    unmount();

    window.location.hash = "#/operations";
    const operations = render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "任务与诊断" })).toBeTruthy();
    expect(screen.getByText("当前没有后台任务。")).toBeTruthy();
    operations.unmount();

    window.location.hash = "#/deployment";
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "部署与能力" })).toBeTruthy();
    expect(screen.getByText("conversation.ledger")).toBeTruthy();
  });
});
