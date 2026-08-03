import type { SidecarHealth } from "@zhiloop/plugin-runtime";

export interface DeploymentPaths {
  readonly home: string;
  readonly binDirectory: string;
  readonly shareDirectory: string;
  readonly releasesDirectory: string;
  readonly releaseDirectory: string;
  readonly currentLink: string;
  readonly sidecarLauncher: string;
  readonly zhiloopLauncher: string;
  readonly stateDirectory: string;
  readonly configPath: string;
  readonly socketPath: string;
  readonly codexSessionsRoot: string;
  readonly ledgerPath: string;
  readonly spoolDirectory: string;
  readonly logDirectory: string;
  readonly sidecarLogPath: string;
  readonly serviceStdoutPath: string;
  readonly serviceStderrPath: string;
  readonly installDirectory: string;
  readonly manifestPath: string;
  readonly journalPath: string;
  readonly hookReceiptPath: string;
  readonly codexHooksPath: string;
  readonly launchAgentPath: string;
}

export interface ReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
}

export interface ReleaseMetadata {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly pluginVersion: string;
  readonly protocolVersion: number;
  readonly sourceCommit: string;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly createdAt: string;
  readonly files: readonly ReleaseFile[];
}

export interface DeploymentManifest {
  readonly schemaVersion: 1;
  readonly state: "ACTIVE";
  readonly version: string;
  readonly installedAt: string;
  readonly releaseDigest: string;
  readonly sourceArtifact: string;
  readonly managedPaths: readonly string[];
  readonly previousVersion?: string;
}

export interface DeploymentPlanItem {
  readonly id: string;
  readonly action: "CREATE" | "MERGE" | "REPLACE" | "REUSE" | "START";
  readonly path?: string;
  readonly summary: string;
}

export interface DeploymentPlan {
  readonly schemaVersion: 1;
  readonly mode: "SHADOW";
  readonly version: string;
  readonly items: readonly DeploymentPlanItem[];
}

export interface DeploymentJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly operation: "install" | "upgrade" | "uninstall";
  readonly state: "PREPARED" | "APPLYING" | "COMMITTED" | "ROLLED_BACK";
  readonly startedAt: string;
  readonly completedSteps: readonly string[];
  readonly failedStep?: string;
}

export interface DeploymentStep {
  readonly id: string;
  apply(): Promise<() => Promise<void>>;
}

export interface DeploymentTransactionOptions {
  readonly journalPath: string;
  readonly operation: DeploymentJournal["operation"];
  readonly failAfterStep?: string;
  readonly clock?: () => Date;
  readonly randomId?: () => string;
}

export interface DeploymentTransactionResult {
  readonly journal: DeploymentJournal;
}

export interface ServiceController {
  bootstrap(plistPath: string): Promise<void>;
  kickstart(): Promise<void>;
  bootout(): Promise<void>;
  status(): Promise<"RUNNING" | "STOPPED" | "UNKNOWN">;
}

export interface HealthProbe {
  health(): Promise<SidecarHealth | undefined>;
}
