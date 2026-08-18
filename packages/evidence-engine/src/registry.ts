import type { AssertionKind, KnowledgeAssertion } from "@zhiloop/domain";

import type { AssertionVerifier, VerificationContext, VerificationResult } from "./types.js";
import {
  createCallPathVerifier,
  createCommandVerifier,
  createConfigVerifier,
  createDependencyVerifier,
  createCrossProjectVerifier,
  createFileVerifier,
  createImpactVerifier,
  createSymbolVerifier,
  createTestVerifier,
  createUserVerifier,
} from "./verifiers.js";

const STATUSES = new Set(["SUPPORTED", "REFUTED", "UNKNOWN", "ERROR"]);
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const EVIDENCE_TYPE_BY_ASSERTION: Partial<Record<AssertionKind, string>> = {
  USER_ACCEPTED: "USER_STATEMENT",
  USER_REJECTED: "USER_STATEMENT",
  SYMBOL_EXISTS: "CODE_SYMBOL",
  CALL_PATH_EXISTS: "CODE_RELATION",
  IMPACT_CONTAINS: "CODE_IMPACT",
  FILE_CONTAINS: "FILE_CONTENT",
  DEPENDENCY_PRESENT: "DEPENDENCY",
  CONFIG_EQUALS: "CONFIGURATION",
  COMMAND_SUCCEEDED: "COMMAND_RESULT",
  TEST_PASSED: "TEST_RESULT",
  CROSS_PROJECT_VERIFIED: "CROSS_PROJECT",
};

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function safeAssertionTarget(assertion: KnowledgeAssertion): string {
  return typeof assertion.assertionId === "string"
    && assertion.assertionId.trim().length > 0
    && assertion.assertionId.length <= 500
    && !/[\0\r\n]/.test(assertion.assertionId)
    ? `assertion:${assertion.assertionId}` : "assertion:invalid";
}

function safeObservedAt(value: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "1970-01-01T00:00:00.000Z";
}

function validVerificationContext(context: VerificationContext): boolean {
  return typeof context.project.projectId === "string" && context.project.projectId.trim().length > 0
    && context.project.projectId.length <= 500 && !/[\0\r\n]/.test(context.project.projectId)
    && typeof context.correlationId === "string" && context.correlationId.trim().length > 0
    && context.correlationId.length <= 500 && !/[\0\r\n]/.test(context.correlationId)
    && Number.isFinite(Date.parse(context.requestedAt));
}

function errorResult(
  assertion: KnowledgeAssertion,
  context: VerificationContext,
  reason: string,
  verifierId?: string,
): VerificationResult {
  return freeze({
    assertionId: assertion.assertionId,
    assertionKind: assertion.kind,
    ...(verifierId === undefined ? {} : { verifierId }),
    status: "ERROR",
    target: safeAssertionTarget(assertion),
    observedAt: safeObservedAt(context.requestedAt),
    reasonCodes: [reason],
  });
}

function validEvidenceDetails(result: VerificationResult): boolean {
  const details = result.evidence?.details;
  if (details === undefined || details["target"] !== result.target
    || details["verifierId"] !== result.verifierId || details["assertionKind"] !== result.assertionKind) return false;
  const entries = Object.entries(details);
  return entries.length <= 32 && entries.every(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key)
    && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && value.length <= 1_000 && !/[\0\r\n]/.test(value))));
}

