import { mkdtemp, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONTROL_API_SCHEMA_VERSION, type ControlRequest } from "@zhiloop/control-api";

import { ControlClientError, UnixSocketControlClient } from "./control-client.js";

const NOW = "2026-08-03T12:00:00.000Z";
const configuration = {
  schemaVersion: 2 as const,
  runtime: {
    sessionScanIntervalMs: 60_000,
    followDebounceMs: 1_000,
    workerPollIntervalMs: 1_000,
    extractionDelayMs: 300_000,
    workerConcurrency: 2,
    scanBatchSize: 100,
    captureBatchSize: 100,
    captureRetry: { maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 },
    alerts: {
      enabled: true,
      notify: false,
      minimumSeverity: "WARNING" as const,
      spoolDepth: { warning: 100, error: 1_000 },
      spoolOldestAgeMs: { warning: 60_000, error: 600_000 },
      cursorLagEvents: { warning: 1_000, error: 10_000 },
      failedJobs: { warning: 1, error: 10 },
      hookSilenceMs: { warning: 3_600_000, error: 21_600_000 },
      quietHours: { enabled: false, startMinute: 1_320, endMinute: 480, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], utcOffsetMinutes: 480 },
    },
  },
  future: { injectionMaxTokens: 800, compilerBatchSize: 50, codexQueryTimeoutMs: 30_000, codexQueryConcurrency: 2 },
  compilation: {
    enabled: true, mode: "PREVIEW_ONLY" as const, minNewTurns: 3, minNewEvents: 2, idleMs: 120_000, maximumWaitMs: 1_800_000,
    onSessionEnd: true, scanIntervalMs: 1_000, maxSessionsPerRun: 100, maxDispatchesPerRun: 20,
    publication: { enabled: false, allowedKindsCsv: "", allowedProjectIdsCsv: "", requireFreshCodeEvidence: true as const, goldenDatasetId: "", goldenDatasetVersion: 0, goldenConfigFingerprint: "" },
  },
  evolution: { maxMatchCandidates: 5, semanticJudgeEnabled: true, failClosed: true as const },
  codeIntelligence: { provider: "codegraph" as const, initializeAutomatically: false as const, queryTimeoutMs: 250, circuitBreakerFailures: 3, circuitBreakerResetMs: 30_000 },
  freshness: { enabled: true, changeDebounceMs: 1_000, fallbackScanIntervalMs: 3_600_000, preInjectionGate: true as const, gateTimeoutMs: 200, maxAffectedPerJob: 500 },
  prewarm: { enabled: true, onSessionStart: true, ttlMs: 1_800_000, maxItems: 8, maxTokens: 800 },
  evolutionAlerts: { enabled: false, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false },
};

