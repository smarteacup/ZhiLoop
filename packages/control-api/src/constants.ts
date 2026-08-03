export const CONTROL_API_SCHEMA_VERSION = 1 as const;
export const MAX_CONTROL_MESSAGE_BYTES = 1_048_576;
export const MAX_PAGE_SIZE = 100;
export const MAX_CURSOR_BYTES = 2_048;

export const CAPABILITY_STATUSES = [
  "NOT_IMPLEMENTED",
  "DISABLED",
  "NOT_CONFIGURED",
  "NOT_VERIFIED",
  "STARTING",
  "READY",
  "DEGRADED",
  "FAILED",
] as const;

export const STAGE_STATUSES = [
  "NOT_APPLICABLE",
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
  "DISABLED",
] as const;

export const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "RETRY_WAIT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export const INJECTION_STATUSES = [
  "PENDING",
  "RETRIEVING",
  "DISABLED",
  "SHADOWED",
  "INJECTED",
  "NO_CONTEXT",
  "ROLLED_BACK",
  "INVALID_INPUT",
  "TIMEOUT",
  "PROVIDER_ERROR",
  "INVALID_CONTEXT",
  "ERROR",
] as const;

export const REASON_CODES = [
  "NOT_APPLICABLE",
  "CAPABILITY_NOT_IMPLEMENTED",
  "CAPABILITY_DISABLED",
  "CAPABILITY_NOT_CONFIGURED",
  "CAPABILITY_NOT_VERIFIED",
  "COMPONENT_STARTING",
  "COMPONENT_READY",
  "COMPONENT_DEGRADED",
  "COMPONENT_FAILED",
  "KNOWLEDGE_WORKER_NOT_COMPOSED",
  "MCP_TRANSPORT_NOT_ENABLED",
  "STOP_VERIFIER_NOT_COMPOSED",
  "ACTIVE_ROLLOUT_NOT_ELIGIBLE",
  "SOURCE_UNAVAILABLE",
  "SOURCE_UNSUPPORTED",
  "DISCOVERED_NOT_CAPTURED",
  "CAPTURED_PARTIAL",
  "CAPTURED_CURRENT",
  "UPSTREAM_BLOCKED",
  "POLICY_SKIPPED",
  "JOB_QUEUED",
  "JOB_RUNNING",
  "JOB_RETRY_WAIT",
  "JOB_SUCCEEDED",
  "JOB_FAILED",
  "JOB_CANCELLED",
  "SHADOW_CONTEXT_ONLY",
  "CONTEXT_INJECTED",
  "NO_ELIGIBLE_CONTEXT",
  "DEADLINE_EXCEEDED",
  "PROVIDER_UNAVAILABLE",
  "INVALID_CONTEXT",
  "INVALID_INPUT",
  "ROLLOUT_CHANGED",
  "OPERATOR_CANCELLED",
] as const;

export const CONTROL_ERROR_CODES = [
  "INVALID_JSON",
  "MESSAGE_TOO_LARGE",
  "UNSUPPORTED_SCHEMA_VERSION",
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN_ORIGIN",
  "CSRF_REJECTED",
  "NOT_FOUND",
  "CONFLICT",
  "STALE_REVISION",
  "INVALID_CURSOR",
  "CAPABILITY_UNAVAILABLE",
  "RATE_LIMITED",
  "SIDECAR_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export const CONTROL_REQUEST_TYPES = [
  "overview.get",
  "capabilities.list",
  "sessions.list",
  "session.get",
  "session.events.list",
  "jobs.list",
  "diagnostics.get",
  "capture.preview",
  "capture.commit",
  "config.get",
  "config.validate",
  "config.activate",
  "config.rollback",
] as const;

export const SSE_EVENT_TYPES = [
  "capability.updated",
  "session.updated",
  "stage.updated",
  "job.updated",
  "configuration.updated",
  "alert.updated",
  "resync.required",
] as const;
