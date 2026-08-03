import { describe, expect, it } from "vitest";

import {
  MAX_CURSOR_OBSERVATIONS,
  evaluateAlerts,
  isQuietHoursActive,
  parseAlertObservation,
  parseAlertPolicy,
  parsePreviousAlertStates,
  type AlertEvaluation,
  type AlertObservation,
  type AlertPolicy,
  type PreviousAlertState,
} from "./index.js";

const MONDAY_NOON = "2026-08-03T12:00:00.000Z";

function policy(overrides: Partial<AlertPolicy> = {}): AlertPolicy {
  return {
    schemaVersion: 1,
    notificationsEnabled: true,
    notificationMinimumSeverity: "WARNING",
    spool: { enabled: true, depth: { warning: 10, error: 20 }, oldestAgeMs: { warning: 60_000, error: 120_000 } },
    cursor: { enabled: true, lagEvents: { warning: 100, error: 1_000 } },
    failedJobs: { enabled: true, count: { warning: 1, error: 5 } },
    hookSilence: { enabled: true, ageMs: { warning: 300_000, error: 900_000 } },
    quietHours: { enabled: false, startMinute: 1_320, endMinute: 420, daysOfWeek: [1, 2, 3, 4, 5], utcOffsetMinutes: 0 },
    ...overrides,
  };
}

function observation(overrides: Partial<AlertObservation> = {}): AlertObservation {
  return {
    schemaVersion: 1,
    observedAt: MONDAY_NOON,
    spool: { depth: 0, oldestAgeMs: 0 },
    cursors: [],
    jobs: { failedCount: 0 },
    hook: { expected: true, monitoringSinceAt: "2026-08-03T11:59:00.000Z", lastEventAt: "2026-08-03T11:59:30.000Z" },
    ...overrides,
  };
}

function previous(evaluation: AlertEvaluation): PreviousAlertState[] {
  return evaluation.activeAlerts.map(({ dedupeKey, severity, reasonCodes, notificationPending, notificationDelivered }) => ({
    dedupeKey,
    severity,
    reasonCodes,
    notificationPending,
    notificationDelivered,
  }));
}

