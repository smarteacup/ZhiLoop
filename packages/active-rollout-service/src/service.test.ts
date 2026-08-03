import { Buffer } from "node:buffer";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderAdditionalContext,
  type ActiveContextProvider,
  type ActiveContextResult,
  type UserPromptSubmitInput,
} from "@zhiloop/codex-context-injection";
import {
  fingerprintRetrievalConfiguration,
  type GoldenDatasetReport,
} from "@zhiloop/retrieval-evaluation";
import { describe, expect, it, vi } from "vitest";

import { evaluateShadowQuality, validateShadowEligibilityEvidence } from "./evaluation.js";
import {
  confirmationFingerprint,
  HighRiskGovernanceService,
  MemoryHighRiskGovernanceStateStore,
} from "./high-risk-governance.js";
import { FileHighRiskGovernanceStateStore } from "./high-risk-store.js";
import { ScopedInjectionCoordinator } from "./injection-coordinator.js";
import { ActiveRolloutService } from "./rollout-service.js";
import { FileRolloutStateStore, MemoryRolloutStateStore } from "./store.js";
import type {
  BlastRadius,
  HighRiskAuthorizationPort,
  HighRiskGovernanceCommand,
  HighRiskGovernancePolicy,
  HighRiskGovernancePort,
  HighRiskGovernanceStateStore,
  HighRiskPermission,
  PersistedRolloutState,
  RolloutStateStore,
  ShadowEligibilityEvidence,
  ShadowTraceObservation,
} from "./types.js";

const now = "2026-08-04T01:00:00.000Z";
const later = "2026-08-04T01:00:01.000Z";
const configuration = { maxTokens: 800, channels: ["exact", "fts"] };
const configFingerprint = fingerprintRetrievalConfiguration(configuration);
const componentVersions = { injection: "1.0.0", retrieval: "2.0.0" };

function goldenReport(overrides: Partial<GoldenDatasetReport> = {}): GoldenDatasetReport {
  return {
    schemaVersion: 1,
    datasetId: "shadow-dataset",
    datasetVersion: 3,
    configFingerprint,
    k: 5,
    totals: { cases: 1, errors: 0, relevant: 1, returned: 1, hits: 1, forbiddenHits: 0 },
    metrics: { recallAtK: 1, precisionAtK: 1, traceabilityRate: 1, scopeLeakCount: 0 },
    thresholds: { recallAtK: 0.9, precisionAtK: 0.8 },
    complexity: {
      levelCounts: { L0_NONE: 0, L1_POINTER: 1, L2_COMPACT: 0, L3_EVIDENCED: 0, L4_EPISODE: 0 },
      averageTokens: 80,
      p95Tokens: 80,
      maximumTokens: 80,
      truncatedCount: 0,
      overBudgetCount: 0,
      automaticL4Count: 0,
      missingReasonAxisCount: 0,
    },
    qualityThresholdsMet: true,
    defaultInjectionAllowed: true,
    gatePassed: true,
    cases: [{
      caseId: "case-a", status: "PASS", traceId: "trace-a",
      retrievedAssetIds: ["knowledge-a"], relevantHits: ["knowledge-a"],
      missingRelevantAssetIds: [], forbiddenHits: [],
    }],
    ...overrides,
  };
}

function trace(): ShadowTraceObservation {
  return {
    traceId: "trace-a",
    runId: "run-a",
    observedAt: "2026-08-04T00:59:00.000Z",
    source: "PERSISTED_SHADOW_TRACE",
    delivery: "SHADOWED",
    projectId: "project-a",
    eligibleKnowledgeVersions: ["knowledge-a@1"],
  };
}

function evidence(report = goldenReport()): ShadowEligibilityEvidence {
  return evaluateShadowQuality({ report, traces: [trace()], retrievalConfiguration: configuration, componentVersions, now });
}

function bootstrapFor(value: ShadowEligibilityEvidence) {
  return {
    policyRevision: 1,
    configFingerprint: value.configFingerprint,
    versionFingerprint: value.versionFingerprint,
    now,
  } as const;
}

function activate(service: ActiveRolloutService, value: ShadowEligibilityEvidence): void {
  service.recordEvidence(value);
  service.activateCanary({
    expectedStateRevision: service.state.stateRevision,
    targetPolicyRevision: 2,
    configFingerprint: value.configFingerprint,
    versionFingerprint: value.versionFingerprint,
    eligibilityEvidenceId: value.evidenceId,
    canary: { projectIds: ["project-a"], allocationSalt: "canary-a" },
    now: later,
  });
}

