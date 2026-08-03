import { afterEach, describe, expect, it, vi } from "vitest";

import { browserConsoleApi, ConsoleApiError, setCsrfToken } from "./client.js";

const timestamp = "2026-08-03T12:00:00.000Z";

function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ schemaVersion: 1, requestId: "request-1", observedAt: timestamp, ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: "STALE_REVISION" | "SIDECAR_UNAVAILABLE", retryable: boolean): Response {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    requestId: "request-1",
    observedAt: timestamp,
    ok: false,
    error: { code, message: code === "STALE_REVISION" ? "Preview changed" : "Unavailable", retryable },
  }), { status: code === "STALE_REVISION" ? 409 : 503, headers: { "content-type": "application/json" } });
}

const retrievalTrace = {
  schemaVersion: 1 as const,
  traceId: "trace-web-p3", runId: "run-web-p3",
  queryContext: {
    prompt: "ConfigService", promptFingerprint: "a".repeat(64), projectId: "project-a",
    paths: [], symbols: ["ConfigService"], errorCodes: [], configKeys: [],
    allowProjectKnowledge: true, allowGlobalKnowledge: true, reasonCodes: ["PROJECT_RESOLVED"],
  },
  policy: { policyId: "policy-current", revision: 1, fingerprint: "b".repeat(64), source: "CURRENT" as const },
  outcome: "NO_CONTEXT" as const,
  filters: [], results: [],
  envelope: {
    detailLevel: "L0_NONE" as const, maxTokens: 800, estimatedTokens: 0, truncated: false,
    selected: [], omitted: [], reasonCodes: ["RISK_LOW", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT", "BUDGET_WITHIN_LIMIT"],
  },
  injectionResult: "NO_CONTEXT" as const,
  durationMs: 1, createdAt: timestamp,
};

afterEach(() => vi.unstubAllGlobals());

describe("typed Console API client", () => {
  it("sends in-memory CSRF proof and validates overview responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => envelope({ schemaVersion: 1, observedAt: timestamp, rolloutMode: "SHADOW", sidecarVersion: "0.1.4", capabilities: [], recentSessions: [], jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 }, alertCount: 0 }));
    vi.stubGlobal("fetch", fetcher);
    setCsrfToken("csrf-token-1234567890");
    await expect(browserConsoleApi.overview()).resolves.toMatchObject({ rolloutMode: "SHADOW" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/overview", expect.objectContaining({ credentials: "same-origin", headers: { "x-zhiloop-csrf": "csrf-token-1234567890" } }));
  });

  it("binds event cursors to an encoded session query", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => envelope({ items: [] }));
    vi.stubGlobal("fetch", fetcher);
    await browserConsoleApi.events("session:1", "signed cursor");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/events?sessionId=session%3A1&cursor=signed+cursor");
  });

  it("rejects unsafe CSRF values and strict response violations", async () => {
    expect(() => setCsrfToken("short")).toThrow(/invalid CSRF/u);
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ rawPrompt: "must not pass" })));
    await expect(browserConsoleApi.overview()).rejects.toThrow();
  });

  it("uses the unified capture command endpoint and strict preview/commit schemas", async () => {
    const preview = { schemaVersion: 1, sessionId: "session-1", previewRevision: 7, transcriptIdentityHash: "a".repeat(64), projectedEvents: 3, ignoredRecords: 1, eventTypes: { USER_PROMPT: 3 }, cursor: { byteOffset: 42, lineNumber: 4 }, hasMore: false, expiresAt: "2099-08-03T12:00:00.000Z" };
    const commit = { schemaVersion: 1, sessionId: "session-1", previewRevision: 7, appendedEvents: 3, duplicateEvents: 0, cursor: { byteOffset: 42, lineNumber: 4 }, knowledgeCompileStage: { schemaVersion: 1, entityId: "session-1", stage: "KNOWLEDGE_COMPILE", status: "DISABLED", reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED", observedAt: timestamp, lastTransitionAt: timestamp, retryable: false, evidenceRefs: [] } };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
      return envelope(body.dryRun ? preview : commit);
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(browserConsoleApi.previewCapture("session-1")).resolves.toMatchObject({ previewRevision: 7 });
    await expect(browserConsoleApi.commitCapture({ sessionId: "session-1", previewRevision: 7, transcriptIdentityHash: "a".repeat(64), idempotencyKey: "capture:7:aaaaaaaaaaaaaaaa" })).resolves.toMatchObject({ appendedEvents: 3 });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/v1/capture-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId: "session-1", dryRun: true }),
      headers: expect.objectContaining({ "content-type": "application/json" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/v1/capture-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sessionId: "session-1", dryRun: false, previewRevision: 7, transcriptIdentityHash: "a".repeat(64), idempotencyKey: "capture:7:aaaaaaaaaaaaaaaa" }),
    }));
  });

  it("sends strict revision-bound cancel and retry commands without placing fields in the URL", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const action = String(input).endsWith("/cancel") ? "CANCEL" : "RETRY";
      const body = JSON.parse(String(init?.body)) as { expectedRevision: number };
      return envelope({
        schemaVersion: 1,
        action,
        disposition: "APPLIED",
        job: {
          schemaVersion: 1, jobId: "job-1", jobType: "AUTOMATIC_INGESTION_SCAN", revision: body.expectedRevision + 1,
          status: action === "CANCEL" ? "CANCELLED" : "QUEUED", attempt: 1, maxAttempts: 3, progress: 0,
          reasonCode: action === "CANCEL" ? "JOB_CANCELLED" : "JOB_QUEUED", observedAt: timestamp,
          lastTransitionAt: timestamp, retryable: action === "RETRY", evidenceRefs: [],
        },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(browserConsoleApi.cancelJob?.({ jobId: "job-1", expectedRevision: 3, idempotencyKey: "operator:cancel:web:one" }))
      .resolves.toMatchObject({ action: "CANCEL", job: { revision: 4 } });
    await expect(browserConsoleApi.retryJob?.({ jobId: "job-1", expectedRevision: 4, idempotencyKey: "operator:retry:web:one" }))
      .resolves.toMatchObject({ action: "RETRY", job: { revision: 5 } });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/v1/jobs/job-1/cancel", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 3, idempotencyKey: "operator:cancel:web:one" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/v1/jobs/job-1/retry", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 4, idempotencyKey: "operator:retry:web:one" }),
    }));
  });

  it("preserves stable API error codes for stale and unavailable UI states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorEnvelope("STALE_REVISION", false)));
    await expect(browserConsoleApi.previewCapture("session-1")).rejects.toMatchObject({ code: "STALE_REVISION", retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));
    const unavailable = await browserConsoleApi.previewCapture("session-1").catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(ConsoleApiError);
    expect(unavailable).toMatchObject({ code: "SIDECAR_UNAVAILABLE", retryable: true });
  });

  it("rejects a validly shaped capture response bound to another session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ schemaVersion: 1, sessionId: "session-other", previewRevision: 7, transcriptIdentityHash: "a".repeat(64), projectedEvents: 0, ignoredRecords: 0, eventTypes: {}, cursor: { byteOffset: 0, lineNumber: 0 }, hasMore: false, expiresAt: "2099-08-03T12:00:00.000Z" })));
    await expect(browserConsoleApi.previewCapture("session-1")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("uses typed configuration query, validate, activate and rollback endpoints with CSRF", async () => {
    const configuration = {
      schemaVersion: 1,
      runtime: {
        sessionScanIntervalMs: 60_000, followDebounceMs: 1_000, workerPollIntervalMs: 1_000, extractionDelayMs: 300_000,
        workerConcurrency: 2, scanBatchSize: 100, captureBatchSize: 100,
        captureRetry: { maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 },
        alerts: {
          enabled: true, notify: false, minimumSeverity: "WARNING",
          spoolDepth: { warning: 100, error: 1_000 }, spoolOldestAgeMs: { warning: 60_000, error: 600_000 },
          cursorLagEvents: { warning: 1_000, error: 10_000 }, failedJobs: { warning: 1, error: 10 }, hookSilenceMs: { warning: 3_600_000, error: 21_600_000 },
          quietHours: { enabled: false, startMinute: 1_320, endMinute: 480, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], utcOffsetMinutes: 480 },
        },
      },
      future: { injectionMaxTokens: 800, compilerBatchSize: 50, codexQueryTimeoutMs: 30_000, codexQueryConcurrency: 2 },
    };
    const state = { view: { schemaVersion: 1, revision: 2, hash: "a".repeat(64), effective: configuration, sources: { "runtime.sessionScanIntervalMs": "GLOBAL" } }, drafts: [], history: [] };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const path = String(input);
      if (path.includes("/draft")) return envelope({ ok: false, diagnostics: [{ code: "CONSUMER_DISABLED", retryable: false }] });
      if (path.includes("/activate")) return envelope({ ok: true, revision: 3, hash: "b".repeat(64), status: "EFFECTIVE" });
      if (path.includes("/rollback")) return envelope({ ok: true, revision: 4, hash: "c".repeat(64), status: "ROLLED_BACK" });
      return envelope(state);
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(browserConsoleApi.configuration?.("project-1")).resolves.toMatchObject({ view: { revision: 2 } });
    await expect(browserConsoleApi.validateConfiguration?.({ baseRevision: 2, scope: "PROJECT", projectId: "project-1", draft: configuration })).resolves.toMatchObject({ ok: false });
    await expect(browserConsoleApi.activateConfiguration?.({ expectedRevision: 2, draftRevision: 3, idempotencyKey: "config-activate-2-3" })).resolves.toMatchObject({ status: "EFFECTIVE" });
    await expect(browserConsoleApi.rollbackConfiguration?.({ expectedRevision: 3, targetRevision: 2, idempotencyKey: "config-rollback-3-2" })).resolves.toMatchObject({ status: "ROLLED_BACK" });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/configuration?projectId=project-1",
      "/api/v1/configuration/draft",
      "/api/v1/configuration/activate",
      "/api/v1/configuration/rollback",
    ]);
    expect(fetcher.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-zhiloop-csrf": "csrf-token-1234567890" }) }));
  });

  it("strictly parses bounded invalidation polling and rejects unsafe revisions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({
      currentRevision: 2, oldestRetainedRevision: 1, requestedAfterRevision: 0, nextRevision: 2,
      resyncRequired: false, hasMore: false, retryAfterMs: 1_000,
      events: [{ schemaVersion: 1, eventId: "event-2", type: "job.updated", entityId: "job-1", revision: 2, occurredAt: timestamp }],
    })));
    await expect(browserConsoleApi.pollInvalidations?.(0)).resolves.toMatchObject({ nextRevision: 2 });
    await expect(browserConsoleApi.pollInvalidations?.(-1)).rejects.toThrow(/afterRevision/u);
  });

  it("uses strict P3 search transport and maps the trace without exposing injection authority", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => envelope({ schemaVersion: 1, kind: "SEARCH", trace: retrievalTrace }));
    vi.stubGlobal("fetch", fetcher);
    const result = await browserConsoleApi.searchKnowledge?.({
      requestId: "request-web-p3",
      query: "ConfigService",
      projectId: "project-a",
      maxResults: 10,
      maxContextTokens: 800,
    });
    expect(result).toMatchObject({ traceId: "trace-web-p3", injectionResult: "NO_CONTEXT", results: [] });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/retrieval/search", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        requestId: "request-web-p3", query: "ConfigService", projectId: "project-a",
        maxResults: 10, maxContextTokens: 800, timeoutMs: 10_000,
      }),
    }));

    vi.stubGlobal("fetch", vi.fn(async () => envelope({ schemaVersion: 1, kind: "SEARCH", trace: retrievalTrace, unexpected: true })));
    await expect(browserConsoleApi.searchKnowledge?.({
      requestId: "request-web-p3-invalid", query: "ConfigService", maxResults: 10, maxContextTokens: 800,
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("downgrades an INJECTED audit to SHADOW when delivery evidence is absent", async () => {
    const capabilities = {
      items: ["INJECTION_AUDIT", "MCP_AUDIT", "CLOSURE_AUDIT", "FEEDBACK", "ROLLOUT", "HIGH_RISK_GOVERNANCE"].map((capability) => ({
        capability, state: "READY", reasonCode: "COMPONENT_READY", evidenceRefs: [],
      })),
    };
    const attempt = {
      schemaVersion: 1, attemptId: "attempt-1", sessionId: "session-1", turnId: "turn-1", traceId: "trace-1", runId: "run-1",
      rolloutRevision: 1, status: "INJECTED", revision: 1, reasonCode: "ACTIVE_CANARY_INCLUDED", createdAt: timestamp, completedAt: timestamp,
      envelope: {
        schemaVersion: 1, runId: "run-1",
        complexity: { level: "L2_COMPACT", breadth: 1, depth: "COMPACT", authority: "VERIFIED_FACT", evidence: "POINTER", reasonCodes: ["RISK_LOW"] },
        budget: { maxTokens: 800, estimatedTokens: 100, truncated: false, disclosedItems: 1, omittedItems: 0 },
        items: [{
          id: "knowledge-1", version: 1, subjectKey: "subject-1", kind: "FACT", status: "VERIFIED", scope: { level: "GLOBAL" },
          authority: "VERIFIED_FACT", detailLevel: "L2_COMPACT", title: "Fact", summary: "Verified fact", retrievalRank: 1,
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/p4/capabilities")) return envelope(capabilities);
      if (path.includes("mcp-expansions")) return envelope({ items: [] });
      return envelope({ items: [attempt] });
    }));
    await expect(browserConsoleApi.sessionInjections?.("session-1")).resolves.toMatchObject({
      capabilityStatus: "READY",
      attempts: [{ status: "ERROR", reasonCode: "DELIVERY_EVIDENCE_NOT_CONFIRMED", envelope: { mode: "SHADOW" } }],
    });
  });

  it("fails closed when optional P4 capability facts are unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/p4/capabilities")) {
        return new Response(JSON.stringify({
          schemaVersion: 1, requestId: "request-1", observedAt: timestamp, ok: false,
          error: { code: "CAPABILITY_UNAVAILABLE", message: "not composed", retryable: false },
        }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return envelope({ items: [] });
    }));
    await expect(browserConsoleApi.sessionInjections?.("session-1")).resolves.toMatchObject({
      capabilityStatus: "NOT_CONFIGURED", capabilityReasonCode: "P4_CAPABILITY_FACTS_UNAVAILABLE", attempts: [],
    });
  });

  it("submits only revision-bound preview proof for high-risk commit", async () => {
    const previewId = `sha256:${"a".repeat(64)}`;
    let submittedBody: unknown;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      submittedBody = JSON.parse(String(init?.body)) as unknown;
      return envelope({
        result: {
          operationId: `sha256:${"b".repeat(64)}`, previewId, kind: "RULE_CHANGE", actor: "gateway-principal", policyRevision: 7,
          blastRadius: { affectedAssets: 1, affectedProjects: 0, affectedRules: 1, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["RULE_IMPACT"] },
          committedAt: timestamp,
        },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    await browserConsoleApi.commitHighRisk?.({ previewId, expectedPolicyRevision: 7, idempotencyKey: `p4.commit:${previewId}`, confirmationPhrase: "CONFIRM RULE CHANGE" });
    const body = submittedBody as Record<string, unknown>;
    expect(body).toEqual({ previewId, expectedPolicyRevision: 7, idempotencyKey: `p4.commit:${previewId}`, confirmationPhrase: "CONFIRM RULE CHANGE" });
    expect(body).not.toHaveProperty("actor");
    expect(body).not.toHaveProperty("confirmationFingerprint");
  });

  it("maps every successful P4 read and command from strict wire facts", async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const capabilities = {
      items: ["INJECTION_AUDIT", "MCP_AUDIT", "CLOSURE_AUDIT", "FEEDBACK", "ROLLOUT", "HIGH_RISK_GOVERNANCE"].map((capability) => ({
        capability, state: "READY", reasonCode: "COMPONENT_READY", evidenceRefs: [],
      })),
    };
    const injection = {
      schemaVersion: 1, attemptId: "attempt-actual", sessionId: "session-1", turnId: "turn-1", traceId: "trace-1", runId: "run-1",
      rolloutRevision: 2, status: "INJECTED", revision: 2, reasonCode: "ACTIVE_CANARY_INCLUDED", createdAt: timestamp,
      completedAt: timestamp, deliveryEvidenceRef: "hook-client:receipt-1", deliveredAt: timestamp,
      envelope: {
        schemaVersion: 1, runId: "run-1", projectId: "project-1", taskId: "turn-1",
        complexity: { level: "L2_COMPACT", breadth: 1, depth: "COMPACT", authority: "VERIFIED_FACT", evidence: "SUMMARY", reasonCodes: ["ACTIVE_CANARY_INCLUDED"] },
        budget: { maxTokens: 800, estimatedTokens: 100, truncated: false, disclosedItems: 1, omittedItems: 0 },
        items: [{ id: "knowledge-1", version: 2, subjectKey: "p4.actual", kind: "FACT", status: "VERIFIED", scope: { level: "PROJECT", projectId: "project-1" }, authority: "VERIFIED_FACT", detailLevel: "L2_COMPACT", title: "Actual", summary: "Delivered", retrievalRank: 1 }],
      },
    };
    const closure = {
      schemaVersion: 1, closureRunId: "closure-1", sessionId: "session-1", turnId: "turn-1",
      taskContract: { contractId: "contract-1", objective: "finish P4", gates: ["tests"], boundaries: ["preserve credentials"] },
      gates: [{ gateId: "tests", status: "SATISFIED", reasonCodes: ["TESTS_PASSED"], evidenceRefs: ["test-run-1"] }],
      decision: "PASS", continuationCount: 0, recursiveStopRejected: false,
      interaction: { required: false }, createdAt: timestamp,
    };
    const action = { enabled: true, capabilityStatus: "READY", reasonCode: "FEEDBACK_TARGET_ELIGIBLE", expectedRevision: 2, idempotencyKey: "feedback:knowledge-1:2" };
    const feedbackTargets = { items: [{
      knowledgeId: "knowledge-1", version: 2, title: "Actual", eligible: true, eligibilityReasonCodes: ["CURRENT_SCOPE_ELIGIBLE"],
      mcpUsed: true, scopeKey: "PROJECT:project-1", traceId: "trace-1", expansionId: "expansion-1",
      actions: { RELEVANT: action, IRRELEVANT: action, PIN: action, SUPPRESS: action, MCP_USED: action },
    }] };
    const effective = { policyRevision: 1, mode: "SHADOW", configFingerprint: fingerprint, versionFingerprint: fingerprint };
    const rollout = { state: {
      schemaVersion: 1, stateRevision: 1, effective, lastKnownGood: effective, evidence: [],
      audit: [{ eventId: fingerprint, kind: "BOOTSTRAP", stateRevision: 1, effectivePolicyRevision: 1, reasonCodes: ["BOOTSTRAP_SHADOW"], occurredAt: timestamp }],
    }, activeCanary: undefined, downgradeHistory: [], rollbackTarget: effective };
    const blastRadius = { affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["PROJECT_ONLY"] };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/p4/capabilities")) return envelope(capabilities);
      if (url.includes("mcp-expansions")) return envelope({ items: [{ schemaVersion: 1, expansionId: "expansion-1", attemptId: "attempt-actual", traceId: "trace-1", tool: "ckl.get", knowledgeId: "knowledge-1", knowledgeVersion: 2, fromDetailLevel: "L1_POINTER", toDetailLevel: "L2_COMPACT", latencyMs: 2, used: true, occurredAt: timestamp }] });
      if (url.endsWith("/injections?limit=100")) return envelope({ items: [injection] });
      if (url.endsWith("/closures?limit=100")) return envelope({ items: [closure] });
      if (url.includes("/closures/closure-1")) return envelope(closure);
      if (url.endsWith("/feedback-targets")) return envelope(feedbackTargets);
      if (url.endsWith("/p4/feedback")) return envelope({ outcome: "EXISTING", eligibleAfterWrite: true });
      if (url.endsWith("/p4/rollout")) return envelope(rollout);
      if (url.endsWith("/p4/high-risk/governance")) return envelope({ policyRevision: 1, activeStageEnabled: false, actor: "local-console", actions: Object.fromEntries(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"].map((kind) => [kind, { enabled: false, capabilityStatus: "NOT_CONFIGURED", reasonCode: "HIGH_RISK_NOT_CONFIGURED" }])) });
      if (url.endsWith("/p4/high-risk/preview")) return envelope({ preview: { previewId: fingerprint, policyRevision: 1, commandFingerprint: fingerprint, command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-1"], projectIds: ["project-1"], reason: "reviewed", payloadFingerprint: fingerprint }, blastRadius, createdAt: timestamp, expiresAt: "2099-08-03T12:00:00.000Z" }, blastRadius, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" });
      return envelope({ result: { operationId: fingerprint, previewId: fingerprint, kind: "GLOBAL_PROMOTION", actor: "local-console", policyRevision: 1, blastRadius, committedAt: timestamp } });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(browserConsoleApi.sessionInjections?.("session-1")).resolves.toMatchObject({ attempts: [{ envelope: { mode: "ACTUAL" }, mcpExpansions: [{ used: true }] }] });
    await expect(browserConsoleApi.closureRuns?.()).resolves.toMatchObject({ capabilityStatus: "NOT_CONFIGURED" });
    await expect(browserConsoleApi.closureRuns?.("session-1")).resolves.toMatchObject({ items: [{ decision: "PASS" }] });
    await expect(browserConsoleApi.closureRun?.("session-1", "closure-1")).resolves.toMatchObject({ closureRunId: "closure-1" });
    await expect(browserConsoleApi.feedbackTargets?.("session-1")).resolves.toHaveLength(1);
    await expect(browserConsoleApi.recordFeedback?.({ kind: "PIN", knowledgeId: "knowledge-1", version: 2, expectedRevision: 2, idempotencyKey: "feedback:knowledge-1:2", scopeKey: "PROJECT:project-1", traceId: "trace-1" })).resolves.toMatchObject({ result: "EXISTING", reasonCode: "FEEDBACK_EXISTING" });
    await expect(browserConsoleApi.rollout?.()).resolves.toMatchObject({ stateRevision: 1, lastTransition: { kind: "BOOTSTRAP" } });
    await expect(browserConsoleApi.highRiskGovernance?.()).resolves.toMatchObject({ activeStageEnabled: false });
    await expect(browserConsoleApi.previewHighRisk?.({ kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-1"], projectIds: ["project-1"], reason: "reviewed", payloadFingerprint: fingerprint, expectedPolicyRevision: 1, idempotencyKey: "preview-1" })).resolves.toMatchObject({ previewId: fingerprint });
    await expect(browserConsoleApi.commitHighRisk?.({ previewId: fingerprint, expectedPolicyRevision: 1, idempotencyKey: "commit-1", confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" })).resolves.toMatchObject({ operationId: fingerprint });
  });

  it("fails closed for automatic L4, degraded MCP, pagination and optional closure evidence", async () => {
    const fingerprint = `sha256:${"b".repeat(64)}`;
    const capabilities = { items: ["INJECTION_AUDIT", "MCP_AUDIT", "CLOSURE_AUDIT", "FEEDBACK", "ROLLOUT", "HIGH_RISK_GOVERNANCE"].map((capability) => ({
      capability, state: capability === "MCP_AUDIT" ? "DISABLED" : "READY",
      reasonCode: capability === "MCP_AUDIT" ? "MCP_DISABLED" : "COMPONENT_READY", evidenceRefs: [],
    })) };
    const injection = {
      schemaVersion: 1, attemptId: "attempt-l4", sessionId: "session-l4", turnId: "turn-l4", traceId: "trace-l4", runId: "run-l4",
      rolloutRevision: 3, status: "SHADOWED", revision: 1, reasonCode: "SHADOW_MODE", createdAt: timestamp, completedAt: timestamp,
      envelope: {
        schemaVersion: 1, runId: "run-l4",
        complexity: { level: "L4_EPISODE", breadth: 1, depth: "EPISODE", authority: "VERIFIED_FACT", evidence: "EPISODE", reasonCodes: ["MODEL_REQUESTED_L4"] },
        budget: { maxTokens: 800, estimatedTokens: 700, truncated: true, disclosedItems: 1, omittedItems: 2 },
        items: [{ id: "knowledge-l4", version: 1, subjectKey: "l4", kind: "FACT", status: "VERIFIED", scope: { level: "GLOBAL" }, authority: "VERIFIED_FACT", detailLevel: "L4_EPISODE", title: "Hidden episode", summary: "Must not be auto injected", retrievalRank: 1 }],
      },
    };
    const closure = {
      schemaVersion: 1, closureRunId: "closure-retry", sessionId: "session-l4", turnId: "turn-l4",
      taskContract: { contractId: "contract-retry", objective: "finish", gates: ["gate-unknown"], boundaries: [] },
      gates: [{ gateId: "gate-unknown", status: "UNKNOWN", reasonCodes: [], evidenceRefs: [] }],
      decision: "ASK_USER", correctionDelta: "provide evidence", continuationCount: 1, recursiveStopRejected: true,
      interaction: { required: true, question: "Continue?", safeDefault: "stop" }, createdAt: timestamp,
    };
    const effective = { policyRevision: 2, mode: "SHADOW", configFingerprint: fingerprint, versionFingerprint: fingerprint };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/p4/capabilities")) return envelope(capabilities);
      if (url.endsWith("/injections?limit=100")) return envelope({ items: [injection], nextCursor: "cursor-injection-123456" });
      if (url.endsWith("/closures?limit=100")) return envelope({ items: [closure], nextCursor: "cursor-closure-12345678" });
      if (url.endsWith("/p4/feedback")) return envelope({ outcome: "RECORDED", eligibleAfterWrite: false });
      if (url.endsWith("/p4/rollout")) return envelope({ state: { schemaVersion: 1, stateRevision: 2, effective, lastKnownGood: effective, evidence: [{ evidenceId: fingerprint, datasetId: "golden", datasetVersion: 1, datasetFingerprint: fingerprint, configFingerprint: fingerprint, versionFingerprint: fingerprint, traceIds: ["trace-l4"], observedFrom: timestamp, observedTo: timestamp, eligible: false, checks: ["REAL_SHADOW_TRACES", "DATASET_BOUND", "CONFIG_BOUND", "VERSION_BOUND", "GOLDEN_GATE", "TRACEABILITY", "SCOPE_ISOLATION", "FORBIDDEN_EXCLUSION", "NO_AUTOMATIC_L4"].map((code) => ({ code, passed: code !== "NO_AUTOMATIC_L4", detail: "bounded check" })), createdAt: timestamp }], audit: [{ eventId: fingerprint, kind: "DOWNGRADED", stateRevision: 2, effectivePolicyRevision: 2, reasonCodes: ["NO_AUTOMATIC_L4_FAILED"], occurredAt: timestamp }] }, downgradeHistory: [], rollbackTarget: effective });
      return envelope({ items: [] });
    }));
    await expect(browserConsoleApi.sessionInjections?.("session-l4")).resolves.toMatchObject({
      truncated: true, capabilityStatus: "DEGRADED", capabilityReasonCode: "MCP_DISABLED",
      attempts: [{ status: "ERROR", reasonCode: "AUTOMATIC_L4_FORBIDDEN", envelope: { mode: "SHADOW", detailLevel: "L3_EVIDENCED", items: [], omittedCount: 3, reasonCodes: ["MODEL_REQUESTED_L4", "AUTOMATIC_L4_FORBIDDEN"] }, mcpExpansions: [] }],
    });
    await expect(browserConsoleApi.closureRuns?.("session-l4")).resolves.toMatchObject({ truncated: true, items: [{ correctionDelta: "provide evidence", recursiveStopRejected: true, gates: [{ reasonCode: "GATE_REASON_NOT_REPORTED" }], interaction: { required: true, question: "Continue?", safeDefault: "stop", confirmationStatus: "PENDING" } }] });
    await expect(browserConsoleApi.recordFeedback?.({ kind: "MCP_USED", knowledgeId: "knowledge-l4", version: 1, expectedRevision: 1, idempotencyKey: "feedback-l4", scopeKey: "GLOBAL", traceId: "trace-l4" })).resolves.toMatchObject({ result: "RECORDED", eligibleAfterWrite: false, reasonCode: "FEEDBACK_RECORDED" });
    await expect(browserConsoleApi.rollout?.()).resolves.toMatchObject({ stateRevision: 2, eligibility: [{ traceCount: 1, eligible: false }], lastTransition: { kind: "DOWNGRADED" } });
  });

  it("rethrows non-capability P4 failures instead of misreporting NOT_CONFIGURED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, requestId: "p4-failure", observedAt: timestamp, ok: false, error: { code: "INTERNAL_ERROR", message: "failed", retryable: false } }), { status: 500, headers: { "content-type": "application/json" } })));
    await expect(browserConsoleApi.closureRuns?.("session-1")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("parses named SSE invalidations and closes the native source on abort", () => {
    class FakeEventSource {
      static instance: FakeEventSource | undefined;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readonly listeners = new Map<string, EventListener>();
      readonly close = vi.fn();
      constructor(readonly url: string, readonly options: EventSourceInit) { FakeEventSource.instance = this; }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") this.listeners.set(type, listener);
      }
      emit(type: string, value: unknown): void { this.listeners.get(type)?.({ data: JSON.stringify(value) } as unknown as Event); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const controller = new AbortController();
    const onOpen = vi.fn();
    const onEvent = vi.fn();
    const onError = vi.fn();
    browserConsoleApi.openInvalidations?.({ onOpen, onEvent, onError }, controller.signal);
    FakeEventSource.instance?.onopen?.();
    FakeEventSource.instance?.emit("job.updated", { schemaVersion: 1, eventId: "event-1", type: "job.updated", entityId: "job-1", revision: 1, occurredAt: timestamp });
    expect(FakeEventSource.instance?.url).toBe("/api/v1/invalidations");
    expect(FakeEventSource.instance?.options.withCredentials).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, type: "job.updated" }));
    controller.abort();
    expect(FakeEventSource.instance?.close).toHaveBeenCalledOnce();
  });

  it("fails closed for aborted transport and malformed control envelopes", async () => {
    const controller = new AbortController();
    controller.abort("cancelled by test");
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw abort; }));
    await expect(browserConsoleApi.overview(controller.signal)).rejects.toBe(abort);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 502 })));
    await expect(browserConsoleApi.overview()).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false,
      message: "控制服务返回了无效响应",
    });
  });

  it("covers optional query and command bindings without leaking fields into paths", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(String(input));
      if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)) as unknown);
      return envelope({});
    }));
    await expect(browserConsoleApi.events("session-only")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(browserConsoleApi.configuration?.()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(browserConsoleApi.validateConfiguration?.({
      baseRevision: 1,
      scope: "GLOBAL",
      draft: {},
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(browserConsoleApi.knowledgeList?.({})).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(browserConsoleApi.knowledgeList?.({ status: "VERIFIED", scope: "PROJECT", projectId: "project/a" }))
      .rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(browserConsoleApi.searchKnowledge?.({
      requestId: "request-all-context",
      query: "trace all context",
      projectId: "project-a",
      taskId: "task-a",
      repositoryRoot: "/workspace/project-a",
      cwd: "/workspace/project-a/src",
      hints: { symbols: ["ConfigService"] },
      maxResults: 5,
      maxContextTokens: 400,
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(paths).toEqual(expect.arrayContaining([
      "/api/v1/events?sessionId=session-only",
      "/api/v1/configuration",
      "/api/v1/knowledge",
      "/api/v1/knowledge?status=VERIFIED&scope=PROJECT&projectId=project%2Fa",
    ]));
    expect(bodies).toContainEqual(expect.objectContaining({
      requestId: "request-all-context",
      taskId: "task-a",
      repositoryRoot: "/workspace/project-a",
      cwd: "/workspace/project-a/src",
      hints: { symbols: ["ConfigService"] },
    }));
    expect(bodies).toContainEqual({ baseRevision: 1, scope: "GLOBAL", draft: {} });
  });

  it("handles unavailable, invalid, closed, and already-aborted SSE streams", async () => {
    vi.stubGlobal("EventSource", undefined);
    const unavailable = vi.fn();
    const fallback = browserConsoleApi.openInvalidations?.({ onOpen: vi.fn(), onEvent: vi.fn(), onError: unavailable });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ message: "EventSource is unavailable" }));
    expect(() => fallback?.close()).not.toThrow();

    class EdgeEventSource {
      static instance: EdgeEventSource | undefined;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readonly listeners = new Map<string, EventListener>();
      readonly close = vi.fn();
      constructor() { EdgeEventSource.instance = this; }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") this.listeners.set(type, listener);
      }
    }
    vi.stubGlobal("EventSource", EdgeEventSource);
    const controller = new AbortController();
    controller.abort();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const subscription = browserConsoleApi.openInvalidations?.({ onOpen, onEvent: vi.fn(), onError }, controller.signal);
    expect(EdgeEventSource.instance?.close).toHaveBeenCalledOnce();
    EdgeEventSource.instance?.onopen?.();
    EdgeEventSource.instance?.onerror?.();
    EdgeEventSource.instance?.listeners.get("session.updated")?.({ data: "not-json" } as unknown as Event);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    subscription?.close();
    expect(EdgeEventSource.instance?.close).toHaveBeenCalledOnce();

    const liveError = vi.fn();
    browserConsoleApi.openInvalidations?.({ onOpen: vi.fn(), onEvent: vi.fn(), onError: liveError });
    EdgeEventSource.instance?.onerror?.();
    EdgeEventSource.instance?.listeners.get("session.updated")?.({ data: "not-json" } as unknown as Event);
    expect(liveError).toHaveBeenCalledTimes(2);
  });
});
