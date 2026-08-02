import type { QueryContext } from "@zhiloop/query-context";
import type { RetrievedKnowledge } from "@zhiloop/retrieval-engine";

import type {
  KnowledgeRerankResult,
  KnowledgeRerankerOptions,
  RerankedKnowledge,
  RerankExplanation,
  RerankPort,
  RerankPortRequest,
  RerankPortResult,
  RerankDiagnostic,
} from "./types.js";

const MAX_CANDIDATES = 30;
const MAX_PROMPT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,99}$/u;

class RerankTimeoutError extends Error {
  override readonly name = "RerankTimeoutError";
}

class InvalidRerankOutputError extends Error {
  override readonly name = "InvalidRerankOutputError";
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/[\0\r\n]/gu, " ").slice(0, 500);
}

function portRequest(
  context: QueryContext,
  candidates: readonly RetrievedKnowledge[],
  signal: AbortSignal,
): RerankPortRequest {
  const value = freeze({
    schemaVersion: 1 as const,
    prompt: context.prompt,
    exactTerms: [
      ...context.paths, ...context.symbols, ...context.errorCodes, ...context.configKeys,
    ].map((term) => ({ ...term })),
    candidates: candidates.map((item) => ({
      assetId: item.asset.id,
      subjectKey: item.asset.subjectKey,
      kind: item.asset.kind,
      status: item.asset.status,
      scope: structuredClone(item.asset.scope),
      title: item.asset.title,
      summary: item.asset.summary,
      applicability: [...item.asset.applicability],
      nonApplicability: [...item.asset.nonApplicability],
      symbols: [...item.asset.symbols],
      evidenceIds: item.asset.evidence.map((evidence) => evidence.evidenceId),
      originalRank: item.rank,
      rrfScore: item.score,
      contributions: item.contributions.map((contribution) => ({ ...contribution })),
    })),
  });
  return Object.freeze({ ...value, signal });
}

function invalidOutput(message: string): never {
  throw new InvalidRerankOutputError(message);
}

function validateOutput(result: unknown, candidates: readonly RetrievedKnowledge[]): Map<string, {
  readonly score: number; readonly reasonCodes: readonly string[];
}> {
  if (typeof result !== "object" || result === null || !("schemaVersion" in result) || !("rankings" in result)
    || result.schemaVersion !== 1 || !Array.isArray(result.rankings) || result.rankings.length !== candidates.length) {
    invalidOutput("rerank output must cover every candidate exactly once");
  }
  const expected = new Set(candidates.map((item) => item.asset.id));
  const values = new Map<string, { readonly score: number; readonly reasonCodes: readonly string[] }>();
  for (const ranking of result.rankings) {
    if (typeof ranking !== "object" || ranking === null || !("assetId" in ranking) || typeof ranking.assetId !== "string"
      || !expected.has(ranking.assetId) || values.has(ranking.assetId)) {
      invalidOutput("rerank output contains an unknown or duplicate assetId");
    }
    if (!("score" in ranking) || typeof ranking.score !== "number" || !Number.isFinite(ranking.score)
      || ranking.score < -1 || ranking.score > 1) {
      invalidOutput("rerank score must be finite and between -1 and 1");
    }
    if (!("reasonCodes" in ranking) || !Array.isArray(ranking.reasonCodes)
      || ranking.reasonCodes.length < 1 || ranking.reasonCodes.length > 10
      || !ranking.reasonCodes.every((reason: unknown) => typeof reason === "string" && REASON_CODE.test(reason))) {
      invalidOutput("rerank reasonCodes are invalid");
    }
    values.set(ranking.assetId, { score: ranking.score, reasonCodes: [...ranking.reasonCodes] as string[] });
  }
  return values;
}

