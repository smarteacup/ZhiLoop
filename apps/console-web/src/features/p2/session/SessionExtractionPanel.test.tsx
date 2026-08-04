// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleApiError, type ConsoleApi } from "../../../api/client.js";
import type { SessionExtractionView } from "../../../api/p2.js";
import { SessionExtractionPanel } from "./SessionExtractionPanel.js";

const observedAt = "2026-08-04T10:00:00.000Z";
const ready = { schemaVersion: 1 as const, capabilityId: "knowledge.compiler", status: "READY" as const, reasonCode: "COMPONENT_READY" as const, observedAt, lastTransitionAt: observedAt, retryable: false, evidenceRefs: [] };
const view: SessionExtractionView = {
  sessionId: "session-1", revision: 7,
  snapshot: { snapshotId: "snapshot-7", revision: 7, completeness: "PARTIAL_SNAPSHOT", sourceSequenceFrom: 1, sourceSequenceThrough: 42, compilerVersion: "compiler-2", policyHash: "policy-hash", createdAt: observedAt, unsupportedEventTypes: ["TOOL_STREAM_DELTA"] },
  stages: [{ stage: "EPISODE_BUILD", status: "SUCCEEDED", reasonCode: "STAGE_COMPLETE", retryable: false, completedUnits: 3, totalUnits: 3 }, { stage: "EVIDENCE", status: "DEGRADED", reasonCode: "EVIDENCE_PARTIAL", retryable: true }],
  candidates: [{ candidateId: "candidate-1", subjectKey: "symbol:Compiler", kind: "DECISION", title: "Compiler boundary", summary: "Keep evidence at the boundary", scope: "PROJECT", confidence: 0.88, status: "PROPOSED", evidenceVerdict: "INCONCLUSIVE", policy: { action: "KEEP_PROPOSED", targetStatus: "PROPOSED", shouldPublish: false, reasonCodes: ["EVIDENCE_PARTIAL"] }, provenance: { sessionIds: ["session-1"], turnIds: ["turn-2"], eventIds: ["event-4"], snapshotIds: ["snapshot-7"], episodeIds: ["episode-1"], knowledgeVersions: [{ knowledgeId: "knowledge-1", version: 2 }] } }],
  reverseProvenance: [],
  extractAction: { enabled: true, expectedRevision: 7, idempotencyKey: "extract:session-1:7", reasonCode: "ACTION_READY" },
  commitAction: { enabled: true, expectedRevision: 1, idempotencyKey: "commit:preview-1:1", reasonCode: "ACTION_READY" },
  previewId: "preview-1",
};

