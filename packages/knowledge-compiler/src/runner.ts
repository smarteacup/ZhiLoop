import { createHash } from "node:crypto";

import type {
  KnowledgeAssertion,
  KnowledgeCandidate,
  KnowledgeExtractionOutput,
} from "@zhiloop/domain";
import { parseKnowledgeCandidate, parseKnowledgeExtractionOutput } from "@zhiloop/schemas";

import { KnowledgeExtractionAdapterError } from "./adapter-error.js";
import type {
  KnowledgeExtractionDiagnostic,
  KnowledgeExtractionFailureReason,
  KnowledgeExtractionPort,
  KnowledgeExtractionRequest,
  KnowledgeExtractionResult,
  KnowledgeExtractionRunOptions,
  KnowledgeExtractionScheduler,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_INPUT_JSON_CHARS = 4_000_000;
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,100}$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

interface ValidatedOptions {
  readonly perAttemptTimeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly signal?: AbortSignal;
  readonly scheduler: KnowledgeExtractionScheduler;
}

type AttemptResult =
  | { readonly kind: "OUTPUT"; readonly output: unknown }
  | { readonly kind: "ERROR"; readonly error: unknown }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "ABORTED"; readonly started: boolean };

type MaterializationResult =
  | { readonly ok: true; readonly candidates: readonly KnowledgeCandidate[] }
  | { readonly ok: false; readonly diagnostics: readonly KnowledgeExtractionDiagnostic[] };

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
    && Number(offsetHourText ?? 0) <= 23 && Number(offsetMinuteText ?? 0) <= 59;
}

function assertNonEmpty(value: string, name: string, maxLength = 200): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} must contain 1 to ${maxLength} characters`);
  }
}

function assertRequest(request: KnowledgeExtractionRequest): void {
  if (request.input.schemaVersion !== 1) throw new Error("extraction input schemaVersion must be 1");
  assertNonEmpty(request.input.episodeId, "episodeId");
  assertNonEmpty(request.input.goal, "goal", 32_000);
  assertNonEmpty(request.input.goalRef, "goalRef", 500);
  assertNonEmpty(request.input.projectContext.projectId, "projectId", 500);
  if (typeof request.input.projectContext.portable !== "boolean") throw new Error("projectContext portable flag is invalid");
  if (!SAFE_VERSION.test(request.input.builderVersion)) throw new Error("builderVersion is invalid");
  if (!SAFE_VERSION.test(request.compilerVersion)) throw new Error("compilerVersion is invalid");
  if (!SAFE_VERSION.test(request.promptVersion)) throw new Error("promptVersion is invalid");
  assertNonEmpty(request.correlationId, "correlationId");
  if (!isIsoDateTime(request.requestedAt)) throw new Error("requestedAt must be a valid ISO date-time");
  if (request.input.evidenceRefs.length === 0) throw new Error("extraction input requires evidenceRefs");
  if (new Set(request.input.evidenceRefs).size !== request.input.evidenceRefs.length) {
    throw new Error("extraction input evidenceRefs must be unique");
  }
  for (const reference of request.input.evidenceRefs) assertNonEmpty(reference, "evidenceRef", 500);
  if (!request.input.evidenceRefs.includes(request.input.goalRef)) {
    throw new Error("extraction input goalRef must be present in evidenceRefs");
  }
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function validateOptions(options: KnowledgeExtractionRunOptions): ValidatedOptions {
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(perAttemptTimeoutMs) || perAttemptTimeoutMs < 1 || perAttemptTimeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`perAttemptTimeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new Error(`maxAttempts must be between 1 and ${MAX_ATTEMPTS}`);
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > MAX_RETRY_DELAY_MS) {
    throw new Error(`retryDelayMs must be between 0 and ${MAX_RETRY_DELAY_MS}`);
  }
  return {
    perAttemptTimeoutMs,
    maxAttempts,
    retryDelayMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    scheduler: options.scheduler ?? { sleep: defaultSleep },
  };
}

