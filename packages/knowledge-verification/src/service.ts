import { createHash } from "node:crypto";

import {
  createCodeIntelligenceCallPathProbe,
  createCodeIntelligenceImpactProbe,
  createCodeIntelligenceSymbolProbe,
  type CodeIntelligenceCapability,
  type CodeProjectSnapshot,
} from "@zhiloop/code-intelligence";
import { isValidSubjectKey, type KnowledgeAssertion } from "@zhiloop/domain";
import { createMvpVerifierRegistry, type VerificationResult, type VerifierProbes } from "@zhiloop/evidence-engine";
import {
  createRepositoryConfigurationProbe,
  createRepositoryDependencyProbe,
  createRepositoryFileProbe,
  NodeRepositoryReadPort,
  SnapshotObservationIndex,
} from "@zhiloop/evidence-probes";

import { createCurrentCrossProjectProbe } from "./cross-project.js";
import type {
  KnowledgeVerificationBatch,
  KnowledgeVerificationRequest,
  KnowledgeVerificationRunSummary,
  KnowledgeVerificationServiceOptions,
  VerificationExecutionControls,
  VerificationResultSummary,
} from "./types.js";

const GRAPH_KINDS = new Set<KnowledgeAssertion["kind"]>(["SYMBOL_EXISTS", "CALL_PATH_EXISTS", "IMPACT_CONTAINS"]);
const CODE_FACT_KINDS = new Set<KnowledgeAssertion["kind"]>([
  "SYMBOL_EXISTS", "CALL_PATH_EXISTS", "IMPACT_CONTAINS", "FILE_CONTAINS", "DEPENDENCY_PRESENT", "CONFIG_EQUALS",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;

export class KnowledgeVerificationError extends Error {
  override readonly name = "KnowledgeVerificationError";
  constructor(readonly code: string, readonly retryable: boolean) { super(code); }
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function timestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateControls(controls: VerificationExecutionControls | undefined): number | undefined {
  if (controls?.deadlineAt === undefined) return undefined;
  if (!timestamp(controls.deadlineAt)) throw new KnowledgeVerificationError("VERIFICATION_DEADLINE_INVALID", false);
  return Date.parse(controls.deadlineAt);
}

async function bounded<T>(work: () => Promise<T>, controls: VerificationExecutionControls | undefined, deadline: number | undefined): Promise<T> {
  if (controls?.signal?.aborted === true) throw new KnowledgeVerificationError("VERIFICATION_CANCELLED", true);
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new KnowledgeVerificationError("VERIFICATION_DEADLINE_EXCEEDED", true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const boundaries: Promise<never>[] = [];
    if (remaining !== undefined) boundaries.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(new KnowledgeVerificationError("VERIFICATION_DEADLINE_EXCEEDED", true)), remaining);
    }));
    if (controls?.signal !== undefined) boundaries.push(new Promise((_, reject) => {
      abort = () => reject(new KnowledgeVerificationError("VERIFICATION_CANCELLED", true));
      controls.signal!.addEventListener("abort", abort, { once: true });
    }));
    const running = work();
    return boundaries.length === 0 ? await running : await Promise.race([running, ...boundaries]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) controls?.signal?.removeEventListener("abort", abort);
  }
}

function selectedAssertions(request: KnowledgeVerificationRequest, maximum: number): readonly KnowledgeAssertion[] {
  if (!SAFE_ID.test(request.candidate.candidateId) || !SAFE_ID.test(request.project.projectId)
    || !SAFE_ID.test(request.candidate.correlationId)
    || !isValidSubjectKey(request.candidate.subjectKey) || !timestamp(request.requestedAt)
    || request.candidate.assertions.length > maximum
    || !["CANDIDATE", "FRESHNESS", "PRE_INJECTION"].includes(request.purpose)) {
    throw new KnowledgeVerificationError("VERIFICATION_REQUEST_INVALID", false);
  }
  const byId = new Map<string, KnowledgeAssertion>();
  for (const assertion of request.candidate.assertions) {
    if (!SAFE_ID.test(assertion.assertionId) || assertion.candidateId !== request.candidate.candidateId || byId.has(assertion.assertionId)) {
      throw new KnowledgeVerificationError("VERIFICATION_ASSERTION_INVALID", false);
    }
    byId.set(assertion.assertionId, assertion);
  }
  if (request.assertionIds === undefined) return [...byId.values()];
  if (request.assertionIds.length === 0 || request.assertionIds.length > maximum
    || new Set(request.assertionIds).size !== request.assertionIds.length) {
    throw new KnowledgeVerificationError("VERIFICATION_SELECTION_INVALID", false);
  }
  return request.assertionIds.map((id) => {
    const assertion = byId.get(id);
    if (assertion === undefined) throw new KnowledgeVerificationError("VERIFICATION_SELECTION_INVALID", false);
    return assertion;
  });
}