function apiWith(overrides: Partial<ConsoleApi> = {}): ConsoleApi {
  return {
    overview: async () => { throw new Error("unused"); }, capabilities: async () => ({ items: [ready] }), sessions: async () => ({ items: [] }), session: async () => { throw new Error("unused"); }, events: async () => ({ items: [] }), jobs: async () => ({ items: [] }), diagnostics: async () => { throw new Error("unused"); }, previewCapture: async () => { throw new Error("unused"); }, commitCapture: async () => { throw new Error("unused"); }, sessionExtraction: async () => view,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("SessionExtractionPanel", () => {
  it("renders partial snapshot, unsupported events, policy and bidirectional provenance", async () => {
    render(<SessionExtractionPanel api={apiWith()} sessionId="session-1" captureCurrent />);
    expect(await screen.findByRole("heading", { name: "会话知识提取" })).toBeTruthy();
    expect(screen.getAllByText("部分快照").length).toBeGreaterThan(0);
    expect(screen.getByText(/工具流式增量事件/u)).toBeTruthy();
    expect(screen.getByText(/保留为候选/u)).toBeTruthy();
    expect(screen.getByText(/技术决策/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "knowledge-1@2" }).getAttribute("href")).toBe("#/knowledge/knowledge-1");
  });

  it("uses the server expected revision and idempotency key when activated by keyboard", async () => {
    const start = vi.fn(async () => ({ ...view, revision: 8 }));
    const user = userEvent.setup();
    render(<SessionExtractionPanel api={apiWith({ startSessionExtraction: start })} sessionId="session-1" captureCurrent />);
    const button = await screen.findByRole("button", { name: "提取当前会话快照" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(start).toHaveBeenCalledWith({ sessionId: "session-1", expectedRevision: 7, idempotencyKey: "extract:session-1:7" });
    expect(await screen.findByText(/服务端最新 revision/u)).toBeTruthy();
  });

  it("does not query extraction when the actual capability is not verified", async () => {
    const query = vi.fn(async () => view);
    render(<SessionExtractionPanel api={apiWith({ capabilities: async () => ({ items: [{ ...ready, status: "NOT_VERIFIED", reasonCode: "CAPABILITY_NOT_VERIFIED" }] }), sessionExtraction: query })} sessionId="session-1" captureCurrent />);
    expect(await screen.findByText("能力尚未验证")).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it("shows the real retry-wait failure reason, attempt count and next retry", async () => {
    const retryAt = "2026-08-04T10:01:00.000Z";
    const retrying: SessionExtractionView = {
      ...view,
      stages: [{
        stage: "CANDIDATE_PREVIEW", status: "RETRY_WAIT", reasonCode: "KNOWLEDGE_PREVIEW_INCOMPLETE", retryable: true,
        jobId: "job-preview-1", attempt: 1, maxAttempts: 5, nextAttemptAt: retryAt,
        failure: { code: "KNOWLEDGE_PREVIEW_INCOMPLETE", retryable: true, occurredAt: observedAt },
      }],
      candidates: [], previewId: undefined,
      commitAction: { enabled: false, expectedRevision: 0, idempotencyKey: "commit:unavailable", reasonCode: "PREVIEW_NOT_READY" },
    };
    render(<SessionExtractionPanel api={apiWith({ sessionExtraction: async () => retrying })} sessionId="session-1" captureCurrent />);
    expect(await screen.findByText(/候选知识生成结果不完整/u, { selector: "small" })).toBeTruthy();
    expect(screen.getByText(/后台闭环没有产出可提交的候选策略结果/u)).toBeTruthy();
    expect(screen.getByText(/已尝试 1\/5 次/u)).toBeTruthy();
    expect(screen.getByText("KNOWLEDGE_PREVIEW_INCOMPLETE", { selector: "code" })).toBeTruthy();
  });

  it("refreshes a stale revision once and retries with the latest server gate", async () => {
    const user = userEvent.setup();
    const refreshed = { ...view, revision: 8, extractAction: { ...view.extractAction, expectedRevision: 8, idempotencyKey: "extract:session-1:8" } };
    const query = vi.fn(async () => query.mock.calls.length === 1 ? view : refreshed);
    const start = vi.fn()
      .mockRejectedValueOnce(new ConsoleApiError("STALE_REVISION", "stale", false))
      .mockResolvedValueOnce({ ...refreshed, revision: 9 });
    render(<SessionExtractionPanel api={apiWith({ sessionExtraction: query, startSessionExtraction: start })} sessionId="session-1" captureCurrent />);
    await user.click(await screen.findByRole("button", { name: "提取当前会话快照" }));
    expect((await screen.findByRole("status")).textContent).toContain("已自动刷新");
    expect(start).toHaveBeenNthCalledWith(1, { sessionId: "session-1", expectedRevision: 7, idempotencyKey: "extract:session-1:7" });
    expect(start).toHaveBeenNthCalledWith(2, { sessionId: "session-1", expectedRevision: 8, idempotencyKey: "extract:session-1:8" });
  });

  it("stops after one automatic refresh when the refreshed gate is disabled", async () => {
    const user = userEvent.setup();
    const refreshed = {
      ...view,
      revision: 8,
      extractAction: { ...view.extractAction, enabled: false, expectedRevision: 8, idempotencyKey: "extract:session-1:8" },
    };
    const query = vi.fn(async () => query.mock.calls.length === 1 ? view : refreshed);
    const start = vi.fn().mockRejectedValue(new ConsoleApiError("STALE_REVISION", "stale", false));
    render(<SessionExtractionPanel api={apiWith({ sessionExtraction: query, startSessionExtraction: start })} sessionId="session-1" captureCurrent />);
    await user.click(await screen.findByRole("button", { name: "提取当前会话快照" }));
    expect((await screen.findByRole("status")).textContent).toContain("自动刷新后仍发生冲突");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("shows an unexpected extraction failure without discarding its diagnostic message", async () => {
    const user = userEvent.setup();
    render(<SessionExtractionPanel api={apiWith({ startSessionExtraction: async () => { throw new Error("model offline"); } })} sessionId="session-1" captureCurrent />);
    await user.click(await screen.findByRole("button", { name: "提取当前会话快照" }));
    expect((await screen.findByRole("status")).textContent).toContain("model offline");
  });

  it("explains that a capture conflict must be resolved before extraction", async () => {
    const user = userEvent.setup();
    render(<SessionExtractionPanel api={apiWith({ startSessionExtraction: async () => { throw new ConsoleApiError("CONFLICT", "conflict", false); } })} sessionId="session-1" captureCurrent />);
    await user.click(await screen.findByRole("button", { name: "提取当前会话快照" }));
    expect((await screen.findByRole("status")).textContent).toContain("主动采集");
  });

  it("blocks extraction until the parent session confirms capture to the current cursor", async () => {
    const start = vi.fn(async () => view);
    render(<SessionExtractionPanel api={apiWith({ startSessionExtraction: start })} sessionId="session-1" captureCurrent={false} />);
    const button = await screen.findByRole("button", { name: "提取当前会话快照" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("CAPTURE_NOT_CURRENT");
    expect(screen.getByText("会话尚未采集至最新")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });
});
