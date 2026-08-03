import {
  MAX_CURSOR_OBSERVATIONS,
  MAX_PREVIOUS_ALERTS,
  OBSERVABILITY_SCHEMA_VERSION,
  type AlertObservation,
  type AlertPolicy,
  type AlertReasonCode,
  type AlertSeverity,
  type PreviousAlertState,
  type QuietHoursPolicy,
  type ThresholdPair,
} from "./types.js";

const REASON_CODES = new Set<AlertReasonCode>([
  "SPOOL_DEPTH_EXCEEDED",
  "SPOOL_AGE_EXCEEDED",
  "CURSOR_LAG_EXCEEDED",
  "FAILED_JOBS_PRESENT",
  "HOOK_SILENT",
  "HOOK_NEVER_OBSERVED",
]);
const SEVERITIES = new Set<AlertSeverity>(["WARNING", "ERROR"]);

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) throw new TypeError(`${name} contains unknown field ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) throw new TypeError(`${name} is missing ${missing}`);
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${name} must be an integer within ${minimum}..${maximum}`);
  }
  return value as number;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  const parsedAt = Date.parse(value);
  if (Number.isNaN(parsedAt)) throw new TypeError(`${name} must be a valid UTC ISO timestamp`);
  const canonical = new Date(parsedAt).toISOString();
  const normalizedInput = value.length === 20 ? value.replace("Z", ".000Z") : value;
  if (canonical !== normalizedInput) throw new TypeError(`${name} must be a valid UTC ISO timestamp`);
  return canonical;
}

function safeId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || !/^[A-Za-z0-9._:@#/-]+$/u.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

function severity(value: unknown, name: string): AlertSeverity {
  if (typeof value !== "string" || !SEVERITIES.has(value as AlertSeverity)) throw new TypeError(`${name} is invalid`);
  return value as AlertSeverity;
}

function thresholds(value: unknown, name: string, minimum: number, maximum: number): ThresholdPair {
  const input = object(value, name);
  exact(input, ["warning", "error"], name);
  const warning = integer(input["warning"], `${name}.warning`, minimum, maximum);
  const error = integer(input["error"], `${name}.error`, minimum, maximum);
  if (error < warning) throw new RangeError(`${name}.error must be greater than or equal to warning`);
  return Object.freeze({ warning, error });
}

function quietHours(value: unknown): QuietHoursPolicy {
  const input = object(value, "policy.quietHours");
  exact(input, ["enabled", "startMinute", "endMinute", "daysOfWeek", "utcOffsetMinutes"], "policy.quietHours");
  const days = input["daysOfWeek"];
  if (!Array.isArray(days) || days.length < 1 || days.length > 7) throw new RangeError("policy.quietHours.daysOfWeek must contain 1..7 days");
  const parsedDays = days.map((day, index) => integer(day, `policy.quietHours.daysOfWeek[${index}]`, 0, 6));
  if (new Set(parsedDays).size !== parsedDays.length) throw new TypeError("policy.quietHours.daysOfWeek must be unique");
  return Object.freeze({
    enabled: boolean(input["enabled"], "policy.quietHours.enabled"),
    startMinute: integer(input["startMinute"], "policy.quietHours.startMinute", 0, 1_439),
    endMinute: integer(input["endMinute"], "policy.quietHours.endMinute", 0, 1_439),
    daysOfWeek: Object.freeze([...parsedDays].sort((left, right) => left - right)),
    utcOffsetMinutes: integer(input["utcOffsetMinutes"], "policy.quietHours.utcOffsetMinutes", -840, 840),
  });
}

export function parseAlertPolicy(value: unknown): AlertPolicy {
  const input = object(value, "policy");
  exact(input, ["schemaVersion", "notificationsEnabled", "notificationMinimumSeverity", "spool", "cursor", "failedJobs", "hookSilence", "quietHours"], "policy");
  if (input["schemaVersion"] !== OBSERVABILITY_SCHEMA_VERSION) throw new TypeError("unsupported observability policy schemaVersion");
  const spool = object(input["spool"], "policy.spool");
  exact(spool, ["enabled", "depth", "oldestAgeMs"], "policy.spool");
  const cursor = object(input["cursor"], "policy.cursor");
  exact(cursor, ["enabled", "lagEvents"], "policy.cursor");
  const failedJobs = object(input["failedJobs"], "policy.failedJobs");
  exact(failedJobs, ["enabled", "count"], "policy.failedJobs");
  const hookSilence = object(input["hookSilence"], "policy.hookSilence");
  exact(hookSilence, ["enabled", "ageMs"], "policy.hookSilence");
  return Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    notificationsEnabled: boolean(input["notificationsEnabled"], "policy.notificationsEnabled"),
    notificationMinimumSeverity: severity(input["notificationMinimumSeverity"], "policy.notificationMinimumSeverity"),
    spool: Object.freeze({
      enabled: boolean(spool["enabled"], "policy.spool.enabled"),
      depth: thresholds(spool["depth"], "policy.spool.depth", 1, 1_000_000),
      oldestAgeMs: thresholds(spool["oldestAgeMs"], "policy.spool.oldestAgeMs", 1_000, 2_592_000_000),
    }),
    cursor: Object.freeze({
      enabled: boolean(cursor["enabled"], "policy.cursor.enabled"),
      lagEvents: thresholds(cursor["lagEvents"], "policy.cursor.lagEvents", 1, 1_000_000_000),
    }),
    failedJobs: Object.freeze({
      enabled: boolean(failedJobs["enabled"], "policy.failedJobs.enabled"),
      count: thresholds(failedJobs["count"], "policy.failedJobs.count", 1, 1_000_000),
    }),
    hookSilence: Object.freeze({
      enabled: boolean(hookSilence["enabled"], "policy.hookSilence.enabled"),
      ageMs: thresholds(hookSilence["ageMs"], "policy.hookSilence.ageMs", 60_000, 2_592_000_000),
    }),
    quietHours: quietHours(input["quietHours"]),
  });
}

