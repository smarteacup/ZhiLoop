// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RetrievalTraceView } from "../../api/p3.js";
import { RetrievalPage, type RetrievalConsoleApi } from "./RetrievalPage.js";

const trace: RetrievalTraceView = {
  traceId: "trace-1", outcome: "SUCCEEDED", injectionResult: "SHADOWED", reasonCodes: ["P3_SHADOW_READ_ONLY"],
  context: { projectId: "project-a", repositoryRoot: "/workspace/project-a", branch: "main", commit: "abcdef1234567", dirty: false },
  scenarios: [{ scenarioId: "scenario:project-a:config", title: "配置变更", summary: "处理项目配置变更。", score: 0.9,
    selected: true, knowledgePointers: ["knowledge-1@2"], taskIntents: ["修改配置"], entryPoints: ["ConfigService"] }],
  results: [{ knowledgeId: "knowledge-1", version: 2, title: "Config", summary: "summary", scope: "PROJECT", status: "VERIFIED", retrievalRank: 1, finalRank: 1, rrfScore: 0.1, contributions: [{ channel: "EXACT", rank: 1, reason: "symbol" }], evidenceIds: ["evidence-1"], injected: false }], filters: [],
  envelope: { detailLevel: "L1_POINTER", maxTokens: 2_000, estimatedTokens: 20, truncated: true, omitted: [{ knowledgeId: "knowledge-2", version: 1, reason: "TOKEN_BUDGET" }] },
};
const api = (overrides: Partial<RetrievalConsoleApi> = {}): RetrievalConsoleApi => ({
  capabilities: async () => ({ items: [{ schemaVersion: 1, capabilityId: "knowledge.retrieval", status: "READY", reasonCode: "COMPONENT_READY", observedAt: "2026-08-03T00:00:00.000Z", lastTransitionAt: "2026-08-03T00:00:00.000Z", retryable: false, evidenceRefs: [] }] }),
  searchKnowledge: async () => trace, ...overrides,
});
afterEach(cleanup);