const input: UserPromptSubmitInput = {
  hook_event_name: "UserPromptSubmit",
  session_id: "session-a",
  turn_id: "turn-a",
  cwd: "/workspace/project-a",
  prompt: "fix the rollout",
};

function validContext(): ActiveContextResult {
  let envelope: ActiveContextResult["envelope"] = {
    schemaVersion: 1,
    runId: "run-injection",
    projectId: "project-a",
    taskId: "task-a",
    complexity: {
      level: "L0_NONE", breadth: 0, depth: "NONE", authority: "NONE", evidence: "NONE",
      reasonCodes: ["TASK_CONTRACT_ONLY"],
    },
    budget: { maxTokens: 800, estimatedTokens: 1, truncated: false, disclosedItems: 0, omittedItems: 0 },
    items: [],
    taskContract: { contractId: "contract-a", objective: "Keep ACTIVE scoped.", gates: [], boundaries: [] },
  };
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const estimate = Math.max(1, Math.ceil(Buffer.byteLength(
      renderAdditionalContext(envelope, "trace-injection"), "utf8",
    ) / 3));
    if (estimate === envelope.budget.estimatedTokens) break;
    envelope = { ...envelope, budget: { ...envelope.budget, estimatedTokens: estimate } };
  }
  return {
    envelope,
    trace: {
      schemaVersion: 1,
      traceId: "trace-injection",
      runId: envelope.runId,
      query: {
        projectId: "project-a", taskId: "task-a",
        allowProjectKnowledge: true, allowGlobalKnowledge: true,
        promptFingerprint: fingerprintRetrievalConfiguration(input.prompt),
        reasonCodes: ["SCOPED_CANARY"],
      },
      filters: [], rerankDiagnostics: [], results: [], injection: { items: [] },
      complexity: {
        level: "L0_NONE", automatic: true,
        estimatedTokens: envelope.budget.estimatedTokens, maxTokens: envelope.budget.maxTokens,
        truncated: false,
        reasonCodes: ["RISK_LOW", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT", "BUDGET_WITHIN_LIMIT"],
      },
    },
  };
}

