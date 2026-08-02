import type {
  CompatibilityIssue,
  CompatibilityReport,
  SidecarCompatibilityPolicy,
  SidecarHealth,
} from "./types.js";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

function parseSemver(value: string): readonly [number, number, number] | undefined {
  const match = SEMVER.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function issue(code: CompatibilityIssue["code"], message: string): CompatibilityIssue {
  return Object.freeze({ code, message });
}

export function evaluateSidecarCompatibility(
  health: SidecarHealth | undefined,
  policy: SidecarCompatibilityPolicy,
): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];
  const plugin = parseSemver(policy.pluginVersion);
  const minimum = parseSemver(policy.minimumSidecarVersion);
  const sidecar = health === undefined ? undefined : parseSemver(health.sidecarVersion);
  const reportedPlugin = health === undefined ? undefined : parseSemver(health.pluginVersion);
  if (
    plugin === undefined || minimum === undefined || minimum[0] !== plugin[0] ||
    health === undefined || sidecar === undefined || reportedPlugin === undefined ||
    health.schemaVersion !== 1 || Number.isNaN(Date.parse(health.startedAt))
  ) {
    issues.push(issue("INVALID_HEALTH", "sidecar health or compatibility policy is missing or invalid"));
    return Object.freeze({ compatible: false, issues: Object.freeze(issues) });
  }
  if (health.status !== "READY") issues.push(issue("SIDECAR_DEGRADED", "sidecar is not ready"));
  if (health.pluginVersion !== policy.pluginVersion) issues.push(issue("PLUGIN_VERSION_MISMATCH", "plugin and sidecar plugin contract versions differ"));
  if (sidecar[0] !== plugin[0]) issues.push(issue("SIDECAR_MAJOR_MISMATCH", "plugin and sidecar major versions differ"));
  if (compare(sidecar, minimum) < 0) issues.push(issue("SIDECAR_TOO_OLD", "sidecar is older than the supported minimum"));
  if (health.protocolVersion !== policy.protocolVersion) issues.push(issue("PROTOCOL_MISMATCH", "sidecar protocol version differs"));
  if (health.hookSchemaVersion !== policy.hookSchemaVersion) issues.push(issue("HOOK_SCHEMA_MISMATCH", "Codex Hook schema version differs"));
  if (health.appServerSchemaVersion !== policy.appServerSchemaVersion) issues.push(issue("APP_SERVER_SCHEMA_MISMATCH", "Codex App Server schema version differs"));
  return Object.freeze({ compatible: issues.length === 0, issues: Object.freeze(issues) });
}