function graphSignature(capability: CodeIntelligenceCapability | undefined): string {
  return capability === undefined ? "ABSENT" : `${capability.status}:${capability.reasonCode}:${capability.indexRevision ?? "none"}`;
}

function validateResults(assertions: readonly KnowledgeAssertion[], results: readonly VerificationResult[], projectId: string): void {
  if (results.length !== assertions.length) throw new KnowledgeVerificationError("VERIFICATION_RESULT_CARDINALITY_INVALID", false);
  const expected = new Map(assertions.map((item) => [item.assertionId, item]));
  const seen = new Set<string>();
  for (const result of results) {
    const assertion = expected.get(result.assertionId);
    if (assertion === undefined || seen.has(result.assertionId) || result.assertionKind !== assertion.kind
      || (result.evidence !== undefined && result.evidence.projectId !== projectId)) {
      throw new KnowledgeVerificationError("VERIFICATION_RESULT_CONTRACT_INVALID", false);
    }
    seen.add(result.assertionId);
  }
}

function summary(result: VerificationResult): VerificationResultSummary {
  return Object.freeze({ assertionId: result.assertionId, assertionKind: result.assertionKind, status: result.status,
    reasonCodes: [...result.reasonCodes], ...(result.evidence === undefined ? {} : { evidenceId: result.evidence.evidenceId }) });
}

export class KnowledgeVerificationService {
  readonly #options: KnowledgeVerificationServiceOptions;
  readonly #maxAssertions: number;
  readonly #maxSnapshotRecords: number;
  readonly #timeoutMs: number;

  constructor(options: KnowledgeVerificationServiceOptions) {
    this.#options = options;
    this.#maxAssertions = options.maxAssertions ?? 100;
    this.#maxSnapshotRecords = options.maxSnapshotRecords ?? 10_000;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.#maxAssertions) || this.#maxAssertions < 1 || this.#maxAssertions > 1_000
      || !Number.isSafeInteger(this.#maxSnapshotRecords) || this.#maxSnapshotRecords < 1 || this.#maxSnapshotRecords > 100_000
      || !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 10 || this.#timeoutMs > 60_000) {
      throw new KnowledgeVerificationError("VERIFICATION_SERVICE_OPTIONS_INVALID", false);
    }
  }

  async verify(request: KnowledgeVerificationRequest, controls?: VerificationExecutionControls): Promise<readonly VerificationResult[]> {
    return (await this.verifyBatch(request, controls)).results;
  }