describe("SHADOW quality evidence", () => {
  it("binds real trace IDs, dataset, configuration, versions, and explicit checks", () => {
    const value = evidence();
    expect(value.eligible).toBe(true);
    expect(value.traceIds).toEqual(["trace-a"]);
    expect(value.configFingerprint).toBe(configFingerprint);
    expect(value.versionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(value.checks).toHaveLength(9);
    expect(Object.isFrozen(value.checks)).toBe(true);
  });

  it("makes a report/trace mismatch ineligible instead of accepting synthetic evidence", () => {
    const report = goldenReport({ cases: [{
      caseId: "case-a", status: "PASS", traceId: "other-trace",
      retrievedAssetIds: ["knowledge-a"], relevantHits: ["knowledge-a"],
      missingRelevantAssetIds: [], forbiddenHits: [],
    }] });
    const value = evidence(report);
    expect(value.eligible).toBe(false);
    expect(value.checks.find((item) => item.code === "DATASET_BOUND")?.passed).toBe(false);
  });

  it("rejects empty datasets, noncanonical time, and a conflicting evidence payload", () => {
    expect(() => evaluateShadowQuality({
      report: goldenReport(), traces: [], retrievalConfiguration: configuration, componentVersions, now,
    })).toThrow("1..10000");
    expect(() => evaluateShadowQuality({
      report: goldenReport(), traces: [trace()], retrievalConfiguration: configuration,
      componentVersions, now: "2026-08-04 01:00:00",
    })).toThrow("canonical");
    const value = evidence();
    const service = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    service.recordEvidence(value);
    const conflicting = {
      ...value,
      checks: value.checks.map((item, index) => index === 0 ? { ...item, detail: "tampered" } : item),
    };
    expect(() => service.recordEvidence(conflicting)).toThrow("semantic conflict");
  });

  it("rejects forged, incomplete, and invalid-window evidence and flags malformed component versions", () => {
    const value = evidence();
    expect(() => validateShadowEligibilityEvidence({ ...value, datasetVersion: 0 })).toThrow("dataset version");
    expect(() => validateShadowEligibilityEvidence({ ...value, observedFrom: later, observedTo: now })).toThrow("window");
    expect(() => validateShadowEligibilityEvidence({ ...value, checks: value.checks.slice(1) })).toThrow("incomplete");
    expect(() => validateShadowEligibilityEvidence({
      ...value, evidenceId: fingerprintRetrievalConfiguration("forged"),
    })).toThrow("fingerprint mismatch");
    const malformed = evaluateShadowQuality({
      report: goldenReport(), traces: [{ ...trace(), observedAt: "not-a-date" }],
      retrievalConfiguration: configuration, componentVersions: { "bad\\name": "1.0.0" }, now,
    });
    expect(malformed.checks.find((item) => item.code === "REAL_SHADOW_TRACES")?.passed).toBe(false);
    expect(malformed.checks.find((item) => item.code === "VERSION_BOUND")?.passed).toBe(false);
  });
});

describe("revision-bound ACTIVE rollout", () => {
  it("rejects a boolean switch and excludes requests outside the canary", () => {
    const value = evidence();
    const service = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    expect(() => service.activateCanary(true)).toThrow("single-boolean");
    activate(service, value);
    expect(service.decision({
      sessionId: "session-a", turnId: "turn-a", projectId: "project-a",
    })).toMatchObject({ mode: "ACTIVE", reasonCode: "ACTIVE_CANARY_INCLUDED" });
    expect(service.decision({
      sessionId: "session-b", turnId: "turn-b", projectId: "project-b",
    })).toMatchObject({ mode: "SHADOW", reasonCode: "GRAY_SCOPE_EXCLUDED" });
  });

  it("rejects stale, unbound, and unscoped ACTIVE activation attempts", () => {
    const value = evidence();
    const service = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    service.recordEvidence(value);
    const base = {
      expectedStateRevision: service.state.stateRevision,
      targetPolicyRevision: 2,
      configFingerprint: value.configFingerprint,
      versionFingerprint: value.versionFingerprint,
      eligibilityEvidenceId: value.evidenceId,
      canary: { projectIds: ["project-a"], allocationSalt: "canary-a" },
      now: later,
    } as const;
    expect(() => service.activateCanary({ ...base, expectedStateRevision: 1 })).toThrow("stale");
    expect(() => service.activateCanary({
      ...base, configFingerprint: fingerprintRetrievalConfiguration({ changed: true }),
    })).toThrow("not revision-bound");
    expect(() => service.activateCanary({
      ...base, canary: { allocationSalt: "canary-a", percentageBasisPoints: 10_000 },
    })).toThrow("scoped canary");
    expect(() => service.activateCanary({
      ...base, canary: { allocationSalt: "canary-a", percentageBasisPoints: 10_001 },
    })).toThrow("1..10000");
    expect(() => service.activateCanary({ ...base, targetPolicyRevision: 1 })).toThrow("must increase");
    expect(() => service.activateCanary({ ...base, now: "not-a-date" })).toThrow("canonical");
    expect(() => service.activateCanary({
      ...base, canary: { projectIds: [] as readonly string[], allocationSalt: "canary-a" },
    })).toThrow("cannot be empty");
    expect(service.decision({ sessionId: "session-a", turnId: "turn-a" })).toMatchObject({
      mode: "SHADOW", reasonCode: "SHADOW_MODE",
    });
  });

  it("applies task/session selectors and deterministic percentage allocation", () => {
    const value = evidence();
    const service = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    service.recordEvidence(value);
    service.activateCanary({
      expectedStateRevision: service.state.stateRevision,
      targetPolicyRevision: 2,
      configFingerprint: value.configFingerprint,
      versionFingerprint: value.versionFingerprint,
      eligibilityEvidenceId: value.evidenceId,
      canary: {
        sessionIds: ["session-a"], taskIds: ["task-a"], percentageBasisPoints: 1,
        allocationSalt: "canary-percentage",
      },
      now: later,
    });
    expect(service.decision({ sessionId: "session-b", turnId: "turn-b", taskId: "task-a" }).mode).toBe("SHADOW");
    expect(service.decision({ sessionId: "session-a", turnId: "turn-a", taskId: "task-b" }).mode).toBe("SHADOW");
    expect(service.decision({ sessionId: "session-a", turnId: "turn-a", taskId: "task-a" }).reasonCode)
      .toMatch(/ACTIVE_CANARY_INCLUDED|GRAY_SCOPE_EXCLUDED/u);
  });

  it("downgrades to SHADOW and restores LKG when quality evidence declines", () => {
    const passing = evidence();
    const service = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(passing));
    activate(service, passing);
    const failing = evidence(goldenReport({
      qualityThresholdsMet: false, defaultInjectionAllowed: false, gatePassed: false,
    }));
    service.observeEligibility(failing, "2026-08-04T01:00:02.000Z");
    expect(service.state.effective).toMatchObject({ mode: "SHADOW", policyRevision: 1 });
    expect(service.state.audit.at(-1)?.reasonCodes).toContain("LAST_KNOWN_GOOD_RESTORED");
    expect(service.injectionRollout.snapshot.mode).toBe("SHADOW");
  });

  it("recovers an ACTIVE effective revision exactly after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-rollout-"));
    try {
      const path = join(directory, "rollout.json");
      const value = evidence();
      const first = new ActiveRolloutService(new FileRolloutStateStore(path), bootstrapFor(value));
      activate(first, value);
      const before = first.state;
      const restarted = new ActiveRolloutService(new FileRolloutStateStore(path), bootstrapFor(value));
      expect(restarted.state).toEqual(before);
      expect(restarted.injectionRollout.snapshot).toMatchObject({
        revision: before.stateRevision, mode: "ACTIVE",
      });
      restarted.downgrade("RESTART_ACCEPTANCE_ROLLBACK", "2026-08-04T01:00:03.000Z");
      const shadowRestart = new ActiveRolloutService(new FileRolloutStateStore(path), bootstrapFor(value));
      expect(shadowRestart.state.effective).toEqual(restarted.state.effective);
      expect(shadowRestart.injectionRollout.snapshot.mode).toBe("SHADOW");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      chmodSync(path, 0o644);
      expect(() => new FileRolloutStateStore(path).load()).toThrow("mode 0600");
      chmodSync(path, 0o600);
      const tampered = JSON.parse(readFileSync(path, "utf8")) as { stateRevision: number };
      tampered.stateRevision += 1;
      writeFileSync(path, JSON.stringify(tampered), { encoding: "utf8", mode: 0o600 });
      expect(() => new FileRolloutStateStore(path).load()).toThrow("checksum");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("forces runtime SHADOW when durable downgrade persistence fails", () => {
    class FailingStore implements RolloutStateStore {
      readonly delegate = new MemoryRolloutStateStore();
      fail = false;
      load(): PersistedRolloutState | undefined { return this.delegate.load(); }
      save(next: PersistedRolloutState, expected: number): void {
        if (this.fail) throw new Error("disk unavailable");
        this.delegate.save(next, expected);
      }
    }
    const store = new FailingStore();
    const value = evidence();
    const service = new ActiveRolloutService(store, bootstrapFor(value));
    activate(service, value);
    store.fail = true;
    expect(() => service.downgrade("QUALITY_DROP", "2026-08-04T01:00:04.000Z")).toThrow("disk unavailable");
    expect(service.injectionRollout.snapshot.mode).toBe("SHADOW");
    expect(service.decision({
      sessionId: "session-a", turnId: "turn-a", projectId: "project-a",
    })).toMatchObject({ mode: "SHADOW", reasonCode: "FAIL_SAFE_SHADOW" });
    store.fail = false;
    service.downgrade("QUALITY_DROP_RETRY", "2026-08-04T01:00:05.000Z");
    expect(service.state.effective.mode).toBe("SHADOW");
    expect(service.injectionRollout.snapshot.revision).toBe(service.state.stateRevision);
  });

  it("fail-closes runtime when unsafe quality evidence cannot be persisted", () => {
    class EvidenceFailStore implements RolloutStateStore {
      readonly delegate = new MemoryRolloutStateStore();
      fail = false;
      load(): PersistedRolloutState | undefined { return this.delegate.load(); }
      save(next: PersistedRolloutState, expected: number): void {
        if (this.fail) throw new Error("evidence disk unavailable");
        this.delegate.save(next, expected);
      }
    }
    const passing = evidence();
    const store = new EvidenceFailStore();
    const service = new ActiveRolloutService(store, bootstrapFor(passing));
    activate(service, passing);
    store.fail = true;
    const failing = evidence(goldenReport({
      qualityThresholdsMet: false, defaultInjectionAllowed: false, gatePassed: false,
    }));
    expect(() => service.observeEligibility(failing, "2026-08-04T01:00:06.000Z"))
      .toThrow("evidence disk unavailable");
    expect(service.injectionRollout.snapshot.mode).toBe("SHADOW");
    expect(service.decision({ sessionId: "session-a", turnId: "turn-a", projectId: "project-a" }))
      .toMatchObject({ mode: "SHADOW", reasonCode: "FAIL_SAFE_SHADOW" });
  });
});

