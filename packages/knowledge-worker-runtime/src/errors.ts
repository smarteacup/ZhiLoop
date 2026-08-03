export class KnowledgeWorkerError extends Error {
  override readonly name = "KnowledgeWorkerError";
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.retryable = retryable;
  }
}

export class KnowledgeWorkerCheckpointConflictError extends Error {
  override readonly name = "KnowledgeWorkerCheckpointConflictError";
}
