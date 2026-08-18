import type { SidecarCompatibilityPolicy } from "@zhiloop/plugin-runtime";

export const SIDECAR_VERSION = "0.4.0";

export const SIDECAR_COMPATIBILITY: SidecarCompatibilityPolicy = Object.freeze({
  pluginVersion: "0.1.0",
  minimumSidecarVersion: "0.1.0",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
});
