// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConsoleApiError,
  type CaptureCommitResult,
  type CapturePreview,
  type ConsoleApi,
} from "../../api/client.js";
import { CapturePanel } from "./CapturePanel.js";

const timestamp = "2026-08-03T12:00:00.000Z";
const preview: CapturePreview = {
  schemaVersion: 1,
  sessionId: "session-1",
  previewRevision: 7,
  transcriptIdentityHash: "a".repeat(64),
  projectedEvents: 3,
  ignoredRecords: 1,
  eventTypes: { USER_PROMPT: 2, ASSISTANT_FINAL: 1 },
  cursor: { byteOffset: 400, lineNumber: 8 },
  hasMore: false,
  expiresAt: "2099-08-03T12:00:00.000Z",
};
const result: CaptureCommitResult = {
  schemaVersion: 1,
  sessionId: "session-1",
  previewRevision: 7,
  appendedEvents: 3,
  duplicateEvents: 0,
  cursor: { byteOffset: 400, lineNumber: 8 },
  knowledgeCompileStage: {
    schemaVersion: 1,
    entityId: "session-1",
    stage: "KNOWLEDGE_COMPILE",
    status: "DISABLED",
    reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED",
    observedAt: timestamp,
    lastTransitionAt: timestamp,
    retryable: false,
    evidenceRefs: [],
  },
};

function apiWith(overrides: Partial<ConsoleApi> = {}): ConsoleApi {
  return {
    overview: async () => { throw new Error("unused"); },
    capabilities: async () => ({ items: [] }),
    sessions: async () => ({ items: [] }),
    session: async () => { throw new Error("unused"); },
    events: async () => ({ items: [] }),
    jobs: async () => ({ items: [] }),
    diagnostics: async () => { throw new Error("unused"); },
    previewCapture: async () => preview,
    commitCapture: async () => result,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("CapturePanel", () => {
  it("remains read-only until preview and explicit commit, then reports the real disabled compile stage", async () => {
    const user = userEvent.setup();
    const previewCapture = vi.fn(async () => preview);
    const commitCapture = vi.fn(async () => result);
    render(<CapturePanel api={apiWith({ previewCapture, commitCapture })} sessionId="session-1" sourceAvailable />);

    expect(screen.getByText(/只有确认提交后才写入/u)).toBeTruthy();
    expect(commitCapture).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "生成采集预览" }));
    expect(await screen.findByRole("heading", { name: "采集影响预览" })).toBeTruthy();
    expect(screen.getByText("USER_PROMPT")).toBeTruthy();
    expect(screen.getByText(/正式提交前不会修改/u)).toBeTruthy();
    expect(commitCapture).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认写入 Ledger" }));
    expect(await screen.findByText("采集提交完成")).toBeTruthy();
    expect(screen.getByText(/仅完成对话事件沉淀到 Ledger/u)).toBeTruthy();
    expect(screen.getByText("KNOWLEDGE_WORKER_NOT_COMPOSED")).toBeTruthy();
    expect(commitCapture).toHaveBeenCalledWith({
      sessionId: "session-1",
      previewRevision: 7,
      transcriptIdentityHash: "a".repeat(64),
      idempotencyKey: `capture:7:${"a".repeat(32)}`,
    });
    expect(document.body.textContent).not.toContain("knowledgeCompiled");
  });

  it("invalidates stale previews and requires a new preview", async () => {
    const user = userEvent.setup();
    const previewCapture = vi.fn(async () => preview);
    const commitCapture = vi.fn(async () => { throw new ConsoleApiError("STALE_REVISION", "stale", false); });
    render(<CapturePanel api={apiWith({ previewCapture, commitCapture })} sessionId="session-1" sourceAvailable />);
    await user.click(screen.getByRole("button", { name: "生成采集预览" }));
    await user.click(await screen.findByRole("button", { name: "确认写入 Ledger" }));
    expect((await screen.findByRole("alert")).textContent).toContain("预览后会话来源发生变化");
    expect(screen.queryByRole("button", { name: "确认写入 Ledger" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "重新生成预览" }));
    expect(previewCapture).toHaveBeenCalledTimes(2);
  });

  it("shows duplicate/idempotent completion without claiming a second write", async () => {
    const user = userEvent.setup();
    render(<CapturePanel api={apiWith({ commitCapture: async () => ({ ...result, appendedEvents: 0, duplicateEvents: 3 }) })} sessionId="session-1" sourceAvailable />);
    await user.click(screen.getByRole("button", { name: "生成采集预览" }));
    await user.click(await screen.findByRole("button", { name: "确认写入 Ledger" }));
    expect(await screen.findByText(/已提交过/u)).toBeTruthy();
    expect(screen.getByText(/未重复写入/u)).toBeTruthy();
  });

  it("keeps the preview and same idempotency key when an unavailable Sidecar is retried", async () => {
    const user = userEvent.setup();
    const commands: unknown[] = [];
    const commitCapture = vi.fn(async (command) => {
      commands.push(command);
      if (commands.length === 1) throw new ConsoleApiError("SIDECAR_UNAVAILABLE", "Unavailable", true);
      return result;
    });
    render(<CapturePanel api={apiWith({ commitCapture })} sessionId="session-1" sourceAvailable />);
    await user.click(screen.getByRole("button", { name: "生成采集预览" }));
    await user.click(await screen.findByRole("button", { name: "确认写入 Ledger" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Sidecar 暂时不可用");
    await user.click(screen.getByRole("button", { name: "使用同一幂等键重试" }));
    expect(await screen.findByText("采集提交完成")).toBeTruthy();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });

  it("shows an unavailable Sidecar before preview without enabling a commit action", async () => {
    const user = userEvent.setup();
    const previewCapture = vi.fn(async () => { throw new ConsoleApiError("SIDECAR_UNAVAILABLE", "Unavailable", true); });
    render(<CapturePanel api={apiWith({ previewCapture })} sessionId="session-1" sourceAvailable />);
    await user.click(screen.getByRole("button", { name: "生成采集预览" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Sidecar 暂时不可用");
    expect(screen.queryByRole("button", { name: "确认写入 Ledger" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新生成预览" })).toBeTruthy();
  });

  it("disables capture when the observed Codex source is unavailable", () => {
    const previewCapture = vi.fn(async () => preview);
    render(<CapturePanel api={apiWith({ previewCapture })} sessionId="session-1" sourceAvailable={false} />);
    expect((screen.getByRole("button", { name: "生成采集预览" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("会话来源不可用")).toBeTruthy();
    expect(previewCapture).not.toHaveBeenCalled();
  });
});
