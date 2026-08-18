import { describe, expect, it, vi } from "vitest";

import type { AssertionKind, KnowledgeAssertion } from "@zhiloop/domain";

import { VerifierRegistry, createMvpVerifierRegistry } from "./registry.js";
import type {
  AssertionVerifier,
  VerificationContext,
  VerificationObservation,
  VerificationProbe,
  VerificationResult,
} from "./types.js";
import { createFileVerifier, createSymbolVerifier, createUserVerifier } from "./verifiers.js";

const requestedAt = "2026-08-01T09:00:00.000Z";
const observedAt = "2026-08-01T09:00:01.000Z";
const project = {
  projectId: "project-1",
  repositoryRoot: "/workspace/zhiloop",
  repositoryRemote: "github.com/smarteacup/zhiloop",
  portable: true,
} as const;

const assertions = {
  accepted: assertion("USER_ACCEPTED", { statementRef: "event-user-1" }),
  rejected: assertion("USER_REJECTED", { statementRef: "event-user-2" }),
  symbol: assertion("SYMBOL_EXISTS", { projectId: "project-1", symbol: "KnowledgeCompiler", path: "packages/compiler/src/index.ts" }),
  callPath: assertion("CALL_PATH_EXISTS", { projectId: "project-1", from: "KnowledgeCompiler", to: "VerifierRegistry", maxDepth: 8 }),
  impact: assertion("IMPACT_CONTAINS", { projectId: "project-1", symbol: "KnowledgeCompiler", impactedSymbol: "VerifierRegistry" }),
  file: assertion("FILE_CONTAINS", { path: "package.json", expected: "zhiloop", matchMode: "EXACT" }),
  dependency: assertion("DEPENDENCY_PRESENT", { name: "vitest", versionConstraint: "^4", manifestPath: "package.json" }),
  config: assertion("CONFIG_EQUALS", { key: "knowledge.enabled", expected: "true", path: "config/app.yml" }),
  command: assertion("COMMAND_SUCCEEDED", { commandHash: "sha256-command", expectedExitCode: 0 }),
  test: assertion("TEST_PASSED", { testId: "scope-resolver", commandHash: "sha256-test", path: "packages/scope-resolver" }),
  crossProject: assertion("CROSS_PROJECT_VERIFIED", { subjectKey: "design.scope.boundary", minimumProjects: 2 }),
} as const;

function assertion<TKind extends AssertionKind>(kind: TKind, parameters: unknown): KnowledgeAssertion {
  return {
    assertionId: `assertion-${kind.toLowerCase()}`,
    candidateId: "candidate-1",
    kind,
    parameters,
    createdAt: requestedAt,
  } as KnowledgeAssertion;
}

function observation(
  target: string,
  status: VerificationObservation["status"] = "SUPPORTED",
  reasonCode = `${status}_BY_FIXTURE`,
): VerificationObservation {
  return {
    status,
    sourceRef: "event-observation-1",
    observedAt,
    target,
    reasonCode,
    details: { adapter: "fixture", durationMs: 1 },
  };
}

function probe<TAssertion extends KnowledgeAssertion>(value: VerificationObservation): VerificationProbe<TAssertion> {
  return { observe: vi.fn(async () => value) };
}

function context(probes: VerificationContext["probes"] = {}): VerificationContext {
  return { project, correlationId: "correlation-1", requestedAt, probes };
}

