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
  readonly codexQuery?: {
    readonly enabled: boolean;
    readonly executable?: string;
    readonly model?: string;
    readonly userConfiguration: "ALLOW" | "IGNORE";
  };
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

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function codexQuery(value: unknown): SidecarConfig["codexQuery"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !["enabled", "executable", "model", "userConfiguration"].includes(key))
    || typeof value["enabled"] !== "boolean") throw new Error("codexQuery configuration is invalid");
  const executable = optionalText(value["executable"], "codexQuery.executable", 4_096);
  const model = optionalText(value["model"], "codexQuery.model", 200);
  const userConfiguration = value["userConfiguration"] ?? "ALLOW";
  if (userConfiguration !== "ALLOW" && userConfiguration !== "IGNORE") throw new Error("codexQuery.userConfiguration is invalid");
  if (!value["enabled"] && (executable !== undefined || model !== undefined)) {
    throw new Error("disabled codexQuery must not configure an executable or model");
  }
  if (executable !== undefined && !isAbsolute(executable)) {
    throw new Error("codexQuery.executable must be an absolute path");
  }
  return Object.freeze({
    enabled: value["enabled"],
    ...(executable === undefined ? {} : { executable }),
    ...(model === undefined ? {} : { model }),
    userConfiguration,
  });
}

export function parseSidecarConfig(value: unknown): SidecarConfig {
  if (!isRecord(value) || value["schemaVersion"] !== 1) {
    throw new Error("sidecar configuration schemaVersion must be 1");
  }
  const allowed = new Set([
    "schemaVersion", "rolloutMode", "socketPath", "codexSessionsRoot", "ledgerPath", "spoolPath", "logPath",
    "hookMaxInputBytes", "hookTimeoutMs", "logMaxBytes", "logRetainFiles", "codexQuery",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("sidecar configuration contains unknown fields");
  if (value["rolloutMode"] !== "SHADOW") {
    throw new Error("this release permits SHADOW rollout only");
  }
  const query = codexQuery(value["codexQuery"]);
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
    ...(query === undefined ? {} : { codexQuery: query }),
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
