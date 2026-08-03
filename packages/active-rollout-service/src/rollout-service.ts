import { createHash } from "node:crypto";

import {
  InjectionRolloutController,
  type InjectionActivationEvidence,
  type UserPromptInjectionResult,
} from "@zhiloop/codex-context-injection";

import type {
  ActivateCanaryRequest,
  CanaryScope,
  EffectiveRolloutRevision,
  PersistedRolloutState,
  RolloutBootstrap,
  RolloutDecision,
  RolloutRequestScope,
  RolloutStateStore,
  ShadowEligibilityEvidence,
} from "./types.js";
import { validateShadowEligibilityEvidence } from "./evaluation.js";
import { fingerprint, freezeClone, requireFingerprint, requireId, uniqueIds, validIso } from "./validation.js";

function validateCanary(canary: CanaryScope): void {
  requireId(canary.allocationSalt, "allocationSalt");
  const lists = [canary.projectIds, canary.sessionIds, canary.taskIds].filter(
    (value): value is readonly string[] => value !== undefined,
  );
  for (const values of lists) {
    if (values.length === 0) throw new Error("canary selector cannot be empty");
    uniqueIds(values, "canary selector", 1_000);
  }
  const percentage = canary.percentageBasisPoints ?? 10_000;
  if (!Number.isSafeInteger(percentage) || percentage < 1 || percentage > 10_000) {
    throw new Error("canary percentageBasisPoints must be within 1..10000");
  }
  if (lists.length === 0 && percentage === 10_000) {
    throw new Error("ACTIVE rollout requires a scoped canary, not global 100% activation");
  }
}

function activationEvidence(evidence: ShadowEligibilityEvidence): InjectionActivationEvidence {
  return {
    datasetId: evidence.datasetId,
    datasetVersion: evidence.datasetVersion,
    configFingerprint: evidence.configFingerprint,
    defaultInjectionAllowed: true,
  };
}

function validateBootstrap(bootstrap: RolloutBootstrap): void {
  if (!Number.isSafeInteger(bootstrap.policyRevision) || bootstrap.policyRevision < 1) {
    throw new Error("bootstrap policy revision is invalid");
  }
  requireFingerprint(bootstrap.configFingerprint, "bootstrap config fingerprint");
  requireFingerprint(bootstrap.versionFingerprint, "bootstrap version fingerprint");
  if (!validIso(bootstrap.now)) throw new Error("bootstrap timestamp must be canonical ISO-8601");
}

function requestIncluded(canary: CanaryScope, scope: RolloutRequestScope): boolean {
  if (canary.projectIds !== undefined
    && (scope.projectId === undefined || !canary.projectIds.includes(scope.projectId))) return false;
  if (canary.sessionIds !== undefined && !canary.sessionIds.includes(scope.sessionId)) return false;
  if (canary.taskIds !== undefined
    && (scope.taskId === undefined || !canary.taskIds.includes(scope.taskId))) return false;
  const percentage = canary.percentageBasisPoints ?? 10_000;
  if (percentage === 10_000) return true;
  const allocationKey = [canary.allocationSalt, scope.projectId ?? "", scope.taskId ?? "", scope.sessionId].join("\0");
  const bucket = Number.parseInt(createHash("sha256").update(allocationKey).digest("hex").slice(0, 8), 16) % 10_000;
  return bucket < percentage;
}

function bounded<T>(values: readonly T[], maximum: number): readonly T[] {
  return values.length <= maximum ? values : values.slice(values.length - maximum);
}

export class ActiveRolloutService {
  readonly injectionRollout = new InjectionRolloutController();
  private stateValue: PersistedRolloutState;
  private volatileShadowReason: string | undefined;

  constructor(private readonly store: RolloutStateStore, bootstrap: RolloutBootstrap) {
    validateBootstrap(bootstrap);
    const loaded = store.load();
    if (loaded === undefined) {
      const effective: EffectiveRolloutRevision = {
        policyRevision: bootstrap.policyRevision,
        mode: "SHADOW",
        configFingerprint: bootstrap.configFingerprint,
        versionFingerprint: bootstrap.versionFingerprint,
      };
      const state: PersistedRolloutState = {
        schemaVersion: 1,
        stateRevision: 1,
        effective,
        lastKnownGood: effective,
        evidence: [],
        audit: [{
          eventId: fingerprint({ kind: "BOOTSTRAP", revision: 1, now: bootstrap.now }),
          kind: "BOOTSTRAP",
          stateRevision: 1,
          effectivePolicyRevision: effective.policyRevision,
          reasonCodes: ["BOOTSTRAP_SHADOW"],
          occurredAt: bootstrap.now,
        }],
      };
      store.save(state, 0);
      this.stateValue = freezeClone(state);
    } else {
      this.stateValue = freezeClone(loaded);
    }
    this.hydrateInjectionRollout();
  }