describe("VerifierRegistry", () => {
  it("registers every assertion kind", () => {
    const registry = createMvpVerifierRegistry();
    const routed = [
      "USER_ACCEPTED", "USER_REJECTED", "SYMBOL_EXISTS", "FILE_CONTAINS",
      "CALL_PATH_EXISTS", "IMPACT_CONTAINS", "DEPENDENCY_PRESENT", "CONFIG_EQUALS",
      "COMMAND_SUCCEEDED", "TEST_PASSED", "CROSS_PROJECT_VERIFIED",
    ] as const;
    for (const kind of routed) expect(registry.verifierFor(kind)?.assertionKinds).toContain(kind);
  });

  it("refuses duplicate or empty registrations", () => {
    expect(() => new VerifierRegistry([createUserVerifier(), createUserVerifier()])).toThrow("Duplicate verifier");
    const empty = { verifierId: "empty", assertionKinds: [], verify: vi.fn() } satisfies AssertionVerifier;
    expect(() => new VerifierRegistry([empty])).toThrow("at least one");
    const repeated = { ...empty, assertionKinds: ["FILE_CONTAINS", "FILE_CONTAINS"] as const };
    expect(() => new VerifierRegistry([repeated])).toThrow("must not declare duplicate");
    expect(() => new VerifierRegistry([{ ...empty, verifierId: "Invalid ID", assertionKinds: ["FILE_CONTAINS"] }]))
      .toThrow("ID is invalid");
  });

  it("isolates custom Verifier exceptions and contract violations", async () => {
    const throwing = {
      verifierId: "throwing",
      assertionKinds: ["FILE_CONTAINS"] as const,
      verify: vi.fn(async () => { throw new Error("plugin secret"); }),
    } satisfies AssertionVerifier;
    const thrown = await new VerifierRegistry([throwing]).verify(assertions.file, context());
    expect(thrown).toMatchObject({ status: "ERROR", reasonCodes: ["VERIFIER_REGISTRY_ISOLATED_ERROR"] });
    expect(JSON.stringify(thrown)).not.toContain("plugin secret");

    const invalid = {
      verifierId: "invalid",
      assertionKinds: ["FILE_CONTAINS"] as const,
      verify: vi.fn(async () => ({
        assertionId: assertions.file.assertionId,
        assertionKind: "FILE_CONTAINS",
        status: "SUPPORTED",
        target: "file:package.json:EXACT",
        observedAt,
        reasonCodes: ["PLUGIN_RESULT"],
      }) as VerificationResult),
    } satisfies AssertionVerifier;
    const violated = await new VerifierRegistry([invalid]).verify(assertions.file, context());
    expect(violated).toMatchObject({ status: "ERROR", reasonCodes: ["VERIFIER_CONTRACT_VIOLATION"] });
  });

  it("returns UNKNOWN rather than ERROR when a registered source is unavailable", async () => {
    const result = await createMvpVerifierRegistry().verify(assertions.crossProject, context());
    expect(result).toMatchObject({ status: "UNKNOWN", reasonCodes: ["VERIFICATION_SOURCE_UNAVAILABLE"] });
    expect(result.evidence).toBeUndefined();
    const malformedContext = await createMvpVerifierRegistry().verify(
      assertions.crossProject,
      { ...context(), requestedAt: "invalid" },
    );
    expect(malformedContext).toMatchObject({ status: "ERROR", reasonCodes: ["INVALID_VERIFICATION_CONTEXT"] });
  });

  it("routes all verifier families and creates traceable Evidence", async () => {
    const probes = {
      user: probe(observation("statement:event-user-1")),
      symbol: probe(observation("symbol:project-1:KnowledgeCompiler:packages/compiler/src/index.ts")),
      callPath: probe(observation("call-path:project-1:KnowledgeCompiler->VerifierRegistry:8")),
      impact: probe(observation("impact:project-1:KnowledgeCompiler->VerifierRegistry")),
      file: probe(observation("file:package.json:EXACT", "REFUTED")),
      dependency: probe(observation("dependency:vitest:package.json")),
      config: probe(observation("config:knowledge.enabled:config/app.yml")),
      command: probe(observation("command:sha256-command:0")),
      test: probe(observation("test:scope-resolver:packages/scope-resolver", "UNKNOWN")),
      crossProject: probe(observation("cross-project:design.scope.boundary:2")),
    };
    const selected = [assertions.accepted, assertions.symbol, assertions.callPath, assertions.impact, assertions.file,
      assertions.dependency, assertions.config, assertions.command, assertions.test, assertions.crossProject];
    const results = await createMvpVerifierRegistry().verifyAll(selected, context(probes));
    expect(results.map((result) => result.status)).toEqual([
      "SUPPORTED", "SUPPORTED", "SUPPORTED", "SUPPORTED", "REFUTED", "SUPPORTED", "SUPPORTED", "SUPPORTED", "UNKNOWN", "SUPPORTED",
    ]);
    expect(results.map((result) => result.evidence?.type)).toEqual([
      "USER_STATEMENT", "CODE_SYMBOL", "CODE_RELATION", "CODE_IMPACT", "FILE_CONTENT", "DEPENDENCY",
      "CONFIGURATION", "COMMAND_RESULT", "TEST_RESULT", "CROSS_PROJECT",
    ]);
    expect(results[4]?.evidence?.verdict).toBe("CONTRADICTS");
    expect(results[8]?.evidence?.verdict).toBe("INCONCLUSIVE");
    for (const result of results) {
      expect(result.evidence).toMatchObject({
        assertionId: result.assertionId,
        sourceRef: "event-observation-1",
        observedAt,
        projectId: "project-1",
        correlationId: "correlation-1",
        details: { target: result.target },
      });
    }
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0]?.evidence?.details)).toBe(true);
  });

  it("keeps verification order stable when probes finish out of order", async () => {
    const slow: VerificationProbe<typeof assertions.accepted> = {
      observe: async () => {
        await Promise.resolve();
        await Promise.resolve();
        return observation("statement:event-user-1");
      },
    };
    const fast = probe<typeof assertions.symbol>(observation("symbol:project-1:KnowledgeCompiler:packages/compiler/src/index.ts"));
    const results = await createMvpVerifierRegistry().verifyAll(
      [assertions.accepted, assertions.symbol],
      context({ user: slow, symbol: fast }),
    );
    expect(results.map((result) => result.assertionKind)).toEqual(["USER_ACCEPTED", "SYMBOL_EXISTS"]);
  });
});

