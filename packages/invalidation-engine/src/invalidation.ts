import type { KnowledgeAssertion, KnowledgeCandidate } from "@zhiloop/domain";
import { transitionKnowledgeStatus } from "@zhiloop/domain";

import type {
  FingerprintObservation,
  FingerprintTarget,
  InvalidationDecision,
  InvalidationInput,
  KnowledgeChangeSet,
  KnowledgeFingerprint,
} from "./types.js";

const SAFE_TEXT = /^[^\0\r\n]{1,1000}$/;
const SAFE_DIGEST = /^[A-Za-z0-9:_-]{8,256}$/;

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function safePath(value: string): boolean {
  return SAFE_TEXT.test(value) && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function target(assertion: KnowledgeAssertion): FingerprintTarget | undefined {
  switch (assertion.kind) {
    case "SYMBOL_EXISTS":
      return { assertionId: assertion.assertionId, kind: "SYMBOL", key: assertion.parameters.symbol,
        ...(assertion.parameters.path === undefined ? {} : { path: assertion.parameters.path }) };
    case "FILE_CONTAINS":
      return { assertionId: assertion.assertionId, kind: "PATH", key: assertion.parameters.path, path: assertion.parameters.path };
    case "CONFIG_EQUALS":
      return { assertionId: assertion.assertionId, kind: "CONFIG", key: assertion.parameters.key,
        ...(assertion.parameters.path === undefined ? {} : { path: assertion.parameters.path }) };
    case "DEPENDENCY_PRESENT":
      return { assertionId: assertion.assertionId, kind: "DEPENDENCY", key: assertion.parameters.name,
        ...(assertion.parameters.manifestPath === undefined ? {} : { path: assertion.parameters.manifestPath }) };
    default:
      return undefined;
  }
}

function validateTarget(item: FingerprintTarget): boolean {
  return SAFE_TEXT.test(item.assertionId) && SAFE_TEXT.test(item.key)
    && (item.path === undefined || safePath(item.path));
}

export function deriveFingerprintTargets(candidate: KnowledgeCandidate): readonly FingerprintTarget[] {
  const targets = candidate.assertions.map(target).filter((item): item is FingerprintTarget => item !== undefined);
  if (targets.some((item) => !validateTarget(item)) || new Set(targets.map((item) => item.assertionId)).size !== targets.length) {
    throw new Error("Candidate contains invalid or duplicate fingerprint targets");
  }
  return freeze(targets.sort((left, right) => left.assertionId.localeCompare(right.assertionId)));
}

function hash(value: string): string {
  const state = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < value.length; index += 1) {
    for (let lane = 0; lane < state.length; lane += 1) {
      state[lane] = Math.imul((state[lane] ?? 0) ^ (value.charCodeAt(index) + lane), [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f][lane] ?? 0x01000193);
    }
  }
  return state.map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}

export function createKnowledgeFingerprint(
  candidate: KnowledgeCandidate,
  projectId: string,
  observations: readonly FingerprintObservation[],
): KnowledgeFingerprint {
  const targets = deriveFingerprintTargets(candidate);
  if (!SAFE_TEXT.test(projectId) || observations.length !== targets.length) throw new Error("Fingerprint input is incomplete");
  const byAssertion = new Map(observations.map((item) => [item.assertionId, item]));
  if (byAssertion.size !== observations.length) throw new Error("Fingerprint observations must be unique");
  const entries = targets.map((expected) => {
    const item = byAssertion.get(expected.assertionId);
    if (item === undefined || item.kind !== expected.kind || item.key !== expected.key || item.path !== expected.path
      || !SAFE_DIGEST.test(item.digest) || !SAFE_TEXT.test(item.sourceRef) || !Number.isFinite(Date.parse(item.observedAt))) {
      throw new Error("Fingerprint observation does not match target");
    }
    return {
      assertionId: item.assertionId,
      kind: item.kind,
      key: item.key,
      ...(item.path === undefined ? {} : { path: item.path }),
      digest: item.digest,
      sourceRef: item.sourceRef,
      observedAt: item.observedAt,
    };
  });
  const identity = JSON.stringify(["knowledge-fingerprint-v1", candidate.candidateId, projectId, entries]);
  return freeze({ schemaVersion: 1, candidateId: candidate.candidateId, projectId, entries, fingerprint: `fp_${hash(identity)}` });
}

