import type { KnowledgeExtractionAdapterErrorCode } from "./types.js";

export class KnowledgeExtractionAdapterError extends Error {
  readonly code: KnowledgeExtractionAdapterErrorCode;
  readonly retryable: boolean;

  constructor(code: KnowledgeExtractionAdapterErrorCode, retryable: boolean, message: string = code) {
    super(message);
    this.name = "KnowledgeExtractionAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}
