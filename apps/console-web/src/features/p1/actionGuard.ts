export interface CapabilityGate {
  readonly status: "READY" | "DEGRADED" | "DISABLED" | "NOT_CONFIGURED" | "NOT_VERIFIED" | "FAILED";
  readonly reasonCode: string;
  readonly observedAt: string;
}

export interface RevisionActionGate {
  readonly capability: CapabilityGate;
  readonly allowed: boolean;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly idempotencyKey: string;
  readonly blockedReason?: string;
}

export interface ActionGateDecision {
  readonly enabled: boolean;
  readonly reason: string;
}

export function decideRevisionAction(
  gate: RevisionActionGate | undefined,
  commandAvailable: boolean,
): ActionGateDecision {
  if (gate === undefined) return { enabled: false, reason: "动作未配置" };
  if (gate.capability.status !== "READY") return { enabled: false, reason: gate.capability.reasonCode };
  if (!commandAvailable) return { enabled: false, reason: "命令端口未连接" };
  if (!gate.allowed) return { enabled: false, reason: gate.blockedReason ?? "当前状态不允许该操作" };
  if (!Number.isSafeInteger(gate.expectedRevision) || gate.expectedRevision < 0) {
    return { enabled: false, reason: "缺少有效 expected revision" };
  }
  if (gate.expectedRevision !== gate.currentRevision) return { enabled: false, reason: "状态 revision 已变化，请刷新后重试" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,255}$/u.test(gate.idempotencyKey)) {
    return { enabled: false, reason: "缺少有效幂等键" };
  }
  return { enabled: true, reason: "允许执行" };
}
