import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InjectionRolloutController } from "@zhiloop/codex-context-injection";
import { ContextOrchestrator } from "@zhiloop/context-orchestrator";
import { SqliteFeedbackStore } from "@zhiloop/feedback-engine";
import { resolveQueryContext } from "@zhiloop/query-context";
import { SqliteRuntimeAuditStore } from "@zhiloop/runtime-audit-store";
import { afterEach, describe, expect, it } from "vitest";

import { ActiveKnowledgeInjectionRuntime } from "./injection-runtime.js";
import { InjectionDeliveryAcknowledger } from "./delivery-acknowledgement.js";
import { asset, fixedNow, injectionPolicy, query, reranked } from "./test-fixtures.js";
import type {
  ActiveInjectionRuntimeDependencies,
  ActiveKnowledgeRetrievalPort,
  KnowledgeEligibilityPort,
  RuntimeAuditStorePort,
  UserPromptSubmitInput,
} from "./types.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function resources() {
  const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-active-injection-"));
  directories.push(directory);
  return {
    audits: new SqliteRuntimeAuditStore(path.join(directory, "audit.sqlite")),
    feedback: new SqliteFeedbackStore(path.join(directory, "feedback.sqlite")),
  };
}

function input(): UserPromptSubmitInput {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "/workspace/project-a",
    prompt: "How does ActiveKnowledgeRuntime work?",
  };
}

function retrieval(beforeReturn?: () => void): ActiveKnowledgeRetrievalPort {
  return {
    retrieve: async (request) => {
      const candidate = reranked();
      const context = query(request.prompt);
      beforeReturn?.();
      return {
        runId: "run-1",
        traceId: "trace-1",
        queryContext: context,
        retrieval: {
          items: [{
            asset: candidate.asset,
            rank: 1,
            score: 1,
            scopeMatched: true,
            contributions: candidate.contributions,
          }],
          diagnostics: [],
        },
        rerank: { items: [candidate], diagnostics: [] },
        candidates: [candidate],
      };
    },
  };
}

const eligible: KnowledgeEligibilityPort = {
  inspect: ({ version }) => ({
    exists: true, currentVersion: 3, current: version === 3,
    scopeMatched: true, statusEligible: true, suppressed: false,
  }),
};

function runtime(
  dependencies: Pick<ActiveInjectionRuntimeDependencies, "retrieval" | "rollout" | "audits" | "feedback">,
  eligibility: KnowledgeEligibilityPort = eligible,
  deadlineMs = 100,
) {
  return new ActiveKnowledgeInjectionRuntime({
    ...dependencies,
    eligibility,
    orchestrator: new ContextOrchestrator(),
    injectionPolicy,
    now: () => new Date(fixedNow),
    deadlineMs,
  });
}

