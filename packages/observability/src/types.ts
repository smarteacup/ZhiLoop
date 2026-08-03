export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;
export const MAX_CURSOR_OBSERVATIONS = 500;
export const MAX_PREVIOUS_ALERTS = 1_000;

export type AlertSeverity = "WARNING" | "ERROR";
export type AlertHealth = "HEALTHY" | "DEGRADED" | "FAILED";
export type AlertReasonCode =
  | "SPOOL_DEPTH_EXCEEDED"
  | "SPOOL_AGE_EXCEEDED"
  | "CURSOR_LAG_EXCEEDED"
  | "FAILED_JOBS_PRESENT"
  | "HOOK_SILENT"
  | "HOOK_NEVER_OBSERVED";
export type AlertTransitionKind = "OPENED" | "UNCHANGED" | "UPDATED" | "ESCALATED" | "DEESCALATED" | "RESOLVED";
export type NotificationDecision =
  | "DELIVER"
  | "NOT_REQUIRED"
  | "SUPPRESSED_DISABLED"
  | "SUPPRESSED_QUIET_HOURS"
  | "SUPPRESSED_MINIMUM_SEVERITY";

export interface ThresholdPair {
  readonly warning: number;
  readonly error: number;
}

export interface QuietHoursPolicy {
  readonly enabled: boolean;
  /** Minute in a fixed-offset local day, from 0 through 1439. */
  readonly startMinute: number;
  readonly endMinute: number;
  /** Sunday=0 through Saturday=6; for overnight windows this is the day the window starts. */
  readonly daysOfWeek: readonly number[];
  /** Fixed UTC offset keeps evaluation reproducible and independent of host timezone/DST databases. */
  readonly utcOffsetMinutes: number;
}

export interface AlertPolicy {
  readonly schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  readonly notificationsEnabled: boolean;
  readonly notificationMinimumSeverity: AlertSeverity;
  readonly spool: {
    readonly enabled: boolean;
    readonly depth: ThresholdPair;
    readonly oldestAgeMs: ThresholdPair;
  };
  readonly cursor: {
    readonly enabled: boolean;
    readonly lagEvents: ThresholdPair;
  };
  readonly failedJobs: {
    readonly enabled: boolean;
    readonly count: ThresholdPair;
  };
  readonly hookSilence: {
    readonly enabled: boolean;
    readonly ageMs: ThresholdPair;
  };
  readonly quietHours: QuietHoursPolicy;
}

export interface AlertObservation {
  readonly schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  readonly observedAt: string;
  readonly spool: {
    readonly depth: number;
    readonly oldestAgeMs: number;
  };
  readonly cursors: readonly {
    readonly consumerId: string;
    readonly lagEvents: number;
  }[];
  readonly jobs: {
    readonly failedCount: number;
  };
  readonly hook: {
    readonly expected: boolean;
    readonly monitoringSinceAt: string;
    readonly lastEventAt?: string;
  };
}

export interface PreviousAlertState {
  readonly dedupeKey: string;
  readonly severity: AlertSeverity;
  readonly reasonCodes: readonly AlertReasonCode[];
  readonly notificationPending: boolean;
  readonly notificationDelivered: boolean;
}

export interface ActiveAlert extends PreviousAlertState {
  readonly alertId: string;
  readonly entityType: "SPOOL" | "CURSOR" | "JOBS" | "HOOK";
  readonly entityId: string;
  readonly observedAt: string;
  readonly observedValue: number;
  readonly threshold: number;
}

export interface AlertTransition {
  readonly dedupeKey: string;
  readonly kind: AlertTransitionKind;
  readonly previousSeverity?: AlertSeverity;
  readonly currentSeverity?: AlertSeverity;
  readonly reasonCodes: readonly AlertReasonCode[];
  readonly notificationDecision: NotificationDecision;
}

export interface AlertEvaluation {
  readonly schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  readonly evaluationId: string;
  readonly observedAt: string;
  readonly health: AlertHealth;
  readonly quietHoursActive: boolean;
  readonly activeAlerts: readonly ActiveAlert[];
  readonly transitions: readonly AlertTransition[];
}
