import type {
  AssertionKind,
  Evidence,
  EvidenceType,
  KnowledgeAssertion,
} from "@zhiloop/domain";

import type {
  AssertionVerifier,
  CallPathAssertion,
  CommandAssertion,
  ConfigAssertion,
  CrossProjectAssertion,
  DependencyAssertion,
  FileAssertion,
  ImpactAssertion,
  SymbolAssertion,
  TestAssertion,
  UserAssertion,
  VerificationContext,
  VerificationObservation,
  VerificationProbe,
  VerificationResult,
} from "./types.js";

const CONTROL_CHARACTERS = /[\0\r\n]/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;

interface VerifierSpec<TAssertion extends KnowledgeAssertion> {
  readonly verifierId: string;
  readonly assertionKinds: readonly TAssertion["kind"][];
  readonly evidenceType: EvidenceType;
  readonly getProbe: (context: VerificationContext) => VerificationProbe<TAssertion> | undefined;
  readonly target: (assertion: TAssertion) => string;
  readonly validate: (assertion: TAssertion, context: VerificationContext) => void;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function isSafeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !CONTROL_CHARACTERS.test(value);
}

function isTimestamp(value: unknown): value is string {
  return isSafeText(value, 100) && Number.isFinite(Date.parse(value));
}

function assertSafeText(value: unknown, field: string, maximum = 500): asserts value is string {
  if (!isSafeText(value, maximum)) throw new Error(`${field} is invalid`);
}

function assertContent(value: unknown, field: string, maximum = 10_000): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${field} is invalid`);
  }
}

function assertSafeRelativePath(value: string | undefined, field: string): void {
  if (value === undefined) return;
  assertSafeText(value, field, 1_000);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    throw new Error(`${field} must be a canonical relative path`);
  }
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${field} contains an unsafe segment`);
  }
}

function validateContext(context: VerificationContext): void {
  if (!isSafeText(context.project.projectId, 500)) throw new Error("Invalid verification projectId");
  if (!isSafeText(context.correlationId, 500)) throw new Error("Invalid verification correlationId");
  if (!isTimestamp(context.requestedAt)) throw new Error("Invalid verification requestedAt");
}

function validateDetails(
  details: Readonly<Record<string, string | number | boolean>> | undefined,
): Readonly<Record<string, string | number | boolean>> {
  if (details === undefined) return {};
  const entries = Object.entries(details);
  if (entries.length > 32) throw new Error("Observation details exceed 32 entries");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key)) throw new Error("Observation detail key is invalid");
    if (typeof value === "string" && (value.length > 1_000 || CONTROL_CHARACTERS.test(value))) {
      throw new Error("Observation detail value is invalid");
    }
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Observation detail number is invalid");
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("Observation detail type is invalid");
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function validateObservation(observation: VerificationObservation, expectedTarget: string): void {
  if (!(["SUPPORTED", "REFUTED", "UNKNOWN"] as const).includes(observation.status)) {
    throw new Error("Observation status is invalid");
  }
  if (!isSafeText(observation.sourceRef, 1_000)) throw new Error("Observation sourceRef is invalid");
  if (!isTimestamp(observation.observedAt)) throw new Error("Observation observedAt is invalid");
  if (observation.target !== expectedTarget) throw new Error("Observation target does not match Assertion");
  if (!REASON_CODE.test(observation.reasonCode)) throw new Error("Observation reasonCode is invalid");
  validateDetails(observation.details);
  if (observation.codeGraphArtifact !== undefined && (
    observation.codeGraphArtifact.sourceRef !== observation.sourceRef
    || observation.codeGraphArtifact.observedAt !== observation.observedAt
  )) throw new Error("Observation CodeGraph artifact does not match observation provenance");
}

function hash(value: string): string {
  const state = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const primes = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (let lane = 0; lane < state.length; lane += 1) {
      state[lane] = Math.imul((state[lane] ?? 0) ^ (code + lane), primes[lane] ?? 0x01000193);
    }
  }
  return state.map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}

function evidenceFor(
  assertion: KnowledgeAssertion,
  context: VerificationContext,
  observation: VerificationObservation,
  evidenceType: EvidenceType,
  verifierId: string,
): Evidence {
  const verdict = observation.status === "SUPPORTED"
    ? "SUPPORTS"
    : observation.status === "REFUTED" ? "CONTRADICTS" : "INCONCLUSIVE";
  const details = {
    ...validateDetails(observation.details),
    assertionKind: assertion.kind,
    target: observation.target,
    verifierId,
  };
  const identity = JSON.stringify([
    "evidence-v1",
    assertion.assertionId,
    evidenceType,
    verdict,
    observation.sourceRef,
    observation.observedAt,
    observation.target,
    observation.reasonCode,
    context.project.projectId,
    context.correlationId,
    details,
  ]);
  return {
    evidenceId: `ev_${hash(identity)}`,
    assertionId: assertion.assertionId,
    type: evidenceType,
    verdict,
    sourceRef: observation.sourceRef,
    projectId: context.project.projectId,
    observedAt: observation.observedAt,
    correlationId: context.correlationId,
    details,
  };
}

