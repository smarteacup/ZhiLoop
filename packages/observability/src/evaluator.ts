import { createHash } from "node:crypto";

import {
  OBSERVABILITY_SCHEMA_VERSION,
  type ActiveAlert,
  type AlertEvaluation,
  type AlertObservation,
  type AlertPolicy,
  type AlertReasonCode,
  type AlertSeverity,
  type AlertTransition,
  type AlertTransitionKind,
  type NotificationDecision,
  type PreviousAlertState,
  type QuietHoursPolicy,
  type ThresholdPair,
} from "./types.js";
import { parseAlertObservation, parseAlertPolicy, parsePreviousAlertStates } from "./validation.js";

const rank: Readonly<Record<AlertSeverity, number>> = { WARNING: 1, ERROR: 2 };

interface AlertCandidate {
  readonly dedupeKey: string;
  readonly entityType: ActiveAlert["entityType"];
  readonly entityId: string;
  readonly severity: AlertSeverity;
  readonly reasonCodes: readonly AlertReasonCode[];
  readonly observedValue: number;
  readonly threshold: number;
}

function threshold(value: number, policy: ThresholdPair): { severity: AlertSeverity; threshold: number } | undefined {
  if (value >= policy.error) return { severity: "ERROR", threshold: policy.error };
  if (value >= policy.warning) return { severity: "WARNING", threshold: policy.warning };
  return undefined;
}

function stronger(
  left: { severity: AlertSeverity; threshold: number } | undefined,
  right: { severity: AlertSeverity; threshold: number } | undefined,
): { severity: AlertSeverity; threshold: number } | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return rank[left.severity] >= rank[right.severity] ? left : right;
}