describe("UnixSocketControlClient", () => {
  const servers: Server[] = [];
  const connections = new Set<Socket>();
  const sockets: string[] = [];

  afterEach(async () => {
    for (const connection of connections) connection.destroy();
    connections.clear();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(sockets.splice(0).map(async (socket) => {
      try { await unlink(socket); } catch { /* already removed */ }
    }));
  });

  async function serve(handler: (request: ControlRequest) => unknown): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhiloop-control-socket-"));
    const socket = path.join(directory, "control.sock");
    sockets.push(socket);
    const server = createServer((client) => {
      connections.add(client);
      client.once("close", () => connections.delete(client));
      const chunks: Buffer[] = [];
      client.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const combined = Buffer.concat(chunks);
        const newline = combined.indexOf(0x0a);
        if (newline < 0) return;
        const parsed = JSON.parse(combined.subarray(0, newline).toString("utf8")) as ControlRequest;
        client.end(`${JSON.stringify(handler(parsed))}\n`);
      });
    });
    servers.push(server);
    server.listen(socket);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return socket;
  }

  it("sends a versioned bounded request and validates the typed result", async () => {
    const socketPath = await serve((request) => ({
      ok: true,
      result: {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt: NOW,
        ok: true,
        result: {
          schemaVersion: CONTROL_API_SCHEMA_VERSION,
          observedAt: NOW,
          rolloutMode: "SHADOW",
          sidecarVersion: "0.1.4",
          capabilities: [],
          recentSessions: [],
          jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 },
          alertCount: 0,
        },
      },
    }));
    const client = new UnixSocketControlClient({ socketPath });
    const result = await client.getOverview({ signal: new AbortController().signal });
    expect(result.rolloutMode).toBe("SHADOW");
  });

  it("keeps the Sidecar capability array contract separate from the HTTP page projection", async () => {
    const socketPath = await serve((request) => ({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: request.requestId,
      observedAt: NOW,
      ok: true,
      result: ["INJECTION_AUDIT", "MCP_AUDIT", "CLOSURE_AUDIT", "FEEDBACK", "ROLLOUT", "HIGH_RISK_GOVERNANCE"].map((capability) => ({
        capability, state: "NOT_CONFIGURED", reasonCode: "P4_COMPONENT_NOT_COMPOSED", evidenceRefs: [],
      })),
    }));
    const client = new UnixSocketControlClient({ socketPath });
    await expect(client.listP4Capabilities({ signal: new AbortController().signal })).resolves.toHaveLength(6);
  });

  it("maps every P4 query and command to a strict Sidecar envelope", async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const effective = { policyRevision: 1, mode: "SHADOW", configFingerprint: fingerprint, versionFingerprint: fingerprint };
    const injection = {
      schemaVersion: 1, attemptId: "attempt-1", sessionId: "session-1", turnId: "turn-1", traceId: "trace-1", runId: "run-1",
      rolloutRevision: 1, status: "SHADOWED", revision: 1, reasonCode: "SHADOW_MODE", createdAt: NOW, completedAt: NOW,
      envelope: { schemaVersion: 1, runId: "run-1", complexity: { level: "L0_NONE", breadth: 0, depth: "NONE", authority: "NONE", evidence: "NONE", reasonCodes: ["SHADOW_MODE"] }, budget: { maxTokens: 100, estimatedTokens: 0, truncated: false, disclosedItems: 0, omittedItems: 0 }, items: [] },
      tokenBudget: { maxTokens: 100, estimatedTokens: 0, truncated: false, disclosedItems: 0, omittedItems: 0 }, omittedReasonCodes: [],
    };
    const closure = { schemaVersion: 1, closureRunId: "closure-1", sessionId: "session-1", turnId: "turn-1", taskContract: { contractId: "contract-1", objective: "finish", gates: [], boundaries: [] }, gates: [], decision: "PASS", continuationCount: 0, recursiveStopRejected: false, createdAt: NOW };
    const blastRadius = { affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["PROJECT_ONLY"] };
    const socketPath = await serve((request) => {
      const type = String(request.type);
      let result: unknown;
      if (type === "p4.injections.list") result = { items: [injection] };
      else if (type === "p4.injections.get") result = injection;
      else if (type === "p4.mcp-expansions.list") result = { items: [] };
      else if (type === "p4.closures.list") result = { items: [closure] };
      else if (type === "p4.closures.get") result = closure;
      else if (type === "p4.rollout.get") result = { state: { schemaVersion: 1, stateRevision: 1, effective, lastKnownGood: effective, evidence: [], audit: [{ eventId: fingerprint, kind: "BOOTSTRAP", stateRevision: 1, effectivePolicyRevision: 1, reasonCodes: ["BOOTSTRAP_SHADOW"], occurredAt: NOW }] }, downgradeHistory: [], rollbackTarget: effective };
      else if (type === "p4.feedback-targets.list") result = { items: [] };
      else if (type === "p4.high-risk.governance") result = { policyRevision: 1, activeStageEnabled: false, actor: "local-console", actions: Object.fromEntries(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"].map((kind) => [kind, { enabled: false, capabilityStatus: "NOT_CONFIGURED", reasonCode: "HIGH_RISK_NOT_CONFIGURED" }])) };
      else if (type === "p4.context.refresh") result = { sessionId: "session-1", removedEntries: 2, refreshedAt: NOW, reasonCode: "SESSION_CONTEXT_REFRESHED" };
      else if (type === "p4.feedback.record") result = { outcome: "RECORDED", eligibleAfterWrite: true };
      else if (type === "p4.high-risk.preview") result = { preview: { previewId: fingerprint, policyRevision: 1, commandFingerprint: fingerprint, command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-1"], projectIds: ["project-1"], reason: "reviewed", payloadFingerprint: fingerprint }, blastRadius, createdAt: NOW, expiresAt: "2099-08-03T12:00:00.000Z" }, blastRadius, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" };
      else result = { result: { operationId: fingerprint, previewId: fingerprint, kind: "GLOBAL_PROMOTION", actor: "local-console", policyRevision: 1, blastRadius, committedAt: NOW } };
      return { schemaVersion: 1, requestId: request.requestId, observedAt: NOW, ok: true, result };
    });
    const client = new UnixSocketControlClient({ socketPath });
    const options = { signal: new AbortController().signal };
    await expect(client.listP4Injections("session-1", { limit: 10 }, options)).resolves.toMatchObject({ items: [{ attemptId: "attempt-1" }] });
    await expect(client.getP4Injection("session-1", "attempt-1", options)).resolves.toMatchObject({ attemptId: "attempt-1" });
    await expect(client.listP4McpExpansions("session-1", "attempt-1", { limit: 10 }, options)).resolves.toEqual({ items: [] });
    await expect(client.listP4Closures("session-1", { limit: 10 }, options)).resolves.toMatchObject({ items: [{ closureRunId: "closure-1" }] });
    await expect(client.getP4Closure("session-1", "closure-1", options)).resolves.toMatchObject({ closureRunId: "closure-1" });
    await expect(client.getP4Rollout(options)).resolves.toMatchObject({ state: { stateRevision: 1 } });
    await expect(client.listP4FeedbackTargets("session-1", options)).resolves.toEqual({ items: [] });
    await expect(client.getP4HighRiskGovernance(options)).resolves.toMatchObject({ activeStageEnabled: false });
    await expect(client.refreshP4Context("session-1", "refresh-1", options)).resolves.toMatchObject({ removedEntries: 2 });
    await expect(client.recordP4Feedback({ action: "PIN", assetId: "knowledge-1", expectedKnowledgeVersion: 1, scopeKey: "PROJECT:project-1", traceId: "trace-1", idempotencyKey: "feedback-1" }, options)).resolves.toMatchObject({ outcome: "RECORDED" });
    await expect(client.previewP4HighRisk({ expectedPolicyRevision: 1, idempotencyKey: "preview-1", command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-1"], projectIds: ["project-1"], reason: "reviewed", payloadFingerprint: fingerprint } }, options)).resolves.toMatchObject({ preview: { previewId: fingerprint } });
    await expect(client.commitP4HighRisk({ expectedPolicyRevision: 1, idempotencyKey: "commit-1", previewId: fingerprint, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" }, options)).resolves.toMatchObject({ result: { operationId: fingerprint } });
  });

  it("maps every P0 query and capture command to the strict Control API contract", async () => {
    const socketPath = await serve((request) => {
      let result: unknown;
      switch (request.type) {
        case "overview.get":
          result = {
            schemaVersion: 1,
            observedAt: NOW,
            rolloutMode: "SHADOW",
            sidecarVersion: "0.1.4",
            capabilities: [],
            recentSessions: [],
            jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 },
            alertCount: 0,
          };
          break;
        case "capabilities.list":
        case "sessions.list":
        case "session.events.list":
        case "jobs.list":
          result = { items: [] };
          break;
        case "job.cancel":
        case "job.retry":
          result = {
            schemaVersion: 1,
            action: request.type === "job.cancel" ? "CANCEL" : "RETRY",
            disposition: "APPLIED",
            job: {
              schemaVersion: 1,
              jobId: request.jobId,
              jobType: "AUTOMATIC_INGESTION_SCAN",
              revision: request.expectedRevision + 1,
              status: request.type === "job.cancel" ? "CANCELLED" : "QUEUED",
              attempt: 1,
              maxAttempts: 3,
              progress: 0,
              reasonCode: request.type === "job.cancel" ? "JOB_CANCELLED" : "JOB_QUEUED",
              observedAt: NOW,
              lastTransitionAt: NOW,
              retryable: request.type === "job.retry",
              evidenceRefs: [],
            },
          };
          break;
        case "session.get":
          result = {
            summary: {
              schemaVersion: 1,
              sessionId: request.sessionId,
              title: "Session",
              source: "CODEX_TRANSCRIPT",
              sourceStatus: "AVAILABLE",
              captureStatus: "DISCOVERED_NOT_CAPTURED",
              firstActivityAt: NOW,
              lastActivityAt: NOW,
              eventCount: 0,
              turnCount: 0,
              ignoredRecords: 0,
              redactionCount: 0,
            },
            stages: [],
            injections: [],
          };
          break;
        case "diagnostics.get":
          result = {
            schemaVersion: 1,
            observedAt: NOW,
            ledgerSequence: 0,
            spoolDepth: 0,
            consumerLags: [],
            worker: { healthy: true, consumed: 0, produced: 0, retryableFailures: 0 },
            storage: { healthy: true, databaseBytes: 0 },
          };
          break;
        case "capture.preview":
          result = {
            schemaVersion: 1,
            sessionId: request.sessionId,
            previewRevision: 1,
            transcriptIdentityHash: "a".repeat(64),
            projectedEvents: 0,
            ignoredRecords: 0,
            eventTypes: {},
            items: [],
            itemsTruncated: false,
            cursor: { byteOffset: 0, lineNumber: 0 },
            hasMore: false,
            expiresAt: NOW,
          };
          break;
        case "capture.commit":
          result = {
            schemaVersion: 1,
            sessionId: request.sessionId,
            previewRevision: request.previewRevision,
            appendedEvents: 0,
            duplicateEvents: 0,
            appendedEventIds: [],
            duplicateEventIds: [],
            eventIdsTruncated: false,
            cursor: { byteOffset: 0, lineNumber: 0 },
            knowledgeCompileStage: {
              schemaVersion: 1,
              entityId: request.sessionId,
              stage: "KNOWLEDGE_COMPILE",
              status: "DISABLED",
              reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED",
              observedAt: NOW,
              lastTransitionAt: NOW,
              retryable: false,
              evidenceRefs: [],
            },
          };
          break;
        case "config.get":
          result = {
            view: {
              schemaVersion: 1,
              revision: 1,
              hash: "c".repeat(64),
              ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
              effective: configuration,
              sources: {},
            },
            drafts: [],
            history: [],
          };
          break;
        case "config.validate":
          result = {
            ok: true,
            draft: {
              draftRevision: 7,
              baseRevision: request.baseRevision,
              scope: request.scope,
              ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
              configuration,
              changedPaths: Object.keys(request.draft),
              requiresRestart: false,
              activatable: true,
              diagnostics: [],
            },
          };
          break;
        case "config.activate":
          result = { ok: true, revision: 2, hash: "d".repeat(64), status: "EFFECTIVE" };
          break;
        case "config.rollback":
          result = { ok: true, revision: 3, hash: "e".repeat(64), status: "ROLLED_BACK" };
          break;
        default:
          throw new Error("unexpected request");
      }
      return {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt: NOW,
        ok: true,
        result,
      };
    });
    const client = new UnixSocketControlClient({ socketPath });
    const options = { signal: new AbortController().signal };
    await expect(client.getOverview(options)).resolves.toMatchObject({ rolloutMode: "SHADOW" });
    await expect(client.listCapabilities({ limit: 1 }, options)).resolves.toEqual({ items: [] });
    await expect(client.listSessions({ limit: 1 }, options)).resolves.toEqual({ items: [] });
    await expect(client.getSession("session-1", options)).resolves.toMatchObject({ summary: { sessionId: "session-1" } });
    await expect(client.listSessionEvents("session-1", { limit: 1 }, options)).resolves.toEqual({ items: [] });
    await expect(client.listJobs({ limit: 1 }, options)).resolves.toEqual({ items: [] });
    await expect(client.cancelJob({
      jobId: "job-1",
      expectedRevision: 2,
      idempotencyKey: "operator:cancel:client:one",
    }, options)).resolves.toMatchObject({ action: "CANCEL", job: { revision: 3 } });
    await expect(client.retryJob({
      jobId: "job-1",
      expectedRevision: 3,
      idempotencyKey: "operator:retry:client:one",
    }, options)).resolves.toMatchObject({ action: "RETRY", job: { revision: 4 } });
    await expect(client.getDiagnostics(options)).resolves.toMatchObject({ ledgerSequence: 0 });
    await expect(client.previewCapture("session-1", options)).resolves.toMatchObject({ previewRevision: 1 });
    await expect(client.commitCapture({
      sessionId: "session-1",
      previewRevision: 1,
      transcriptIdentityHash: "a".repeat(64),
      idempotencyKey: "capture:session-1:revision-1",
    }, options)).resolves.toMatchObject({ appendedEvents: 0 });
    await expect(client.getConfiguration("project-a", options)).resolves.toMatchObject({ view: { projectId: "project-a", revision: 1 } });
    await expect(client.validateConfiguration({
      baseRevision: 1,
      scope: "PROJECT",
      projectId: "project-a",
      draft: { "runtime.workerConcurrency": 3 },
    }, options)).resolves.toMatchObject({ ok: true, draft: { draftRevision: 7 } });
    await expect(client.activateConfiguration({
      expectedRevision: 1,
      draftRevision: 7,
      idempotencyKey: "config:activate:revision-7",
    }, options)).resolves.toMatchObject({ ok: true, revision: 2, status: "EFFECTIVE" });
    await expect(client.rollbackConfiguration({
      expectedRevision: 2,
      targetRevision: 1,
      idempotencyKey: "config:rollback:revision-1",
    }, options)).resolves.toMatchObject({ ok: true, revision: 3, status: "ROLLED_BACK" });
  });

  it("rejects mismatched request IDs and invalid result fields", async () => {
    const socketPath = await serve(() => ({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: "mismatched-request",
      observedAt: NOW,
      ok: true,
      result: { rawPrompt: "must not pass" },
    }));
    const client = new UnixSocketControlClient({ socketPath });
    await expect(client.getOverview({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects P2 Sidecar response drift instead of passing unknown objects through", async () => {
    const socketPath = await serve((request) => ({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: request.requestId,
      observedAt: NOW,
      ok: true,
      result: { sessionId: "session-1", stages: "not-an-array", injectedUnknownField: true },
    }));
    const client = new UnixSocketControlClient({ socketPath });
    await expect(client.getSessionExtraction("session-1", { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects P3 Sidecar response drift and preserves the caller request identity", async () => {
    let received: unknown;
    const socketPath = await serve((request) => {
      received = request;
      return {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt: NOW,
        ok: true,
        result: { schemaVersion: 1, kind: "SEARCH", trace: {}, unexpected: true },
      };
    });
    const client = new UnixSocketControlClient({ socketPath });
    await expect(client.searchKnowledge({
      requestId: "request-p3-client",
      query: "ConfigService",
      projectId: "project-a",
      maxResults: 10,
      maxContextTokens: 800,
      timeoutMs: 1_000,
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL" });
    expect(received).toMatchObject({
      schemaVersion: 1,
      requestId: "request-p3-client",
      type: "p3.knowledge.search",
    });
  });

  it("rejects typed result violations and safe remote errors", async () => {
    const invalidResultSocket = await serve((request) => ({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: request.requestId,
      observedAt: NOW,
      ok: true,
      result: { rawPrompt: "must not pass" },
    }));
    const invalidResultClient = new UnixSocketControlClient({ socketPath: invalidResultSocket });
    await expect(invalidResultClient.getOverview({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL" });

    const remoteErrorSocket = await serve((request) => ({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: request.requestId,
      observedAt: NOW,
      ok: false,
      error: { code: "SIDECAR_UNAVAILABLE", message: "Unavailable", retryable: true },
    }));
    const remoteErrorClient = new UnixSocketControlClient({ socketPath: remoteErrorSocket });
    await expect(remoteErrorClient.getOverview({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "REMOTE_ERROR", remoteCode: "SIDECAR_UNAVAILABLE" });

    const transportErrorSocket = await serve(() => ({ ok: false, errorCode: "CONTROL_REJECTED" }));
    const transportErrorClient = new UnixSocketControlClient({ socketPath: transportErrorSocket });
    await expect(transportErrorClient.getOverview({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "REMOTE_ERROR" });
  });

  it("rejects oversized Sidecar responses", async () => {
    const socketPath = await serve((request) => ({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: request.requestId,
      observedAt: NOW,
      ok: true,
      result: { padding: "x".repeat(2_000) },
    }));
    const client = new UnixSocketControlClient({ socketPath, maximumResponseBytes: 512 });
    await expect(client.getOverview({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects oversized configuration drafts before opening the Unix socket", async () => {
    const client = new UnixSocketControlClient({ socketPath: "/tmp/zhiloop-not-contacted.sock" });
    await expect(client.validateConfiguration({
      baseRevision: 1,
      scope: "GLOBAL",
      draft: { padding: "x".repeat(1_100_000) },
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects trailing protocol frames after the bounded response", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhiloop-control-trailing-"));
    const socketPath = path.join(directory, "control.sock");
    sockets.push(socketPath);
    const server = createServer((client) => {
      connections.add(client);
      client.once("close", () => connections.delete(client));
      client.once("data", () => client.end("{}\n{}\n"));
    });
    servers.push(server);
    server.listen(socketPath);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const client = new UnixSocketControlClient({ socketPath });
    await expect(client.getOverview({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects unsafe client limits and unavailable sockets", async () => {
    expect(() => new UnixSocketControlClient({ socketPath: "relative.sock" })).toThrow(/absolute/u);
    expect(() => new UnixSocketControlClient({ socketPath: "/tmp/control.sock", timeoutMs: 0 })).toThrow(/timeoutMs/u);
    expect(() => new UnixSocketControlClient({ socketPath: "/tmp/control.sock", maximumResponseBytes: 2_000_000 })).toThrow(/maximumResponseBytes/u);
    const client = new UnixSocketControlClient({ socketPath: "/tmp/zhiloop-definitely-absent.sock" });
    await expect(client.getOverview({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(client.getOverview({ signal: aborted.signal })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("bounds socket timeouts and returns a safe error", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhiloop-control-timeout-"));
    const socketPath = path.join(directory, "control.sock");
    sockets.push(socketPath);
    const server = createServer((client) => {
      connections.add(client);
      client.once("close", () => connections.delete(client));
    });
    servers.push(server);
    server.listen(socketPath);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const client = new UnixSocketControlClient({ socketPath, timeoutMs: 20 });
    await expect(client.getOverview({ signal: new AbortController().signal })).rejects.toBeInstanceOf(ControlClientError);
  });
});