  async verifyBatch(request: KnowledgeVerificationRequest, controls?: VerificationExecutionControls): Promise<KnowledgeVerificationBatch> {
    const requestedDeadline = validateControls(controls);
    const serviceDeadline = Date.now() + this.#timeoutMs;
    const deadline = requestedDeadline === undefined ? serviceDeadline : Math.min(requestedDeadline, serviceDeadline);
    const assertions = selectedAssertions(request, this.#maxAssertions);
    const requestId = `vreq_${digest({ candidateId: request.candidate.candidateId, subjectKey: request.candidate.subjectKey,
      projectId: request.project.projectId, requestedAt: request.requestedAt, purpose: request.purpose,
      assertionIds: assertions.map((item) => item.assertionId), snapshot: request.snapshot === undefined ? undefined
        : { snapshotId: request.snapshot.snapshotId, sourceVersion: request.snapshot.sourceVersion, contentHash: request.snapshot.contentHash },
      expectedCodeRevision: request.expectedCodeRevision, knowledgeVersion: request.knowledgeVersion })}`;
    const runId = `vrun_${digest(["verification-run-v1", requestId])}`;
    const before = await bounded(() => this.#options.revisions.capture(request.project), controls, deadline);
    if (request.expectedCodeRevision !== undefined && request.expectedCodeRevision !== before.revision) {
      throw new KnowledgeVerificationError("CODE_REVISION_CONFLICT", true);
    }
    const graphRequired = assertions.some((item) => GRAPH_KINDS.has(item.kind));
    const graphProject: CodeProjectSnapshot | undefined = request.project.repositoryRoot === undefined ? undefined
      : { projectRoot: request.project.repositoryRoot, projectFingerprint: before.revision };
    const graphBefore = graphRequired && graphProject !== undefined && this.#options.codeIntelligence !== undefined
      ? await bounded(() => this.#options.codeIntelligence!.capabilities(graphProject, { refresh: true }), controls, deadline) : undefined;
    const probes: VerifierProbes = {};
    if (request.project.repositoryRoot !== undefined) {
      const repository = new NodeRepositoryReadPort(request.project.repositoryRoot);
      Object.assign(probes, {
        file: createRepositoryFileProbe(repository, this.#options.fileProbe),
        dependency: createRepositoryDependencyProbe(repository),
        config: createRepositoryConfigurationProbe(repository),
      });
    }
    if (request.snapshot !== undefined) {
      const snapshot = new SnapshotObservationIndex(request.snapshot, { maxRecords: this.#maxSnapshotRecords });
      Object.assign(probes, { user: snapshot.userProbe(), command: snapshot.commandProbe(), test: snapshot.testProbe() });
    }
    if (this.#options.codeIntelligence !== undefined) {
      const fingerprintFor = () => before.revision;
      Object.assign(probes, {
        symbol: createCodeIntelligenceSymbolProbe(this.#options.codeIntelligence, { fingerprintFor }),
        callPath: createCodeIntelligenceCallPathProbe(this.#options.codeIntelligence, { fingerprintFor }),
        impact: createCodeIntelligenceImpactProbe(this.#options.codeIntelligence, { fingerprintFor }),
      });
    }
    if (this.#options.crossProject !== undefined) {
      Object.assign(probes, { crossProject: createCurrentCrossProjectProbe(this.#options.crossProject, request.project.projectId) });
    }
    const registry = createMvpVerifierRegistry();
    const results = await bounded(() => registry.verifyAll(assertions, {
      project: request.project, correlationId: request.candidate.correlationId, requestedAt: request.requestedAt, probes,
    }), controls, deadline);
    validateResults(assertions, results, request.project.projectId);
    const after = await bounded(() => this.#options.revisions.capture(request.project), controls, deadline);
    if (after.revision !== before.revision || after.capability !== before.capability) {
      throw new KnowledgeVerificationError("CODE_REVISION_CHANGED", true);
    }
    const graphAfter = graphBefore !== undefined && graphProject !== undefined && this.#options.codeIntelligence !== undefined
      ? await bounded(() => this.#options.codeIntelligence!.capabilities(graphProject, { refresh: true }), controls, deadline) : undefined;
    if (graphSignature(graphAfter) !== graphSignature(graphBefore)) {
      throw new KnowledgeVerificationError("GRAPH_REVISION_CHANGED", true);
    }
    if (controls?.signal?.aborted === true || (deadline !== undefined && Date.now() >= deadline)) {
      throw new KnowledgeVerificationError(controls?.signal?.aborted === true ? "VERIFICATION_CANCELLED" : "VERIFICATION_DEADLINE_EXCEEDED", true);
    }
    const resultSummaries = results.map(summary);
    const proofResults = resultSummaries.filter((item) => item.assertionKind !== "CROSS_PROJECT_VERIFIED");
    const codeBacked = proofResults.some((item) => CODE_FACT_KINDS.has(item.assertionKind));
    const qualifyingProof = request.purpose === "FRESHNESS" && request.knowledgeVersion !== undefined
      && proofResults.length > 0 && proofResults.every((item) => item.status === "SUPPORTED")
      && (!codeBacked || before.capability === "READY");
    const runSummary: KnowledgeVerificationRunSummary = Object.freeze({
      schemaVersion: 1, runId, requestId, purpose: request.purpose, projectId: request.project.projectId,
      subjectKey: request.candidate.subjectKey, candidateId: request.candidate.candidateId,
      ...(request.knowledgeVersion === undefined ? {} : { knowledgeVersion: request.knowledgeVersion }),
      codeRevision: before.revision, codeRevisionCapability: before.capability,
      ...(graphBefore?.indexRevision === undefined ? {} : { graphRevision: graphBefore.indexRevision }),
      status: "COMPLETED", qualifyingProof, results: resultSummaries,
      startedAt: request.requestedAt, completedAt: request.requestedAt,
    });
    this.#options.store.appendRun(runSummary);
    return Object.freeze({ schemaVersion: 1, runId, requestId, purpose: request.purpose, projectId: request.project.projectId,
      codeRevision: before.revision, codeRevisionCapability: before.capability,
      ...(graphBefore?.indexRevision === undefined ? {} : { graphRevision: graphBefore.indexRevision }),
      observedAt: request.requestedAt, results: [...results] });
  }
}
