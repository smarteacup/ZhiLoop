import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const MAX_CONFIG_BYTES = 1_048_576;

export interface SidecarConfig {
  readonly schemaVersion: 1;
  readonly rolloutMode: "SHADOW";
  readonly socketPath: string;
  readonly codexSessionsRoot: string;
  readonly ledgerPath: string;
  readonly spoolPath: string;
  readonly logPath: string;
  readonly hookMaxInputBytes: number;
  readonly hookTimeoutMs: number;
  readonly logMaxBytes: number;
  readonly logRetainFiles: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
  }
  return value as number;
}

export function parseSidecarConfig(value: unknown): SidecarConfig {
  if (!isRecord(value) || value["schemaVersion"] !== 1) {
    throw new Error("sidecar configuration schemaVersion must be 1");
  }
  if (value["rolloutMode"] !== "SHADOW") {
    throw new Error("this release permits SHADOW rollout only");
  }
  return Object.freeze({
    schemaVersion: 1,
    rolloutMode: "SHADOW",
    socketPath: absolutePath(value["socketPath"], "socketPath"),
    codexSessionsRoot: absolutePath(value["codexSessionsRoot"], "codexSessionsRoot"),
    ledgerPath: absolutePath(value["ledgerPath"], "ledgerPath"),
    spoolPath: absolutePath(value["spoolPath"], "spoolPath"),
    logPath: absolutePath(value["logPath"], "logPath"),
    hookMaxInputBytes: boundedInteger(value["hookMaxInputBytes"] ?? 5_242_880, "hookMaxInputBytes", 1, 5_242_880),
    hookTimeoutMs: boundedInteger(value["hookTimeoutMs"] ?? 750, "hookTimeoutMs", 1, 3_000),
    logMaxBytes: boundedInteger(value["logMaxBytes"] ?? 5_242_880, "logMaxBytes", 1_024, 104_857_600),
    logRetainFiles: boundedInteger(value["logRetainFiles"] ?? 3, "logRetainFiles", 1, 20),
  });
}

export async function loadSidecarConfig(path: string): Promise<SidecarConfig> {
  if (!isAbsolute(path)) throw new Error("configuration path must be absolute");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("configuration path must be a regular file");
  if (stat.size > MAX_CONFIG_BYTES) throw new Error("sidecar configuration exceeds 1 MiB");
  const text = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("sidecar configuration is not valid JSON");
  }
  return parseSidecarConfig(value);
}
