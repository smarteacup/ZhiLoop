import type { ConsoleApi } from "../../api/client.js";

export type ConsoleCapability = Awaited<ReturnType<ConsoleApi["capabilities"]>>["items"][number];

export interface CapabilityDecision {
  readonly status: string;
  readonly reasonCode: string;
  readonly retryable: boolean;
  readonly capabilityId: string;
  readonly ready: boolean;
}

export function capabilityDecision(items: readonly ConsoleCapability[], candidates: readonly string[]): CapabilityDecision {
  const exact = candidates.map((candidate) => items.find((item) => item.capabilityId === candidate)).find((item) => item !== undefined);
  const fuzzy = items.find((item) => candidates.some((candidate) => item.capabilityId.includes(candidate)));
  const capability = exact ?? fuzzy;
  if (capability === undefined) {
    return { capabilityId: candidates[0] ?? "unknown", status: "NOT_CONFIGURED", reasonCode: "CAPABILITY_NOT_REPORTED", retryable: false, ready: false };
  }
  return {
    capabilityId: capability.capabilityId,
    status: capability.status,
    reasonCode: capability.reasonCode,
    retryable: capability.retryable,
    ready: capability.status === "READY",
  };
}