describe("scoped injection coordination", () => {
  it("observes a mid-request rollback and never emits context", async () => {
    let resolve: ((context: ActiveContextResult) => void) | undefined;
    const provider: ActiveContextProvider = {
      retrieve: async () => await new Promise<ActiveContextResult>((done) => { resolve = done; }),
    };
    const value = evidence();
    const rollout = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    activate(rollout, value);
    const coordinator = new ScopedInjectionCoordinator({ provider }, rollout, {
      scopeResolver: () => ({ sessionId: "session-a", turnId: "turn-a", projectId: "project-a" }),
    });
    const pending = coordinator.handle(input, "2026-08-04T01:00:02.000Z");
    rollout.downgrade("MID_REQUEST_QUALITY_DROP", "2026-08-04T01:00:02.000Z");
    resolve?.(validContext());
    const result = await pending;
    expect(result.status).toBe("ROLLED_BACK");
    expect(result.output).toBeUndefined();
  });

  it("times out with no partial context and automatically downgrades", async () => {
    const provider: ActiveContextProvider = {
      retrieve: async () => await new Promise<ActiveContextResult>(() => undefined),
    };
    const value = evidence();
    const rollout = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    activate(rollout, value);
    const coordinator = new ScopedInjectionCoordinator({ provider }, rollout, {
      deadlineMs: 5,
      scopeResolver: () => ({ sessionId: "session-a", turnId: "turn-a", projectId: "project-a" }),
    });
    const result = await coordinator.handle(input, "2026-08-04T01:00:02.000Z");
    expect(result.status).toBe("TIMEOUT");
    expect(result.output).toBeUndefined();
    expect(rollout.state.effective).toMatchObject({ mode: "SHADOW", policyRevision: 1 });
  });

  it("runs gray-scope exclusions as SHADOW even while the effective mode is ACTIVE", async () => {
    const provider: ActiveContextProvider = { retrieve: vi.fn(async () => validContext()) };
    const value = evidence();
    const rollout = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    activate(rollout, value);
    const coordinator = new ScopedInjectionCoordinator({ provider }, rollout, {
      scopeResolver: () => ({ sessionId: "session-b", turnId: "turn-b", projectId: "project-b" }),
    });
    const result = await coordinator.handle(input);
    expect(result).toMatchObject({ status: "SHADOWED", rolloutDecision: { reasonCode: "GRAY_SCOPE_EXCLUDED" } });
    expect(result.output).toBeUndefined();
    expect(rollout.state.effective.mode).toBe("ACTIVE");
  });

  it("uses the default scope resolver in SHADOW mode", async () => {
    const provider: ActiveContextProvider = { retrieve: async () => validContext() };
    const value = evidence();
    const rollout = new ActiveRolloutService(new MemoryRolloutStateStore(), bootstrapFor(value));
    const result = await new ScopedInjectionCoordinator({ provider }, rollout).handle(input);
    expect(result).toMatchObject({ status: "SHADOWED", rolloutDecision: { reasonCode: "SHADOW_MODE" } });
  });
});

