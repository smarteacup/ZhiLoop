import { describe, expect, it } from "vitest";

import type { CrossProjectAssertion } from "@zhiloop/evidence-engine";

import { createCurrentCrossProjectProbe } from "./cross-project.js";
import type { KnowledgeVerificationStore, SupportingProofRef } from "./types.js";

const assertion: CrossProjectAssertion = { assertionId: "cross-1", candidateId: "candidate-1", kind: "CROSS_PROJECT_VERIFIED",
  parameters: { subjectKey: "design.runtime.verification", minimumProjects: 2 }, createdAt: "2026-08-19T00:00:00.000Z" };
const context = { project: { projectId: "project-1", portable: false }, correlationId: "correlation-1", requestedAt: "2026-08-19T00:00:00.000Z" };

function dependencies(proofs: SupportingProofRef[], states: Readonly<Record<string, "CURRENT" | "STALE" | "UNKNOWN">>) {
  const store = { listSupportingProofs: () => proofs } as unknown as KnowledgeVerificationStore;
  return { store, eligibility: { classify: (proof: SupportingProofRef) => states[proof.runId] ?? "UNKNOWN" } };
}

describe("Current cross-project proof", () => {
  it("deduplicates branches and worktrees sharing one canonical project identity", async () => {
    const proofs: SupportingProofRef[] = [
      { runId: "main", canonicalProjectId: "project-1", knowledgeVersion: { assetId: "a", assetVersion: 1 }, completedAt: context.requestedAt },
      { runId: "branch", canonicalProjectId: "project-1", knowledgeVersion: { assetId: "a", assetVersion: 1 }, completedAt: context.requestedAt },
    ];
    await expect(createCurrentCrossProjectProbe(dependencies(proofs, { main: "CURRENT", branch: "CURRENT" }), "project-1")
      .observe(assertion, context)).resolves.toMatchObject({ status: "REFUTED", details: { projectCount: 1 } });
  });

  it("supports independent current proof and treats unresolved eligibility as UNKNOWN", async () => {
    const proofs: SupportingProofRef[] = [
      { runId: "one", canonicalProjectId: "project-1", knowledgeVersion: { assetId: "a", assetVersion: 1 }, completedAt: context.requestedAt },
      { runId: "two", canonicalProjectId: "project-2", knowledgeVersion: { assetId: "b", assetVersion: 1 }, completedAt: context.requestedAt },
    ];
    await expect(createCurrentCrossProjectProbe(dependencies(proofs, { one: "CURRENT", two: "CURRENT" }), "project-1")
      .observe(assertion, context)).resolves.toMatchObject({ status: "SUPPORTED", details: { projectCount: 2 } });
    await expect(createCurrentCrossProjectProbe(dependencies(proofs, { one: "CURRENT", two: "UNKNOWN" }), "project-1")
      .observe(assertion, context)).resolves.toMatchObject({ status: "UNKNOWN", reasonCode: "CROSS_PROJECT_ELIGIBILITY_UNKNOWN" });
  });
});