class MvpAssertionVerifier<TAssertion extends KnowledgeAssertion> implements AssertionVerifier {
  readonly verifierId: string;
  readonly assertionKinds: readonly AssertionKind[];

  constructor(private readonly spec: VerifierSpec<TAssertion>) {
    this.verifierId = spec.verifierId;
    this.assertionKinds = freeze([...spec.assertionKinds]);
  }

  async verify(assertion: KnowledgeAssertion, context: VerificationContext): Promise<VerificationResult> {
    const fallbackTarget = isSafeText(assertion.assertionId, 500) ? `assertion:${assertion.assertionId}` : "assertion:invalid";
    let resolvedTarget = fallbackTarget;
    try {
      validateContext(context);
      if (!this.assertionKinds.includes(assertion.kind)) {
        return freeze({
          assertionId: assertion.assertionId,
          assertionKind: assertion.kind,
          verifierId: this.verifierId,
          status: "ERROR",
          target: fallbackTarget,
          observedAt: context.requestedAt,
          reasonCodes: ["UNSUPPORTED_ASSERTION_KIND"],
        });
      }
      const typedAssertion = assertion as TAssertion;
      try {
        this.spec.validate(typedAssertion, context);
      } catch {
        return freeze({
          assertionId: assertion.assertionId,
          assertionKind: assertion.kind,
          verifierId: this.verifierId,
          status: "ERROR",
          target: fallbackTarget,
          observedAt: context.requestedAt,
          reasonCodes: ["INVALID_ASSERTION"],
        });
      }
      const target = this.spec.target(typedAssertion);
      if (!isSafeText(target, 2_000)) throw new Error("Assertion target is invalid");
      resolvedTarget = target;
      const probe = this.spec.getProbe(context);
      if (probe === undefined) {
        return freeze({
          assertionId: assertion.assertionId,
          assertionKind: assertion.kind,
          verifierId: this.verifierId,
          status: "UNKNOWN",
          target,
          observedAt: context.requestedAt,
          reasonCodes: ["VERIFICATION_SOURCE_UNAVAILABLE"],
        });
      }
      const observation = await probe.observe(typedAssertion, context);
      validateObservation(observation, target);
      const evidence = evidenceFor(assertion, context, observation, this.spec.evidenceType, this.verifierId);
      return freeze({
        assertionId: assertion.assertionId,
        assertionKind: assertion.kind,
        verifierId: this.verifierId,
        status: observation.status,
        target,
        observedAt: observation.observedAt,
        reasonCodes: [observation.reasonCode],
        evidence,
        ...(observation.codeGraphArtifact === undefined ? {} : { codeGraphArtifact: observation.codeGraphArtifact }),
      });
    } catch {
      return freeze({
        assertionId: assertion.assertionId,
        assertionKind: assertion.kind,
        verifierId: this.verifierId,
        status: "ERROR",
        target: resolvedTarget,
        observedAt: isTimestamp(context.requestedAt) ? context.requestedAt : "1970-01-01T00:00:00.000Z",
        reasonCodes: ["VERIFIER_EXECUTION_ERROR"],
      });
    }
  }
}

export function createUserVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<UserAssertion>({
    verifierId: "user-verifier-v1",
    assertionKinds: ["USER_ACCEPTED", "USER_REJECTED"],
    evidenceType: "USER_STATEMENT",
    getProbe: (context) => context.probes.user,
    target: (assertion) => `statement:${assertion.parameters.statementRef}`,
    validate: (assertion) => assertSafeText(assertion.parameters.statementRef, "statementRef"),
  });
}

export function createSymbolVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<SymbolAssertion>({
    verifierId: "symbol-verifier-v1",
    assertionKinds: ["SYMBOL_EXISTS"],
    evidenceType: "CODE_SYMBOL",
    getProbe: (context) => context.probes.symbol,
    target: (assertion) => `symbol:${assertion.parameters.projectId}:${assertion.parameters.symbol}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`,
    validate: (assertion, context) => {
      if (assertion.parameters.projectId !== context.project.projectId) throw new Error("Symbol projectId conflicts with context");
      assertSafeText(assertion.parameters.symbol, "symbol");
      assertSafeRelativePath(assertion.parameters.path, "symbol path");
    },
  });
}

export function createCallPathVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<CallPathAssertion>({
    verifierId: "call-path-verifier-v1",
    assertionKinds: ["CALL_PATH_EXISTS"],
    evidenceType: "CODE_RELATION",
    getProbe: (context) => context.probes.callPath,
    target: (assertion) => `call-path:${assertion.parameters.projectId}:${assertion.parameters.from}->${assertion.parameters.to}:${assertion.parameters.maxDepth ?? 8}`,
    validate: (assertion, context) => {
      if (assertion.parameters.projectId !== context.project.projectId) throw new Error("Call path projectId conflicts with context");
      assertSafeText(assertion.parameters.from, "call path from");
      assertSafeText(assertion.parameters.to, "call path to");
      if (assertion.parameters.maxDepth !== undefined
        && (!Number.isSafeInteger(assertion.parameters.maxDepth)
          || assertion.parameters.maxDepth < 1 || assertion.parameters.maxDepth > 32)) {
        throw new Error("call path maxDepth is invalid");
      }
    },
  });
}

