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
const configuration = {
  schemaVersion: 1 as const,
  runtime: {
    sessionScanIntervalMs: 60_000, followDebounceMs: 1_000, workerPollIntervalMs: 1_000, extractionDelayMs: 300_000,
    workerConcurrency: 2, scanBatchSize: 100, captureBatchSize: 100,
    captureRetry: { maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 },
    alerts: {
      enabled: true, notify: false, minimumSeverity: "WARNING" as const,
      spoolDepth: { warning: 100, error: 1_000 }, spoolOldestAgeMs: { warning: 60_000, error: 600_000 },
      cursorLagEvents: { warning: 1_000, error: 10_000 }, failedJobs: { warning: 1, error: 10 }, hookSilenceMs: { warning: 3_600_000, error: 21_600_000 },
      quietHours: { enabled: false, startMinute: 1_320, endMinute: 480, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], utcOffsetMinutes: 480 },
    },
  },
  future: { injectionMaxTokens: 800, compilerBatchSize: 50, codexQueryTimeoutMs: 30_000, codexQueryConcurrency: 2 },
};
const api: ConsoleApi = {
  overview: async () => ({ schemaVersion: 1, observedAt: timestamp, rolloutMode: "SHADOW", sidecarVersion: "0.1.4", capabilities: [capability], recentSessions: [session], jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 }, alertCount: 0 }),
  capabilities: async () => ({ items: [capability] }),
  sessions: async () => ({ items: [session] }),
  session: async () => ({ summary: session, stages: [], injections: [] }),
  events: async () => ({ items: [] }),
  jobs: async () => ({ items: [] }),
  diagnostics: async () => ({ schemaVersion: 1, observedAt: timestamp, ledgerSequence: 0, spoolDepth: 0, consumerLags: [], worker: { healthy: true, consumed: 0, produced: 0, retryableFailures: 0 }, storage: { healthy: true, databaseBytes: 4096 } }),
  configuration: async () => ({ view: { schemaVersion: 1, revision: 1, hash: "a".repeat(64), effective: configuration, sources: {} }, drafts: [], history: [] }),
  previewCapture: async () => ({ schemaVersion: 1, sessionId: "session-1", previewRevision: 1, transcriptIdentityHash: "a".repeat(64), projectedEvents: 0, ignoredRecords: 0, eventTypes: {}, cursor: { byteOffset: 0, lineNumber: 0 }, hasMore: false, expiresAt: "2099-08-03T12:00:00.000Z" }),
  commitCapture: async (command) => ({ schemaVersion: 1, sessionId: command.sessionId, previewRevision: command.previewRevision, appendedEvents: 0, duplicateEvents: 0, cursor: { byteOffset: 0, lineNumber: 0 }, knowledgeCompileStage: { schemaVersion: 1, entityId: command.sessionId, stage: "KNOWLEDGE_COMPILE", status: "DISABLED", reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED", observedAt: timestamp, lastTransitionAt: timestamp, retryable: false, evidenceRefs: [] } }),
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
    expect(await screen.findByRole("heading", { name: "知识查询不可用" })).toBeTruthy();
    expect(screen.getByText(/CAPABILITY_NOT_REPORTED/)).toBeTruthy();
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
    expect(await screen.findByRole("heading", { name: "任务、采集与诊断" })).toBeTruthy();
    expect(screen.getByText("当前没有任务。")).toBeTruthy();
    operations.unmount();

    window.location.hash = "#/deployment";
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "部署与能力" })).toBeTruthy();
    expect(screen.getByText("conversation.ledger")).toBeTruthy();
  });

  it("routes the P1 jobs, diagnostics and configuration views", async () => {
    window.location.hash = "#/jobs";
    const jobs = render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "后台任务" })).toBeTruthy();
    expect(screen.getByText("当前没有任务。")).toBeTruthy();
    jobs.unmount();

    window.location.hash = "#/diagnostics";
    const diagnostics = render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "诊断与告警" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "实时更新" })).toBeTruthy();
    diagnostics.unmount();

    window.location.hash = "#/configuration";
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "有效配置与草稿" })).toBeTruthy();
    expect(screen.getByText("VALIDATED_DRAFT_NOT_AVAILABLE")).toBeTruthy();
  });
});