function localParts(observedAt: string, utcOffsetMinutes: number): { readonly day: number; readonly minute: number } {
  const shifted = new Date(Date.parse(observedAt) + utcOffsetMinutes * 60_000);
  return { day: shifted.getUTCDay(), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export function isQuietHoursActive(policy: QuietHoursPolicy, observedAt: string): boolean {
  if (!policy.enabled) return false;
  const local = localParts(observedAt, policy.utcOffsetMinutes);
  const days = new Set(policy.daysOfWeek);
  if (policy.startMinute === policy.endMinute) return days.has(local.day);
  if (policy.startMinute < policy.endMinute) {
    return days.has(local.day) && local.minute >= policy.startMinute && local.minute < policy.endMinute;
  }
  if (local.minute >= policy.startMinute) return days.has(local.day);
  const previousDay = (local.day + 6) % 7;
  return local.minute < policy.endMinute && days.has(previousDay);
}

function reasonSetEqual(left: readonly AlertReasonCode[], right: readonly AlertReasonCode[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function transitionKind(previous: PreviousAlertState | undefined, current: AlertCandidate): AlertTransitionKind {
  if (previous === undefined) return "OPENED";
  if (rank[current.severity] > rank[previous.severity]) return "ESCALATED";
  if (rank[current.severity] < rank[previous.severity]) return "DEESCALATED";
  return reasonSetEqual(previous.reasonCodes, current.reasonCodes) ? "UNCHANGED" : "UPDATED";
}

function shouldNotify(kind: AlertTransitionKind, previous: PreviousAlertState | undefined): boolean {
  return kind === "OPENED" || kind === "ESCALATED" || previous?.notificationPending === true;
}

function notificationDecision(
  policy: AlertPolicy,
  quiet: boolean,
  severity: AlertSeverity,
  required: boolean,
): NotificationDecision {
  if (!required) return "NOT_REQUIRED";
  if (!policy.notificationsEnabled) return "SUPPRESSED_DISABLED";
  if (rank[severity] < rank[policy.notificationMinimumSeverity]) return "SUPPRESSED_MINIMUM_SEVERITY";
  if (quiet) return "SUPPRESSED_QUIET_HOURS";
  return "DELIVER";
}

function alertId(dedupeKey: string): string {
  return `alert-${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 24)}`;
}

function candidates(policy: AlertPolicy, observation: AlertObservation): AlertCandidate[] {
  const output: AlertCandidate[] = [];
  if (policy.spool.enabled) {
    const depth = threshold(observation.spool.depth, policy.spool.depth);
    const age = threshold(observation.spool.oldestAgeMs, policy.spool.oldestAgeMs);
    const selected = stronger(depth, age);
    if (selected !== undefined) {
      const reasons: AlertReasonCode[] = [];
      if (depth !== undefined) reasons.push("SPOOL_DEPTH_EXCEEDED");
      if (age !== undefined) reasons.push("SPOOL_AGE_EXCEEDED");
      const useDepth = depth !== undefined && rank[depth.severity] === rank[selected.severity];
      output.push({
        dedupeKey: "spool:backlog",
        entityType: "SPOOL",
        entityId: "local-spool",
        severity: selected.severity,
        reasonCodes: Object.freeze(reasons.sort()),
        observedValue: useDepth ? observation.spool.depth : observation.spool.oldestAgeMs,
        threshold: useDepth ? depth.threshold : (age as { threshold: number }).threshold,
      });
    }
  }
  if (policy.cursor.enabled) {
    for (const cursor of observation.cursors) {
      const selected = threshold(cursor.lagEvents, policy.cursor.lagEvents);
      if (selected !== undefined) output.push({
        dedupeKey: `cursor:${cursor.consumerId}`,
        entityType: "CURSOR",
        entityId: cursor.consumerId,
        severity: selected.severity,
        reasonCodes: Object.freeze(["CURSOR_LAG_EXCEEDED"]),
        observedValue: cursor.lagEvents,
        threshold: selected.threshold,
      });
    }
  }
  if (policy.failedJobs.enabled) {
    const selected = threshold(observation.jobs.failedCount, policy.failedJobs.count);
    if (selected !== undefined) output.push({
      dedupeKey: "jobs:failed",
      entityType: "JOBS",
      entityId: "durable-jobs",
      severity: selected.severity,
      reasonCodes: Object.freeze(["FAILED_JOBS_PRESENT"]),
      observedValue: observation.jobs.failedCount,
      threshold: selected.threshold,
    });
  }
  if (policy.hookSilence.enabled && observation.hook.expected) {
    const baseline = observation.hook.lastEventAt ?? observation.hook.monitoringSinceAt;
    const age = Date.parse(observation.observedAt) - Date.parse(baseline);
    const selected = threshold(age, policy.hookSilence.ageMs);
    if (selected !== undefined) output.push({
      dedupeKey: "hook:silence",
      entityType: "HOOK",
      entityId: "codex-hook",
      severity: selected.severity,
      reasonCodes: Object.freeze([observation.hook.lastEventAt === undefined ? "HOOK_NEVER_OBSERVED" : "HOOK_SILENT"]),
      observedValue: age,
      threshold: selected.threshold,
    });
  }
  return output.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey, "en"));
}

export function evaluateAlerts(policyInput: unknown, observationInput: unknown, previousInput?: unknown): AlertEvaluation {
  const policy = parseAlertPolicy(policyInput);
  const observation = parseAlertObservation(observationInput);
  const previous = parsePreviousAlertStates(previousInput);
  const previousByKey = new Map(previous.map((state) => [state.dedupeKey, state]));
  const current = candidates(policy, observation);
  const quietHoursActive = isQuietHoursActive(policy.quietHours, observation.observedAt);
  const transitions: AlertTransition[] = [];
  const activeAlerts: ActiveAlert[] = [];

  for (const candidate of current) {
    const prior = previousByKey.get(candidate.dedupeKey);
    previousByKey.delete(candidate.dedupeKey);
    const kind = transitionKind(prior, candidate);
    const decision = notificationDecision(policy, quietHoursActive, candidate.severity, shouldNotify(kind, prior));
    const suppressed = decision.startsWith("SUPPRESSED_");
    const delivered = decision === "DELIVER" || prior?.notificationDelivered === true;
    activeAlerts.push(Object.freeze({
      ...candidate,
      alertId: alertId(candidate.dedupeKey),
      observedAt: observation.observedAt,
      notificationPending: suppressed,
      notificationDelivered: delivered,
    }));
    transitions.push(Object.freeze({
      dedupeKey: candidate.dedupeKey,
      kind,
      ...(prior === undefined ? {} : { previousSeverity: prior.severity }),
      currentSeverity: candidate.severity,
      reasonCodes: candidate.reasonCodes,
      notificationDecision: decision,
    }));
  }
  for (const resolved of previousByKey.values()) {
    const required = resolved.notificationDelivered;
    transitions.push(Object.freeze({
      dedupeKey: resolved.dedupeKey,
      kind: "RESOLVED",
      previousSeverity: resolved.severity,
      reasonCodes: resolved.reasonCodes,
      notificationDecision: notificationDecision(policy, quietHoursActive, resolved.severity, required),
    }));
  }
  transitions.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey, "en"));
  const health = activeAlerts.some(({ severity }) => severity === "ERROR")
    ? "FAILED"
    : activeAlerts.length > 0
      ? "DEGRADED"
      : "HEALTHY";
  const evaluationId = createHash("sha256").update(JSON.stringify({ policy, observation, previous })).digest("hex");
  return Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    evaluationId,
    observedAt: observation.observedAt,
    health,
    quietHoursActive,
    activeAlerts: Object.freeze(activeAlerts),
    transitions: Object.freeze(transitions),
  });
}