const blast: BlastRadius = {
  affectedAssets: 2,
  affectedProjects: 1,
  affectedRules: 0,
  affectedBindings: 0,
  affectedTraces: 5,
  affectedInjections: 3,
  irreversible: false,
  reasonCodes: ["BLAST_RADIUS_COMPUTED"],
};

function command(kind: HighRiskGovernanceCommand["kind"]): HighRiskGovernanceCommand {
  return {
    kind,
    assetIds: ["knowledge-a", "knowledge-b"],
    projectIds: ["project-a"],
    reason: "approved high-risk change",
    payloadFingerprint: fingerprintRetrievalConfiguration({ kind, revision: 2 }),
  };
}

function policy(enabled = true): HighRiskGovernancePolicy {
  return {
    revision: 1,
    activeStageEnabled: true,
    enabledOperations: {
      GLOBAL_PROMOTION: enabled,
      RULE_CHANGE: enabled,
      BINDING_CHANGE: enabled,
      PRIVACY_PURGE: enabled,
    },
    previewTtlMs: 60_000,
  };
}

function authorize(grants: Readonly<Record<string, readonly HighRiskPermission[]>>): HighRiskAuthorizationPort {
  return { hasPermission: (actor, permission) => grants[actor]?.includes(permission) ?? false };
}

