// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeGraphPage } from "./CodeGraphPage.js";
import { codeGraphPage, observedAt, testApi } from "./test-api.js";

afterEach(() => cleanup());

describe("CodeGraphPage", () => {
  it("keeps repository paths server-owned and uses explicit preview then commit", async () => {
    const preview = { schemaVersion: 1 as const, previewId: "preview-1", projectId: "project-1", repositoryIdentity: "a".repeat(64),
      repositoryRootLabel: "repo", targetDirectoryLabel: "repo/.codegraph", expectedRevision: 0, providerVersion: "0.9.3",
      currentStatus: "NOT_CONFIGURED" as const, riskCodes: ["WRITES_CODEGRAPH_INDEX"], createdAt: observedAt, expiresAt: "2026-08-19T02:05:00.000Z" };
    const commit = vi.fn(async () => ({ preview, job: { schemaVersion: 1 as const, jobId: "job-1", jobType: "CODEGRAPH_INITIALIZE",
      revision: 1, status: "QUEUED" as const, attempt: 0, maxAttempts: 5, progress: 0, reasonCode: "JOB_QUEUED" as const, observedAt,
      lastTransitionAt: observedAt, retryable: false, evidenceRefs: [] } }));
    render(<CodeGraphPage api={testApi({ codeGraphProjects: async () => codeGraphPage,
      previewCodeGraphInitialization: async () => preview, commitCodeGraphInitialization: commit })} />);
    const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "生成初始化预览" }));
    expect(screen.getByText(/repo\/\.codegraph/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认创建 CodeGraph 初始化任务" }));
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", expectedRevision: 0,
      repositoryIdentity: "a".repeat(64) }));
    expect(screen.queryByLabelText(/路径/u)).toBeNull();
  });

  it("shows empty and query failure states", async () => {
    const { rerender } = render(<CodeGraphPage api={testApi({ codeGraphProjects: async () => ({ revision: 0, items: [], bounded: false, observedAt }) })} />);
    expect(await screen.findByText("尚无已观察项目")).toBeTruthy();
    rerender(<CodeGraphPage api={testApi({ codeGraphProjects: async () => { throw new Error("codegraph query failed"); } })} />);
    expect(await screen.findByText(/codegraph query failed/u)).toBeTruthy();
    rerender(<CodeGraphPage api={testApi({})} />);
    expect(await screen.findByText("CodeGraph 控制能力尚未接通")).toBeTruthy();
  });

  it("reports an unknown commit failure after a successful preview", async () => {
    const preview = { schemaVersion: 1 as const, previewId: "preview-failure", projectId: "project-1", repositoryIdentity: "a".repeat(64),
      repositoryRootLabel: "repo", targetDirectoryLabel: "repo/.codegraph", expectedRevision: 0, providerVersion: "0.9.3",
      currentStatus: "NOT_CONFIGURED" as const, riskCodes: ["WRITES_CODEGRAPH_INDEX"], createdAt: observedAt, expiresAt: "2099-08-19T02:05:00.000Z" };
    render(<CodeGraphPage api={testApi({ codeGraphProjects: async () => codeGraphPage,
      previewCodeGraphInitialization: async () => preview, commitCodeGraphInitialization: async () => { throw "unknown"; } })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "生成初始化预览" }));
    await user.click(screen.getByRole("button", { name: "确认创建 CodeGraph 初始化任务" }));
    expect(await screen.findByText("提交失败")).toBeTruthy();
  });

  it("uses safe fallbacks for missing provider metadata and unknown preview failures", async () => {
    render(<CodeGraphPage api={testApi({ codeGraphProjects: async () => ({ ...codeGraphPage,
      items: [{ ...codeGraphPage.items[0]!, providerVersion: undefined }] }),
      previewCodeGraphInitialization: async () => { throw "unknown"; } })} />);
    expect(await screen.findByText("未检测")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "生成初始化预览" }));
    expect(await screen.findByText("预览失败")).toBeTruthy();
  });

  it("renders retry diagnostics and retries a failed durable job", async () => {
    const retry = vi.fn(async () => ({ schemaVersion: 1 as const, action: "RETRY" as const, disposition: "APPLIED" as const,
      job: { schemaVersion: 1 as const, jobId: "job-failed", jobType: "CODEGRAPH_INITIALIZE", revision: 5,
        status: "QUEUED" as const, attempt: 1, maxAttempts: 3, progress: 0, reasonCode: "JOB_QUEUED" as const,
        observedAt, lastTransitionAt: observedAt, retryable: false, evidenceRefs: [] } }));
    render(<CodeGraphPage api={testApi({ codeGraphProjects: async () => ({ ...codeGraphPage, revision: 4, items: [{ ...codeGraphPage.items[0]!,
      status: "FAILED" as const, reasonCode: "CODEGRAPH_INIT_FAILED", revision: 4, latestJob: { schemaVersion: 1, jobId: "job-failed",
        jobType: "CODEGRAPH_INITIALIZE", revision: 4, status: "FAILED", attempt: 3, maxAttempts: 3, progress: 50,
        reasonCode: "JOB_FAILED", observedAt, lastTransitionAt: observedAt, retryable: true, evidenceRefs: [],
        lastFailure: { code: "CODEGRAPH_TIMEOUT", retryable: true, occurredAt: observedAt } } }] }), retryJob: retry,
      previewCodeGraphInitialization: async () => { throw new Error("preview failed"); } })} />);
    const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "重试失败任务" }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-failed", expectedRevision: 4 }));
    await user.click(screen.getByRole("button", { name: "生成初始化预览" })); expect(await screen.findByText(/preview failed/u)).toBeTruthy();
  });
});
