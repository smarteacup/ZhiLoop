// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Diagnostics, JobSnapshot, Overview, SessionSummary } from "@zhiloop/control-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApi, InvalidationHandlers } from "../../../api/client.js";
import { jobIngestionViewModel, P1OperationsPage } from "./P1OperationsPage.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    jobType: "SESSION_CAPTURE",
    status: "RUNNING",
    attempt: 1,
    maxAttempts: 5,
    progress: 0.5,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    checkpoint: { revision: 7, payloadHash: "a".repeat(64), progress: 0.5, updatedAt: timestamp },
    cancellation: { status: "REQUESTED", requestedAt: timestamp },
    reasonCode: "JOB_RUNNING",
    observedAt: timestamp,
    lastTransitionAt: timestamp,
    retryable: false,
    evidenceRefs: ["job:job-1"],
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    title: "Console planning",
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    captureStatus: "CAPTURED_CURRENT",
    firstActivityAt: timestamp,
    lastActivityAt: timestamp,
    eventCount: 10,
    turnCount: 4,
    ignoredRecords: 0,
    redactionCount: 0,
    ...overrides,
  };
}

function diagnostics(overrides: Partial<Diagnostics> = {}): Diagnostics {
  return {
    schemaVersion: 1,
    observedAt: timestamp,
    ledgerSequence: 12,
    spoolDepth: 3,
    consumerLags: [{ consumerId: "knowledge-compiler", sequence: 10, lag: 2, updatedAt: timestamp }],
    worker: { healthy: true, consumed: 10, produced: 9, retryableFailures: 0 },
    storage: { healthy: true, databaseBytes: 4_096 },
    ...overrides,
  };
}

function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    schemaVersion: 1,
    observedAt: timestamp,
    rolloutMode: "SHADOW",
    sidecarVersion: "0.1.4",
    capabilities: [],
    recentSessions: [],
    jobs: { queued: 0, running: 1, retryWait: 0, failed: 0 },
    alertCount: 0,
    ...overrides,
  };
}