function validResult(
  result: VerificationResult,
  assertion: KnowledgeAssertion,
  context: VerificationContext,
  verifier: AssertionVerifier,
): boolean {
  if (result.assertionId !== assertion.assertionId || result.assertionKind !== assertion.kind || !STATUSES.has(result.status)) {
    return false;
  }
  if (result.verifierId !== verifier.verifierId
    || typeof result.target !== "string" || result.target.length === 0 || result.target.length > 2_000 || /[\0\r\n]/.test(result.target)
    || !Number.isFinite(Date.parse(result.observedAt))
    || result.reasonCodes.length === 0 || result.reasonCodes.length > 16
    || !result.reasonCodes.every((reason) => REASON_CODE.test(reason))) return false;
  if (result.evidence !== undefined && result.evidence.assertionId !== assertion.assertionId) return false;
  if (result.status === "ERROR") return result.evidence === undefined;
  if (result.evidence !== undefined && (
    result.evidence.type !== EVIDENCE_TYPE_BY_ASSERTION[assertion.kind]
    || result.evidence.projectId !== context.project.projectId
    || result.evidence.correlationId !== context.correlationId
    || result.evidence.observedAt !== result.observedAt
    || typeof result.evidence.evidenceId !== "string" || result.evidence.evidenceId.length === 0 || result.evidence.evidenceId.length > 500
    || typeof result.evidence.sourceRef !== "string" || result.evidence.sourceRef.length === 0
    || result.evidence.sourceRef.length > 1_000 || /[\0\r\n]/.test(result.evidence.sourceRef)
    || !validEvidenceDetails(result)
  )) return false;
  if (result.status === "SUPPORTED") return result.evidence?.verdict === "SUPPORTS";
  if (result.status === "REFUTED") return result.evidence?.verdict === "CONTRADICTS";
  return result.evidence === undefined || result.evidence.verdict === "INCONCLUSIVE";
}

export class VerifierRegistry {
  readonly #verifiers = new Map<AssertionKind, AssertionVerifier>();

  constructor(verifiers: readonly AssertionVerifier[] = []) {
    for (const verifier of verifiers) this.register(verifier);
  }

  register(verifier: AssertionVerifier): void {
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(verifier.verifierId)) throw new Error("Verifier ID is invalid");
    if (verifier.assertionKinds.length === 0) throw new Error("Verifier must declare at least one Assertion kind");
    if (new Set(verifier.assertionKinds).size !== verifier.assertionKinds.length) {
      throw new Error("Verifier must not declare duplicate Assertion kinds");
    }
    for (const kind of verifier.assertionKinds) {
      if (this.#verifiers.has(kind)) throw new Error(`Duplicate verifier for ${kind}`);
    }
    for (const kind of verifier.assertionKinds) this.#verifiers.set(kind, verifier);
  }

  verifierFor(kind: AssertionKind): AssertionVerifier | undefined {
    return this.#verifiers.get(kind);
  }

  async verify(assertion: KnowledgeAssertion, context: VerificationContext): Promise<VerificationResult> {
    if (!validVerificationContext(context)) return errorResult(assertion, context, "INVALID_VERIFICATION_CONTEXT");
    const verifier = this.verifierFor(assertion.kind);
    if (verifier !== undefined) {
      try {
        const result = await verifier.verify(assertion, context);
        return validResult(result, assertion, context, verifier)
          ? freeze(result)
          : errorResult(assertion, context, "VERIFIER_CONTRACT_VIOLATION", verifier.verifierId);
      } catch {
        return errorResult(assertion, context, "VERIFIER_REGISTRY_ISOLATED_ERROR", verifier.verifierId);
      }
    }
    return freeze({
      assertionId: assertion.assertionId,
      assertionKind: assertion.kind,
      status: "UNKNOWN",
      target: safeAssertionTarget(assertion),
      observedAt: safeObservedAt(context.requestedAt),
      reasonCodes: ["NO_VERIFIER_REGISTERED"],
    });
  }

  async verifyAll(
    assertions: readonly KnowledgeAssertion[],
    context: VerificationContext,
  ): Promise<readonly VerificationResult[]> {
    return freeze(await Promise.all(assertions.map(async (assertion) => this.verify(assertion, context))));
  }
}

export function createMvpVerifierRegistry(): VerifierRegistry {
  return new VerifierRegistry([
    createUserVerifier(),
    createSymbolVerifier(),
    createCallPathVerifier(),
    createImpactVerifier(),
    createFileVerifier(),
    createDependencyVerifier(),
    createConfigVerifier(),
    createCommandVerifier(),
    createTestVerifier(),
    createCrossProjectVerifier(),
  ]);
}