  get state(): PersistedRolloutState {
    return freezeClone(this.stateValue);
  }

  recordEvidence(evidence: ShadowEligibilityEvidence): PersistedRolloutState {
    const existing = this.stateValue.evidence.find((item) => item.evidenceId === evidence.evidenceId);
    if (existing !== undefined) {
      if (fingerprint(existing) !== fingerprint(evidence)) throw new Error("eligibility evidence ID semantic conflict");
      return this.state;
    }
    validateShadowEligibilityEvidence(evidence);
    const next = {
      ...this.stateValue,
      stateRevision: this.stateValue.stateRevision + 1,
      evidence: bounded([...this.stateValue.evidence, freezeClone(evidence)], 1_000),
    } satisfies PersistedRolloutState;
    this.store.save(next, this.stateValue.stateRevision);
    this.stateValue = freezeClone(next);
    return this.state;
  }

  activateCanary(request: ActivateCanaryRequest | boolean): PersistedRolloutState {
    if (typeof request !== "object" || request === null) {
      throw new Error("single-boolean ACTIVE activation is forbidden; revision, evidence, and canary are required");
    }
    if (request.expectedStateRevision !== this.stateValue.stateRevision) throw new Error("stale rollout state revision");
    if (this.stateValue.effective.mode !== "SHADOW") throw new Error("ACTIVE canary can only be activated from SHADOW");
    const maximumKnownPolicyRevision = Math.max(
      this.stateValue.effective.policyRevision,
      this.stateValue.lastKnownGood.policyRevision,
      ...this.stateValue.audit.map((item) => item.effectivePolicyRevision),
    );
    if (!Number.isSafeInteger(request.targetPolicyRevision)
      || request.targetPolicyRevision <= maximumKnownPolicyRevision) {
      throw new Error("target policy revision must increase");
    }
    if (!validIso(request.now)) throw new Error("activation timestamp must be canonical ISO-8601");
    requireFingerprint(request.configFingerprint, "activation config fingerprint");
    requireFingerprint(request.versionFingerprint, "activation version fingerprint");
    validateCanary(request.canary);
    const evidence = this.stateValue.evidence.find((item) => item.evidenceId === request.eligibilityEvidenceId);
    if (evidence === undefined || !evidence.eligible || evidence.configFingerprint !== request.configFingerprint
      || evidence.versionFingerprint !== request.versionFingerprint || !evidence.checks.every((item) => item.passed)) {
      throw new Error("ACTIVE eligibility evidence is missing, failing, or not revision-bound");
    }
    const effective: EffectiveRolloutRevision = {
      policyRevision: request.targetPolicyRevision,
      mode: "ACTIVE",
      configFingerprint: request.configFingerprint,
      versionFingerprint: request.versionFingerprint,
      canary: freezeClone(request.canary),
      evidenceId: evidence.evidenceId,
    };
    const nextRevision = this.stateValue.stateRevision + 1;
    const next: PersistedRolloutState = {
      ...this.stateValue,
      stateRevision: nextRevision,
      effective,
      lastKnownGood: this.stateValue.effective,
      audit: bounded([...this.stateValue.audit, {
        eventId: fingerprint({ kind: "ACTIVATED", revision: nextRevision, request }),
        kind: "ACTIVATED" as const,
        stateRevision: nextRevision,
        effectivePolicyRevision: effective.policyRevision,
        reasonCodes: ["SHADOW_EVIDENCE_PASSED", "SCOPED_CANARY"],
        occurredAt: request.now,
      }], 10_000),
    };
    this.store.save(next, this.stateValue.stateRevision);
    this.stateValue = freezeClone(next);
    this.injectionRollout.activate(nextRevision, "ACTIVE", activationEvidence(evidence));
    return this.state;
  }

