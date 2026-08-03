// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RevisionActionGate } from "../actionGuard.js";
import { JobIngestionPanel, type JobCommandPort, type JobIngestionViewModel, type JobRowViewModel } from "./JobIngestionPanel.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function gate(currentRevision: number, overrides: Partial<RevisionActionGate> = {}): RevisionActionGate {
  return {
    capability: { status: "READY", reasonCode: "READY", observedAt: timestamp },
    allowed: true,
    expectedRevision: currentRevision,
    currentRevision,
    idempotencyKey: `job-action-${currentRevision}`,
    ...overrides,
  };
}

function job(overrides: Partial<JobRowViewModel> = {}): JobRowViewModel {
  return {
    jobId: "job-1",
    revision: 7,
    jobType: "SESSION_FOLLOW",
    status: "RUNNING",
    progress: 0.35,
    completedUnits: 35,
    totalUnits: 100,
    checkpoint: "cursor:35",
    attempts: [{ attempt: 1, status: "RUNNING", startedAt: timestamp, retryable: false, checkpoint: "cursor:35" }],
    retry: gate(7),
    cancel: gate(7),
    ...overrides,
  };
}

function viewModel(jobs: readonly JobRowViewModel[] = [job()]): JobIngestionViewModel {
  return {
    observedAt: timestamp,
    backlog: { queued: 4, running: 1, retryWait: 2, cancelRequested: 0 },
    jobs,
    completeness: {
      catalogCoverage: "BOUNDED",
      relationCoverage: "NOT_CONFIGURED",
      currentSessions: 10,
      partialSessions: 2,
      pendingSessions: 4,
      sourceUnavailableSessions: 1,
      reasonCodes: ["SESSION_SCAN_BOUNDED", "REAL_CODEX_TASK_NOT_VERIFIED"],
    },
  };
}

function commands(): { readonly port: JobCommandPort; readonly retry: ReturnType<typeof vi.fn>; readonly cancel: ReturnType<typeof vi.fn> } {
  const retry = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  return { port: { retry, cancel }, retry, cancel };
}

afterEach(() => cleanup());

describe("JobIngestionPanel", () => {
  it("shows bounded backlog, progress, attempts, last success and completeness without claiming full coverage", () => {
    render(<JobIngestionPanel viewModel={viewModel()} />);
    expect(screen.getByRole("progressbar", { name: "SESSION_FOLLOW 进度" }).getAttribute("aria-valuenow")).toBe("35");
    expect(screen.getByText("cursor:35", { exact: false })).toBeTruthy();
    expect(screen.getByText("Attempt 历史（1）")).toBeTruthy();
    expect(screen.getByText("尚未成功")).toBeTruthy();
    expect(screen.getByText("NOT_CONFIGURED")).toBeTruthy();
    expect(screen.getByText("REAL_CODEX_TASK_NOT_VERIFIED")).toBeTruthy();
    expect(screen.getByText("4", { selector: "strong" })).toBeTruthy();
  });

  it("submits cancellation only at a legal state with capability and matching revision", async () => {
    const user = userEvent.setup();
    const command = commands();
    render(<JobIngestionPanel viewModel={viewModel()} commands={command.port} />);
    expect((screen.getByRole("button", { name: "SESSION_FOLLOW 安全重试" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "SESSION_FOLLOW 请求取消" }));
    expect(command.cancel).toHaveBeenCalledWith({ jobId: "job-1", expectedRevision: 7, idempotencyKey: "job-action-7" });
    expect(await screen.findByText(/安全边界停止/u)).toBeTruthy();
    expect(command.retry).not.toHaveBeenCalled();
  });

  it("blocks stale retry and unsafe cancellation even when an upstream allowed flag is true", () => {
    const failed = job({
      status: "FAILED",
      retry: gate(8, { expectedRevision: 7 }),
      cancel: gate(8),
      revision: 8,
    });
    render(<JobIngestionPanel viewModel={viewModel([failed])} commands={commands().port} />);
    const retry = screen.getByRole("button", { name: "SESSION_FOLLOW 安全重试" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: "SESSION_FOLLOW 请求取消" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.title).toContain("revision 已变化");
    expect(cancel.disabled).toBe(true);
    expect(cancel.title).toContain("状态 FAILED 不允许取消");
  });

  it("retries a failed job with the exact guarded revision and idempotency key", async () => {
    const user = userEvent.setup();
    const command = commands();
    const failed = job({ status: "FAILED", retry: gate(7), cancel: gate(7) });
    render(<JobIngestionPanel viewModel={viewModel([failed])} commands={command.port} />);
    await user.click(screen.getByRole("button", { name: "SESSION_FOLLOW 安全重试" }));
    expect(command.retry).toHaveBeenCalledWith({ jobId: "job-1", expectedRevision: 7, idempotencyKey: "job-action-7" });
  });

  it("renders empty and successful completeness branches and clamps invalid progress", () => {
    const complete = viewModel([]);
    render(<JobIngestionPanel viewModel={{
      ...complete,
      completeness: { ...complete.completeness, lastSuccessfulIngestionAt: timestamp, reasonCodes: [], catalogCoverage: "COMPLETE", relationCoverage: "COMPLETE" },
    }} />);
    expect(screen.getByText("当前没有任务。")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "采集完整性诊断" })).toBeNull();

    cleanup();
    render(<JobIngestionPanel viewModel={viewModel([job({ progress: Number.NaN, checkpoint: undefined, nextRetryAt: timestamp, attempts: [{ attempt: 2, status: "RETRY_WAIT", startedAt: timestamp, reasonCode: "TRANSIENT", retryable: true }] })])} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText(/下次重试/u)).toBeTruthy();
    expect(screen.getByText("TRANSIENT")).toBeTruthy();
  });

  it("surfaces command failures without changing job state locally", async () => {
    const user = userEvent.setup();
    const failed = job({ status: "FAILED" });
    const port: JobCommandPort = { retry: async () => { throw new Error("retry rejected by lease fence"); }, cancel: async () => undefined };
    render(<JobIngestionPanel viewModel={viewModel([failed])} commands={port} />);
    await user.click(screen.getByRole("button", { name: "SESSION_FOLLOW 安全重试" }));
    expect(await screen.findByText("retry rejected by lease fence")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
  });
});
