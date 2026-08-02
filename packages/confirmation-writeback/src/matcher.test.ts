import type { ConfirmationRequest } from "@zhiloop/domain";
import { describe, expect, it } from "vitest";

import { matchConfirmationReply } from "./matcher.js";

function request(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    schemaVersion: 1, confirmationId: "confirmation-a", sessionId: "session-a", turnId: "turn-20", turnOrdinal: 20,
    triggerId: "trigger-a", kind: "KNOWLEDGE_CONFLICT", subjectIds: ["knowledge-a"],
    question: "暂不处理、拒绝还是采用？",
    options: [
      { optionId: "keep-proposed", label: "保持候选，不覆盖当前结论", effect: "KEEP_PROPOSED" },
      { optionId: "reject-candidate", label: "明确拒绝该候选", effect: "REJECT_CANDIDATE" },
      { optionId: "accept-candidate", label: "采用该候选", effect: "ACCEPT_CANDIDATE" },
    ],
    safeDefaultOptionId: "keep-proposed", createdAt: "2026-08-02T03:00:00.000Z", ...overrides,
  };
}

describe("Confirmation reply matcher", () => {
  it("matches exact option ID, label, ordinal, and narrow natural phrases", () => {
    expect(matchConfirmationReply(request(), "accept-candidate")).toMatchObject({ status: "MATCH", option: { effect: "ACCEPT_CANDIDATE" } });
    expect(matchConfirmationReply(request(), "明确拒绝该候选")).toMatchObject({ status: "MATCH", option: { effect: "REJECT_CANDIDATE" } });
    expect(matchConfirmationReply(request(), "1")).toMatchObject({ status: "MATCH", option: { effect: "KEEP_PROPOSED" } });
    expect(matchConfirmationReply(request(), "同意采用")).toMatchObject({ status: "MATCH", option: { effect: "ACCEPT_CANDIDATE" } });
  });

  it("does not infer a choice from generic acknowledgement or surrounding prose", () => {
    expect(matchConfirmationReply(request(), "好的")).toEqual({ status: "NO_MATCH" });
    expect(matchConfirmationReply(request(), "我们可以讨论是否采用")).toEqual({ status: "NO_MATCH" });
    expect(matchConfirmationReply(request(), "   ")).toEqual({ status: "NO_MATCH" });
    expect(matchConfirmationReply(request(), "不是很确定")).toEqual({ status: "NO_MATCH" });
    expect(matchConfirmationReply(request(), "不是这个意思")).toMatchObject({ status: "MATCH", option: { effect: "REJECT_CANDIDATE" }, responseKind: "OPTION" });
  });

  it("maps an explicit correction only for a knowledge conflict", () => {
    expect(matchConfirmationReply(request(), "不对，应该是连接池按租户隔离")).toMatchObject({
      status: "MATCH", option: { effect: "REJECT_CANDIDATE" }, responseKind: "CORRECTION",
    });
    expect(matchConfirmationReply(request({
      kind: "SCOPE_PROMOTION",
      options: [
        { optionId: "keep-project", label: "仅保留在当前项目", effect: "KEEP_PROJECT" },
        { optionId: "promote-global", label: "提升为全局知识", effect: "PROMOTE_GLOBAL" },
      ],
      safeDefaultOptionId: "keep-project",
    }), "改成全局")).toEqual({ status: "NO_MATCH" });
  });

  it("returns ambiguous instead of guessing when malformed labels match multiple options", () => {
    const ambiguous = request({
      options: [
        { optionId: "keep-proposed", label: "选择", effect: "KEEP_PROPOSED" },
        { optionId: "reject-candidate", label: "选择", effect: "REJECT_CANDIDATE" },
        { optionId: "accept-candidate", label: "采用", effect: "ACCEPT_CANDIDATE" },
      ],
    });
    expect(matchConfirmationReply(ambiguous, "选择")).toEqual({ status: "AMBIGUOUS" });
  });
});