describe("RetrievalPage", () => {
  it("renders deterministic channel/rank/evidence/budget explanations as SHADOW", async () => {
    const search = vi.fn(async () => trace);
    const user = userEvent.setup(); render(<RetrievalPage api={api({ searchKnowledge: search })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "ConfigService");
    await user.click(screen.getByRole("button", { name: "搜索知识" }));
    expect(await screen.findByRole("heading", { name: "Retrieval Trace" })).toBeTruthy();
    expect(screen.getByText(/EXACT#1: symbol/u)).toBeTruthy();
    expect(screen.getAllByText(/SHADOWED/u).length).toBeGreaterThan(0);
    expect(screen.getByText(/TOKEN_BUDGET/u)).toBeTruthy();
    expect(screen.getByText(/已选择 · 配置变更/u)).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("shows cited Codex answer and deterministic fallback without claiming model facts", async () => {
    const user = userEvent.setup(); render(<RetrievalPage api={api({ askZhiLoop: async () => ({ outcome: "FALLBACK_SEARCH", answer: "", citations: [], unknowns: ["Codex answer unavailable"], conflicts: [], retrieval: trace, latencyMs: 4 }) })} />);
    await user.click(screen.getByRole("tab", { name: "问 ZhiLoop" }));
    await user.type(screen.getByLabelText("自然语言问题"), "how?");
    await user.click(screen.getByRole("button", { name: "问 ZhiLoop" }));
    expect(await screen.findByText(/降级为确定性搜索/u)).toBeTruthy();
    expect(screen.getByText(/Codex answer unavailable/u)).toBeTruthy();
  });

  it("fails closed when retrieval capability is not ready", async () => {
    const search = vi.fn(async () => trace);
    const user = userEvent.setup(); render(<RetrievalPage api={api({ capabilities: async () => ({ items: [] }), searchKnowledge: search })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "query");
    await user.click(screen.getByRole("button", { name: "搜索知识" }));
    expect((await screen.findByRole("alert")).textContent).toContain("RETRIEVAL_CAPABILITY_NOT_REPORTED");
    expect(search).not.toHaveBeenCalled();
  });

  it("cancels an in-flight query through its AbortSignal", async () => {
    let observedSignal: AbortSignal | undefined;
    const search = vi.fn((_command: unknown, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<RetrievalTraceView>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    });
    const user = userEvent.setup();
    render(<RetrievalPage api={api({ searchKnowledge: search })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "query");
    await user.click(screen.getByRole("button", { name: "搜索知识" }));
    await user.click(await screen.findByRole("button", { name: "取消查询" }));
    expect(observedSignal?.aborted).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toContain("QUERY_CANCELLED");
  });

  it("renders complete ASK evidence, citations and conflicts", async () => {
    const user = userEvent.setup();
    const emptyTrace: RetrievalTraceView = {
      ...trace,
      filters: [{ decision: "EXCLUDED", reasonCode: "SCOPE_MISMATCH", safeMessage: "Excluded by scope" }],
      results: [{ ...trace.results[0]!, evidenceIds: [], contributions: [] }],
      envelope: { ...trace.envelope, truncated: false, omitted: [] },
    };
    render(<RetrievalPage api={api({ askZhiLoop: async () => ({
      outcome: "SUCCEEDED",
      answer: "Use the project-scoped configuration.",
      citations: [{ knowledgeId: "knowledge/1", version: 2, answerSpans: [{ start: 0, end: 3 }] }],
      unknowns: [],
      conflicts: [{ summary: "Two revisions disagree", knowledgeVersions: [{ knowledgeId: "knowledge/1", version: 1 }] }],
      retrieval: emptyTrace,
      latencyMs: 8,
    }) })} />);
    await user.click(screen.getByRole("tab", { name: "问 ZhiLoop" }));
    await user.type(screen.getByLabelText("自然语言问题"), "  how should this work?  ");
    await user.type(screen.getByLabelText(/项目 ID/u), "  project-a  ");
    await user.click(screen.getByRole("button", { name: "问 ZhiLoop" }));
    expect(await screen.findByText("Use the project-scoped configuration.")).toBeTruthy();
    expect(screen.getByText("Two revisions disagree")).toBeTruthy();
    expect(screen.getByText("无")).toBeTruthy();
    expect(screen.getByText(/SCOPE_MISMATCH/u)).toBeTruthy();
    expect(screen.queryByText("未注入项与原因")).toBeNull();
  });

  it("fails closed for missing query ports, explicit capability reasons and non-Error failures", async () => {
    const user = userEvent.setup();
    const first = render(<RetrievalPage api={{ capabilities: api().capabilities }} />);
    await user.type(screen.getByLabelText("自然语言问题"), "query");
    await user.click(screen.getByRole("button", { name: "搜索知识" }));
    expect((await screen.findByRole("alert")).textContent).toContain("RETRIEVAL_QUERY_API_NOT_EXPOSED");
    first.unmount();

    const second = render(<RetrievalPage api={api({
      capabilities: async () => ({ items: [{ schemaVersion: 1, capabilityId: "knowledge.retrieval", status: "DEGRADED", reasonCode: "CAPABILITY_DISABLED", observedAt: "2026-08-03T00:00:00.000Z", lastTransitionAt: "2026-08-03T00:00:00.000Z", retryable: true, evidenceRefs: [] }] }),
    })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "query");
    await user.click(screen.getByRole("button", { name: "搜索知识" }));
    expect((await screen.findByRole("alert")).textContent).toContain("CAPABILITY_DISABLED");
    second.unmount();

    const third = render(<RetrievalPage api={api({ searchKnowledge: async () => { throw "opaque failure"; } })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "query");
    await user.click(screen.getByRole("button", { name: "搜索知识" }));
    expect((await screen.findByRole("alert")).textContent).toContain("QUERY_FAILED");
    third.unmount();

    render(<RetrievalPage api={{ capabilities: api().capabilities }} />);
    await user.click(screen.getByRole("tab", { name: "问 ZhiLoop" }));
    await user.type(screen.getByLabelText("自然语言问题"), "query");
    await user.click(screen.getByRole("button", { name: "问 ZhiLoop" }));
    expect((await screen.findByRole("alert")).textContent).toContain("CODEX_QUERY_API_NOT_EXPOSED");
  });

  it("compares current and draft policies and reports simulation edge states", async () => {
    const user = userEvent.setup();
    const simulate = vi.fn(async () => ({
      current: trace,
      draft: { ...trace, traceId: "trace-draft", envelope: { ...trace.envelope, estimatedTokens: 25 } },
      comparison: { selectedOnlyByCurrent: [], selectedOnlyByDraft: ["knowledge-2@1"], tokenDelta: 5 },
    }));
    const first = render(<RetrievalPage api={api({ simulateRetrieval: simulate })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.type(screen.getByLabelText(/项目 ID/u), "project-a");
    await user.type(screen.getByLabelText(/项目目录/u), "  /workspace/project-a  ");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    expect(await screen.findByRole("heading", { name: "策略比较实验室" })).toBeTruthy();
    expect(screen.getByText("knowledge-2@1")).toBeTruthy();
    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-a", cwd: "/workspace/project-a" }), expect.any(AbortSignal));
    first.unmount();

    const second = render(<RetrievalPage api={api({ simulateRetrieval: async () => ({ current: trace }) })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    expect(await screen.findByText(/当前没有草稿策略/u)).toBeTruthy();
    second.unmount();

    const noComparison = render(<RetrievalPage api={api({ simulateRetrieval: async () => ({ current: trace, draft: trace }) })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    expect(await screen.findByText("0")).toBeTruthy();
    expect(screen.getByText("无")).toBeTruthy();
    noComparison.unmount();

    const capabilityFailure = render(<RetrievalPage api={api({
      capabilities: async () => ({ items: [] }),
      simulateRetrieval: async () => ({ current: trace }),
    })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    expect((await screen.findByRole("alert")).textContent).toContain("RETRIEVAL_CAPABILITY_NOT_REPORTED");
    capabilityFailure.unmount();

    const third = render(<RetrievalPage api={{ capabilities: api().capabilities }} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    expect((await screen.findByRole("alert")).textContent).toContain("RETRIEVAL_SIMULATION_API_NOT_EXPOSED");
    third.unmount();

    const explicitFailure = render(<RetrievalPage api={api({ simulateRetrieval: async () => { throw new Error("simulation unavailable"); } })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    expect((await screen.findByRole("alert")).textContent).toContain("simulation unavailable");
    explicitFailure.unmount();

    const cancellable = render(<RetrievalPage api={api({
      simulateRetrieval: async (_command, signal) => await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      }),
    })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    await user.click(await screen.findByRole("button", { name: "取消查询" }));
    expect((await screen.findByRole("alert")).textContent).toContain("QUERY_CANCELLED");
    cancellable.unmount();

    render(<RetrievalPage api={api({ simulateRetrieval: async () => { throw "opaque simulation failure"; } })} />);
    await user.type(screen.getByLabelText("自然语言问题"), "compare");
    await user.click(screen.getByRole("button", { name: "比较当前/草稿策略" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("SIMULATION_FAILED"));
  });
});
