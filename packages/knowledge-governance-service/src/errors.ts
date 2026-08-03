export type GovernanceErrorCode =
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "STALE_EXPECTED_VERSION"
  | "MANUAL_MARKDOWN_CONFLICT"
  | "PROJECTION_NOT_CURRENT"
  | "HIGH_RISK_GOVERNANCE_DISABLED"
  | "DRAFT_NOT_VALIDATED"
  | "DRAFT_ALREADY_COMMITTED"
  | "REVALIDATION_FAILED"
  | "RESTORE_REVALIDATION_FAILED"
  | "OUTBOX_FAILED";

export class GovernanceError extends Error {
  override readonly name = "GovernanceError";
  readonly code: GovernanceErrorCode;
  readonly retryable: boolean;

  constructor(code: GovernanceErrorCode, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.retryable = retryable;
  }
}

export class GovernanceStoreConflictError extends Error {
  override readonly name = "GovernanceStoreConflictError";
}