export function knowledgeExtractionInputHash(request: KnowledgeExtractionRequest): string {
  const serialized = canonicalJson(request.input);
  if (serialized.length > MAX_INPUT_JSON_CHARS) {
    throw new Error(`extraction input must not exceed ${MAX_INPUT_JSON_CHARS} canonical JSON characters`);
  }
  return hash(["knowledge-extraction-input-v1", serialized]);
}

function extractionKey(request: KnowledgeExtractionRequest, inputHash: string): string {
  return hash([
    "knowledge-extraction-v1",
    request.input.episodeId,
    request.input.builderVersion,
    inputHash,
    request.compilerVersion,
    request.promptVersion,
  ]);
}

export function knowledgeExtractionKey(request: KnowledgeExtractionRequest): string {
  return extractionKey(request, knowledgeExtractionInputHash(request));
}

async function runAttempt(
  port: KnowledgeExtractionPort,
  request: KnowledgeExtractionRequest,
  extractionKey: string,
  inputHash: string,
  attempt: number,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): Promise<AttemptResult> {
  if (parentSignal?.aborted === true) return { kind: "ABORTED", started: false };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortParent: (() => void) | undefined;
  const boundary = new Promise<AttemptResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort("timeout");
      resolve({ kind: "TIMEOUT" });
    }, timeoutMs);
    if (parentSignal !== undefined) {
      abortParent = (): void => {
        controller.abort(parentSignal.reason);
        resolve({ kind: "ABORTED", started: true });
      };
      parentSignal.addEventListener("abort", abortParent, { once: true });
    }
  });
  const extraction = Promise.resolve()
    .then(() => port.extract(request.input, {
      extractionKey,
      inputHash,
      compilerVersion: request.compilerVersion,
      promptVersion: request.promptVersion,
      attempt,
      signal: controller.signal,
    }))
    .then<AttemptResult, AttemptResult>(
      (output) => ({ kind: "OUTPUT", output }),
      (error: unknown) => ({ kind: "ERROR", error }),
    );
  try {
    return await Promise.race([extraction, boundary]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (parentSignal !== undefined && abortParent !== undefined) parentSignal.removeEventListener("abort", abortParent);
  }
}

function validateGrounding(
  output: KnowledgeExtractionOutput,
  request: KnowledgeExtractionRequest,
): readonly KnowledgeExtractionDiagnostic[] {
  const diagnostics: KnowledgeExtractionDiagnostic[] = [];
  const evidence = new Set(request.input.evidenceRefs);
  const expectedProject = request.input.projectContext;
  for (const [candidateIndex, candidate] of output.candidates.entries()) {
    const base = `/candidates/${candidateIndex}`;
    if (candidate.scopeHint.projectId !== undefined && candidate.scopeHint.projectId !== expectedProject.projectId) {
      diagnostics.push({ code: "PROJECT_MISMATCH", path: `${base}/scopeHint/projectId` });
    }
    if (
      candidate.scopeHint.repositoryRemote !== undefined
      && candidate.scopeHint.repositoryRemote !== expectedProject.repositoryRemote
    ) {
      diagnostics.push({ code: "PROJECT_MISMATCH", path: `${base}/scopeHint/repositoryRemote` });
    }
    for (const [assertionIndex, assertion] of candidate.assertions.entries()) {
      if (
        (assertion.kind === "USER_ACCEPTED" || assertion.kind === "USER_REJECTED")
        && !evidence.has(assertion.parameters.statementRef)
      ) {
        diagnostics.push({ code: "UNREFERENCED_SOURCE", path: `${base}/assertions/${assertionIndex}/parameters/statementRef` });
      }
      if (assertion.kind === "SYMBOL_EXISTS" && assertion.parameters.projectId !== expectedProject.projectId) {
        diagnostics.push({ code: "PROJECT_MISMATCH", path: `${base}/assertions/${assertionIndex}/parameters/projectId` });
      }
    }
    for (const [hintIndex, hint] of candidate.evidenceHints.entries()) {
      if (!evidence.has(hint.sourceRef)) {
        diagnostics.push({ code: "UNREFERENCED_SOURCE", path: `${base}/evidenceHints/${hintIndex}/sourceRef` });
      }
      if (hint.projectId !== undefined && hint.projectId !== expectedProject.projectId) {
        diagnostics.push({ code: "PROJECT_MISMATCH", path: `${base}/evidenceHints/${hintIndex}/projectId` });
      }
    }
  }
  return diagnostics;
}

