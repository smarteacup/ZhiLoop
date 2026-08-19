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
  candidates: [{ candidateId: "candidate-1", subjectKey: "symbol:Compiler", kind: "DECISION", title: "Compiler boundary", summary: "Keep evidence at the boundary", body: "# Compiler boundary\n\nKeep evidence at the boundary.", scope: "PROJECT", confidence: 0.88, status: "PROPOSED", evidenceVerdict: "INCONCLUSIVE", localization: { claimMode: "USER_DECISION", projectId: "project-1", repositoryRemote: "example/project", observedBranch: "main", observedCommit: "abcdef1", dirty: false, branchMode: "EXACT_BRANCH", branchValue: "main", scenarioId: "scenario:project-1:compiler.boundary", scenarioKey: "compiler.boundary", scenarioTitle: "维护编译器边界", scenarioSummary: "在编译器边界维护证据。", taskIntents: ["调整编译器证据"], entryPoints: ["Compiler"], applicability: ["项目主分支"], nonApplicability: ["其他项目"], modulePaths: ["packages/compiler"], symbols: ["Compiler"] }, policy: { action: "KEEP_PROPOSED", targetStatus: "PROPOSED", shouldPublish: false, reasonCodes: ["EVIDENCE_PARTIAL"] }, assertions: [{ assertionId: "assertion-1", kind: "SYMBOL_EXISTS", target: "{\"symbol\":\"Compiler\"}" }], evidenceChecks: [{ assertionId: "assertion-1", kind: "SYMBOL_EXISTS", status: "SUPPORTED", reasonCodes: ["SYMBOL_FOUND"], codeGraphArtifact: { artifactId: "artifact-1", operation: "SYMBOL", status: "ACTIVE", codeRevision: "abcdef1", graphRevision: "graph-1", query: "Compiler", factCount: 1, bounded: true, reasonCodes: ["CODEGRAPH_QUERY_SUPPORTED"] } }], commitments: [{ signalId: "signal-1", kind: "USER_ACCEPTED", turnId: "turn-2", statementRef: "statement-1", statement: "就按这个方案", occurredAt: observedAt, reasonCodes: ["EXPLICIT_TOPIC_MATCH"] }], evolution: { status: "DECIDED", action: "SUPPLEMENT", targetKnowledgeVersions: [{ knowledgeId: "knowledge-1", version: 2 }], confidence: 0.9, requiresConfirmation: false, reasonCodes: ["SUBJECT_MATCH"] }, provenance: { sessionIds: ["session-1"], turnIds: ["turn-2"], eventIds: ["event-4"], snapshotIds: ["snapshot-7"], episodeIds: ["episode-1"], knowledgeVersions: [{ knowledgeId: "knowledge-1", version: 2 }] } }],
  commitmentAmbiguities: [],
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
  it("renders partial snapshot, candidate body, commitments, evolution and bidirectional provenance", async () => {
    const user = userEvent.setup();
    render(<SessionExtractionPanel api={apiWith()} sessionId="session-1" captureCurrent />);
    expect(await screen.findByRole("heading", { name: "会话知识提取" })).toBeTruthy();
    expect(screen.getAllByText("部分快照").length).toBeGreaterThan(0);
    expect(screen.getByText(/工具流式增量事件/u)).toBeTruthy();
    expect(screen.getByText(/保留为候选/u)).toBeTruthy();
    expect(screen.getByText(/技术决策/u)).toBeTruthy();
    await user.click(screen.getByText("项目、分支与使用场景"));
    expect(screen.getByText("维护编译器边界")).toBeTruthy();
    expect(screen.getAllByText("main")).toHaveLength(2);
    await user.click(screen.getByText("候选正文、断言与用户承诺"));
    expect(screen.getByText(/Keep evidence at the boundary\./u)).toBeTruthy();
    expect(screen.getByText(/用户已明确接受/u)).toBeTruthy();
    expect(screen.getByText(/CodeGraph SYMBOL/u)).toBeTruthy();
    await user.click(screen.getByText("演进决策"));
    expect(screen.getByText(/补充现有知识/u)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "knowledge-1@2" }).every((link) => link.getAttribute("href") === "#/knowledge/knowledge-1")).toBe(true);
  });

  it("labels legacy candidates without inventing localization or evidence", async () => {
    const legacy: SessionExtractionView = {
      ...view,
      candidates: [{ ...view.candidates[0]!, localization: undefined, evidenceChecks: [] }],
    };
    render(<SessionExtractionPanel api={apiWith({ sessionExtraction: async () => legacy })} sessionId="session-1" captureCurrent />);
    expect(await screen.findByText("旧版候选缺少定位")).toBeTruthy();
    expect(screen.getByText("该候选不会被当作已定位的当前代码事实。")).toBeTruthy();
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
    expect(screen.getByRole("link", { name: "查看后台任务尝试记录" }).getAttribute("href")).toBe("#/jobs");
  });

  it("keeps an unknown terminal diagnostic visible without fabricating unavailable job metadata", async () => {
    const failed: SessionExtractionView = {
      ...view,
      stages: [{ stage: "CANDIDATE_PREVIEW", status: "FAILED", reasonCode: "FUTURE_WORKER_FAILURE", retryable: false }],
      candidates: [], previewId: undefined,
      commitAction: { enabled: false, expectedRevision: 0, idempotencyKey: "commit:unavailable", reasonCode: "PREVIEW_NOT_READY" },
    };
    render(<SessionExtractionPanel api={apiWith({ sessionExtraction: async () => failed })} sessionId="session-1" captureCurrent />);
    expect(await screen.findByText(/后台任务返回了失败诊断/u)).toBeTruthy();
    expect(screen.getByText("FUTURE_WORKER_FAILURE", { selector: "code" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "查看后台任务尝试记录" })).toBeNull();
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
