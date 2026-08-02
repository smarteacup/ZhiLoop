import type { SidecarCompatibilityPolicy, SidecarHealth } from "@zhiloop/plugin-runtime";

export type DaemonState = "STOPPED" | "STARTING" | "READY" | "DEGRADED" | "STOPPING";

export interface DaemonLifecycleComponent {
  readonly name: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  health(signal: AbortSignal): Promise<{ readonly healthy: boolean; readonly diagnostic?: string }>;
}

export interface DaemonHookPort {
  handle(input: unknown, signal: AbortSignal): Promise<string | undefined>;
}

export interface DaemonMcpPort {
  handle(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface DaemonWorkerCycle {
  readonly consumed: number;
  readonly produced: number;
  readonly cursor: number;
  readonly retryableFailures: number;
}

export interface DaemonWorkerPort {
  runOnce(signal: AbortSignal): Promise<DaemonWorkerCycle>;
}

export interface DaemonRuntimePorts {
  readonly components: readonly DaemonLifecycleComponent[];
  readonly hook: DaemonHookPort;
  readonly mcp: DaemonMcpPort;
  readonly worker: DaemonWorkerPort;
}

export interface DaemonRuntimeOptions {
  readonly compatibility: SidecarCompatibilityPolicy;
  readonly sidecarVersion: string;
  readonly clock?: () => Date;
  readonly hookDeadlinesMs?: Partial<Record<"UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd" | "other", number>>;
  readonly shutdownDeadlineMs?: number;
}

export interface DaemonComponentHealth {
  readonly name: string;
  readonly healthy: boolean;
  readonly diagnostic?: string;
}

export interface DaemonHealthSnapshot extends SidecarHealth {
  readonly daemonState: DaemonState;
  readonly components: readonly DaemonComponentHealth[];
  readonly lastWorkerCycle?: DaemonWorkerCycle;
  readonly diagnostic?: string;
}