export function parseAlertObservation(value: unknown): AlertObservation {
  const input = object(value, "observation");
  exact(input, ["schemaVersion", "observedAt", "spool", "cursors", "jobs", "hook"], "observation");
  if (input["schemaVersion"] !== OBSERVABILITY_SCHEMA_VERSION) throw new TypeError("unsupported observability observation schemaVersion");
  const observedAt = timestamp(input["observedAt"], "observation.observedAt");
  const observedAtMs = Date.parse(observedAt);
  const spool = object(input["spool"], "observation.spool");
  exact(spool, ["depth", "oldestAgeMs"], "observation.spool");
  const cursors = input["cursors"];
  if (!Array.isArray(cursors) || cursors.length > MAX_CURSOR_OBSERVATIONS) throw new RangeError(`observation.cursors exceeds ${MAX_CURSOR_OBSERVATIONS}`);
  const parsedCursors = cursors.map((entry, index) => {
    const cursor = object(entry, `observation.cursors[${index}]`);
    exact(cursor, ["consumerId", "lagEvents"], `observation.cursors[${index}]`);
    return Object.freeze({
      consumerId: safeId(cursor["consumerId"], `observation.cursors[${index}].consumerId`),
      lagEvents: integer(cursor["lagEvents"], `observation.cursors[${index}].lagEvents`, 0, 1_000_000_000),
    });
  });
  if (new Set(parsedCursors.map(({ consumerId }) => consumerId)).size !== parsedCursors.length) {
    throw new TypeError("observation.cursors consumerId must be unique");
  }
  const jobs = object(input["jobs"], "observation.jobs");
  exact(jobs, ["failedCount"], "observation.jobs");
  const hook = object(input["hook"], "observation.hook");
  const allowedHook = ["expected", "monitoringSinceAt", ...(Object.hasOwn(hook, "lastEventAt") ? ["lastEventAt"] : [])];
  exact(hook, allowedHook, "observation.hook");
  const monitoringSinceAt = timestamp(hook["monitoringSinceAt"], "observation.hook.monitoringSinceAt");
  const lastEventAt = Object.hasOwn(hook, "lastEventAt")
    ? timestamp(hook["lastEventAt"], "observation.hook.lastEventAt")
    : undefined;
  if (Date.parse(monitoringSinceAt) > observedAtMs || (lastEventAt !== undefined && Date.parse(lastEventAt) > observedAtMs)) {
    throw new RangeError("hook timestamps must not be after observation.observedAt");
  }
  return Object.freeze({
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    observedAt,
    spool: Object.freeze({
      depth: integer(spool["depth"], "observation.spool.depth", 0, 1_000_000),
      oldestAgeMs: integer(spool["oldestAgeMs"], "observation.spool.oldestAgeMs", 0, 2_592_000_000),
    }),
    cursors: Object.freeze(parsedCursors.sort((left, right) => left.consumerId.localeCompare(right.consumerId, "en"))),
    jobs: Object.freeze({ failedCount: integer(jobs["failedCount"], "observation.jobs.failedCount", 0, 1_000_000) }),
    hook: Object.freeze({
      expected: boolean(hook["expected"], "observation.hook.expected"),
      monitoringSinceAt,
      ...(lastEventAt === undefined ? {} : { lastEventAt }),
    }),
  });
}

export function parsePreviousAlertStates(value: unknown): readonly PreviousAlertState[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_PREVIOUS_ALERTS) throw new RangeError(`previous alerts exceed ${MAX_PREVIOUS_ALERTS}`);
  const parsed = value.map((entry, index) => {
    const state = object(entry, `previous[${index}]`);
    exact(state, ["dedupeKey", "severity", "reasonCodes", "notificationPending", "notificationDelivered"], `previous[${index}]`);
    const reasonCodes = state["reasonCodes"];
    if (!Array.isArray(reasonCodes) || reasonCodes.length < 1 || reasonCodes.length > 4
      || reasonCodes.some((code) => typeof code !== "string" || !REASON_CODES.has(code as AlertReasonCode))) {
      throw new TypeError(`previous[${index}].reasonCodes is invalid`);
    }
    const sortedReasons = [...reasonCodes as AlertReasonCode[]].sort();
    if (new Set(sortedReasons).size !== sortedReasons.length) throw new TypeError(`previous[${index}].reasonCodes must be unique`);
    return Object.freeze({
      dedupeKey: safeId(state["dedupeKey"], `previous[${index}].dedupeKey`),
      severity: severity(state["severity"], `previous[${index}].severity`),
      reasonCodes: Object.freeze(sortedReasons),
      notificationPending: boolean(state["notificationPending"], `previous[${index}].notificationPending`),
      notificationDelivered: boolean(state["notificationDelivered"], `previous[${index}].notificationDelivered`),
    });
  });
  if (new Set(parsed.map(({ dedupeKey }) => dedupeKey)).size !== parsed.length) throw new TypeError("previous dedupeKey must be unique");
  return Object.freeze(parsed.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey, "en")));
}
