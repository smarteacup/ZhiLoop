export const OPERATIONAL_ALERT_TYPES = [
  "PERMANENT_JOB_FAILURE",
  "CODEGRAPH_UNAVAILABLE",
  "STALE_KNOWLEDGE",
  "MIGRATION_FAILED",
] as const;
export const OPERATIONAL_ALERT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export const OPERATIONAL_ALERT_DELIVERY_STATES = ["LOCAL_ONLY", "PENDING", "DELIVERED", "DELIVERY_FAILED"] as const;

export type OperationalAlertType = (typeof OPERATIONAL_ALERT_TYPES)[number];
export type OperationalAlertSeverity = (typeof OPERATIONAL_ALERT_SEVERITIES)[number];
export type OperationalAlertDeliveryState = (typeof OPERATIONAL_ALERT_DELIVERY_STATES)[number];

export interface OperationalAlertInput {
  /** Stable producer identity; retries with the same eventId are idempotent. */
  readonly eventId: string;
  readonly observedAt: string;
  readonly dedupKey: string;
  readonly severity: OperationalAlertSeverity;
  readonly type: OperationalAlertType;
  readonly projectId?: string;
  readonly entityRef?: string;
  readonly reasonCodes: readonly string[];
}

export interface OperationalAlertRecord {
  readonly schemaVersion: 1;
  readonly alertId: string;
  readonly dedupKey: string;
  readonly severity: OperationalAlertSeverity;
  readonly type: OperationalAlertType;
  readonly projectId?: string;
  readonly entityRef?: string;
  readonly reasonCodes: readonly string[];
  readonly occurrenceCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly revision: number;
  readonly deliveryState: OperationalAlertDeliveryState;
  readonly lastDeliveryAttemptAt?: string;
  readonly lastDeliveredAt?: string;
  readonly providerRef?: string;
}

export interface OperationalAlertDeliveryProvider {
  deliver(alert: OperationalAlertRecord): Promise<{ readonly providerRef?: string }>;
}

export interface OperationalAlertSink {
  emit(alert: OperationalAlertInput): Promise<OperationalAlertRecord>;
}

export interface OperationalAlertPage {
  readonly items: readonly OperationalAlertRecord[];
  readonly next?: { readonly lastObservedAt: string; readonly alertId: string };
}

export interface OperationalAlertStoreOptions {
  readonly cooldownMs?: number;
  readonly provider?: OperationalAlertDeliveryProvider;
}