describe("high-risk governance enforcement", () => {
  it("reloads an authoritative preview by identity without trusting client payloads", async () => {
    const state = new MemoryHighRiskGovernanceStateStore();
    const service = new HighRiskGovernanceService({
      preview: () => ({
        affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0,
        affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["PROJECT_TO_GLOBAL"],
      }),
      execute: async () => { throw new Error("not called"); },
    }, state, authorize({ "operator-a": ["PROMOTE_GLOBAL"] }), policy());
    const created = await service.preview(command("GLOBAL_PROMOTION"), now);
    const restarted = new HighRiskGovernanceService({
      preview: () => { throw new Error("not called"); },
      execute: async () => { throw new Error("not called"); },
    }, state, authorize({ "operator-a": ["PROMOTE_GLOBAL"] }), policy());

    expect(restarted.getPreview(created.previewId)).toEqual(created);
    expect(() => restarted.getPreview("client-preview")).toThrow("preview ID");
  });
  it.each([
    ["GLOBAL_PROMOTION", "PROMOTE_GLOBAL"],
    ["RULE_CHANGE", "CHANGE_RULE"],
    ["BINDING_CHANGE", "CHANGE_BINDING"],
  ] as const)("requires a blast preview and distinct permission for %s", async (kind, permission) => {
    const port: HighRiskGovernancePort = {
      preview: vi.fn(async () => blast),
      execute: vi.fn(async (_command, identity) => ({
        operationId: identity.operationId,
        requestFingerprint: identity.requestFingerprint,
        outcome: "COMMITTED" as const,
        committedAt: later,
      })),
    };
    const auth = authorize({ "operator-a": [permission] });
    const service = new HighRiskGovernanceService(port, new MemoryHighRiskGovernanceStateStore(), auth, policy());
    const preview = await service.preview(command(kind), now);
    await expect(service.commit({
      preview,
      expectedPolicyRevision: 1,
      actor: "operator-denied",
      confirmationFingerprint: confirmationFingerprint(preview, "operator-denied"),
      now: later,
    })).rejects.toThrow(`permission ${permission}`);
    const result = await service.commit({
      preview,
      expectedPolicyRevision: 1,
      actor: "operator-a",
      confirmationFingerprint: confirmationFingerprint(preview, "operator-a"),
      now: later,
    });
    expect(result.blastRadius).toEqual(blast);
    expect(port.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps privacy purge behind its own gate, irreversible preview, permission, and confirmation", async () => {
    const port: HighRiskGovernancePort = {
      preview: async () => ({ ...blast, irreversible: true, reasonCodes: ["PRIVACY_ERASURE_IMPACT"] }),
      execute: async (_command, identity) => ({
        operationId: identity.operationId,
        requestFingerprint: identity.requestFingerprint,
        outcome: "COMMITTED",
        committedAt: later,
      }),
    };
    const privacyAuth = authorize({ "privacy-officer": ["PURGE_PRIVATE_DATA"] });
    const disabled = new HighRiskGovernanceService(port, new MemoryHighRiskGovernanceStateStore(), privacyAuth, {
      ...policy(), enabledOperations: { ...policy().enabledOperations, PRIVACY_PURGE: false },
    });
    const disabledPreview = await disabled.preview(command("PRIVACY_PURGE"), now);
    await expect(disabled.commit({
      preview: disabledPreview, expectedPolicyRevision: 1, actor: "privacy-officer",
      confirmationFingerprint: confirmationFingerprint(disabledPreview, "privacy-officer"), now: later,
    })).rejects.toThrow("gate is disabled");

    const service = new HighRiskGovernanceService(port, new MemoryHighRiskGovernanceStateStore(), privacyAuth, policy());
    const preview = await service.preview(command("PRIVACY_PURGE"), now);
    await expect(service.commit({
      preview, expectedPolicyRevision: 1, actor: "privacy-officer",
      confirmationFingerprint: fingerprintRetrievalConfiguration("forged"), now: later,
    })).rejects.toThrow("confirmation");
    await expect(service.commit({
      preview, expectedPolicyRevision: 1, actor: "unprivileged",
      confirmationFingerprint: confirmationFingerprint(preview, "unprivileged"), now: later,
    })).rejects.toThrow("permission PURGE_PRIVATE_DATA");
    await expect(service.commit({
      preview, expectedPolicyRevision: 1, actor: "privacy-officer",
      confirmationFingerprint: confirmationFingerprint(preview, "privacy-officer"), now: later,
    })).resolves.toMatchObject({ kind: "PRIVACY_PURGE" });
  });

  it("rejects disabled ACTIVE stage, expired or forged previews, and stale policy revisions", async () => {
    const port: HighRiskGovernancePort = {
      preview: async () => blast,
      execute: async (_command, identity) => ({
        operationId: identity.operationId,
        requestFingerprint: identity.requestFingerprint,
        outcome: "COMMITTED",
        committedAt: later,
      }),
    };
    const store = new MemoryHighRiskGovernanceStateStore();
    const promotionAuth = authorize({ "operator-a": ["PROMOTE_GLOBAL"] });
    const service = new HighRiskGovernanceService(port, store, promotionAuth, { ...policy(), activeStageEnabled: false });
    const preview = await service.preview(command("GLOBAL_PROMOTION"), now);
    const request = {
      preview, expectedPolicyRevision: 1, actor: "operator-a",
      confirmationFingerprint: confirmationFingerprint(preview, "operator-a"), now: later,
    };
    await expect(service.commit(request)).rejects.toThrow("ACTIVE stage");
    expect(() => service.updatePolicy({ ...policy(), revision: 2 }, 0)).toThrow("stale");
    service.updatePolicy({ ...policy(), revision: 2 }, 1);
    await expect(service.commit(request)).rejects.toThrow("stale");

    const expiryService = new HighRiskGovernanceService(
      port, new MemoryHighRiskGovernanceStateStore(), promotionAuth, policy(),
    );
    const expiring = await expiryService.preview(command("GLOBAL_PROMOTION"), now);
    await expect(expiryService.commit({
      ...request,
      preview: expiring,
      confirmationFingerprint: confirmationFingerprint(expiring, "operator-a"),
      now: "2026-08-04T01:02:00.000Z",
    })).rejects.toThrow("expired");
    await expect(expiryService.commit({
      ...request,
      preview: { ...expiring, commandFingerprint: fingerprintRetrievalConfiguration("forged") },
      confirmationFingerprint: confirmationFingerprint(expiring, "operator-a"),
    })).rejects.toThrow("forged");
  });

  it("uses a stable execution identity so a crash after an irreversible effect replays exactly once", async () => {
    class FailOnceCommitStore implements HighRiskGovernanceStateStore {
      readonly delegate = new MemoryHighRiskGovernanceStateStore();
      fail = true;
      getPreview(id: string) { return this.delegate.getPreview(id); }
      putPreview(value: Parameters<HighRiskGovernanceStateStore["putPreview"]>[0]) { this.delegate.putPreview(value); }
      getCommit(id: string) { return this.delegate.getCommit(id); }
      putCommit(value: Parameters<HighRiskGovernanceStateStore["putCommit"]>[0]) {
        if (this.fail) { this.fail = false; throw new Error("crash before commit receipt persisted"); }
        this.delegate.putCommit(value);
      }
    }
    const executed = new Map<string, string>();
    let irreversibleEffects = 0;
    const port: HighRiskGovernancePort = {
      preview: async () => ({ ...blast, irreversible: true, reasonCodes: ["PRIVACY_ERASURE_IMPACT"] }),
      execute: async (_command, identity) => {
        const previous = executed.get(identity.idempotencyKey);
        if (previous !== undefined && previous !== identity.requestFingerprint) throw new Error("idempotency conflict");
        if (previous === undefined) { executed.set(identity.idempotencyKey, identity.requestFingerprint); irreversibleEffects += 1; }
        return {
          operationId: identity.operationId,
          requestFingerprint: identity.requestFingerprint,
          outcome: previous === undefined ? "COMMITTED" : "REPLAYED",
          committedAt: later,
        };
      },
    };
    const store = new FailOnceCommitStore();
    const privacyAuth = authorize({ "privacy-officer": ["PURGE_PRIVATE_DATA"] });
    const first = new HighRiskGovernanceService(port, store, privacyAuth, policy());
    const preview = await first.preview(command("PRIVACY_PURGE"), now);
    const request = {
      preview, expectedPolicyRevision: 1, actor: "privacy-officer",
      confirmationFingerprint: confirmationFingerprint(preview, "privacy-officer"), now: later,
    };
    await expect(first.commit(request)).rejects.toThrow("receipt persisted");
    const restarted = new HighRiskGovernanceService(port, store, privacyAuth, policy());
    const result = await restarted.commit({ ...request, now: "2026-08-04T01:00:05.000Z" });
    expect(result.kind).toBe("PRIVACY_PURGE");
    expect(irreversibleEffects).toBe(1);
    await expect(restarted.commit({ ...request, actor: "attacker" })).rejects.toThrow("idempotent");
  });

  it("rejects invalid commands, blast radii, receipts, and state-store semantic conflicts", async () => {
    const invalidBlastPort: HighRiskGovernancePort = {
      preview: async () => ({ ...blast, affectedAssets: -1 }),
      execute: async (_command, identity) => ({
        operationId: identity.operationId, requestFingerprint: identity.requestFingerprint,
        outcome: "COMMITTED", committedAt: later,
      }),
    };
    const ruleAuth = authorize({ "operator-a": ["CHANGE_RULE"] });
    const service = new HighRiskGovernanceService(
      invalidBlastPort, new MemoryHighRiskGovernanceStateStore(), ruleAuth, policy(),
    );
    await expect(service.preview({ ...command("RULE_CHANGE"), assetIds: [] }, now)).rejects.toThrow("affected assets");
    await expect(service.preview(command("RULE_CHANGE"), "not-a-date")).rejects.toThrow("canonical");
    await expect(service.preview(command("RULE_CHANGE"), now)).rejects.toThrow("blast-radius");

    const badReceiptPort: HighRiskGovernancePort = {
      preview: async () => blast,
      execute: async (_command, identity) => ({
        operationId: identity.operationId,
        requestFingerprint: fingerprintRetrievalConfiguration("wrong"),
        outcome: "COMMITTED",
        committedAt: later,
      }),
    };
    const stateStore = new MemoryHighRiskGovernanceStateStore();
    const receiptService = new HighRiskGovernanceService(badReceiptPort, stateStore, ruleAuth, policy());
    const preview = await receiptService.preview(command("RULE_CHANGE"), now);
    await expect(receiptService.commit({
      preview, expectedPolicyRevision: 1, actor: "operator-a",
      confirmationFingerprint: confirmationFingerprint(preview, "operator-a"), now: later,
    })).rejects.toThrow("receipt");
    expect(() => stateStore.putPreview({ ...preview, expiresAt: "2026-08-04T02:00:00.000Z" }))
      .toThrow("semantic conflict");
  });

  it("persists previews and commit receipts across real file-store restarts with mode 0600 and checksum", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-high-risk-"));
    try {
      const path = join(directory, "high-risk.json");
      const effects = new Map<string, string>();
      const port: HighRiskGovernancePort = {
        preview: async () => blast,
        execute: async (_command, identity) => {
          const previous = effects.get(identity.idempotencyKey);
          if (previous !== undefined && previous !== identity.requestFingerprint) throw new Error("effect conflict");
          effects.set(identity.idempotencyKey, identity.requestFingerprint);
          return {
            operationId: identity.operationId,
            requestFingerprint: identity.requestFingerprint,
            outcome: previous === undefined ? "COMMITTED" : "REPLAYED",
            committedAt: later,
          };
        },
      };
      const auth = authorize({ "operator-a": ["CHANGE_RULE"] });
      const first = new HighRiskGovernanceService(
        port, new FileHighRiskGovernanceStateStore(path), auth, policy(),
      );
      const preview = await first.preview(command("RULE_CHANGE"), now);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const request = {
        preview, expectedPolicyRevision: 1, actor: "operator-a",
        confirmationFingerprint: confirmationFingerprint(preview, "operator-a"), now: later,
      };
      const restarted = new HighRiskGovernanceService(
        port, new FileHighRiskGovernanceStateStore(path), auth, policy(),
      );
      const committed = await restarted.commit(request);
      const secondRestart = new HighRiskGovernanceService(
        port, new FileHighRiskGovernanceStateStore(path), auth, policy(),
      );
      await expect(secondRestart.commit({ ...request, now: "2026-08-04T01:00:07.000Z" }))
        .resolves.toEqual(committed);
      expect(effects).toHaveLength(1);
      const tampered = JSON.parse(readFileSync(path, "utf8")) as { stateRevision: number };
      tampered.stateRevision += 1;
      writeFileSync(path, JSON.stringify(tampered), { encoding: "utf8", mode: 0o600 });
      expect(() => new FileHighRiskGovernanceStateStore(path).getPreview(preview.previewId)).toThrow("checksum");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("rollout state store validation", () => {
  it("rejects malformed state, stale CAS, invalid file paths, and stale file writes", () => {
    const value = evidence();
    const memory = new MemoryRolloutStateStore();
    const service = new ActiveRolloutService(memory, bootstrapFor(value));
    const state = service.state;
    expect(() => memory.save({ ...state, schemaVersion: 2 as 1, stateRevision: 2 }, 1)).toThrow("header");
    expect(() => memory.save({ ...state, stateRevision: 3 }, 1)).toThrow("stale");
    expect(() => new FileRolloutStateStore("")).toThrow("path");

    const directory = mkdtempSync(join(tmpdir(), "zhiloop-store-"));
    try {
      const store = new FileRolloutStateStore(join(directory, "rollout.json"));
      new ActiveRolloutService(store, bootstrapFor(value));
      expect(() => store.save({ ...state, stateRevision: 2 }, 0)).toThrow("stale");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