function affected(entry: FingerprintObservation, changes: KnowledgeChangeSet): boolean {
  if (entry.path !== undefined && changes.changedPaths.includes(entry.path)) return true;
  if (entry.kind === "SYMBOL") return changes.changedSymbols.includes(entry.key);
  if (entry.kind === "CONFIG") return changes.changedConfigs.includes(entry.key);
  if (entry.kind === "DEPENDENCY") return changes.changedDependencies.includes(entry.key);
  return false;
}

function output(input: InvalidationInput, values: Omit<InvalidationDecision, "currentStatus" | "preserveBody">): InvalidationDecision {
  return freeze({ currentStatus: input.currentStatus, preserveBody: true, ...values });
}

function validChangeSet(changes: KnowledgeChangeSet): boolean {
  return SAFE_TEXT.test(changes.projectId) && SAFE_TEXT.test(changes.sourceRef) && Number.isFinite(Date.parse(changes.observedAt))
    && changes.changedPaths.every(safePath)
    && [...changes.changedSymbols, ...changes.changedConfigs, ...changes.changedDependencies].every((item) => SAFE_TEXT.test(item));
}

function validFingerprint(input: InvalidationInput): boolean {
  try {
    return createKnowledgeFingerprint(input.candidate, input.fingerprint.projectId, input.fingerprint.entries).fingerprint
      === input.fingerprint.fingerprint;
  } catch {
    return false;
  }
}

function supportedRevalidation(input: InvalidationInput, assertionId: string): boolean {
  const matching = (input.revalidationResults ?? []).filter((result) => result.assertionId === assertionId);
  if (matching.length !== 1) return false;
  const result = matching[0];
  const assertion = input.candidate.assertions.find((item) => item.assertionId === assertionId);
  return result?.status === "SUPPORTED" && assertion !== undefined && result.assertionKind === assertion.kind
    && result.evidence?.verdict === "SUPPORTS" && result.evidence.assertionId === assertionId
    && result.evidence.projectId === input.fingerprint.projectId
    && result.evidence.correlationId === input.candidate.correlationId;
}

export function evaluateInvalidation(input: InvalidationInput): InvalidationDecision {
  if (input.fingerprint.candidateId !== input.candidate.candidateId
    || input.fingerprint.projectId !== input.changes.projectId || !validChangeSet(input.changes) || !validFingerprint(input)) {
    return output(input, { action: "UNCHANGED", targetStatus: input.currentStatus, affectedAssertionIds: [], reasonCodes: ["INVALID_CHANGESET_OR_FINGERPRINT"] });
  }
  const affectedIds = input.fingerprint.entries.filter((entry) => affected(entry, input.changes))
    .map((entry) => entry.assertionId).sort();
  if (affectedIds.length === 0) {
    return output(input, { action: "UNCHANGED", targetStatus: input.currentStatus, affectedAssertionIds: [], reasonCodes: ["NO_RELEVANT_CHANGE"] });
  }
  const allSupported = affectedIds.every((id) => supportedRevalidation(input, id));
  if (allSupported) {
    return output(input, { action: "REFRESH_FINGERPRINT", targetStatus: input.currentStatus, affectedAssertionIds: affectedIds,
      reasonCodes: ["AFFECTED_TARGETS_REVALIDATED"] });
  }
  if ((input.currentStatus === "IMPLEMENTED" || input.currentStatus === "VERIFIED")
    && transitionKnowledgeStatus(input.currentStatus, "STALE").ok) {
    return output(input, { action: "MARK_STALE", targetStatus: "STALE", affectedAssertionIds: affectedIds,
      reasonCodes: ["AFFECTED_TARGET_REVALIDATION_INCOMPLETE", "BODY_PRESERVED"] });
  }
  return output(input, { action: "REVALIDATE", targetStatus: input.currentStatus, affectedAssertionIds: affectedIds,
    reasonCodes: ["AFFECTED_TARGET_REQUIRES_REVALIDATION"] });
}
