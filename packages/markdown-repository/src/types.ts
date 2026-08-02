import type { KnowledgeAsset } from "@zhiloop/domain";

export type MarkdownRepositoryDiagnosticCode =
  | "NOT_FOUND"
  | "DOCUMENT_TOO_LARGE"
  | "INVALID_DOCUMENT"
  | "INVALID_FRONT_MATTER"
  | "SCHEMA_VALIDATION_FAILED"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "PATH_BINDING_MISMATCH"
  | "UNSAFE_STORAGE";

export interface MarkdownRepositoryDiagnostic {
  readonly code: MarkdownRepositoryDiagnosticCode;
  readonly message: string;
  readonly path: string;
  readonly issues: readonly string[];
}

export interface StoredKnowledgeVersion {
  readonly asset: KnowledgeAsset;
  readonly tombstone: boolean;
  readonly tombstoneReason?: string;
  readonly historyState: "COMMITTED" | "MANUAL_EDIT" | "UNVERIFIED";
  readonly documentPath: string;
}

export type MarkdownReadResult =
  | { readonly ok: true; readonly value: StoredKnowledgeVersion }
  | {
      readonly ok: false;
      readonly error: MarkdownRepositoryDiagnostic;
      readonly lastValid?: StoredKnowledgeVersion;
    };

export interface MarkdownPublishOptions {
  readonly expectedCurrentVersion?: number;
}

export interface MarkdownPublishResult {
  readonly status: "PUBLISHED" | "IDEMPOTENT";
  readonly value: StoredKnowledgeVersion;
}

export interface MarkdownTombstoneOptions {
  readonly expectedCurrentVersion: number;
  readonly reason: string;
  readonly updatedAt: string;
  readonly correlationId: string;
}

export interface MarkdownRestoreOptions {
  readonly expectedCurrentVersion: number;
  readonly updatedAt: string;
  readonly correlationId: string;
}

export interface MarkdownManualEditOptions {
  readonly expectedCurrentVersion: number;
  readonly updatedAt: string;
  readonly correlationId: string;
}

export type MarkdownCommitPhase = "BEFORE_VERSION_COMMIT" | "BEFORE_CURRENT_COMMIT";

export interface MarkdownRepositoryOptions {
  readonly maxDocumentBytes?: number;
  readonly randomId?: () => string;
  readonly faultInjector?: (phase: MarkdownCommitPhase) => void | Promise<void>;
}

export class MarkdownRepositoryConflictError extends Error {
  override readonly name = "MarkdownRepositoryConflictError";
}

export class MarkdownRepositoryInvalidDocumentError extends Error {
  override readonly name = "MarkdownRepositoryInvalidDocumentError";
  readonly diagnostic: MarkdownRepositoryDiagnostic;

  constructor(diagnostic: MarkdownRepositoryDiagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}
