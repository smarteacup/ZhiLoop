export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface HookHandlerConfiguration {
  readonly type: string;
  readonly command?: string;
  readonly commandWindows?: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
  readonly additionalContextLimit?: number;
  readonly [key: string]: JsonValue | undefined;
}

export interface HookMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookHandlerConfiguration[];
  readonly [key: string]: JsonValue | readonly HookHandlerConfiguration[] | undefined;
}

export interface HookConfiguration {
  readonly hooks: Readonly<Record<string, readonly HookMatcherGroup[]>>;
  readonly [key: string]: JsonValue | Readonly<Record<string, readonly HookMatcherGroup[]>>;
}

export interface ManagedHookEntry {
  readonly event: string;
  readonly fingerprint: string;
  readonly command: string;
}

export interface HookInstallReceipt {
  readonly schemaVersion: 1;
  readonly state: "PREPARED" | "ACTIVE";
  readonly targetPath: string;
  readonly originallyExisted: boolean;
  readonly originalText?: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly inserted: readonly ManagedHookEntry[];
  readonly createdAt: string;
}

export interface HookMergeResult {
  readonly configuration: HookConfiguration;
  readonly inserted: readonly ManagedHookEntry[];
  readonly preexisting: readonly ManagedHookEntry[];
}

export interface HookUnmergeResult {
  readonly configuration: HookConfiguration;
  readonly removed: readonly ManagedHookEntry[];
  readonly conflicts: readonly ManagedHookEntry[];
}

export interface SidecarHealth {
  readonly schemaVersion: 1;
  readonly status: "READY" | "DEGRADED";
  readonly pluginVersion: string;
  readonly sidecarVersion: string;
  readonly protocolVersion: number;
  readonly hookSchemaVersion: string;
  readonly appServerSchemaVersion: string;
  readonly startedAt: string;
}

export interface SidecarCompatibilityPolicy {
  readonly pluginVersion: string;
  readonly minimumSidecarVersion: string;
  readonly protocolVersion: number;
  readonly hookSchemaVersion: string;
  readonly appServerSchemaVersion: string;
}

export type CompatibilityIssueCode =
  | "SIDECAR_DEGRADED"
  | "PLUGIN_VERSION_MISMATCH"
  | "SIDECAR_MAJOR_MISMATCH"
  | "SIDECAR_TOO_OLD"
  | "PROTOCOL_MISMATCH"
  | "HOOK_SCHEMA_MISMATCH"
  | "APP_SERVER_SCHEMA_MISMATCH"
  | "INVALID_HEALTH";

export interface CompatibilityIssue {
  readonly code: CompatibilityIssueCode;
  readonly message: string;
}

export interface CompatibilityReport {
  readonly compatible: boolean;
  readonly issues: readonly CompatibilityIssue[];
}

export interface SidecarControlPort {
  health(signal: AbortSignal): Promise<SidecarHealth | undefined>;
  start(signal: AbortSignal): Promise<void>;
}

export interface SidecarReadiness {
  readonly started: boolean;
  readonly health?: SidecarHealth;
  readonly compatibility: CompatibilityReport;
}