async function withTimeout(
  port: RerankPort,
  request: RerankPortRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<RerankPortResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.rerank(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new RerankTimeoutError(`rerank exceeded ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function dedupe(
  ordered: readonly RetrievedKnowledge[],
  explanations: ReadonlyMap<string, RerankExplanation>,
  diagnostics: RerankDiagnostic[],
): RerankedKnowledge[] {
  const subjects = new Map<string, string>();
  const output: RerankedKnowledge[] = [];
  for (const item of ordered) {
    const kept = subjects.get(item.asset.subjectKey);
    if (kept !== undefined) {
      diagnostics.push({
        code: "DUPLICATE_SUBJECT_REMOVED",
        assetId: item.asset.id,
        keptAssetId: kept,
        message: `subject ${item.asset.subjectKey} already kept as ${kept}`,
      });
      continue;
    }
    subjects.set(item.asset.subjectKey, item.asset.id);
    output.push({
      ...structuredClone(item),
      rank: output.length + 1,
      rerank: explanations.get(item.asset.id) as RerankExplanation,
    });
  }
  return output;
}

export class KnowledgeReranker {
  readonly #port: RerankPort | undefined;
  readonly #timeoutMs: number;

  constructor(port?: RerankPort, options: KnowledgeRerankerOptions = {}) {
    this.#port = port;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
    }
  }

  async rerank(context: QueryContext, input: readonly RetrievedKnowledge[]): Promise<KnowledgeRerankResult> {
    const diagnostics: RerankDiagnostic[] = [];
    const candidates = [...input]
      .sort((left, right) => left.rank - right.rank || left.asset.id.localeCompare(right.asset.id))
      .slice(0, MAX_CANDIDATES);
    if (input.length > MAX_CANDIDATES) diagnostics.push({
      code: "CANDIDATE_LIMIT_APPLIED",
      message: `rerank accepted the first ${MAX_CANDIDATES} RRF candidates`,
    });

    let values: Map<string, { readonly score: number; readonly reasonCodes: readonly string[] }> | undefined;
    let fallbackCode: RerankDiagnostic["code"] | undefined;
    let fallbackMessage = "";
    if (candidates.length === 0) {
      return freeze({ items: [], diagnostics });
    } else if (context.prompt.length > MAX_PROMPT_CHARS) {
      fallbackCode = "QUERY_TOO_LARGE";
      fallbackMessage = `prompt exceeds ${MAX_PROMPT_CHARS} characters`;
    } else if (this.#port === undefined || !this.#port.available) {
      fallbackCode = "UNAVAILABLE";
      fallbackMessage = "RerankPort is unavailable";
    } else {
      try {
        const controller = new AbortController();
        values = validateOutput(
          await withTimeout(this.#port, portRequest(context, candidates, controller.signal), controller, this.#timeoutMs),
          candidates,
        );
      } catch (error) {
        fallbackCode = error instanceof RerankTimeoutError ? "TIMEOUT"
          : error instanceof InvalidRerankOutputError ? "INVALID_OUTPUT" : "PORT_ERROR";
        fallbackMessage = safeMessage(error);
      }
    }

    let ordered = candidates;
    const explanations = new Map<string, RerankExplanation>();
    if (values === undefined) {
      diagnostics.push({ code: fallbackCode as RerankDiagnostic["code"], message: fallbackMessage });
      for (const item of candidates) explanations.set(item.asset.id, {
        applied: false, originalRank: item.rank, reasonCodes: ["RRF_FALLBACK"],
      });
    } else {
      ordered = [...candidates].sort((left, right) => {
        const leftScore = values?.get(left.asset.id)?.score as number;
        const rightScore = values?.get(right.asset.id)?.score as number;
        return rightScore - leftScore || left.rank - right.rank || left.asset.id.localeCompare(right.asset.id);
      });
      for (const item of candidates) {
        const value = values.get(item.asset.id) as { readonly score: number; readonly reasonCodes: readonly string[] };
        explanations.set(item.asset.id, {
          applied: true, originalRank: item.rank, score: value.score, reasonCodes: value.reasonCodes,
        });
      }
    }
    return freeze({ items: dedupe(ordered, explanations, diagnostics), diagnostics });
  }
}
