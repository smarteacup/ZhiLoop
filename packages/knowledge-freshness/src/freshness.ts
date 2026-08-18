import { createHash } from "node:crypto";

import type { VerificationResult } from "@zhiloop/evidence-engine";
import {
  createKnowledgeFingerprint,
  deriveFingerprintTargets,
  evaluateInvalidation,
  type FingerprintObservation,
} from "@zhiloop/invalidation-engine";

import type { FreshnessPlan, FreshnessPlanningInput, FreshnessProjectionInput, KnowledgeFreshnessRecord } from "./types.js";

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceFor(assertionId: string, results: readonly VerificationResult[]): VerificationResult | undefined {
  const matches = results.filter((result) => result.assertionId === assertionId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function buildFreshnessRecord(input: FreshnessProjectionInput): KnowledgeFreshnessRecord {
  if (input.asset.id.trim().length === 0 || input.asset.version < 1 || input.projectId.trim().length === 0
    || !Number.isFinite(Date.parse(input.observedAt))
    || input.asset.subjectKey !== input.candidate.subjectKey
    || input.asset.kind !== input.candidate.kind
    || input.asset.correlationId !== input.candidate.correlationId
    || input.candidate.sourceEpisodes.some((episodeId) => !input.asset.sourceEpisodes.includes(episodeId))) {
    throw new Error("FRESHNESS_PROJECTION_INPUT_INVALID");
  }
  const anchors = deriveFingerprintTargets(input.candidate);
  const observations: FingerprintObservation[] = anchors.map((anchor) => {
    const result = evidenceFor(anchor.assertionId, input.verificationResults);
    const evidence = result?.evidence;
    return {
      ...anchor,
      digest: evidence?.evidenceId ?? `missing_${digest(`${input.candidate.candidateId}:${anchor.assertionId}`)}`,
      sourceRef: evidence?.sourceRef ?? `candidate:${input.candidate.candidateId}`,
      observedAt: evidence?.observedAt ?? input.observedAt,
    };
  });
  const fingerprint = createKnowledgeFingerprint(input.candidate, input.projectId, observations);
  return freeze({
    schemaVersion: 1,
    assetId: input.asset.id,
    assetVersion: input.asset.version,
    assetContentHash: input.asset.contentHash,
    projectId: input.projectId,
    lifecycleStatus: input.asset.status,
    freshnessStatus: "FRESH",
    candidate: structuredClone(input.candidate),
    fingerprint,
    anchors,
    updatedAt: input.observedAt,
  });
}

function hasUnknown(results: readonly VerificationResult[] | undefined): boolean {
  return results?.some((result) => result.status === "UNKNOWN" || result.status === "ERROR") === true;
}

export function planKnowledgeFreshness(input: FreshnessPlanningInput): FreshnessPlan {
  const decision = evaluateInvalidation({
    candidate: input.record.candidate,
    currentStatus: input.record.lifecycleStatus,
    fingerprint: input.record.fingerprint,
    changes: input.changes,
    ...(input.revalidationResults === undefined ? {} : { revalidationResults: input.revalidationResults }),
  });
  let freshnessStatus: FreshnessPlan["freshnessStatus"];
  let action: FreshnessPlan["action"];
  if (decision.reasonCodes.includes("INVALID_CHANGESET_OR_FINGERPRINT")) {
    freshnessStatus = "UNKNOWN";
    action = "NONE";
  } else if (decision.action === "REFRESH_FINGERPRINT") {
    freshnessStatus = "FRESH";
    action = "REFRESH_FINGERPRINT";
  } else if (decision.action === "MARK_STALE") {
    freshnessStatus = input.revalidationResults === undefined
      ? "REVALIDATE"
      : hasUnknown(input.revalidationResults) ? "UNKNOWN" : "CONFLICT";
    action = freshnessStatus === "CONFLICT" ? "MARK_STALE" : "REQUEST_REVALIDATION";
  } else if (decision.action === "REVALIDATE") {
    freshnessStatus = hasUnknown(input.revalidationResults) ? "UNKNOWN" : "REVALIDATE";
    action = "REQUEST_REVALIDATION";
  } else {
    freshnessStatus = "FRESH";
    action = "NONE";
  }
  return freeze({
    schemaVersion: 1,
    assetId: input.record.assetId,
    expectedAssetVersion: input.record.assetVersion,
    freshnessStatus,
    currentLifecycleStatus: input.record.lifecycleStatus,
    targetLifecycleStatus: action === "MARK_STALE" ? decision.targetStatus : input.record.lifecycleStatus,
    action,
    affectedAssertionIds: decision.affectedAssertionIds,
    reasonCodes: decision.reasonCodes,
    preserveBody: true,
  });
}