describe("ActiveKnowledgeInjectionRuntime", () => {
  it("persists PENDING before the exact ACTIVE delivery result and only then returns context", async () => {
    const values = resources();
    const rollout = new InjectionRolloutController();
    rollout.activate(1, "ACTIVE", {
      datasetId: "golden-1",
      datasetVersion: 1,
      configFingerprint: `sha256:${"a".repeat(64)}`,
      defaultInjectionAllowed: true,
    });
    const order: string[] = [];
    const auditPort: RuntimeAuditStorePort = {
      beginInjection: (record) => { order.push("PENDING"); return values.audits.beginInjection(record); },
      completeInjection: (...args) => { order.push(args[2]); return values.audits.completeInjection(...args); },
      acknowledgeInjectionDelivery: (...args) => values.audits.acknowledgeInjectionDelivery(...args),
      getInjection: (id) => values.audits.getInjection(id),
      listInjections: (id, limit) => values.audits.listInjections(id, limit),
      recordMcpExpansion: (record) => values.audits.recordMcpExpansion(record),
      getMcpExpansion: (id) => values.audits.getMcpExpansion(id),
      listMcpExpansions: (id, limit) => values.audits.listMcpExpansions(id, limit),
      recordClosure: (record) => values.audits.recordClosure(record),
      getClosure: (id) => values.audits.getClosure(id),
      listClosures: (id, limit) => values.audits.listClosures(id, limit),
    };
    const result = await runtime({ retrieval: retrieval(), rollout, audits: auditPort, feedback: values.feedback }).handle(input());
    expect(order).toEqual(["PENDING", "INJECTED"]);
    expect(result).toMatchObject({ status: "INJECTED", attempt: { status: "INJECTED", revision: 1 } });
    expect(result.attempt).not.toHaveProperty("deliveryEvidenceRef");
    expect(result.attempt).not.toHaveProperty("deliveredAt");
    expect(result.hookOutput).toContain("additionalContext");
    expect(values.audits.listInjections("session-1").items[0]?.envelope.items[0]).toMatchObject({ id: "knowledge-1", version: 3 });
    const acknowledged = new InjectionDeliveryAcknowledger(auditPort).acknowledge({
      attemptId: result.attempt!.attemptId,
      expectedRevision: result.attempt!.revision,
      deliveryEvidenceRef: "hook-client:accepted-1",
      deliveredAt: fixedNow,
    });
    expect(acknowledged).toMatchObject({ revision: 2, deliveryEvidenceRef: "hook-client:accepted-1", deliveredAt: fixedNow });
    values.audits.close(); values.feedback.close();
  });

  it("keeps SHADOW as SHADOWED and never exposes hook context", async () => {
    const values = resources();
    const rollout = new InjectionRolloutController();
    rollout.activate(1, "SHADOW");
    const result = await runtime({ retrieval: retrieval(), rollout, ...values }).handle(input());
    expect(result.status, result.diagnostic).toBe("SHADOWED");
    expect(result).toMatchObject({ attempt: { status: "SHADOWED", reasonCode: "ROLLOUT_SHADOW" } });
    expect(result.hookOutput).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("INJECTED");
    values.audits.close(); values.feedback.close();
  });

  it("rejects trace/run identity reuse with a different exact Context Envelope", async () => {
    const values = resources();
    const rollout = new InjectionRolloutController();
    rollout.activate(1, "SHADOW");
    expect((await runtime({ retrieval: retrieval(), rollout, ...values }).handle(input())).status).toBe("SHADOWED");
    const changedRetrieval: ActiveKnowledgeRetrievalPort = {
      retrieve: async (request) => {
        const changed = reranked(asset({
          summary: "different untracked summary.", body: "different untracked payload", contentHash: "sha256:different",
        }));
        return {
          runId: "run-1", traceId: "trace-1", queryContext: query(request.prompt),
          retrieval: { items: [{
            asset: changed.asset, rank: 1, score: 1, scopeMatched: true, contributions: changed.contributions,
          }], diagnostics: [] },
          rerank: { items: [changed], diagnostics: [] }, candidates: [changed],
        };
      },
    };
    const conflict = await runtime({ retrieval: changedRetrieval, rollout, ...values }).handle(input());
    expect(conflict.status).toBe("ERROR");
    expect(conflict.diagnostic).toContain("identity conflicts");
    expect(conflict.hookOutput).toBeUndefined();
    expect(values.audits.listInjections("session-1").items).toHaveLength(1);
    values.audits.close(); values.feedback.close();
  });

  it("terminalizes an already-persisted PENDING attempt when composition fails", async () => {
    const values = resources();
    const rollout = new InjectionRolloutController();
    rollout.activate(1, "SHADOW");
    let gets = 0;
    const flaky: RuntimeAuditStorePort = {
      beginInjection: (record) => values.audits.beginInjection(record),
      completeInjection: (...args) => values.audits.completeInjection(...args),
      acknowledgeInjectionDelivery: (...args) => values.audits.acknowledgeInjectionDelivery(...args),
      getInjection: (id) => {
        gets += 1;
        if (gets === 2) throw new Error("transient projection failure");
        return values.audits.getInjection(id);
      },
      listInjections: (id, limit) => values.audits.listInjections(id, limit),
      recordMcpExpansion: (record) => values.audits.recordMcpExpansion(record),
      getMcpExpansion: (id) => values.audits.getMcpExpansion(id),
      listMcpExpansions: (id, limit) => values.audits.listMcpExpansions(id, limit),
      recordClosure: (record) => values.audits.recordClosure(record),
      getClosure: (id) => values.audits.getClosure(id),
      listClosures: (id, limit) => values.audits.listClosures(id, limit),
    };
    const result = await runtime({ retrieval: retrieval(), rollout, audits: flaky, feedback: values.feedback }).handle(input());
    expect(result).toMatchObject({ status: "ERROR", attempt: { status: "ERROR", reasonCode: "RUNTIME_COMPOSITION_ERROR" } });
    expect(values.audits.listInjections("session-1").items[0]).toMatchObject({ status: "ERROR", revision: 1 });
    values.audits.close(); values.feedback.close();
  });

  it("applies feedback suppression immediately and never lets a pin revive ineligible knowledge", async () => {
    const scopeKey = JSON.stringify({ level: "TASK", projectId: "project-a", taskId: "turn-1" });
    const suppressedValues = resources();
    suppressedValues.feedback.record({
      eventId: "feedback-suppress", assetId: "knowledge-1", scopeKey, action: "SUPPRESS",
      traceId: "trace-feedback", actor: "operator", occurredAt: fixedNow,
    });
    const suppressedRollout = new InjectionRolloutController();
    suppressedRollout.activate(1, "SHADOW");
    const suppressed = await runtime({ retrieval: retrieval(), rollout: suppressedRollout, ...suppressedValues }).handle(input());
    expect(suppressed).toMatchObject({ status: "NO_CONTEXT", attempt: { envelope: { items: [] } } });
    suppressedValues.audits.close(); suppressedValues.feedback.close();

    const pinnedValues = resources();
    pinnedValues.feedback.record({
      eventId: "feedback-pin", assetId: "knowledge-1", scopeKey, action: "PIN",
      traceId: "trace-feedback", actor: "operator", occurredAt: fixedNow,
    });
    const pinnedRollout = new InjectionRolloutController();
    pinnedRollout.activate(1, "SHADOW");
    const forbidden: KnowledgeEligibilityPort = {
      inspect: () => ({ exists: true, currentVersion: 3, current: true, scopeMatched: false, statusEligible: true, suppressed: false }),
    };
    const pinned = await runtime({ retrieval: retrieval(), rollout: pinnedRollout, ...pinnedValues }, forbidden).handle(input());
    expect(pinned).toMatchObject({ status: "NO_CONTEXT", attempt: { envelope: { items: [] } } });
    expect(JSON.stringify(pinned)).not.toContain("knowledge-1");
    pinnedValues.audits.close(); pinnedValues.feedback.close();
  });

  it("fails open on deadline, rollout revision change, and stale eligibility", async () => {
    const timeoutValues = resources();
    const timeoutRollout = new InjectionRolloutController();
    timeoutRollout.activate(1, "SHADOW");
    const timeoutRetrieval: ActiveKnowledgeRetrievalPort = {
      retrieve: async () => new Promise(() => undefined),
    };
    const timeout = await runtime({ retrieval: timeoutRetrieval, rollout: timeoutRollout, ...timeoutValues }, eligible, 10).handle(input());
    expect(timeout).toMatchObject({ status: "TIMEOUT", attempt: { status: "TIMEOUT", envelope: { complexity: { level: "L0_NONE" }, items: [] } } });
    expect(timeout.hookOutput).toBeUndefined();
    expect(timeoutValues.audits.listInjections("session-1").items).toHaveLength(1);
    timeoutValues.audits.close(); timeoutValues.feedback.close();

    const rollbackValues = resources();
    const rollback = new InjectionRolloutController();
    rollback.activate(1, "SHADOW");
    const changed = await runtime({
      retrieval: retrieval(() => rollback.rollback(2)), rollout: rollback, ...rollbackValues,
    }).handle(input());
    expect(changed).toMatchObject({ status: "ROLLED_BACK", attempt: { rolloutRevision: 1, status: "ROLLED_BACK" } });
    expect(changed.hookOutput).toBeUndefined();
    rollbackValues.audits.close(); rollbackValues.feedback.close();

    const staleValues = resources();
    const active = new InjectionRolloutController();
    active.activate(1, "ACTIVE", {
      datasetId: "golden-1", datasetVersion: 1,
      configFingerprint: `sha256:${"b".repeat(64)}`, defaultInjectionAllowed: true,
    });
    const stale: KnowledgeEligibilityPort = {
      inspect: () => ({ exists: true, currentVersion: 4, current: false, scopeMatched: true, statusEligible: true, suppressed: false }),
    };
    const excluded = await runtime({ retrieval: retrieval(), rollout: active, ...staleValues }, stale).handle(input());
    expect(excluded).toMatchObject({ status: "NO_CONTEXT", attempt: { envelope: { items: [] } } });
    expect(excluded.hookOutput).toBeUndefined();
    staleValues.audits.close(); staleValues.feedback.close();
  });

  it("rejects invalid Hook input without retrieval or persistence", async () => {
    const values = resources();
    const rollout = new InjectionRolloutController();
    rollout.activate(1, "SHADOW");
    const result = await runtime({ retrieval: retrieval(), rollout, ...values }).handle({ ...input(), prompt: "" });
    expect(result).toEqual({ status: "INVALID_INPUT" });
    expect(values.audits.listInjections("session-1").items).toEqual([]);
    expect(asset().version).toBe(3);
    values.audits.close(); values.feedback.close();
  });

  it("fails open for OFF, provider failure, invalid context and exact terminal replay", async () => {
    const offValues = resources();
    const off = new InjectionRolloutController();
    expect((await runtime({ retrieval: retrieval(), rollout: off, ...offValues }).handle(input()))).toEqual({ status: "DISABLED" });
    offValues.audits.close(); offValues.feedback.close();

    const providerValues = resources();
    const shadow = new InjectionRolloutController();
    shadow.activate(1, "SHADOW");
    const failedProvider: ActiveKnowledgeRetrievalPort = {
      retrieve: async () => { throw new Error("retrieval unavailable"); },
    };
    const failed = await runtime({ retrieval: failedProvider, rollout: shadow, ...providerValues }).handle(input());
    expect(failed).toMatchObject({ status: "ERROR", attempt: { status: "ERROR", reasonCode: "RETRIEVAL_PROVIDER_ERROR" }, diagnostic: expect.stringContaining("retrieval unavailable") });
    providerValues.audits.close(); providerValues.feedback.close();

    const invalidValues = resources();
    const invalidContext: ActiveKnowledgeRetrievalPort = {
      retrieve: async () => {
        const candidate = reranked();
        return {
          runId: "run-invalid", traceId: "trace-invalid", queryContext: query("a different prompt"),
          retrieval: { items: [{
            asset: candidate.asset, rank: 1, score: 1, scopeMatched: true, contributions: candidate.contributions,
          }], diagnostics: [] },
          rerank: { items: [candidate], diagnostics: [] }, candidates: [candidate],
        };
      },
    };
    const invalid = await runtime({ retrieval: invalidContext, rollout: shadow, ...invalidValues }).handle(input());
    expect(invalid).toMatchObject({ status: "ERROR", attempt: { status: "ERROR", reasonCode: "CONTEXT_VALIDATION_FAILED" } });
    invalidValues.audits.close(); invalidValues.feedback.close();

    const replayValues = resources();
    const first = await runtime({ retrieval: retrieval(), rollout: shadow, ...replayValues }).handle(input());
    const replayed = await runtime({ retrieval: retrieval(), rollout: shadow, ...replayValues }).handle(input());
    expect(replayed.attempt).toEqual(first.attempt);
    expect(replayValues.audits.listInjections("session-1").items).toHaveLength(1);
    replayValues.audits.close(); replayValues.feedback.close();
  });

  it("retains recoverable PENDING when terminal audit persistence is unavailable", async () => {
    const values = resources();
    const rollout = new InjectionRolloutController();
    rollout.activate(1, "SHADOW");
    const unavailable: RuntimeAuditStorePort = {
      beginInjection: (record) => values.audits.beginInjection(record),
      completeInjection: () => { throw new Error("audit unavailable"); },
      acknowledgeInjectionDelivery: (...args) => values.audits.acknowledgeInjectionDelivery(...args),
      getInjection: (id) => values.audits.getInjection(id),
      listInjections: (id, limit) => values.audits.listInjections(id, limit),
      recordMcpExpansion: (record) => values.audits.recordMcpExpansion(record),
      getMcpExpansion: (id) => values.audits.getMcpExpansion(id),
      listMcpExpansions: (id, limit) => values.audits.listMcpExpansions(id, limit),
      recordClosure: (record) => values.audits.recordClosure(record),
      getClosure: (id) => values.audits.getClosure(id),
      listClosures: (id, limit) => values.audits.listClosures(id, limit),
    };
    const result = await runtime({ retrieval: retrieval(), rollout, audits: unavailable, feedback: values.feedback }).handle(input());
    expect(result).toMatchObject({ status: "ERROR", attempt: { status: "PENDING" }, diagnostic: expect.stringContaining("audit unavailable") });
    expect(values.audits.listInjections("session-1").items[0]?.status).toBe("PENDING");
    values.audits.close(); values.feedback.close();
  });

  it("handles PROJECT/GLOBAL scope keys and applies eligible pin ordering with optional orchestration signals", async () => {
    const projectValues = resources();
    const projectScope = JSON.stringify({ level: "PROJECT", projectId: "project-a" });
    projectValues.feedback.record({
      eventId: "feedback-project-pin", assetId: "knowledge-2", scopeKey: projectScope,
      action: "PIN", traceId: "trace-feedback", actor: "operator", occurredAt: fixedNow,
    });
    const projectRetrieval: ActiveKnowledgeRetrievalPort = {
      retrieve: async (request) => {
        const first = reranked();
        const second = { ...reranked(asset({
          id: "knowledge-2", subjectKey: "symbol:Pinned", title: "Pinned knowledge",
          contentHash: "sha256:pinned", symbols: ["Pinned"],
        })), rank: 2, rerank: { applied: false, originalRank: 2, reasonCodes: ["DETERMINISTIC_ORDER"] } };
        const context = resolveQueryContext({
          prompt: request.prompt,
          project: { projectId: "project-a", repositoryRoot: "/workspace/project-a", branch: "main", portable: true },
          cwd: request.cwd,
        });
        return {
          runId: "run-project", traceId: "trace-project", queryContext: context,
          retrieval: { items: [
            { asset: first.asset, rank: 1, score: 1, scopeMatched: true, contributions: first.contributions },
            { asset: second.asset, rank: 2, score: 0.8, scopeMatched: true, contributions: second.contributions },
          ], diagnostics: [] },
          rerank: { items: [first, second], diagnostics: [] }, candidates: [first, second],
          requestedLevel: "L2_COMPACT", signals: { risk: "HIGH", ambiguous: true },
          taskContract: { contractId: "contract-project", objective: "stay scoped", gates: ["tests"], boundaries: ["no global"] },
        };
      },
    };
    const shadow = new InjectionRolloutController();
    shadow.activate(1, "SHADOW");
    const project = await runtime({ retrieval: projectRetrieval, rollout: shadow, ...projectValues }).handle(input());
    expect(project).toMatchObject({
      status: "SHADOWED",
      attempt: { envelope: { projectId: "project-a", taskContract: { contractId: "contract-project" } } },
    });
    expect(project.attempt?.envelope.items[0]?.id).toBe("knowledge-2");
    projectValues.audits.close(); projectValues.feedback.close();

    const globalValues = resources();
    const globalRetrieval: ActiveKnowledgeRetrievalPort = {
      retrieve: async (request) => {
        const global = reranked(asset({ scope: { level: "GLOBAL" } }));
        const base = resolveQueryContext({ prompt: request.prompt });
        const context = { ...base, retrievalBoundary: { ...base.retrievalBoundary, allowGlobalKnowledge: true } };
        return {
          runId: "run-global", traceId: "trace-global", queryContext: context,
          retrieval: { items: [{
            asset: global.asset, rank: 1, score: 1, scopeMatched: true, contributions: global.contributions,
          }], diagnostics: [] },
          rerank: { items: [global], diagnostics: [] }, candidates: [global],
        };
      },
    };
    const global = await runtime({ retrieval: globalRetrieval, rollout: shadow, ...globalValues }).handle(input());
    expect(global).toMatchObject({ status: "SHADOWED", attempt: { envelope: { items: [{ scope: { level: "GLOBAL" } }] } } });
    globalValues.audits.close(); globalValues.feedback.close();
  });

  it("explains every fail-closed eligibility dimension without leaking excluded assets", async () => {
    const values = resources();
    const scope = JSON.stringify({ level: "TASK", projectId: "project-a", taskId: "turn-1" });
    values.feedback.record({
      eventId: "feedback-matrix-suppress",
      assetId: "knowledge-feedback-suppressed",
      scopeKey: scope,
      action: "SUPPRESS",
      traceId: "trace-matrix",
      actor: "operator",
      occurredAt: fixedNow,
    });
    const ids = [
      "knowledge-missing",
      "knowledge-stale",
      "knowledge-wrong-scope",
      "knowledge-status-blocked",
      "knowledge-store-suppressed",
      "knowledge-feedback-suppressed",
    ];
    const candidates = ids.map((id, index) => ({
      ...reranked(asset({
        id,
        subjectKey: `symbol:${id}`,
        title: id,
        contentHash: `sha256:${id}`,
        symbols: [id],
      })),
      rank: index + 1,
      rerank: { applied: false, originalRank: index + 1, reasonCodes: ["DETERMINISTIC_ORDER"] },
    }));
    const matrixRetrieval: ActiveKnowledgeRetrievalPort = {
      retrieve: async (request) => ({
        runId: "run-matrix",
        traceId: "trace-matrix",
        queryContext: query(request.prompt),
        retrieval: {
          items: candidates.map((candidate) => ({
            asset: candidate.asset,
            rank: candidate.rank,
            score: 1,
            scopeMatched: true,
            contributions: candidate.contributions,
          })),
          diagnostics: [],
        },
        rerank: { items: candidates, diagnostics: [] },
        candidates,
      }),
    };
    const matrixEligibility: KnowledgeEligibilityPort = {
      inspect: ({ assetId }) => ({
        exists: assetId !== "knowledge-missing",
        currentVersion: 3,
        current: assetId !== "knowledge-stale",
        scopeMatched: assetId !== "knowledge-wrong-scope",
        statusEligible: assetId !== "knowledge-status-blocked",
        suppressed: assetId === "knowledge-store-suppressed",
      }),
    };
    const rollout = new InjectionRolloutController();
    rollout.activate(1, "SHADOW");
    const result = await runtime(
      { retrieval: matrixRetrieval, rollout, ...values },
      matrixEligibility,
    ).handle(input());
    expect(result).toMatchObject({ status: "NO_CONTEXT", attempt: { envelope: { items: [] } } });
    expect(JSON.stringify(result)).not.toContain("knowledge-missing");
    values.audits.close(); values.feedback.close();
  });
});
