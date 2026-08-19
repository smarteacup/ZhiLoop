export const SESSION_CATALOG_SCHEMA_VERSION = 1 as const;
export const MAX_SESSION_PAGE_SIZE = 100;
export const MAX_DISCOVERED_SESSIONS = 50_000;

export type SessionSource = "CODEX_APP_SERVER" | "CODEX_TRANSCRIPT";
export type SessionSourceStatus = "AVAILABLE" | "UNAVAILABLE" | "UNSUPPORTED";
export type SessionCaptureStatus =
  | "DISCOVERED_NOT_CAPTURED"
  | "CAPTURED_PARTIAL"
  | "CAPTURED_CURRENT"
  | "SOURCE_UNAVAILABLE";
export type SessionTimeGroup = "TODAY" | "YESTERDAY" | "PREVIOUS_7_DAYS" | "OLDER";
export type SessionTitleSource = "SOURCE" | "FIRST_USER_PROMPT" | "CWD" | "SESSION_ID";

export type SessionCatalogDiagnosticCode =
  | "SOURCE_NOT_CONFIGURED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_UNSUPPORTED"
  | "UNSAFE_ROOT"
  | "DEPTH_LIMIT_EXCEEDED"
  | "FILE_LIMIT_EXCEEDED"
  | "FILE_TOO_LARGE"
  | "LINE_TOO_LARGE"
  | "MALFORMED_RECORD"
  | "UNSUPPORTED_FORMAT"
  | "DUPLICATE_SESSION_ID"
  | "UNSAFE_PATH"
  | "PROVIDER_LIMIT_EXCEEDED";

export interface SessionCatalogDiagnostic {
  readonly code: SessionCatalogDiagnosticCode;
  readonly source: SessionSource;
  readonly safeSourceAlias?: string;
  readonly retryable: boolean;
}

export interface SessionSourceCapability {
  readonly schemaVersion: typeof SESSION_CATALOG_SCHEMA_VERSION;
  readonly source: SessionSource;
  readonly status: SessionSourceStatus;
  readonly reason: "READY" | "NOT_CONFIGURED" | "UNAVAILABLE" | "UNSUPPORTED";
  readonly observedAt: string;
  readonly supportedFormatVersions: readonly string[];
  readonly observedFormatVersion?: string;
  readonly diagnosticCount: number;
}

export interface SourceSessionRecord {
  readonly sessionId: string;
  readonly source: SessionSource;
  readonly sourceStatus: SessionSourceStatus;
  readonly sourceVersion?: string;
  readonly sourceFormatVersion: string;
  readonly safeSourceAlias: string;
  readonly explicitTitle?: string;
  readonly firstUserPrompt?: string;
  readonly cwd?: string;
  readonly firstActivityAt: string;
  readonly lastActivityAt: string;
  readonly sourceRecordCount: number;
  readonly sourceTurnCount: number;
  readonly ignoredRecords: number;
  readonly sourceByteLength?: number;
}

export interface SessionSourceSnapshot {
  readonly source: SessionSource;
  readonly capability: SessionSourceCapability;
  readonly sessions: readonly SourceSessionRecord[];
  readonly diagnostics: readonly SessionCatalogDiagnostic[];
  readonly revision: string;
  readonly changed: boolean;
  readonly scanStats: {
    readonly filesVisited: number;
    readonly filesRead: number;
    readonly filesReused: number;
  };
}

export interface SessionCatalogSourcePort {
  scan(): Promise<SessionSourceSnapshot>;
}

export interface CapturedSessionState {
  readonly current: boolean;
  readonly cursorByteOffset?: number;
  readonly eventCount: number;
  readonly turnCount: number;
  readonly ignoredRecords: number;
  readonly redactionCount: number;
  readonly projectHint?: string;
  readonly cwdAlias?: string;
}

export interface SessionCaptureProjectionPort {
  getMany(sessionIds: readonly string[]): Promise<ReadonlyMap<string, CapturedSessionState>>;
  /** Optional bounded metadata retained by ZhiLoop for sessions whose Codex source is currently unavailable. */
  listKnownSessions?(maximum: number): Promise<readonly SourceSessionRecord[]>;
}

export interface SessionCatalogEntry {
  readonly schemaVersion: typeof SESSION_CATALOG_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly title: string;
  readonly titleSource: SessionTitleSource;
  readonly source: SessionSource;
  readonly sourceStatus: SessionSourceStatus;
  readonly sourceVersion?: string;
  readonly sourceFormatVersion: string;
  readonly safeSourceAlias: string;
  readonly captureStatus: SessionCaptureStatus;
  readonly projectHint?: string;
  readonly cwdAlias?: string;
  readonly firstActivityAt: string;
  readonly lastActivityAt: string;
  readonly timeGroup: SessionTimeGroup;
  readonly eventCount: number;
  readonly turnCount: number;
  readonly ignoredRecords: number;
  readonly redactionCount: number;
}

export interface SessionPagePosition {
  readonly lastActivityAt: string;
  readonly sessionId: string;
}

export interface SessionCatalogListRequest {
  readonly limit?: number;
  readonly after?: SessionPagePosition;
  readonly source?: SessionSource;
  readonly captureStatus?: SessionCaptureStatus;
  readonly timeGroup?: SessionTimeGroup;
  readonly projectHint?: string;
}

export interface SessionCatalogListResult {
  readonly items: readonly SessionCatalogEntry[];
  readonly nextPosition?: SessionPagePosition;
  readonly sourceCapabilities: readonly SessionSourceCapability[];
  readonly diagnostics: readonly SessionCatalogDiagnostic[];
  readonly revision: string;
  readonly changed: boolean;
}

export interface SessionCatalogQueryPort {
  list(request?: SessionCatalogListRequest): Promise<SessionCatalogListResult>;
  get(sessionId: string): Promise<SessionCatalogEntry | undefined>;
}

/** The exact shape consumed by control-api's SessionSummary without importing its HTTP DTO package. */
export interface ControlSessionSummaryCompatible {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly title: string;
  readonly source: SessionSource;
  readonly sourceStatus: SessionSourceStatus;
  readonly sourceVersion?: string;
  readonly captureStatus: SessionCaptureStatus;
  readonly projectHint?: string;
  readonly cwdAlias?: string;
  readonly firstActivityAt: string;
  readonly lastActivityAt: string;
  readonly eventCount: number;
  readonly turnCount: number;
  readonly ignoredRecords: number;
  readonly redactionCount: number;
}
