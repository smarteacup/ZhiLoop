import { describe, expect, it } from "vitest";

import { decideRevisionAction, type RevisionActionGate } from "./actionGuard.js";

const base: RevisionActionGate = {
  capability: { status: "READY", reasonCode: "READY", observedAt: "2026-08-03T12:00:00.000Z" },
  allowed: true,
  expectedRevision: 3,
  currentRevision: 3,
  idempotencyKey: "safe-key-3",
};

describe("decideRevisionAction", () => {
  it("fails closed for absent ports, non-ready capability, unsafe state, stale revision, and invalid key", () => {
    expect(decideRevisionAction(undefined, true).enabled).toBe(false);
    expect(decideRevisionAction(base, false).reason).toContain("未连接");
    expect(decideRevisionAction({ ...base, capability: { ...base.capability, status: "DEGRADED", reasonCode: "SIDE_CAR_DEGRADED" } }, true).reason).toBe("SIDE_CAR_DEGRADED");
    expect(decideRevisionAction({ ...base, allowed: false, blockedReason: "安全边界未到达" }, true).reason).toBe("安全边界未到达");
    expect(decideRevisionAction({ ...base, expectedRevision: -1 }, true).reason).toContain("expected revision");
    expect(decideRevisionAction({ ...base, expectedRevision: 2 }, true).reason).toContain("revision 已变化");
    expect(decideRevisionAction({ ...base, idempotencyKey: "short" }, true).reason).toContain("幂等键");
    expect(decideRevisionAction(base, true)).toEqual({ enabled: true, reason: "允许执行" });
  });
});
