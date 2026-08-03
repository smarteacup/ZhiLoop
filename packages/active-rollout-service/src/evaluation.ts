import { fingerprintRetrievalConfiguration } from "@zhiloop/retrieval-evaluation";

import type {
  ShadowEligibilityCheck,
  ShadowEligibilityEvidence,
  ShadowQualityEvaluationInput,
} from "./types.js";
import { fingerprint, freezeClone, requireFingerprint, requireId, uniqueIds, validIso } from "./validation.js";

const CHECK_CODES: readonly ShadowEligibilityCheck["code"][] = [
  "REAL_SHADOW_TRACES", "DATASET_BOUND", "CONFIG_BOUND", "VERSION_BOUND", "GOLDEN_GATE",
  "TRACEABILITY", "SCOPE_ISOLATION", "FORBIDDEN_EXCLUSION", "NO_AUTOMATIC_L4",
];

function evidenceCore(evidence: Omit<ShadowEligibilityEvidence, "evidenceId" | "observedFrom" | "observedTo" | "createdAt">): unknown {
  return {
    datasetId: evidence.datasetId,
    datasetVersion: evidence.datasetVersion,
    datasetFingerprint: evidence.datasetFingerprint,
    configFingerprint: evidence.configFingerprint,
    versionFingerprint: evidence.versionFingerprint,
    traceIds: evidence.traceIds,
    checks: evidence.checks,
    eligible: evidence.eligible,
  };
}

export function validateShadowEligibilityEvidence(evidence: ShadowEligibilityEvidence): void {
  requireId(evidence.datasetId, "datasetId");
  if (!Number.isSafeInteger(evidence.datasetVersion) || evidence.datasetVersion < 1) {
    throw new Error("dataset version is invalid");
  }
  requireFingerprint(evidence.datasetFingerprint, "dataset fingerprint");
  requireFingerprint(evidence.configFingerprint, "config fingerprint");
  requireFingerprint(evidence.versionFingerprint, "version fingerprint");
  uniqueIds(evidence.traceIds, "trace IDs");
  if (evidence.traceIds.length < 1 || !validIso(evidence.observedFrom)
    || !validIso(evidence.observedTo) || !validIso(evidence.createdAt)
    || Date.parse(evidence.observedFrom) > Date.parse(evidence.observedTo)) {
    throw new Error("evidence observation window is invalid");
  }
  const codes = evidence.checks.map((item) => item.code);
  if (codes.length !== CHECK_CODES.length || new Set(codes).size !== codes.length
    || CHECK_CODES.some((code) => !codes.includes(code))
    || evidence.eligible !== evidence.checks.every((item) => item.passed)) {
    throw new Error("eligibility checks are incomplete or inconsistent");
  }
  const expectedId = fingerprint(evidenceCore(evidence));
  if (evidence.evidenceId !== expectedId) throw new Error("eligibility evidence fingerprint mismatch");
}

function check(code: ShadowEligibilityCheck["code"], passed: boolean, detail: string): ShadowEligibilityCheck {
  return { code, passed, detail };
}

export function evaluateShadowQuality(input: ShadowQualityEvaluationInput): ShadowEligibilityEvidence {
  if (!validIso(input.now)) throw new Error("evaluation timestamp must be canonical ISO-8601");
  if (input.traces.length < 1 || input.traces.length > 10_000) {
    throw new Error("SHADOW trace dataset must contain 1..10000 traces");
  }
  requireId(input.report.datasetId, "datasetId");
  const traceIds = input.traces.map((trace) => trace.traceId);
  const reportTraceIds = input.report.cases.flatMap((item) => item.traceId === undefined ? [] : [item.traceId]);
  const realShadowTraces = input.traces.every((trace) => {
    requireId(trace.traceId, "traceId");
    requireId(trace.runId, "runId");
    if (!validIso(trace.observedAt)) return false;
    if (trace.projectId !== undefined) requireId(trace.projectId, "projectId");
    if (trace.taskId !== undefined) requireId(trace.taskId, "taskId");
    uniqueIds(trace.eligibleKnowledgeVersions, "eligible knowledge versions");
    return trace.source === "PERSISTED_SHADOW_TRACE"
      && (["SHADOWED", "NO_CONTEXT", "TIMEOUT", "ERROR"] as const).includes(trace.delivery);
  }) && new Set(traceIds).size === traceIds.length;
  const sortedTraceIds = [...traceIds].sort();
  const datasetBound = input.report.totals.cases === input.traces.length
    && JSON.stringify([...reportTraceIds].sort()) === JSON.stringify(sortedTraceIds);
  const configFingerprint = fingerprintRetrievalConfiguration(input.retrievalConfiguration);
  const configBound = input.report.configFingerprint === configFingerprint;
  const versions = Object.entries(input.componentVersions);
  const versionBound = versions.length > 0 && versions.length <= 100
    && versions.every(([name, version]) => {
      try { requireId(name, "component name"); requireId(version, "component version"); return true; }
      catch { return false; }
    });
  const versionFingerprint = fingerprint(input.componentVersions);
  const checks: ShadowEligibilityCheck[] = [
    check("REAL_SHADOW_TRACES", realShadowTraces, `${input.traces.length} persisted observations`),
    check("DATASET_BOUND", datasetBound, `report cases and trace IDs ${datasetBound ? "match" : "do not match"}`),
    check("CONFIG_BOUND", configBound, `report config ${configBound ? "matches" : "differs"}`),
    check("VERSION_BOUND", versionBound, `${versions.length} component versions fingerprinted`),
    check("GOLDEN_GATE", input.report.gatePassed && input.report.defaultInjectionAllowed, "Golden Dataset gate result"),
    check("TRACEABILITY", input.report.metrics.traceabilityRate === 1, `rate=${input.report.metrics.traceabilityRate}`),
    check("SCOPE_ISOLATION", input.report.metrics.scopeLeakCount === 0, `leaks=${input.report.metrics.scopeLeakCount}`),
    check("FORBIDDEN_EXCLUSION", input.report.totals.forbiddenHits === 0, `hits=${input.report.totals.forbiddenHits}`),
    check("NO_AUTOMATIC_L4", input.report.complexity.automaticL4Count === 0, `count=${input.report.complexity.automaticL4Count}`),
  ];
  const observed = input.traces.map((trace) => trace.observedAt).sort();
  const datasetFingerprint = fingerprint({
    datasetId: input.report.datasetId,
    datasetVersion: input.report.datasetVersion,
    traces: [...input.traces].sort((left, right) => left.traceId.localeCompare(right.traceId)),
  });
  const eligible = checks.every((item) => item.passed);
  const core = {
    datasetId: input.report.datasetId,
    datasetVersion: input.report.datasetVersion,
    datasetFingerprint,
    configFingerprint,
    versionFingerprint,
    traceIds: sortedTraceIds,
    checks,
    eligible,
  };
  return freezeClone({
    evidenceId: fingerprint(core),
    ...core,
    observedFrom: observed[0]!,
    observedTo: observed.at(-1)!,
    createdAt: input.now,
  });
}