describe("MVP verifiers", () => {
  it("only accepts its declared Assertion kind", async () => {
    const userProbe = probe(observation("statement:event-user-1"));
    const result = await createUserVerifier().verify(assertions.file, context({ user: userProbe }));
    expect(result).toMatchObject({ status: "ERROR", reasonCodes: ["UNSUPPORTED_ASSERTION_KIND"] });
    expect(userProbe.observe).not.toHaveBeenCalled();
  });

  it("returns UNKNOWN without fabricating Evidence when a source is absent", async () => {
    const result = await createFileVerifier().verify(assertions.file, context());
    expect(result).toMatchObject({
      status: "UNKNOWN",
      target: "file:package.json:EXACT",
      reasonCodes: ["VERIFICATION_SOURCE_UNAVAILABLE"],
    });
    expect(result.evidence).toBeUndefined();
  });

  it("isolates thrown probe failures as ERROR without Evidence or exception text", async () => {
    const failing: VerificationProbe<typeof assertions.file> = { observe: vi.fn(async () => { throw new Error("secret path"); }) };
    const result = await createFileVerifier().verify(assertions.file, context({ file: failing }));
    expect(result).toMatchObject({ status: "ERROR", reasonCodes: ["VERIFIER_EXECUTION_ERROR"] });
    expect(result.evidence).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret path");
  });

  it("rejects a forged Observation target and invalid status", async () => {
    const forged = await createSymbolVerifier().verify(
      assertions.symbol,
      context({ symbol: probe(observation("symbol:other-project:KnowledgeCompiler")) }),
    );
    expect(forged.status).toBe("ERROR");
    const invalid = { ...observation("file:package.json:EXACT"), status: "ERROR" } as unknown as VerificationObservation;
    const invalidResult = await createFileVerifier().verify(
      assertions.file,
      context({ file: probe(invalid as VerificationObservation) }),
    );
    expect(invalidResult.status).toBe("ERROR");
  });

  it("rejects cross-project symbols and unsafe relative paths before calling probes", async () => {
    const symbolProbe = probe(observation("unused"));
    const otherProject = {
      ...assertions.symbol,
      parameters: { ...assertions.symbol.parameters, projectId: "other-project" },
    } as KnowledgeAssertion;
    expect((await createSymbolVerifier().verify(otherProject, context({ symbol: symbolProbe }))).status).toBe("ERROR");
    expect(symbolProbe.observe).not.toHaveBeenCalled();

    const fileProbe = probe(observation("unused"));
    const unsafe = { ...assertions.file, parameters: { ...assertions.file.parameters, path: "../secret" } } as KnowledgeAssertion;
    expect((await createFileVerifier().verify(unsafe, context({ file: fileProbe }))).status).toBe("ERROR");
    expect(fileProbe.observe).not.toHaveBeenCalled();
  });

  it("rejects malformed Observation metadata and oversized details", async () => {
    const malformed = { ...observation("file:package.json:EXACT"), sourceRef: "bad\nsource" };
    expect((await createFileVerifier().verify(assertions.file, context({ file: probe(malformed) }))).status).toBe("ERROR");
    const details = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, index]));
    const oversized = { ...observation("file:package.json:EXACT"), details };
    expect((await createFileVerifier().verify(assertions.file, context({ file: probe(oversized) }))).status).toBe("ERROR");
  });

  it("rejects every malformed Observation field and accepts missing optional details", async () => {
    const target = "file:package.json:EXACT";
    const malformed = [
      { ...observation(target), observedAt: "not-a-time" },
      { ...observation(target), reasonCode: "not-valid" },
      { ...observation(target), details: { "bad key": true } },
      { ...observation(target), details: { value: "bad\nvalue" } },
      { ...observation(target), details: { value: Number.NaN } },
      { ...observation(target), details: { value: null } as unknown as Record<string, string> },
    ];
    for (const item of malformed) {
      expect((await createFileVerifier().verify(assertions.file, context({ file: probe(item) }))).status).toBe("ERROR");
    }
    const withoutDetails = { ...observation(target) };
    delete (withoutDetails as { details?: VerificationObservation["details"] }).details;
    const valid = await createFileVerifier().verify(assertions.file, context({ file: probe(withoutDetails) }));
    expect(valid).toMatchObject({ status: "SUPPORTED", evidence: { details: { target } } });
  });

  it("validates Assertion content, match mode, paths, and exit codes before probing", async () => {
    const registry = createMvpVerifierRegistry();
    const invalidAssertions = [
      { ...assertions.file, parameters: { ...assertions.file.parameters, path: "/absolute" } },
      { ...assertions.file, parameters: { ...assertions.file.parameters, path: "C:\\secret" } },
      { ...assertions.file, parameters: { ...assertions.file.parameters, path: "src//file.ts" } },
      { ...assertions.file, parameters: { ...assertions.file.parameters, expected: "" } },
      { ...assertions.file, parameters: { ...assertions.file.parameters, matchMode: "FUZZY" } },
      { ...assertions.config, parameters: { ...assertions.config.parameters, expected: "bad\0value" } },
      { ...assertions.command, parameters: { ...assertions.command.parameters, expectedExitCode: 256 } },
      { ...assertions.dependency, parameters: { ...assertions.dependency.parameters, versionConstraint: "" } },
      { ...assertions.test, parameters: { ...assertions.test.parameters, commandHash: "" } },
    ] as unknown as KnowledgeAssertion[];
    for (const invalidAssertion of invalidAssertions) {
      const result = await registry.verify(invalidAssertion, context());
      expect(result.status).toBe("ERROR");
      expect(result.reasonCodes).toEqual(["VERIFIER_EXECUTION_ERROR"]);
    }
  });

  it("validates project and correlation identifiers independently", async () => {
    const invalidProject = context();
    const projectResult = await createFileVerifier().verify(assertions.file, {
      ...invalidProject,
      project: { ...project, projectId: "" },
    });
    expect(projectResult.status).toBe("ERROR");
    const correlationResult = await createFileVerifier().verify(assertions.file, {
      ...context(),
      correlationId: "bad\ncorrelation",
    });
    expect(correlationResult.status).toBe("ERROR");
  });

  it("creates deterministic Evidence IDs and changes them with source observations", async () => {
    const verifier = createFileVerifier();
    const first = await verifier.verify(assertions.file, context({ file: probe(observation("file:package.json:EXACT")) }));
    const replay = await verifier.verify(assertions.file, context({ file: probe(observation("file:package.json:EXACT")) }));
    const changedObservation = { ...observation("file:package.json:EXACT"), sourceRef: "event-observation-2" };
    const changed = await verifier.verify(assertions.file, context({ file: probe(changedObservation) }));
    const changedDetails = await verifier.verify(assertions.file, context({
      file: probe({ ...observation("file:package.json:EXACT"), details: { adapter: "other" } }),
    }));
    expect(first.evidence?.evidenceId).toBe(replay.evidence?.evidenceId);
    expect(changed.evidence?.evidenceId).not.toBe(first.evidence?.evidenceId);
    expect(changedDetails.evidence?.evidenceId).not.toBe(first.evidence?.evidenceId);
  });

  it("fails safely when trusted context is malformed", async () => {
    const invalid = { ...context(), requestedAt: "not-a-time" };
    const result = await createFileVerifier().verify(assertions.file, invalid);
    expect(result).toMatchObject({ status: "ERROR", observedAt: "1970-01-01T00:00:00.000Z" });
  });
});