function materializeCandidates(
  output: KnowledgeExtractionOutput,
  request: KnowledgeExtractionRequest,
  extractionKey: string,
): MaterializationResult {
  const groundingDiagnostics = validateGrounding(output, request);
  if (groundingDiagnostics.length > 0) return { ok: false, diagnostics: groundingDiagnostics };
  const candidates: KnowledgeCandidate[] = [];
  for (const [candidateIndex, draft] of output.candidates.entries()) {
    const candidateId = hash([extractionKey, "candidate", String(candidateIndex), canonicalJson(draft)]);
    const assertions = draft.assertions.map((assertion, assertionIndex): KnowledgeAssertion => ({
      assertionId: hash([candidateId, "assertion", String(assertionIndex), canonicalJson(assertion)]),
      candidateId,
      kind: assertion.kind,
      parameters: structuredClone(assertion.parameters),
      createdAt: request.requestedAt,
    }) as KnowledgeAssertion);
    const candidateInput = {
      schemaVersion: 1,
      candidateId,
      compilerVersion: request.compilerVersion,
      status: "PROPOSED",
      subjectKey: draft.subjectKey,
      kind: draft.kind,
      scopeHint: structuredClone(draft.scopeHint),
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      sourceEpisodes: [request.input.episodeId],
      confidence: draft.confidence,
      createdAt: request.requestedAt,
      correlationId: request.correlationId,
      assertions,
      evidenceHints: draft.evidenceHints.map((hint) => ({
        ...hint,
        correlationId: request.correlationId,
      })),
    };
    const parsed = parseKnowledgeCandidate(candidateInput);
    if (!parsed.ok) {
      return {
        ok: false,
        diagnostics: [{ code: "GENERATED_CANDIDATE_INVALID", path: `/candidates/${candidateIndex}` }],
      };
    }
    candidates.push(deepFreeze(parsed.value));
  }
  return { ok: true, candidates: Object.freeze(candidates) };
}

function invalidOutput(
  output: unknown,
  request: KnowledgeExtractionRequest,
  extractionKey: string,
): { readonly candidates?: readonly KnowledgeCandidate[]; readonly diagnostics: readonly KnowledgeExtractionDiagnostic[] } {
  const parsed = parseKnowledgeExtractionOutput(output);
  if (!parsed.ok) {
    const issues = parsed.error.issues.length === 0
      ? [{ instancePath: parsed.error.code === "UNSUPPORTED_SCHEMA_VERSION" ? "/schemaVersion" : "" }]
      : parsed.error.issues;
    return {
      diagnostics: Object.freeze(issues.slice(0, 100).map((issue) => Object.freeze({
        code: "SCHEMA_INVALID" as const,
        path: issue.instancePath,
      }))),
    };
  }
  const materialized = materializeCandidates(parsed.value, request, extractionKey);
  if (!materialized.ok) return { diagnostics: Object.freeze(materialized.diagnostics) };
  return { candidates: materialized.candidates, diagnostics: [] };
}

function resultBase(request: KnowledgeExtractionRequest, extractionKey: string, inputHash: string, attempts: number) {
  return {
    extractionKey,
    inputHash,
    episodeId: request.input.episodeId,
    builderVersion: request.input.builderVersion,
    compilerVersion: request.compilerVersion,
    promptVersion: request.promptVersion,
    attempts,
  } as const;
}

function failureReason(error: unknown): { readonly reason: KnowledgeExtractionFailureReason; readonly retryable: boolean } {
  if (error instanceof KnowledgeExtractionAdapterError) {
    if (error.code === "INVALID_OUTPUT") return { reason: "INVALID_OUTPUT", retryable: error.retryable };
    return {
      reason: error.retryable ? "ADAPTER_UNAVAILABLE" : "ADAPTER_REJECTED",
      retryable: error.retryable,
    };
  }
  return { reason: "ADAPTER_UNAVAILABLE", retryable: true };
}