function apiWith(overrides: Partial<ConsoleApi> = {}): ConsoleApi {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    overview: async () => overview(),
    capabilities: unused,
    sessions: async () => ({ items: [session()] }),
    session: unused,
    events: unused,
    jobs: async () => ({ items: [job()] }),
    diagnostics: async () => diagnostics(),
    previewCapture: unused,
    commitCapture: unused,
    openInvalidations: () => ({ close: () => undefined }),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("P1OperationsPage", () => {
  it("maps bounded job and session evidence without inventing write commands", async () => {
    const model = jobIngestionViewModel(
      [job()],
      [session(), session({ sessionId: "session-2", captureStatus: "CAPTURED_PARTIAL", sourceStatus: "UNAVAILABLE" })],
      true,
      timestamp,
    );
    expect(model).toMatchObject({
      backlog: { running: 1, cancelRequested: 1 },
      completeness: { catalogCoverage: "BOUNDED", currentSessions: 1, partialSessions: 1, sourceUnavailableSessions: 1 },
    });
    expect(model.completeness.reasonCodes).toEqual(["SESSION_PAGE_BOUNDED", "SOURCE_UNAVAILABLE"]);

    render(<P1OperationsPage api={apiWith()} mode="jobs" />);
    expect(await screen.findByRole("heading", { name: "后台任务" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "SESSION_CAPTURE 进度" }).getAttribute("aria-valuenow")).toBe("50");
    const retry = screen.getByRole("button", { name: "SESSION_CAPTURE 安全重试" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: "SESSION_CAPTURE 请求取消" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(screen.getAllByText(/JOB_COMMAND_CONTRACT_NOT_CONFIGURED/u).length).toBeGreaterThan(0);
  });

  it("enables a safe retry only from the durable job revision and refreshes after the command", async () => {
    const retryJob = vi.fn(async () => ({
      schemaVersion: 1 as const,
      action: "RETRY" as const,
      disposition: "APPLIED" as const,
      job: job({ revision: 10, status: "QUEUED", cancellation: { status: "NOT_REQUESTED" } }),
    }));
    const failed = job({
      revision: 9,
      status: "FAILED",
      cancellation: { status: "NOT_REQUESTED" },
      lastFailure: { code: "SOURCE_UNAVAILABLE", retryable: true, occurredAt: timestamp },
      reasonCode: "JOB_MAX_ATTEMPTS_EXHAUSTED",
    });
    render(<P1OperationsPage api={apiWith({
      jobs: async () => ({ items: [failed] }),
      overview: async () => overview({ capabilities: [{
        schemaVersion: 1, capabilityId: "durable.jobs", status: "READY", reasonCode: "COMPONENT_READY",
        observedAt: timestamp, lastTransitionAt: timestamp, retryable: false, evidenceRefs: [],
      }] }),
      retryJob,
      cancelJob: async () => { throw new Error("unused"); },
    })} mode="jobs" />);
    const retry = await screen.findByRole("button", { name: "SESSION_CAPTURE 安全重试" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(retryJob).toHaveBeenCalledWith({
      jobId: "job-1",
      expectedRevision: 9,
      idempotencyKey: "job-retry-9-job-1",
    }));
    expect(await screen.findByText("已提交安全重试请求，等待状态刷新。")).toBeTruthy();
  });

  it("keeps commands disabled for a legacy snapshot without a durable revision even when capability is ready", async () => {
    render(<P1OperationsPage api={apiWith({
      overview: async () => overview({ capabilities: [{
        schemaVersion: 1, capabilityId: "durable.jobs", status: "READY", reasonCode: "COMPONENT_READY",
        observedAt: timestamp, lastTransitionAt: timestamp, retryable: false, evidenceRefs: [],
      }] }),
      cancelJob: async () => { throw new Error("must not execute"); },
      retryJob: async () => { throw new Error("must not execute"); },
    })} mode="jobs" />);
    const cancel = await screen.findByRole("button", { name: "SESSION_CAPTURE 请求取消" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.title).toContain("缺少 revision");
  });

  it("shows typed diagnostics, detailed alerts and degraded capability evidence", async () => {
    const alertDiagnostics = diagnostics({
      worker: { healthy: false, consumed: 10, produced: 9, retryableFailures: 2 },
      storage: { healthy: false, databaseBytes: 8_192 },
      alerts: {
        schemaVersion: 1,
        evaluationId: "c".repeat(64),
        observedAt: timestamp,
        health: "FAILED",
        quietHoursActive: true,
        activeAlerts: [{
          alertId: "alert-1",
          dedupeKey: "jobs:failed",
          entityType: "JOBS",
          entityId: "capture",
          severity: "ERROR",
          reasonCodes: ["JOB_FAILED"],
          observedAt: timestamp,
          observedValue: 12,
          threshold: 10,
          notificationPending: false,
          notificationDelivered: false,
        }],
        transitions: [],
      },
      operationalAlerts: [{
        schemaVersion: 1, alertId: "operational-alert-1", dedupKey: "stale:project-1:asset-1@2",
        severity: "WARNING", type: "STALE_KNOWLEDGE", projectId: "project-1", entityRef: "asset-1@2",
        reasonCodes: ["VERIFICATION_CONFLICT"], occurrenceCount: 3, firstObservedAt: timestamp,
        lastObservedAt: timestamp, revision: 3, deliveryState: "LOCAL_ONLY",
      }],
    });
    const degradedOverview = overview({
      alertCount: 3,
      capabilities: [{ schemaVersion: 1, capabilityId: "knowledge.compiler", status: "DEGRADED", reasonCode: "COMPONENT_DEGRADED", observedAt: timestamp, lastTransitionAt: timestamp, retryable: true, evidenceRefs: [] }],
    });
    render(<P1OperationsPage api={apiWith({ diagnostics: async () => alertDiagnostics, overview: async () => degradedOverview })} mode="diagnostics" />);
    expect(await screen.findByRole("heading", { name: "诊断与告警" })).toBeTruthy();
    expect(screen.getByText("后台 Worker 异常")).toBeTruthy();
    expect(screen.getByText("本地存储异常")).toBeTruthy();
    expect(screen.getByText("JOBS · capture")).toBeTruthy();
    expect(screen.getByText(/观测值 12，阈值 10/u)).toBeTruthy();
    expect(screen.getByText("发现过期知识 · asset-1@2")).toBeTruthy();
    expect(screen.getByText(/仅本地记录 · 累计 3 次/u)).toBeTruthy();
    expect(screen.getByText("1 个未展开活动告警")).toBeTruthy();
    expect(screen.getByText("knowledge.compiler")).toBeTruthy();
  });

  it("refetches invalidated resources after the debounce and closes the live subscription", async () => {
    let handlers: InvalidationHandlers | undefined;
    const close = vi.fn();
    const jobs = vi.fn(async () => ({ items: [job()] }));
    const api = apiWith({
      jobs,
      openInvalidations: (next) => {
        handlers = next;
        return { close };
      },
    });
    const view = render(<P1OperationsPage api={api} />);
    await screen.findByRole("heading", { name: "任务、采集与诊断" });
    expect(jobs).toHaveBeenCalledOnce();
    act(() => handlers?.onEvent({ schemaVersion: 1, eventId: "event-1", type: "job.updated", entityId: "job-1", revision: 1, occurredAt: timestamp }));
    await waitFor(() => expect(jobs).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/revision 1/u)).toBeTruthy();
    view.unmount();
    expect(close).toHaveBeenCalledOnce();
  });
});
