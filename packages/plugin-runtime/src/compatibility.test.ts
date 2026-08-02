import { describe, expect, it } from "vitest";

import { evaluateSidecarCompatibility } from "./compatibility.js";
import type { SidecarCompatibilityPolicy, SidecarHealth } from "./types.js";

const policy: SidecarCompatibilityPolicy = {
  pluginVersion: "0.1.0",
  minimumSidecarVersion: "0.1.0",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
};

const health: SidecarHealth = {
  schemaVersion: 1,
  status: "READY",
  pluginVersion: "0.1.0",
  sidecarVersion: "0.1.1",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
  startedAt: "2026-08-02T10:00:00.000Z",
};

describe("sidecar compatibility", () => {
  it("accepts a ready same-major sidecar at or above the minimum", () => {
    expect(evaluateSidecarCompatibility(health, policy)).toEqual({ compatible: true, issues: [] });
  });

  it("reports every independently actionable incompatibility", () => {
    const report = evaluateSidecarCompatibility({
      ...health,
      status: "DEGRADED",
      pluginVersion: "0.2.0",
      sidecarVersion: "1.0.0",
      protocolVersion: 2,
      hookSchemaVersion: "other",
      appServerSchemaVersion: "v3",
    }, policy);
    expect(report.compatible).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual([
      "SIDECAR_DEGRADED",
      "PLUGIN_VERSION_MISMATCH",
      "SIDECAR_MAJOR_MISMATCH",
      "PROTOCOL_MISMATCH",
      "HOOK_SCHEMA_MISMATCH",
      "APP_SERVER_SCHEMA_MISMATCH",
    ]);
  });

  it("rejects missing, malformed, and too-old health", () => {
    expect(evaluateSidecarCompatibility(undefined, policy).issues[0]?.code).toBe("INVALID_HEALTH");
    expect(evaluateSidecarCompatibility({ ...health, sidecarVersion: "latest" }, policy).issues[0]?.code).toBe("INVALID_HEALTH");
    expect(evaluateSidecarCompatibility({ ...health, pluginVersion: "dev" }, policy).issues[0]?.code).toBe("INVALID_HEALTH");
    expect(evaluateSidecarCompatibility({ ...health, startedAt: "today" }, policy).issues[0]?.code).toBe("INVALID_HEALTH");
    expect(evaluateSidecarCompatibility(health, { ...policy, minimumSidecarVersion: "1.0.0" }).issues[0]?.code).toBe("INVALID_HEALTH");
    const tooOld = evaluateSidecarCompatibility({ ...health, sidecarVersion: "0.0.9" }, policy);
    expect(tooOld.issues.map(({ code }) => code)).toContain("SIDECAR_TOO_OLD");
  });
});
