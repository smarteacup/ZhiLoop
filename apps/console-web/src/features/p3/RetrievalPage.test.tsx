// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RetrievalTraceView } from "../../api/p3.js";
import { RetrievalPage, type RetrievalConsoleApi } from "./RetrievalPage.js";

const trace: RetrievalTraceView = {
  traceId: "trace-1", outcome: "SUCCEEDED", injectionResult: "SHADOWED", reasonCodes: ["P3_SHADOW_READ_ONLY"],
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
});
