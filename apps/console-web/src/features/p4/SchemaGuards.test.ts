import { describe, expect, it } from "vitest";

import { highRiskGovernanceViewSchema, highRiskPreviewViewSchema, rolloutViewSchema } from "../../api/p4.js";
import { disabledHighRisk, rollout } from "./test-fixtures.js";

describe("P4 fail-closed server fact schemas", () => {
  it("rejects ACTIVE rollout without scoped canary and bound evidence", () => {
    expect(rolloutViewSchema.safeParse({ ...rollout, effective: { ...rollout.effective, canary: undefined, evidenceId: undefined } }).success).toBe(false);
  });

  it("rejects unscoped full ACTIVE canaries and malformed fingerprints", () => {
    expect(rolloutViewSchema.safeParse({
      ...rollout,
      effective: { ...rollout.effective, canary: { allocationSalt: "salt", percentageBasisPoints: 10_000 } },
    }).success).toBe(false);
    expect(rolloutViewSchema.safeParse({
      ...rollout,
      effective: { ...rollout.effective, configFingerprint: "client-claim" },
    }).success).toBe(false);
  });

  it("rejects enabled high-risk actions while ACTIVE stage is disabled", () => {
    expect(highRiskGovernanceViewSchema.safeParse({ ...disabledHighRisk, actions: { ...disabledHighRisk.actions, GLOBAL_PROMOTION: { enabled: true, capabilityStatus: "READY", reasonCode: "FORGED", expectedRevision: 1, idempotencyKey: "idem" } } }).success).toBe(false);
  });

  it("rejects a privacy purge preview that hides irreversible impact", () => {
    expect(highRiskPreviewViewSchema.safeParse({ previewId: "preview", policyRevision: 1, kind: "PRIVACY_PURGE", expiresAt: "2099-08-04T00:00:00.000Z", actor: "operator", confirmationPhrase: "confirm", blastRadius: { affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["PURGE"] } }).success).toBe(false);
  });

  it("rejects server confirmation fingerprints exposed in a preview", () => {
    expect(highRiskPreviewViewSchema.safeParse({
      previewId: "preview", policyRevision: 1, kind: "GLOBAL_PROMOTION",
      expiresAt: "2099-08-04T00:00:00.000Z", actor: "operator", confirmationPhrase: "confirm",
      confirmationFingerprint: `sha256:${"a".repeat(64)}`,
      blastRadius: { affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["GLOBAL"] },
    }).success).toBe(false);
  });
});
