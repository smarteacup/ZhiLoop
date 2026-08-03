import type { ConsoleConfiguration } from "./schema.js";

export type ConfigurationScope = "GLOBAL" | "PROJECT";
export type ConfigurationFieldSource = "DEFAULT" | "GLOBAL" | "PROJECT_OVERRIDE";
export type ConsumerCapability = "READY" | "DISABLED" | "NOT_CONFIGURED" | "NOT_VERIFIED";

export interface ConfigurationDiagnostic {
  readonly code: "INVALID_CONFIGURATION" | "STALE_REVISION" | "CONFLICT" | "CONSUMER_DISABLED" | "COMPONENT_PREPARE_FAILED" | "COMPONENT_APPLY_FAILED" | "COMPONENT_ROLLBACK_FAILED" | "NOT_FOUND";
  readonly path?: string;
  readonly retryable: boolean;
}

export interface ConfigurationView {
  readonly revision: number;
  readonly hash: string;
  readonly effective: ConsoleConfiguration;
  readonly sources: Readonly<Record<string, ConfigurationFieldSource>>;
  readonly projectId?: string;
}

export interface ConfigurationDraft {
  readonly draftRevision: number;
  readonly baseRevision: number;
  readonly scope: ConfigurationScope;
  readonly projectId?: string;
  readonly configuration: ConsoleConfiguration;
  readonly changedPaths: readonly string[];
  readonly requiresRestart: boolean;
  readonly activatable: boolean;
  readonly diagnostics: readonly ConfigurationDiagnostic[];
}

export type ConfigurationValidationResult =
  | { readonly ok: true; readonly draft: ConfigurationDraft }
  | { readonly ok: false; readonly diagnostics: readonly ConfigurationDiagnostic[] };

export type ConfigurationMutationResult =
  | { readonly ok: true; readonly revision: number; readonly hash: string; readonly status: "EFFECTIVE" | "ROLLED_BACK" }
  | { readonly ok: false; readonly diagnostic: ConfigurationDiagnostic };

export interface ConfigurationHistoryEntry {
  readonly revision: number;
  readonly baseRevision: number;
  readonly status: "EFFECTIVE" | "REJECTED" | "ROLLED_BACK";
  readonly hash: string;
  readonly scope: ConfigurationScope;
  readonly projectId?: string;
  readonly changedPaths: readonly string[];
  readonly requiresRestart: boolean;
  readonly createdAt: string;
  readonly reasonCode: string;
}

export interface ConfigurationAuditEntry {
  readonly sequence: number;
  readonly revision: number;
  readonly operatorId: string;
  readonly component: string;
  readonly code: string;
  readonly changedPaths: readonly string[];
  readonly observedAt: string;
}

export interface ConfigurationActivationComponent {
  readonly componentId: string;
  prepare(configuration: ConsoleConfiguration): Promise<void>;
  apply(configuration: ConsoleConfiguration): Promise<() => Promise<void>>;
}

export interface ConfigurationServiceOptions {
  readonly clock?: () => Date;
  readonly capabilities?: () => Readonly<Record<string, ConsumerCapability>>;
  readonly components?: readonly ConfigurationActivationComponent[];
}
