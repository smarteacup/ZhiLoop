// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedbackTargetView, HighRiskGovernanceView, HighRiskPreviewView } from "../../api/p4.js";
import { FeedbackPanel, feedbackEnabled } from "./FeedbackPanel.js";
import { HighRiskGovernancePanel } from "./HighRiskGovernancePanel.js";
import { P4ConsolePage } from "./P4ConsolePage.js";
import { disabledHighRisk, feedbackTarget, p4Api, readyGate } from "./test-fixtures.js";

afterEach(cleanup);

describe("P4 feedback and high-risk governance", () => {
  it("switches deterministically across every P4 Console tab", async () => {
    const user = userEvent.setup(); render(<P4ConsolePage api={p4Api()} sessionId="session-1" />);
    expect(await screen.findByRole("heading", { name: "Context Envelope 与 MCP 展开" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "CLOSURE" })); expect(await screen.findByRole("heading", { name: "闭环验证" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "ROLLOUT" })); expect(await screen.findByRole("heading", { name: "SHADOW 质量与灰度" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "GOVERNANCE" })); expect(await screen.findByRole("heading", { name: "高风险治理" })).toBeTruthy();
  });
  it("disables feedback when capability, eligibility or expected revision is not satisfied", async () => {
    const ineligible: FeedbackTargetView = { ...feedbackTarget, eligible: false, eligibilityReasonCodes: ["SUPPRESSED"], actions: { ...feedbackTarget.actions, SUPPRESS: { ...readyGate, expectedRevision: 1 } } };
    const record = vi.fn();
    render(<FeedbackPanel api={p4Api({ feedbackTargets: async () => [ineligible], recordFeedback: record })} sessionId="session-1" />);
    expect(await screen.findByRole("button", { name: "相关" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "固定" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "标记 MCP 已使用" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "停止召回" })).toHaveProperty("disabled", true);
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps high-risk operations disabled when ACTIVE capability is absent", async () => {
    const preview = vi.fn(); render(<HighRiskGovernancePanel api={p4Api({ highRiskGovernance: async () => disabledHighRisk, previewHighRisk: preview })} />);
    expect(await screen.findByText(/默认禁用：ACTIVE_STAGE_DISABLED/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "服务端预览影响范围" })).toHaveProperty("disabled", true);
    expect(preview).not.toHaveBeenCalled();
  });

  it("requires a fresh blast-radius preview and exact server-issued confirmation", async () => {
    const enabled: HighRiskGovernanceView = { policyRevision: 2, activeStageEnabled: true, actor: "local-operator", actions: { GLOBAL_PROMOTION: { ...readyGate, expectedRevision: 2 }, RULE_CHANGE: { ...readyGate, expectedRevision: 2 }, BINDING_CHANGE: { ...readyGate, expectedRevision: 2 }, PRIVACY_PURGE: { ...readyGate, expectedRevision: 2 } } };
    const previewValue: HighRiskPreviewView = { previewId: "preview-1", policyRevision: 2, kind: "GLOBAL_PROMOTION", expiresAt: "2099-08-04T00:00:00.000Z", actor: "local-operator", confirmationPhrase: "CONFIRM GLOBAL preview-1", blastRadius: { affectedAssets: 1, affectedProjects: 2, affectedRules: 0, affectedBindings: 0, affectedTraces: 5, affectedInjections: 1, irreversible: false, reasonCodes: ["GLOBAL_IMPACT"] } };
    const preview = vi.fn(async () => previewValue); const commit = vi.fn(async () => ({ operationId: "operation-1", previewId: "preview-1", kind: "GLOBAL_PROMOTION" as const, actor: "local-operator", policyRevision: 2, committedAt: "2026-08-04T00:00:00.000Z" }));
    const user = userEvent.setup(); render(<HighRiskGovernancePanel api={p4Api({ highRiskGovernance: async () => enabled, previewHighRisk: preview, commitHighRisk: commit })} />);
    await user.type(await screen.findByLabelText(/Asset IDs/u), "knowledge-1"); await user.type(screen.getByLabelText(/原因/u), "promote reviewed knowledge"); await user.type(screen.getByLabelText(/Payload fingerprint/u), `sha256:${"a".repeat(64)}`);
    await user.click(screen.getByRole("button", { name: "服务端预览影响范围" }));
    const commitButton = await screen.findByRole("button", { name: "确认执行高风险操作" });
    expect(commitButton).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("高风险确认短语"), "wrong"); expect(commitButton).toHaveProperty("disabled", true);
    await user.clear(screen.getByLabelText("高风险确认短语")); await user.type(screen.getByLabelText("高风险确认短语"), "CONFIRM GLOBAL preview-1");
    expect(commitButton).toHaveProperty("disabled", false); await user.click(commitButton);
    expect(commit).toHaveBeenCalledWith({ previewId: "preview-1", expectedPolicyRevision: 2, idempotencyKey: "p4.commit:preview-1", confirmationPhrase: "CONFIRM GLOBAL preview-1" });
  });

  it("evaluates every feedback gate and reports success, Error and unknown failures", async () => {
    expect(feedbackEnabled(feedbackTarget, "PIN", readyGate)).toBe(true);
    expect(feedbackEnabled(feedbackTarget, "PIN", { ...readyGate, enabled: false })).toBe(false);
    expect(feedbackEnabled(feedbackTarget, "PIN", { ...readyGate, capabilityStatus: "DEGRADED" })).toBe(false);
    expect(feedbackEnabled(feedbackTarget, "PIN", { ...readyGate, expectedRevision: 99 })).toBe(false);
    expect(feedbackEnabled(feedbackTarget, "PIN", { ...readyGate, idempotencyKey: undefined })).toBe(false);
    expect(feedbackEnabled({ ...feedbackTarget, scopeKey: "" }, "IRRELEVANT", readyGate)).toBe(false);
    expect(feedbackEnabled({ ...feedbackTarget, traceId: "" }, "SUPPRESS", readyGate)).toBe(false);
    expect(feedbackEnabled({ ...feedbackTarget, expansionId: undefined }, "MCP_USED", readyGate)).toBe(false);
    expect(feedbackEnabled({ ...feedbackTarget, eligible: false }, "RELEVANT", readyGate)).toBe(false);

    const user = userEvent.setup(); const record = vi.fn(async () => ({ result: "RECORDED" as const, revision: 1, eligibleAfterWrite: true, reasonCode: "FEEDBACK_RECORDED" }));
    render(<FeedbackPanel api={p4Api({ recordFeedback: record })} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "相关" }));
    expect((await screen.findByRole("status")).textContent).toContain("FEEDBACK_RECORDED");
    cleanup();
    render(<FeedbackPanel api={p4Api({ recordFeedback: async () => { throw new Error("write failed"); } })} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "固定" })); expect((await screen.findByRole("status")).textContent).toContain("反馈失败：write failed");
    cleanup();
    render(<FeedbackPanel api={p4Api({ recordFeedback: async () => { throw "unknown"; } })} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "停止召回" })); expect((await screen.findByRole("status")).textContent).toContain("反馈失败");
  });

  it("renders an empty feedback target response", async () => {
    render(<FeedbackPanel api={p4Api({ feedbackTargets: async () => [] })} sessionId="session-1" />);
    expect(await screen.findByText("没有可反馈的知识版本。")).toBeTruthy();
  });

  it("reports preview and commit failures and keeps expired previews disabled", async () => {
    const enabled: HighRiskGovernanceView = { policyRevision: 2, activeStageEnabled: true, actor: "local-operator", actions: { GLOBAL_PROMOTION: { ...readyGate, expectedRevision: 2 }, RULE_CHANGE: { ...readyGate, expectedRevision: 2 }, BINDING_CHANGE: { ...readyGate, expectedRevision: 2 }, PRIVACY_PURGE: { ...readyGate, expectedRevision: 2 } } };
    const user = userEvent.setup();
    render(<HighRiskGovernancePanel api={p4Api({ highRiskGovernance: async () => enabled, previewHighRisk: async () => { throw new Error("preview failed"); } })} />);
    await user.type(await screen.findByLabelText(/Asset IDs/u), " knowledge-1, knowledge-1 "); await user.type(screen.getByLabelText(/原因/u), "reviewed"); await user.type(screen.getByLabelText(/Payload fingerprint/u), `sha256:${"a".repeat(64)}`);
    await user.click(screen.getByRole("button", { name: "服务端预览影响范围" })); expect((await screen.findByRole("status")).textContent).toContain("预览失败：preview failed");
    cleanup();
    const expired: HighRiskPreviewView = { previewId: "expired", policyRevision: 2, kind: "GLOBAL_PROMOTION", expiresAt: "2000-01-01T00:00:00.000Z", confirmationPhrase: "CONFIRM", blastRadius: { affectedAssets: 1, affectedProjects: 0, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: true, reasonCodes: ["IRREVERSIBLE"] } };
    render(<HighRiskGovernancePanel api={p4Api({ highRiskGovernance: async () => enabled, previewHighRisk: async () => expired, commitHighRisk: async () => { throw new Error("commit failed"); } })} />);
    await user.type(await screen.findByLabelText(/Asset IDs/u), "knowledge-1"); await user.type(screen.getByLabelText(/原因/u), "reviewed"); await user.type(screen.getByLabelText(/Payload fingerprint/u), `sha256:${"a".repeat(64)}`); await user.click(screen.getByRole("button", { name: "服务端预览影响范围" }));
    expect(await screen.findAllByText("IRREVERSIBLE")).toHaveLength(2); expect(screen.getByRole("button", { name: "确认执行高风险操作" })).toHaveProperty("disabled", true);
  });
});