export async function runKnowledgeExtraction(
  request: KnowledgeExtractionRequest,
  port: KnowledgeExtractionPort,
  options: KnowledgeExtractionRunOptions = {},
): Promise<KnowledgeExtractionResult> {
  const stableRequest = deepFreeze(structuredClone(request)) as KnowledgeExtractionRequest;
  assertRequest(stableRequest);
  const validated = validateOptions(options);
  const inputHash = knowledgeExtractionInputHash(stableRequest);
  const stableExtractionKey = extractionKey(stableRequest, inputHash);
  let lastReason: KnowledgeExtractionFailureReason = "ADAPTER_UNAVAILABLE";
  let lastDiagnostics: readonly KnowledgeExtractionDiagnostic[] = [];

  for (let attempt = 1; attempt <= validated.maxAttempts; attempt += 1) {
    const attemptResult = await runAttempt(
      port,
      stableRequest,
      stableExtractionKey,
      inputHash,
      attempt,
      validated.perAttemptTimeoutMs,
      validated.signal,
    );
    let retryable = true;
    if (attemptResult.kind === "OUTPUT") {
      const processed = invalidOutput(attemptResult.output, stableRequest, stableExtractionKey);
      if (processed.candidates !== undefined) {
        return deepFreeze({
          ...resultBase(stableRequest, stableExtractionKey, inputHash, attempt),
          status: "SUCCEEDED",
          candidates: processed.candidates,
          diagnostics: [] as const,
        });
      }
      lastReason = "INVALID_OUTPUT";
      lastDiagnostics = processed.diagnostics;
    } else if (attemptResult.kind === "TIMEOUT") {
      lastReason = "TIMEOUT";
      lastDiagnostics = [];
    } else if (attemptResult.kind === "ABORTED") {
      return deepFreeze({
        ...resultBase(stableRequest, stableExtractionKey, inputHash, attemptResult.started ? attempt : attempt - 1),
        status: "FAILED",
        candidates: [] as const,
        reason: "ABORTED",
        diagnostics: [] as const,
      });
    } else {
      const classified = failureReason(attemptResult.error);
      lastReason = classified.reason;
      retryable = classified.retryable;
      lastDiagnostics = [];
    }

    if (!retryable) {
      return deepFreeze({
        ...resultBase(stableRequest, stableExtractionKey, inputHash, attempt),
        status: "FAILED",
        candidates: [] as const,
        reason: lastReason,
        diagnostics: lastDiagnostics,
      });
    }
    if (attempt < validated.maxAttempts && validated.retryDelayMs > 0) {
      if (validated.signal?.aborted === true) {
        return deepFreeze({
          ...resultBase(stableRequest, stableExtractionKey, inputHash, attempt),
          status: "FAILED",
          candidates: [] as const,
          reason: "ABORTED",
          diagnostics: [] as const,
        });
      }
      const delayController = new AbortController();
      const abortDelay = (): void => delayController.abort(validated.signal?.reason);
      validated.signal?.addEventListener("abort", abortDelay, { once: true });
      try {
        await validated.scheduler.sleep(validated.retryDelayMs, delayController.signal);
      } catch {
        const aborted = delayController.signal.aborted;
        return deepFreeze({
          ...resultBase(stableRequest, stableExtractionKey, inputHash, attempt),
          status: aborted ? "FAILED" : "RETRYABLE",
          candidates: [] as const,
          reason: aborted ? "ABORTED" : "RETRY_SCHEDULER_FAILED",
          diagnostics: [] as const,
        });
      } finally {
        validated.signal?.removeEventListener("abort", abortDelay);
      }
    }
  }

  return deepFreeze({
    ...resultBase(stableRequest, stableExtractionKey, inputHash, validated.maxAttempts),
    status: "RETRYABLE",
    candidates: [] as const,
    reason: lastReason,
    diagnostics: lastDiagnostics,
  });
}