  decision(scope: RolloutRequestScope): RolloutDecision {
    requireId(scope.sessionId, "sessionId");
    requireId(scope.turnId, "turnId");
    if (scope.projectId !== undefined) requireId(scope.projectId, "projectId");
    if (scope.taskId !== undefined) requireId(scope.taskId, "taskId");
    const effective = this.stateValue.effective;
    if (this.volatileShadowReason !== undefined) {
      return freezeClone({
        stateRevision: this.stateValue.stateRevision,
        policyRevision: effective.policyRevision,
        mode: "SHADOW",
        reasonCode: "FAIL_SAFE_SHADOW",
      });
    }
    if (effective.mode === "SHADOW") {
      return freezeClone({
        stateRevision: this.stateValue.stateRevision,
        policyRevision: effective.policyRevision,
        mode: "SHADOW",
        reasonCode: "SHADOW_MODE",
      });
    }
    if (effective.canary === undefined) throw new Error("ACTIVE state is missing canary scope");
    const included = requestIncluded(effective.canary, scope);
    return freezeClone({
      stateRevision: this.stateValue.stateRevision,
      policyRevision: effective.policyRevision,
      mode: included ? "ACTIVE" : "SHADOW",
      reasonCode: included ? "ACTIVE_CANARY_INCLUDED" : "GRAY_SCOPE_EXCLUDED",
    });
  }

  downgrade(reasonCode: string, now: string): PersistedRolloutState {
    requireId(reasonCode, "downgrade reason");
    if (!validIso(now)) throw new Error("downgrade timestamp must be canonical ISO-8601");
    if (this.stateValue.effective.mode === "SHADOW") return this.state;
    const nextRevision = this.stateValue.stateRevision + 1;
    const effective: EffectiveRolloutRevision = { ...this.stateValue.lastKnownGood, mode: "SHADOW" };
    const next: PersistedRolloutState = {
      ...this.stateValue,
      stateRevision: nextRevision,
      effective,
      lastKnownGood: effective,
      audit: bounded([...this.stateValue.audit, {
        eventId: fingerprint({ kind: "DOWNGRADED", revision: nextRevision, reasonCode, now }),
        kind: "DOWNGRADED" as const,
        stateRevision: nextRevision,
        effectivePolicyRevision: effective.policyRevision,
        reasonCodes: [reasonCode, "LAST_KNOWN_GOOD_RESTORED"],
        occurredAt: now,
      }], 10_000),
    };
    try {
      this.store.save(next, this.stateValue.stateRevision);
    } catch (error) {
      this.forceRuntimeShadow(reasonCode, nextRevision);
      throw error;
    }
    this.stateValue = freezeClone(next);
    this.volatileShadowReason = undefined;
    this.forceRuntimeShadow(reasonCode, nextRevision);
    this.volatileShadowReason = undefined;
    return this.state;
  }

  observeEligibility(evidence: ShadowEligibilityEvidence, now: string): PersistedRolloutState {
    try {
      this.recordEvidence(evidence);
    } catch (error) {
      if (this.stateValue.effective.mode === "ACTIVE") {
        this.forceRuntimeShadow("QUALITY_EVIDENCE_UNSAFE", this.stateValue.stateRevision + 1);
      }
      throw error;
    }
    const effective = this.stateValue.effective;
    if (effective.mode === "ACTIVE" && (!evidence.eligible
      || evidence.configFingerprint !== effective.configFingerprint
      || evidence.versionFingerprint !== effective.versionFingerprint)) {
      return this.downgrade("QUALITY_EVIDENCE_DEGRADED", now);
    }
    return this.state;
  }

  observeInjectionResult(
    decision: RolloutDecision,
    result: UserPromptInjectionResult,
    now: string,
  ): PersistedRolloutState {
    if (decision.mode !== "ACTIVE" || this.stateValue.effective.mode !== "ACTIVE"
      || decision.policyRevision !== this.stateValue.effective.policyRevision) return this.state;
    if (["TIMEOUT", "PROVIDER_ERROR", "INVALID_CONTEXT"].includes(result.status)) {
      return this.downgrade(`ACTIVE_${result.status}`, now);
    }
    return this.state;
  }

  private hydrateInjectionRollout(): void {
    const effective = this.stateValue.effective;
    if (effective.mode === "SHADOW") {
      this.injectionRollout.activate(this.stateValue.stateRevision, "SHADOW");
      return;
    }
    const evidence = this.stateValue.evidence.find((item) => item.evidenceId === effective.evidenceId);
    if (evidence === undefined || !evidence.eligible || effective.canary === undefined
      || evidence.configFingerprint !== effective.configFingerprint
      || evidence.versionFingerprint !== effective.versionFingerprint) {
      throw new Error("persisted ACTIVE state has no matching eligibility evidence");
    }
    validateCanary(effective.canary);
    this.injectionRollout.activate(this.stateValue.stateRevision, "ACTIVE", activationEvidence(evidence));
  }

  private forceRuntimeShadow(reasonCode: string, revision: number): void {
    this.volatileShadowReason = reasonCode;
    if (this.injectionRollout.snapshot.revision < revision) {
      this.injectionRollout.activate(revision, "SHADOW");
    }
  }
}