export function createImpactVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<ImpactAssertion>({
    verifierId: "impact-verifier-v1",
    assertionKinds: ["IMPACT_CONTAINS"],
    evidenceType: "CODE_IMPACT",
    getProbe: (context) => context.probes.impact,
    target: (assertion) => `impact:${assertion.parameters.projectId}:${assertion.parameters.symbol}->${assertion.parameters.impactedSymbol}`,
    validate: (assertion, context) => {
      if (assertion.parameters.projectId !== context.project.projectId) throw new Error("Impact projectId conflicts with context");
      assertSafeText(assertion.parameters.symbol, "impact symbol");
      assertSafeText(assertion.parameters.impactedSymbol, "impacted symbol");
    },
  });
}

export function createFileVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<FileAssertion>({
    verifierId: "file-verifier-v1",
    assertionKinds: ["FILE_CONTAINS"],
    evidenceType: "FILE_CONTENT",
    getProbe: (context) => context.probes.file,
    target: (assertion) => `file:${assertion.parameters.path}:${assertion.parameters.matchMode}`,
    validate: (assertion) => {
      assertSafeRelativePath(assertion.parameters.path, "file path");
      assertContent(assertion.parameters.expected, "expected file content");
      if (!(["EXACT", "REGEX", "STRUCTURAL"] as const).includes(assertion.parameters.matchMode)) {
        throw new Error("file matchMode is invalid");
      }
    },
  });
}

export function createDependencyVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<DependencyAssertion>({
    verifierId: "dependency-verifier-v1",
    assertionKinds: ["DEPENDENCY_PRESENT"],
    evidenceType: "DEPENDENCY",
    getProbe: (context) => context.probes.dependency,
    target: (assertion) => `dependency:${assertion.parameters.name}${assertion.parameters.manifestPath === undefined ? "" : `:${assertion.parameters.manifestPath}`}`,
    validate: (assertion) => {
      assertSafeText(assertion.parameters.name, "dependency name");
      if (assertion.parameters.versionConstraint !== undefined) {
        assertSafeText(assertion.parameters.versionConstraint, "dependency versionConstraint");
      }
      assertSafeRelativePath(assertion.parameters.manifestPath, "dependency manifestPath");
    },
  });
}

export function createConfigVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<ConfigAssertion>({
    verifierId: "config-verifier-v1",
    assertionKinds: ["CONFIG_EQUALS"],
    evidenceType: "CONFIGURATION",
    getProbe: (context) => context.probes.config,
    target: (assertion) => `config:${assertion.parameters.key}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`,
    validate: (assertion) => {
      assertSafeText(assertion.parameters.key, "config key");
      assertContent(assertion.parameters.expected, "config expected", 5_000);
      assertSafeRelativePath(assertion.parameters.path, "config path");
    },
  });
}

export function createCommandVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<CommandAssertion>({
    verifierId: "command-verifier-v1",
    assertionKinds: ["COMMAND_SUCCEEDED"],
    evidenceType: "COMMAND_RESULT",
    getProbe: (context) => context.probes.command,
    target: (assertion) => `command:${assertion.parameters.commandHash}:${assertion.parameters.expectedExitCode}`,
    validate: (assertion) => {
      assertSafeText(assertion.parameters.commandHash, "commandHash");
      if (!Number.isInteger(assertion.parameters.expectedExitCode) || Math.abs(assertion.parameters.expectedExitCode) > 255) {
        throw new Error("expectedExitCode is invalid");
      }
    },
  });
}

export function createTestVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<TestAssertion>({
    verifierId: "test-verifier-v1",
    assertionKinds: ["TEST_PASSED"],
    evidenceType: "TEST_RESULT",
    getProbe: (context) => context.probes.test,
    target: (assertion) => `test:${assertion.parameters.testId}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`,
    validate: (assertion) => {
      assertSafeText(assertion.parameters.testId, "testId");
      if (assertion.parameters.commandHash !== undefined) assertSafeText(assertion.parameters.commandHash, "test commandHash");
      assertSafeRelativePath(assertion.parameters.path, "test path");
    },
  });
}

export function createCrossProjectVerifier(): AssertionVerifier {
  return new MvpAssertionVerifier<CrossProjectAssertion>({
    verifierId: "cross-project-verifier-v1",
    assertionKinds: ["CROSS_PROJECT_VERIFIED"],
    evidenceType: "CROSS_PROJECT",
    getProbe: (context) => context.probes.crossProject,
    target: (assertion) => `cross-project:${assertion.parameters.subjectKey}:${assertion.parameters.minimumProjects}`,
    validate: (assertion) => {
      assertSafeText(assertion.parameters.subjectKey, "cross-project subjectKey");
      if (!Number.isSafeInteger(assertion.parameters.minimumProjects)
        || assertion.parameters.minimumProjects < 2 || assertion.parameters.minimumProjects > 20) {
        throw new Error("cross-project minimumProjects is invalid");
      }
    },
  });
}
