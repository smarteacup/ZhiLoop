export type RepositoryReadErrorCode =
  | "REPOSITORY_ROOT_INVALID"
  | "REPOSITORY_PATH_INVALID"
  | "REPOSITORY_PATH_ESCAPE"
  | "REPOSITORY_FILE_NOT_FOUND"
  | "REPOSITORY_FILE_NOT_REGULAR"
  | "REPOSITORY_FILE_TOO_LARGE"
  | "REPOSITORY_FILE_BINARY"
  | "REPOSITORY_READ_FAILED";

export class RepositoryReadError extends Error {
  constructor(readonly code: RepositoryReadErrorCode) {
    super(code);
    this.name = "RepositoryReadError";
  }
}

export interface RepositoryFile {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface RepositoryReadPort {
  read(relativePath: string): Promise<RepositoryFile>;
}

export interface RepositoryReadOptions {
  readonly maxBytes?: number;
  readonly maxPathDepth?: number;
}

export interface RegisteredRegexEvaluator {
  readonly evaluatorId: string;
  evaluate(input: {
    readonly pattern: string;
    readonly content: string;
    readonly deadlineMs: number;
  }): boolean | Promise<boolean>;
}

export interface RegisteredStructuralEvaluator {
  readonly evaluatorId: string;
  readonly extensions: readonly string[];
  contains(input: {
    readonly expected: string;
    readonly content: string;
    readonly path: string;
    readonly deadlineMs: number;
  }): boolean | Promise<boolean>;
}

export interface FileProbeOptions {
  readonly regex?: RegisteredRegexEvaluator;
  readonly structural?: readonly RegisteredStructuralEvaluator[];
  readonly evaluationTimeoutMs?: number;
}

export interface DependencyProbeOptions {
  readonly defaultManifestPaths?: readonly string[];
}

export interface ConfigurationProbeOptions {
  readonly defaultConfigPaths?: readonly string[];
  readonly maxKeyDepth?: number;
}