describe("deterministic alert evaluation", () => {
  it("returns healthy with no hidden or synthetic alerts", () => {
    const result = evaluateAlerts(policy(), observation());
    expect(result).toMatchObject({ health: "HEALTHY", quietHoursActive: false, activeAlerts: [], transitions: [] });
    expect(result.evaluationId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("evaluates spool, cursor, failed jobs and Hook silence at exact bounded thresholds", () => {
    const result = evaluateAlerts(policy(), observation({
      spool: { depth: 20, oldestAgeMs: 60_000 },
      cursors: [{ consumerId: "knowledge-worker", lagEvents: 1_000 }],
      jobs: { failedCount: 5 },
      hook: { expected: true, monitoringSinceAt: "2026-08-03T10:00:00.000Z", lastEventAt: "2026-08-03T11:45:00.000Z" },
    }));
    expect(result.health).toBe("FAILED");
    expect(result.activeAlerts.map(({ dedupeKey, severity }) => [dedupeKey, severity])).toEqual([
      ["cursor:knowledge-worker", "ERROR"],
      ["hook:silence", "ERROR"],
      ["jobs:failed", "ERROR"],
      ["spool:backlog", "ERROR"],
    ]);
    expect(result.activeAlerts.find(({ dedupeKey }) => dedupeKey === "spool:backlog")?.reasonCodes).toEqual([
      "SPOOL_AGE_EXCEEDED",
      "SPOOL_DEPTH_EXCEEDED",
    ]);
    expect(result.transitions.every(({ kind, notificationDecision }) => kind === "OPENED" && notificationDecision === "DELIVER")).toBe(true);
  });

  it("distinguishes a Hook never observed from a previously observed silent Hook", () => {
    const never = evaluateAlerts(policy(), observation({
      hook: { expected: true, monitoringSinceAt: "2026-08-03T11:40:00.000Z" },
    }));
    expect(never.activeAlerts[0]?.reasonCodes).toEqual(["HOOK_NEVER_OBSERVED"]);
    const silent = evaluateAlerts(policy(), observation({
      hook: { expected: true, monitoringSinceAt: "2026-08-03T10:00:00.000Z", lastEventAt: "2026-08-03T11:40:00.000Z" },
    }));
    expect(silent.activeAlerts[0]?.reasonCodes).toEqual(["HOOK_SILENT"]);
    expect(evaluateAlerts(policy(), observation({
      hook: { expected: false, monitoringSinceAt: "2026-08-01T00:00:00.000Z" },
    })).activeAlerts).toEqual([]);
  });

  it("deduplicates and reports unchanged, escalation, de-escalation, update and resolution transitions", () => {
    const opened = evaluateAlerts(policy(), observation({ spool: { depth: 10, oldestAgeMs: 0 } }));
    expect(opened.transitions[0]?.kind).toBe("OPENED");
    const unchanged = evaluateAlerts(policy(), observation({ spool: { depth: 11, oldestAgeMs: 0 } }), previous(opened));
    expect(unchanged.transitions[0]).toMatchObject({ kind: "UNCHANGED", notificationDecision: "NOT_REQUIRED" });
    const escalated = evaluateAlerts(policy(), observation({ spool: { depth: 20, oldestAgeMs: 0 } }), previous(unchanged));
    expect(escalated.transitions[0]).toMatchObject({ kind: "ESCALATED", notificationDecision: "DELIVER" });
    const deescalated = evaluateAlerts(policy(), observation({ spool: { depth: 10, oldestAgeMs: 0 } }), previous(escalated));
    expect(deescalated.transitions[0]).toMatchObject({ kind: "DEESCALATED", notificationDecision: "NOT_REQUIRED" });
    const updated = evaluateAlerts(policy(), observation({ spool: { depth: 10, oldestAgeMs: 60_000 } }), previous(deescalated));
    expect(updated.transitions[0]).toMatchObject({ kind: "UPDATED" });
    const resolved = evaluateAlerts(policy(), observation(), previous(updated));
    expect(resolved).toMatchObject({ health: "HEALTHY", activeAlerts: [] });
    expect(resolved.transitions[0]).toMatchObject({ kind: "RESOLVED", notificationDecision: "DELIVER" });
  });

  it("suppresses only delivery during overnight quiet hours and delivers a pending alert afterward", () => {
    const quietPolicy = policy({
      quietHours: { enabled: true, startMinute: 1_320, endMinute: 420, daysOfWeek: [1], utcOffsetMinutes: 0 },
    });
    const during = evaluateAlerts(quietPolicy, observation({
      observedAt: "2026-08-03T23:00:00.000Z",
      spool: { depth: 20, oldestAgeMs: 0 },
      hook: { expected: false, monitoringSinceAt: "2026-08-03T22:00:00.000Z" },
    }));
    expect(during).toMatchObject({ health: "FAILED", quietHoursActive: true });
    expect(during.transitions[0]?.notificationDecision).toBe("SUPPRESSED_QUIET_HOURS");
    expect(during.activeAlerts[0]).toMatchObject({ notificationPending: true, notificationDelivered: false });
    expect(isQuietHoursActive(quietPolicy.quietHours, "2026-08-04T02:00:00.000Z")).toBe(true);
    expect(isQuietHoursActive(quietPolicy.quietHours, "2026-08-04T23:00:00.000Z")).toBe(false);

    const afterward = evaluateAlerts(quietPolicy, observation({
      observedAt: "2026-08-04T08:00:00.000Z",
      spool: { depth: 20, oldestAgeMs: 0 },
      hook: { expected: false, monitoringSinceAt: "2026-08-03T22:00:00.000Z" },
    }), previous(during));
    expect(afterward).toMatchObject({ health: "FAILED", quietHoursActive: false });
    expect(afterward.transitions[0]).toMatchObject({ kind: "UNCHANGED", notificationDecision: "DELIVER" });
  });

  it("supports same-minute full-day quiet windows using fixed-offset local weekdays", () => {
    const quiet = { enabled: true, startMinute: 0, endMinute: 0, daysOfWeek: [1], utcOffsetMinutes: 480 } as const;
    expect(isQuietHoursActive(quiet, "2026-08-03T12:00:00.000Z")).toBe(true);
    expect(isQuietHoursActive(quiet, "2026-08-04T12:00:00.000Z")).toBe(false);
  });

  it("notification switches and severity filters never hide failed health", () => {
    const disabled = evaluateAlerts(policy({ notificationsEnabled: false }), observation({ jobs: { failedCount: 5 } }));
    expect(disabled).toMatchObject({ health: "FAILED" });
    expect(disabled.transitions[0]?.notificationDecision).toBe("SUPPRESSED_DISABLED");
    const filtered = evaluateAlerts(policy({ notificationMinimumSeverity: "ERROR" }), observation({ jobs: { failedCount: 1 } }));
    expect(filtered).toMatchObject({ health: "DEGRADED" });
    expect(filtered.transitions[0]?.notificationDecision).toBe("SUPPRESSED_MINIMUM_SEVERITY");
  });

  it("normalizes cursor order so identical facts have the same output and evaluation ID", () => {
    const left = observation({ cursors: [{ consumerId: "b", lagEvents: 100 }, { consumerId: "a", lagEvents: 100 }] });
    const right = observation({ cursors: [{ consumerId: "a", lagEvents: 100 }, { consumerId: "b", lagEvents: 100 }] });
    expect(evaluateAlerts(policy(), left)).toEqual(evaluateAlerts(policy(), right));
  });
});

describe("strict observability boundaries", () => {
  it("rejects unknown policy fields, reversed thresholds, duplicate days and unsupported versions", () => {
    expect(() => parseAlertPolicy({ ...policy(), secret: "do not accept" })).toThrow(/unknown field/u);
    expect(() => parseAlertPolicy({ ...policy(), spool: { ...policy().spool, depth: { warning: 20, error: 10 } } })).toThrow(/greater/u);
    expect(() => parseAlertPolicy({ ...policy(), quietHours: { ...policy().quietHours, daysOfWeek: [1, 1] } })).toThrow(/unique/u);
    expect(() => parseAlertPolicy({ ...policy(), schemaVersion: 2 })).toThrow(/schemaVersion/u);
  });

  it("rejects future Hook timestamps, duplicate consumers, unsafe IDs and unknown observation fields", () => {
    expect(() => parseAlertObservation(observation({
      hook: { expected: true, monitoringSinceAt: "2026-08-03T12:01:00.000Z" },
    }))).toThrow(/must not be after/u);
    expect(() => parseAlertObservation(observation({
      cursors: [{ consumerId: "same", lagEvents: 0 }, { consumerId: "same", lagEvents: 1 }],
    }))).toThrow(/unique/u);
    expect(() => parseAlertObservation(observation({ cursors: [{ consumerId: "bad\nsecret", lagEvents: 1 }] }))).toThrow(/safe identifier/u);
    expect(() => parseAlertObservation({ ...observation(), rawPrompt: "must not pass" })).toThrow(/unknown field/u);
    expect(() => parseAlertObservation({
      ...observation(),
      observedAt: "Mon, 03 Aug 2026 12:00:00 GMT",
    })).toThrow(/ISO timestamp/u);
    expect(() => parseAlertObservation({
      ...observation(),
      observedAt: "2026-02-30T12:00:00.000Z",
    })).toThrow(/valid UTC ISO timestamp/u);
    expect(() => parseAlertObservation({
      ...observation(),
      observedAt: "2026-13-03T12:00:00.000Z",
    })).toThrow(/valid UTC ISO timestamp/u);
    expect(() => parseAlertObservation(observation({
      hook: { expected: true, monitoringSinceAt: "2026-08-03T11:59:00.000Z", lastEventAt: undefined as unknown as string },
    }))).toThrow(/ISO timestamp/u);
  });

  it("accepts the maximum cursor bound and rejects one beyond it", () => {
    const cursors = Array.from({ length: MAX_CURSOR_OBSERVATIONS }, (_value, index) => ({ consumerId: `consumer-${index}`, lagEvents: 100 }));
    expect(evaluateAlerts(policy(), observation({ cursors })).activeAlerts).toHaveLength(MAX_CURSOR_OBSERVATIONS);
    expect(() => parseAlertObservation(observation({ cursors: [...cursors, { consumerId: "overflow", lagEvents: 0 }] }))).toThrow(/exceeds/u);
  });

  it("strictly validates previous state and never accepts duplicated or content-bearing records", () => {
    const state: PreviousAlertState = {
      dedupeKey: "jobs:failed",
      severity: "ERROR",
      reasonCodes: ["FAILED_JOBS_PRESENT"],
      notificationPending: false,
      notificationDelivered: true,
    };
    expect(parsePreviousAlertStates([state])).toEqual([state]);
    expect(() => parsePreviousAlertStates([state, state])).toThrow(/unique/u);
    expect(() => parsePreviousAlertStates([{ ...state, prompt: "secret" }])).toThrow(/unknown field/u);
  });
});
