import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTROL_API_SCHEMA_VERSION,
  MAX_PAGE_SIZE,
  type CapabilitySnapshot,
  type CaptureCommitResult,
  type CapturePreview,
  type ConfigurationMutationResult,
  type ConfigurationState,
  type ConfigurationValidationResult,
  type Diagnostics,
  type EventMetadata,
  type JobSnapshot,
  type JobCommandResult,
  type Overview,
  type P2KnowledgeFilter,
  type P2KnowledgeListView,
  type SessionDetail,
  type SessionSummary,
  type RetrievalTraceContract,
} from "@zhiloop/control-api";
import type { P3AskResponse, P3ConsoleQueryBody, P3SearchResponse, P3SimulationResponse } from "@zhiloop/p3-console-runtime";

import type {
  CaptureCommitCommand,
  ConfigurationActivateCommand,
  ConfigurationDraftCommand,
  ConfigurationRollbackCommand,
  ControlCommandPort,
  ControlQueryPort,
  Page,
  PageQuery,
  QueryOptions,
  JobOperatorCommand,
} from "./ports.js";
import { ControlClientError } from "./control-client.js";
import { BoundedInvalidationLog } from "./invalidation.js";
import { createConsoleGateway, type ConsoleGateway, type ConsoleGatewayAddress } from "./server.js";

const NOW = "2026-08-03T12:00:00.000Z";
const BOOTSTRAP_TOKEN = "bootstrap-token-that-is-long-enough-for-tests-0000000000000000";

const capability: CapabilitySnapshot = {
  schemaVersion: CONTROL_API_SCHEMA_VERSION,
  capabilityId: "conversation.capture",
  status: "READY",
  reasonCode: "COMPONENT_READY",
  observedAt: NOW,
  lastTransitionAt: NOW,
  retryable: false,
  evidenceRefs: ["health:sidecar"],
};

const session: SessionSummary = {
  schemaVersion: CONTROL_API_SCHEMA_VERSION,
  sessionId: "session-1",
  title: "Safe session title",
  source: "CODEX_TRANSCRIPT",
  sourceStatus: "AVAILABLE",
  sourceVersion: "v1",
  captureStatus: "CAPTURED_CURRENT",
  firstActivityAt: NOW,
  lastActivityAt: NOW,
  eventCount: 1,
  turnCount: 1,
  ignoredRecords: 0,
  redactionCount: 1,
};

const job: JobSnapshot = {
  schemaVersion: CONTROL_API_SCHEMA_VERSION,
  jobId: "job-1",
  jobType: "SESSION_CAPTURE",
  revision: 3,
  status: "SUCCEEDED",
  attempt: 1,
  maxAttempts: 3,
  progress: 1,
  reasonCode: "JOB_SUCCEEDED",
  observedAt: NOW,
  lastTransitionAt: NOW,
  retryable: false,
  evidenceRefs: [],
};

const event: EventMetadata = {
  schemaVersion: CONTROL_API_SCHEMA_VERSION,
  sequence: 1,
  eventId: "event-1",
  eventType: "user.prompted",
  source: "codex",
  sessionId: "session-1",
  turnId: "turn-1",
  occurredAt: NOW,
  correlationId: "correlation-1",
  contentHash: "a".repeat(64),
  redactionCount: 1,
  payloadPurged: false,
};

const overview: Overview = {
  schemaVersion: CONTROL_API_SCHEMA_VERSION,
  observedAt: NOW,
  rolloutMode: "SHADOW",
  sidecarVersion: "0.1.4",
  capabilities: [capability],
  recentSessions: [session],
  jobs: { queued: 0, running: 0, retryWait: 0, failed: 0 },
  alertCount: 0,
};

const diagnostics: Diagnostics = {
  schemaVersion: CONTROL_API_SCHEMA_VERSION,
  observedAt: NOW,
  ledgerSequence: 1,
  spoolDepth: 0,
  consumerLags: [],
  worker: { healthy: true, consumed: 1, produced: 1, retryableFailures: 0 },
  storage: { healthy: true, databaseBytes: 4096 },
};

const retrievalTrace: RetrievalTraceContract = {
  schemaVersion: 1,
  traceId: "trace-gateway-p3",
  runId: "run-gateway-p3",
  queryContext: {
    prompt: "How does ConfigService work?",
    promptFingerprint: "a".repeat(64),
    projectId: "project-a",
    taskId: "task-p3",
    repositoryRoot: "/workspace/project-a",
    paths: [], symbols: ["ConfigService"], errorCodes: [], configKeys: [],
    allowProjectKnowledge: true, allowGlobalKnowledge: true,
    reasonCodes: ["PROJECT_RESOLVED"],
  },
  policy: { policyId: "policy-current", revision: 1, fingerprint: "b".repeat(64), source: "CURRENT" },
  outcome: "NO_CONTEXT",
  filters: [], results: [], scenarios: [],
  envelope: {
    detailLevel: "L0_NONE", maxTokens: 800, estimatedTokens: 0, truncated: false,
    selected: [], omitted: [],
    reasonCodes: ["RISK_LOW", "AMBIGUITY_ABSENT", "CONFLICT_ABSENT", "BUDGET_WITHIN_LIMIT"],
  },
  injectionResult: "NO_CONTEXT",
  durationMs: 1,
  createdAt: NOW,
};

const consoleConfiguration = {
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
    onSessionEnd: true, scanIntervalMs: 1_000, maxSessionsPerRun: 100, maxDispatchesPerRun: 20, maxOutstandingJobs: 2,
    publication: { enabled: false, allowedKindsCsv: "", allowedProjectIdsCsv: "", requireFreshCodeEvidence: true as const, goldenDatasetId: "", goldenDatasetVersion: 0, goldenConfigFingerprint: "" },
  },
  evolution: { maxMatchCandidates: 5, semanticJudgeEnabled: true, failClosed: true as const },
  codeIntelligence: { provider: "codegraph" as const, initializeAutomatically: false as const, queryTimeoutMs: 250, circuitBreakerFailures: 3, circuitBreakerResetMs: 30_000 },
  freshness: { enabled: true, changeDebounceMs: 1_000, fallbackScanIntervalMs: 3_600_000, preInjectionGate: true as const, gateTimeoutMs: 200, maxAffectedPerJob: 500 },
  prewarm: { enabled: true, onSessionStart: true, ttlMs: 1_800_000, maxItems: 8, maxTokens: 800 },
  evolutionAlerts: { enabled: false, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false },
};

const configurationState: ConfigurationState = {
  view: {
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    revision: 1,
    hash: "c".repeat(64),
    effective: consoleConfiguration,
    sources: {},
  },
  drafts: [],
  history: [],
};

class FakeQueryPort implements ControlQueryPort {
  public overview: Overview = overview;
  public failure: Error | undefined;
  public hang = false;
  public askDelayMs = 0;
  public calls: string[] = [];

  public getOverview(options: QueryOptions): Promise<Overview> {
    return this.result("overview", this.overview, options);
  }

  public listCapabilities(page: PageQuery, options: QueryOptions): Promise<Page<CapabilitySnapshot>> {
    return this.result(`capabilities:${page.limit}`, { items: [capability] }, options);
  }

  public listSessions(page: PageQuery, options: QueryOptions): Promise<Page<SessionSummary>> {
    return this.result(`sessions:${page.limit}`, { items: [session] }, options);
  }

  public getSession(sessionId: string, options: QueryOptions): Promise<SessionDetail> {
    return this.result(`session:${sessionId}`, { summary: session, stages: [], injections: [] }, options);
  }

  public listSessionEvents(sessionId: string, page: PageQuery, options: QueryOptions): Promise<Page<EventMetadata>> {
    return this.result(`events:${sessionId}:${page.limit}`, { items: [event] }, options);
  }

  public listJobs(page: PageQuery, options: QueryOptions): Promise<Page<JobSnapshot>> {
    return this.result(`jobs:${page.limit}`, { items: [job] }, options);
  }

  public getDiagnostics(options: QueryOptions): Promise<Diagnostics> {
    return this.result("diagnostics", diagnostics, options);
  }

  public getConfiguration(projectId: string | undefined, options: QueryOptions): Promise<ConfigurationState> {
    return this.result(`configuration:${projectId ?? "GLOBAL"}`, configurationState, options);
  }

  public listKnowledge(_filter: P2KnowledgeFilter, options: QueryOptions): Promise<P2KnowledgeListView> {
    return this.result("knowledge", { revision: 0, items: [], indexStatus: "READY", indexReasonCode: "INDEX_CURRENT", retryable: false }, options);
  }

  public searchKnowledge(_command: P3ConsoleQueryBody, options: QueryOptions): Promise<P3SearchResponse> {
    return this.result("p3:search", { schemaVersion: 1, kind: "SEARCH", trace: retrievalTrace }, options);
  }

  public async askKnowledge(command: P3ConsoleQueryBody, options: QueryOptions): Promise<P3AskResponse> {
    if (this.askDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.askDelayMs);
        options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
    }
    return this.result("p3:ask", {
      schemaVersion: 1,
      kind: "ASK",
      trace: retrievalTrace,
      answer: {
        schemaVersion: 1, queryId: command.requestId, retrievalTraceId: retrievalTrace.traceId,
        outcome: "FALLBACK_SEARCH", answer: "", factualSpans: [], citations: [],
        unknowns: ["Codex query unavailable"], conflicts: [], latencyMs: 0, usage: {},
      },
    }, options);
  }

  public simulateRetrieval(_command: P3ConsoleQueryBody, options: QueryOptions): Promise<P3SimulationResponse> {
    return this.result("p3:simulate", { schemaVersion: 1, kind: "SIMULATION", current: retrievalTrace }, options);
  }

  public getRetrievalTrace(_command: { readonly requestId: string; readonly traceId: string }, options: QueryOptions): Promise<RetrievalTraceContract> {
    return this.result("p3:trace", retrievalTrace, options);
  }

  private result<T>(call: string, value: T, options: QueryOptions): Promise<T> {
    this.calls.push(call);
    if (this.failure) return Promise.reject(this.failure);
    if (!this.hang) return Promise.resolve(value);
    return new Promise<T>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

class FakeCommandPort implements ControlCommandPort {
  public calls: string[] = [];
  public failure: Error | undefined;
  public mutationResult: ConfigurationMutationResult = { ok: true, revision: 2, hash: "d".repeat(64), status: "EFFECTIVE" };

  public async previewCapture(sessionId: string): Promise<CapturePreview> {
    if (this.failure) throw this.failure;
    this.calls.push(`preview:${sessionId}`);
    return { schemaVersion: 1, sessionId, previewRevision: 7, transcriptIdentityHash: "a".repeat(64), projectedEvents: 3, ignoredRecords: 0, eventTypes: { USER_PROMPT: 1 }, items: [{ eventId: "event-1", eventType: "USER_PROMPT", occurredAt: NOW, contentPreview: "设计 Ledger", contentTruncated: false }], itemsTruncated: false, cursor: { byteOffset: 100, lineNumber: 4 }, hasMore: false, expiresAt: NOW };
  }

  public async commitCapture(command: CaptureCommitCommand): Promise<CaptureCommitResult> {
    if (this.failure) throw this.failure;
    this.calls.push(`commit:${command.sessionId}:${command.previewRevision}:${command.idempotencyKey}`);
    return { schemaVersion: 1, sessionId: command.sessionId, previewRevision: command.previewRevision, appendedEvents: 3, duplicateEvents: 0, appendedEventIds: ["event-1", "event-2", "event-3"], duplicateEventIds: [], eventIdsTruncated: false, cursor: { byteOffset: 100, lineNumber: 4 }, knowledgeCompileStage: { schemaVersion: 1, entityId: command.sessionId, stage: "KNOWLEDGE_COMPILE", status: "DISABLED", reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED", observedAt: NOW, lastTransitionAt: NOW, retryable: false, evidenceRefs: [] } };
  }

  public async validateConfiguration(command: ConfigurationDraftCommand): Promise<ConfigurationValidationResult> {
    if (this.failure) throw this.failure;
    this.calls.push(`config:validate:${command.scope}:${command.projectId ?? "GLOBAL"}:${command.baseRevision}`);
    return {
      ok: true,
      draft: {
        draftRevision: 7,
        baseRevision: command.baseRevision,
        scope: command.scope,
        ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
        configuration: consoleConfiguration,
        changedPaths: Object.keys(command.draft),
        requiresRestart: false,
        activatable: true,
        diagnostics: [],
      },
    };
  }

  public async activateConfiguration(command: ConfigurationActivateCommand): Promise<ConfigurationMutationResult> {
    if (this.failure) throw this.failure;
    this.calls.push(`config:activate:${command.expectedRevision}:${command.draftRevision}:${command.idempotencyKey}`);
    return this.mutationResult;
  }

  public async rollbackConfiguration(command: ConfigurationRollbackCommand): Promise<ConfigurationMutationResult> {
    if (this.failure) throw this.failure;
    this.calls.push(`config:rollback:${command.expectedRevision}:${command.targetRevision}:${command.idempotencyKey}`);
    return this.mutationResult.ok ? { ...this.mutationResult, status: "ROLLED_BACK" } : this.mutationResult;
  }

  public async cancelJob(command: JobOperatorCommand): Promise<JobCommandResult> {
    if (this.failure) throw this.failure;
    this.calls.push(`job:cancel:${command.jobId}:${command.expectedRevision}:${command.idempotencyKey}`);
    return { schemaVersion: 1, action: "CANCEL", disposition: "APPLIED", job: { ...job, revision: command.expectedRevision + 1, status: "CANCELLED", reasonCode: "JOB_CANCELLED" } };
  }

  public async retryJob(command: JobOperatorCommand): Promise<JobCommandResult> {
    if (this.failure) throw this.failure;
    this.calls.push(`job:retry:${command.jobId}:${command.expectedRevision}:${command.idempotencyKey}`);
    return { schemaVersion: 1, action: "RETRY", disposition: "APPLIED", job: { ...job, revision: command.expectedRevision + 1, status: "QUEUED", reasonCode: "JOB_QUEUED", progress: 0 } };
  }

  public async refreshP4Context(sessionId: string, idempotencyKey: string) {
    if (this.failure) throw this.failure;
    this.calls.push(`p4:context-refresh:${sessionId}:${idempotencyKey}`);
    return { sessionId, removedEntries: 2, refreshedAt: NOW, reasonCode: "SESSION_CONTEXT_REFRESHED" };
  }
}

interface AuthenticatedBrowser {
  readonly cookie: string;
  readonly csrf: string;
}

describe("Console Gateway security boundary", () => {
  let staticRoot: string;
  let queryPort: FakeQueryPort;
  let commandPort: FakeCommandPort;
  let gateway: ConsoleGateway | undefined;
  let address: ConsoleGatewayAddress | undefined;

  beforeEach(async () => {
    staticRoot = await mkdtemp(path.join(os.tmpdir(), "zhiloop-console-gateway-"));
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>ZhiLoop</title>");
    await mkdir(path.join(staticRoot, "assets"));
    await writeFile(path.join(staticRoot, "assets", "app.js"), "document.title = 'ZhiLoop';");
    queryPort = new FakeQueryPort();
    commandPort = new FakeCommandPort();
  });

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    address = undefined;
  });

  async function start(overrides: Partial<Parameters<typeof createConsoleGateway>[0]> = {}): Promise<void> {
    gateway = await createConsoleGateway({
      queryPort,
      commandPort,
      staticRoot,
      bootstrapToken: BOOTSTRAP_TOKEN,
      ...overrides,
    });
    address = await gateway.listen();
  }

  async function authenticate(token = BOOTSTRAP_TOKEN): Promise<{ response: Response; browser?: AuthenticatedBrowser }> {
    const response = await fetch(`${address?.origin}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: address?.origin ?? "" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) return { response };
    const body = await response.json() as { csrfToken: string };
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("missing test session cookie");
    return { response, browser: { cookie, csrf: body.csrfToken } };
  }

  function authorizedHeaders(browser: AuthenticatedBrowser): Record<string, string> {
    return { cookie: browser.cookie, "x-zhiloop-csrf": browser.csrf };
  }

  function publish(log: BoundedInvalidationLog, revision: number): void {
    log.publish({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      eventId: `event-${revision}`,
      type: "session.updated",
      entityId: "session-1",
      revision,
      occurredAt: NOW,
      reasonCode: "CAPTURED_CURRENT",
    });
  }

  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
    const decoder = new TextDecoder();
    let collected = "";
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 2_000);
      timer.unref();
    });
    return Promise.race([
      (async () => {
        while (!collected.includes(expected)) {
          const next = await reader.read();
          if (next.done) throw new Error(`stream ended before ${expected}`);
          collected += decoder.decode(next.value, { stream: true });
        }
        return collected;
      })(),
      timeout,
    ]);
  }

  it("uses a one-time fragment-compatible bootstrap and hardened browser session", async () => {
    await start();
    expect(address?.bootstrapUrl).toContain("/#bootstrap=");
    expect(address?.bootstrapUrl).not.toContain("?token=");
    const first = await authenticate();
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict; Max-Age=/u);
    expect(first.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(first.response.headers.get("access-control-allow-origin")).toBeNull();
    expect((await authenticate()).response.status).toBe(401);
  });

  it("resumes an existing browser session without weakening protected API CSRF checks", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;

    const resumed = await fetch(`${address?.origin}/api/v1/auth/session`, {
      headers: { cookie: browser.cookie },
    });
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get("cache-control")).toBe("no-store");
    await expect(resumed.json()).resolves.toMatchObject({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      csrfToken: browser.csrf,
    });

    expect((await fetch(`${address?.origin}/api/v1/auth/session`)).status).toBe(401);
    expect((await fetch(`${address?.origin}/api/v1/auth/session?unexpected=true`, {
      headers: { cookie: browser.cookie },
    })).status).toBe(405);
    expect((await fetch(`${address?.origin}/api/v1/auth/session`, {
      method: "POST",
      headers: { cookie: browser.cookie, origin: address?.origin ?? "" },
    })).status).toBe(405);
    expect((await fetch(`${address?.origin}/api/v1/overview`, {
      headers: { cookie: browser.cookie },
    })).status).toBe(403);
  });

  it("rejects unauthenticated, missing-CSRF, wrong-Origin and forged-Host requests", async () => {
    await start();
    expect((await fetch(`${address?.origin}/api/v1/overview`)).status).toBe(401);
    const authenticated = await authenticate();
    const browser = authenticated.browser as AuthenticatedBrowser;
    expect((await fetch(`${address?.origin}/api/v1/overview`, { headers: { cookie: browser.cookie } })).status).toBe(403);
    expect((await fetch(`${address?.origin}/api/v1/overview`, {
      headers: { ...authorizedHeaders(browser), origin: "https://attacker.invalid" },
    })).status).toBe(403);
    const forged = await rawRequest(address as ConsoleGatewayAddress, "/api/v1/overview", {
      host: "attacker.invalid",
      cookie: browser.cookie,
      "x-zhiloop-csrf": browser.csrf,
    });
    expect(forged.status).toBe(403);
    expect(queryPort.calls).toEqual([]);
  });

  it("rejects 100 percent of the P0 unauthorized request sample", async () => {
    await start({ maximumRequestsPerWindow: 120 });
    const statuses = await Promise.all(Array.from({ length: 100 }, async () => (await fetch(`${address?.origin}/api/v1/overview`)).status));
    expect(statuses).toHaveLength(100);
    expect(statuses.every((status) => status === 401)).toBe(true);
    expect(queryPort.calls).toEqual([]);
  });

  it("fails closed for optional P4 facts and strictly bounds high-risk browser input", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const readHeaders = authorizedHeaders(browser);
    expect((await fetch(`${address?.origin}/api/v1/p4/capabilities`, { headers: readHeaders })).status).toBe(503);
    expect((await fetch(`${address?.origin}/api/v1/p4/sessions/session-1/injections?limit=100`, { headers: readHeaders })).status).toBe(503);

    const commandHeaders = { ...readHeaders, origin: address?.origin ?? "", "content-type": "application/json" };
    const validCommit = {
      expectedPolicyRevision: 3,
      idempotencyKey: "p4.commit:preview-1",
      previewId: `sha256:${"a".repeat(64)}`,
      confirmationPhrase: "CONFIRM RULE CHANGE",
    };
    const unavailable = await fetch(`${address?.origin}/api/v1/p4/high-risk/commit`, {
      method: "POST", headers: commandHeaders, body: JSON.stringify(validCommit),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain("CAPABILITY_UNAVAILABLE");

    const browserForgedAuthority = await fetch(`${address?.origin}/api/v1/p4/high-risk/commit`, {
      method: "POST", headers: commandHeaders,
      body: JSON.stringify({ ...validCommit, actor: "browser-forged", confirmationFingerprint: `sha256:${"b".repeat(64)}` }),
    });
    expect(browserForgedAuthority.status).toBe(400);
    expect(await browserForgedAuthority.text()).toContain("INVALID_REQUEST");
  });

  it("serves every strict P4 audit, feedback, rollout and governance route", async () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const effective = { policyRevision: 1, mode: "SHADOW" as const, configFingerprint: fingerprint, versionFingerprint: fingerprint };
    const injection = {
      schemaVersion: 1 as const, attemptId: "attempt-1", sessionId: "session-1", turnId: "turn-1", traceId: "trace-1", runId: "run-1",
      rolloutRevision: 1, status: "INJECTED" as const, revision: 2, reasonCode: "HOOK_CONTEXT_GENERATED", createdAt: NOW, completedAt: NOW,
      deliveryEvidenceRef: "hook-client:receipt-1", deliveredAt: NOW,
      envelope: {
        schemaVersion: 1 as const, runId: "run-1",
        complexity: { level: "L1_POINTER" as const, breadth: 1, depth: "POINTER" as const, authority: "VERIFIED_FACT" as const, evidence: "POINTER" as const, reasonCodes: ["POINTER_SELECTED"] },
        budget: { maxTokens: 100, estimatedTokens: 20, truncated: false, disclosedItems: 1, omittedItems: 0 },
        items: [{ id: "knowledge-1", version: 1, subjectKey: "delivery", kind: "IMPLEMENTATION" as const, status: "VERIFIED" as const, scope: { level: "PROJECT" as const, projectId: "project-1" }, authority: "VERIFIED_FACT" as const, detailLevel: "L1_POINTER" as const, title: "Delivery", summary: "Acknowledged delivery", retrievalRank: 1 }],
      },
      tokenBudget: { maxTokens: 100, estimatedTokens: 20, truncated: false, disclosedItems: 1, omittedItems: 0 }, omittedReasonCodes: [],
    };
    const injectionDetail = Object.fromEntries(Object.entries(injection).filter(([key]) => key !== "tokenBudget" && key !== "omittedReasonCodes"));
    const expansion = { schemaVersion: 1 as const, expansionId: "expansion-1", attemptId: "attempt-1", traceId: "trace-1", tool: "ckl.get" as const, knowledgeId: "knowledge-1", knowledgeVersion: 1, fromDetailLevel: "L1_POINTER" as const, toDetailLevel: "L2_COMPACT" as const, latencyMs: 2, used: true, occurredAt: NOW };
    const closure = { schemaVersion: 1 as const, closureRunId: "closure-1", sessionId: "session-1", turnId: "turn-1", taskContract: { contractId: "contract-1", objective: "finish", gates: [], boundaries: [] }, gates: [], decision: "PASS" as const, continuationCount: 0, recursiveStopRejected: false, createdAt: NOW };
    const blastRadius = { affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["PROJECT_ONLY"] };
    const disabledActions = Object.fromEntries(["GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE"].map((kind) => [kind, { enabled: false, capabilityStatus: "NOT_CONFIGURED", reasonCode: "HIGH_RISK_NOT_CONFIGURED" }]));
    Object.assign(queryPort, {
      listP4Capabilities: async () => ["INJECTION_AUDIT", "MCP_AUDIT", "CLOSURE_AUDIT", "FEEDBACK", "ROLLOUT", "HIGH_RISK_GOVERNANCE"].map((capability) => ({ capability, state: capability === "HIGH_RISK_GOVERNANCE" ? "NOT_CONFIGURED" : "READY", reasonCode: capability === "HIGH_RISK_GOVERNANCE" ? "HIGH_RISK_NOT_CONFIGURED" : "COMPONENT_READY", evidenceRefs: [] })),
      listP4Injections: async (sessionId: string, page: PageQuery) => { queryPort.calls.push(`p4:injections:${sessionId}:${page.limit}`); return { items: [injection] }; },
      getP4Injection: async (sessionId: string, attemptId: string) => { queryPort.calls.push(`p4:injection:${sessionId}:${attemptId}`); return injectionDetail; },
      listP4McpExpansions: async (sessionId: string, attemptId: string, page: PageQuery) => { queryPort.calls.push(`p4:mcp:${sessionId}:${attemptId}:${page.limit}`); return { items: [expansion] }; },
      listP4Closures: async (sessionId: string, page: PageQuery) => { queryPort.calls.push(`p4:closures:${sessionId}:${page.limit}`); return { items: [closure] }; },
      getP4Closure: async (sessionId: string, closureRunId: string) => { queryPort.calls.push(`p4:closure:${sessionId}:${closureRunId}`); return closure; },
      getP4Rollout: async () => ({ state: { schemaVersion: 1 as const, stateRevision: 1, effective, lastKnownGood: effective, evidence: [], audit: [{ eventId: fingerprint, kind: "BOOTSTRAP" as const, stateRevision: 1, effectivePolicyRevision: 1, reasonCodes: ["BOOTSTRAP_SHADOW"], occurredAt: NOW }] }, downgradeHistory: [], rollbackTarget: effective }),
      listP4FeedbackTargets: async () => ({ items: [{ knowledgeId: "knowledge-1", version: 1, title: "Delivery", eligible: true, eligibilityReasonCodes: ["ELIGIBLE"], mcpUsed: true, scopeKey: "PROJECT:project-1", traceId: "trace-1", expansionId: "expansion-1", actions: Object.fromEntries(["RELEVANT", "IRRELEVANT", "PIN", "SUPPRESS", "MCP_USED"].map((kind) => [kind, { enabled: true, capabilityStatus: "READY", reasonCode: "ACTION_READY", expectedRevision: 1, idempotencyKey: `feedback:${kind}:knowledge-1:1` }])) }] }),
      getP4HighRiskGovernance: async () => ({ policyRevision: 1, activeStageEnabled: false, actor: "local-console", actions: disabledActions }),
    });
    Object.assign(commandPort, {
      recordP4Feedback: async () => ({ outcome: "RECORDED" as const, eligibleAfterWrite: true }),
      previewP4HighRisk: async (command: { expectedPolicyRevision: number; command: { kind: "GLOBAL_PROMOTION" } }) => ({ preview: { previewId: fingerprint, policyRevision: command.expectedPolicyRevision, commandFingerprint: fingerprint, command: { ...command.command, assetIds: ["knowledge-1"], projectIds: ["project-1"], reason: "reviewed", payloadFingerprint: fingerprint }, blastRadius, createdAt: NOW, expiresAt: "2099-08-03T12:00:00.000Z" }, blastRadius, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" }),
      commitP4HighRisk: async () => ({ result: { operationId: fingerprint, previewId: fingerprint, kind: "GLOBAL_PROMOTION" as const, actor: "local-console", policyRevision: 1, blastRadius, committedAt: NOW } }),
    });
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const readHeaders = authorizedHeaders(browser);
    const reads = [
      "/api/v1/p4/capabilities",
      "/api/v1/p4/sessions/session-1/injections?limit=10",
      "/api/v1/p4/sessions/session-1/injections/attempt-1",
      "/api/v1/p4/sessions/session-1/injections/attempt-1/mcp-expansions?limit=10",
      "/api/v1/p4/sessions/session-1/closures?limit=10",
      "/api/v1/p4/sessions/session-1/closures/closure-1",
      "/api/v1/p4/sessions/session-1/feedback-targets",
      "/api/v1/p4/rollout",
      "/api/v1/p4/high-risk/governance",
    ];
    for (const route of reads) expect((await fetch(`${address?.origin}${route}`, { headers: readHeaders })).status, route).toBe(200);
    const commandHeaders = { ...readHeaders, origin: address?.origin ?? "", "content-type": "application/json" };
    const commands = [
      ["/api/v1/p4/sessions/session-1/context-refresh", { idempotencyKey: "refresh-1" }],
      ["/api/v1/p4/feedback", { kind: "MCP_USED", knowledgeId: "knowledge-1", version: 1, expectedRevision: 1, idempotencyKey: "feedback-1", scopeKey: "PROJECT:project-1", traceId: "trace-1", expansionId: "expansion-1" }],
      ["/api/v1/p4/high-risk/preview", { expectedPolicyRevision: 1, idempotencyKey: "preview-1", command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-1"], projectIds: ["project-1"], reason: "reviewed", payloadFingerprint: fingerprint } }],
      ["/api/v1/p4/high-risk/commit", { expectedPolicyRevision: 1, idempotencyKey: "commit-1", previewId: fingerprint, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" }],
    ] as const;
    for (const [route, body] of commands) expect((await fetch(`${address?.origin}${route}`, { method: "POST", headers: commandHeaders, body: JSON.stringify(body) })).status, route).toBe(200);
    expect(queryPort.calls).toEqual(expect.arrayContaining(["p4:injections:session-1:10", "p4:mcp:session-1:attempt-1:10", "p4:closure:session-1:closure-1"]));
    expect(commandPort.calls).toContain("p4:context-refresh:session-1:refresh-1");
  });

  it("rejects malformed P4 routes and reports each uncomposed optional capability", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const readHeaders = authorizedHeaders(browser);
    const invalidReads: ReadonlyArray<readonly [string, RequestInit, number]> = [
      ["/api/v1/p4/capabilities", { method: "POST", headers: { ...readHeaders, origin: address?.origin ?? "" } }, 405],
      ["/api/v1/p4/capabilities?extra=1", { headers: readHeaders }, 400],
      ["/api/v1/p4/sessions/bad%20id/injections", { headers: readHeaders }, 400],
      ["/api/v1/p4/sessions/session-1/injections?limit=0", { headers: readHeaders }, 400],
      ["/api/v1/p4/sessions/session-1/injections/attempt-1", { headers: readHeaders }, 503],
      ["/api/v1/p4/sessions/session-1/injections/attempt-1?extra=1", { headers: readHeaders }, 400],
      ["/api/v1/p4/sessions/session-1/injections/attempt-1/mcp-expansions?limit=10", { headers: readHeaders }, 503],
      ["/api/v1/p4/sessions/session-1/injections/attempt-1/mcp-expansions?limit=0", { headers: readHeaders }, 400],
      ["/api/v1/p4/sessions/session-1/closures?limit=10", { headers: readHeaders }, 503],
      ["/api/v1/p4/sessions/session-1/closures/closure-1", { headers: readHeaders }, 503],
      ["/api/v1/p4/sessions/session-1/closures/closure-1?extra=1", { headers: readHeaders }, 400],
      ["/api/v1/p4/sessions/bad%20id/closures", { headers: readHeaders }, 400],
      ["/api/v1/p4/sessions/session-1/feedback-targets", { headers: readHeaders }, 503],
      ["/api/v1/p4/sessions/session-1/feedback-targets?extra=1", { headers: readHeaders }, 400],
      ["/api/v1/p4/rollout", { headers: readHeaders }, 503],
      ["/api/v1/p4/rollout?extra=1", { headers: readHeaders }, 400],
      ["/api/v1/p4/high-risk/governance", { headers: readHeaders }, 503],
      ["/api/v1/p4/high-risk/governance?extra=1", { headers: readHeaders }, 400],
    ];
    for (const [route, init, status] of invalidReads) expect((await fetch(`${address?.origin}${route}`, init)).status, route).toBe(status);

    const headers = { ...readHeaders, origin: address?.origin ?? "", "content-type": "application/json" };
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const commands: ReadonlyArray<readonly [string, unknown, number]> = [
      ["/api/v1/p4/sessions/session-1/context-refresh", { idempotencyKey: "bad id" }, 400],
      ["/api/v1/p4/feedback", { kind: "PIN", knowledgeId: "knowledge-1", version: 1, expectedRevision: 1, idempotencyKey: "feedback-1", scopeKey: "PROJECT:project-1", traceId: "trace-1" }, 503],
      ["/api/v1/p4/feedback", { kind: "PIN", knowledgeId: "knowledge-1", version: 1, expectedRevision: 2, idempotencyKey: "feedback-1", scopeKey: "PROJECT:project-1", traceId: "trace-1" }, 400],
      ["/api/v1/p4/high-risk/preview", { expectedPolicyRevision: 1, idempotencyKey: "preview-1", command: { kind: "RULE_CHANGE", assetIds: ["knowledge-1"], projectIds: [], reason: "reviewed", payloadFingerprint: fingerprint } }, 503],
      ["/api/v1/p4/high-risk/preview", { expectedPolicyRevision: 0 }, 400],
    ];
    for (const [route, body, status] of commands) expect((await fetch(`${address?.origin}${route}`, { method: "POST", headers, body: JSON.stringify(body) })).status, route).toBe(status);
    expect((await fetch(`${address?.origin}/api/v1/p4/sessions/session-1/context-refresh`, { method: "GET", headers })).status).toBe(405);
    expect((await fetch(`${address?.origin}/api/v1/p4/sessions/session-1/context-refresh`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "refresh-1", padding: "x".repeat(20_000) }) })).status).toBe(413);
    expect((await fetch(`${address?.origin}/api/v1/p4/feedback`, { method: "GET", headers })).status).toBe(405);
    expect((await fetch(`${address?.origin}/api/v1/p4/feedback`, { method: "POST", headers: { ...readHeaders, origin: address?.origin ?? "" }, body: "{}" })).status).toBe(405);
    expect((await fetch(`${address?.origin}/api/v1/p4/feedback`, { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/p4/feedback`, { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(1_100_000) }) })).status).toBe(413);
  });

  it("refuses wildcard and non-loopback bind addresses", async () => {
    await expect(createConsoleGateway({ queryPort, staticRoot, host: "0.0.0.0" })).rejects.toThrow(/loopback/u);
    await expect(createConsoleGateway({ queryPort, staticRoot, host: "192.0.2.1" })).rejects.toThrow(/loopback/u);
  });

  it("serves only bounded canonical static assets and blocks traversal", async () => {
    await start();
    const index = await fetch(`${address?.origin}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("ZhiLoop");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${address?.origin}/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect((await fetch(`${address?.origin}/assets/app.js?bootstrap=${BOOTSTRAP_TOKEN}`)).status).toBe(404);
  });

  it("maps all bounded P0 views through the typed query port", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const headers = authorizedHeaders(browser);
    const routes = [
      "/api/v1/overview",
      "/api/v1/capabilities?limit=10",
      "/api/v1/sessions?limit=11",
      "/api/v1/sessions/session-1",
      "/api/v1/events?sessionId=session-1&limit=12",
      "/api/v1/jobs?limit=13",
      "/api/v1/diagnostics",
    ];
    for (const route of routes) {
      const response = await fetch(`${address?.origin}${route}`, { headers });
      expect(response.status, route).toBe(200);
      expect((await response.json() as { ok: boolean }).ok, route).toBe(true);
    }
    expect(queryPort.calls).toEqual([
      "overview",
      "capabilities:10",
      "sessions:11",
      "session:session-1",
      "events:session-1:12",
      "jobs:13",
      "diagnostics",
    ]);
    expect((await fetch(`${address?.origin}/api/v1/sessions?limit=${MAX_PAGE_SIZE + 1}`, { headers })).status).toBe(400);
  });

  it("maps strict configuration get, draft, activation and rollback contracts", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const readHeaders = authorizedHeaders(browser);
    const commandHeaders = { ...readHeaders, origin: address?.origin ?? "", "content-type": "application/json" };
    const state = await fetch(`${address?.origin}/api/v1/configuration?projectId=project-a`, { headers: readHeaders });
    expect(state.status).toBe(200);
    expect((await state.json() as { result: ConfigurationState }).result.view.revision).toBe(1);

    const draft = await fetch(`${address?.origin}/api/v1/configuration/draft`, {
      method: "POST",
      headers: commandHeaders,
      body: JSON.stringify({ baseRevision: 1, scope: "PROJECT", projectId: "project-a", draft: { "runtime.workerConcurrency": 3 } }),
    });
    expect(draft.status).toBe(200);
    expect((await draft.json() as { result: ConfigurationValidationResult }).result).toMatchObject({ ok: true, draft: { draftRevision: 7 } });

    const activate = await fetch(`${address?.origin}/api/v1/configuration/activate`, {
      method: "POST",
      headers: commandHeaders,
      body: JSON.stringify({ expectedRevision: 1, draftRevision: 7, idempotencyKey: "config:activate:revision-7" }),
    });
    expect(activate.status).toBe(200);
    expect((await activate.json() as { result: ConfigurationMutationResult }).result).toMatchObject({ ok: true, status: "EFFECTIVE" });

    const rollback = await fetch(`${address?.origin}/api/v1/configuration/rollback`, {
      method: "POST",
      headers: commandHeaders,
      body: JSON.stringify({ expectedRevision: 2, targetRevision: 1, idempotencyKey: "config:rollback:revision-1" }),
    });
    expect(rollback.status).toBe(200);
    expect((await rollback.json() as { result: ConfigurationMutationResult }).result).toMatchObject({ ok: true, status: "ROLLED_BACK" });
    expect(queryPort.calls).toEqual(["configuration:project-a"]);
    expect(commandPort.calls).toEqual([
      "config:validate:PROJECT:project-a:1",
      "config:activate:1:7:config:activate:revision-7",
      "config:rollback:2:1:config:rollback:revision-1",
    ]);
  });

  it("rejects unknown, scope-mismatched and oversized configuration inputs", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const readHeaders = authorizedHeaders(browser);
    const headers = { ...readHeaders, origin: address?.origin ?? "", "content-type": "application/json" };
    const unknown = await fetch(`${address?.origin}/api/v1/configuration/draft`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseRevision: 1, scope: "GLOBAL", draft: {}, rawPrompt: "forbidden" }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain("forbidden");
    expect((await fetch(`${address?.origin}/api/v1/configuration/draft`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseRevision: 1, scope: "PROJECT", draft: {} }),
    })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/configuration/draft`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseRevision: 1, scope: "GLOBAL", draft: { padding: "x".repeat(20_000) } }),
    })).status).toBe(413);
    expect((await fetch(`${address?.origin}/api/v1/configuration/draft`, { headers: readHeaders })).status).toBe(405);
    expect((await fetch(`${address?.origin}/api/v1/configuration?projectId=bad%0Aid`, { headers: readHeaders })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/configuration?projectId=a&projectId=b`, { headers: readHeaders })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/configuration?unknown=1`, { headers: readHeaders })).status).toBe(400);
    expect(commandPort.calls).toEqual([]);
    expect(queryPort.calls).toEqual([]);
  });

  it("preserves configuration stale, conflict and unavailable HTTP semantics without leaking details", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const headers = { ...authorizedHeaders(browser), origin: address?.origin ?? "", "content-type": "application/json" };
    const activateBody = JSON.stringify({ expectedRevision: 1, draftRevision: 7, idempotencyKey: "config:activate:revision-7" });
    commandPort.mutationResult = { ok: false, diagnostic: { code: "STALE_REVISION", retryable: false } };
    const stale = await fetch(`${address?.origin}/api/v1/configuration/activate`, { method: "POST", headers, body: activateBody });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("STALE_REVISION");

    commandPort.failure = new ControlClientError("private config value", "REMOTE_ERROR", "CONFLICT");
    const conflict = await fetch(`${address?.origin}/api/v1/configuration/activate`, { method: "POST", headers, body: activateBody });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain("private config value");

    commandPort.failure = new ControlClientError("private socket path", "REMOTE_ERROR", "SIDECAR_UNAVAILABLE");
    const unavailable = await fetch(`${address?.origin}/api/v1/configuration/activate`, { method: "POST", headers, body: activateBody });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private socket path");

    for (const [remoteCode, expectedStatus] of [
      ["NOT_FOUND", 404],
      ["INVALID_REQUEST", 400],
      ["RATE_LIMITED", 429],
    ] as const) {
      commandPort.failure = new ControlClientError("private remote detail", "REMOTE_ERROR", remoteCode);
      const response = await fetch(`${address?.origin}/api/v1/configuration/activate`, { method: "POST", headers, body: activateBody });
      expect(response.status, remoteCode).toBe(expectedStatus);
      expect(await response.text()).not.toContain("private remote detail");
    }
    commandPort.failure = new ControlClientError("private protocol detail", "PROTOCOL");
    const protocolFailure = await fetch(`${address?.origin}/api/v1/configuration/activate`, { method: "POST", headers, body: activateBody });
    expect(protocolFailure.status).toBe(503);
    expect(await protocolFailure.text()).not.toContain("private protocol detail");

    commandPort.failure = undefined;
    for (const [code, expectedStatus] of [
      ["NOT_FOUND", 404],
      ["INVALID_CONFIGURATION", 400],
      ["COMPONENT_APPLY_FAILED", 503],
    ] as const) {
      commandPort.mutationResult = { ok: false, diagnostic: { code, retryable: false } };
      const response = await fetch(`${address?.origin}/api/v1/configuration/activate`, { method: "POST", headers, body: activateBody });
      expect(response.status, code).toBe(expectedStatus);
      expect(await response.text()).toContain(code);
    }

    queryPort.failure = new Error("private effective configuration");
    const unavailableRead = await fetch(`${address?.origin}/api/v1/configuration`, { headers: authorizedHeaders(browser) });
    expect(unavailableRead.status).toBe(503);
    expect(await unavailableRead.text()).not.toContain("private effective configuration");
  });

  it("returns capability unavailable when configuration mutation wiring is absent", async () => {
    await start({ commandPort: undefined });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const response = await fetch(`${address?.origin}/api/v1/configuration/activate`, {
      method: "POST",
      headers: { ...authorizedHeaders(browser), origin: address?.origin ?? "", "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, draftRevision: 7, idempotencyKey: "config:activate:revision-7" }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("CAPABILITY_UNAVAILABLE");
  });

  it("streams live invalidations with cookie-only EventSource auth and bounded heartbeats", async () => {
    const invalidationLog = new BoundedInvalidationLog({ maximumEvents: 4, maximumBytes: 4_096 });
    await start({ invalidationLog, sseHeartbeatMs: 100, pollingFallbackMs: 750 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const controller = new AbortController();
    const response = await fetch(`${address?.origin}/api/v1/invalidations`, {
      headers: { cookie: browser.cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    expect(await readUntil(reader, ": heartbeat revision=0")).toContain("retry: 750");
    publish(invalidationLog, 1);
    const live = await readUntil(reader, '"revision":1');
    expect(live).toContain("event: session.updated");
    expect(live).not.toContain("Safe session title");
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("publishes observed background state changes within the P1 one-second UI budget without request overlap", async () => {
    await start({ sseHeartbeatMs: 100, pollingFallbackMs: 100 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const controller = new AbortController();
    const response = await fetch(`${address?.origin}/api/v1/invalidations`, {
      headers: { cookie: browser.cookie },
      signal: controller.signal,
    });
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await readUntil(reader, ": heartbeat revision=0");
    await new Promise((resolve) => setTimeout(resolve, 150));
    queryPort.overview = { ...queryPort.overview, alertCount: 1 };
    const startedAt = performance.now();
    const update = await readUntil(reader, "event: alert.updated");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(update).toContain('"revision":1');
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("resumes after Last-Event-ID and emits one resync signal after replay expiry", async () => {
    const invalidationLog = new BoundedInvalidationLog({ maximumEvents: 2, maximumBytes: 4_096 });
    publish(invalidationLog, 1);
    publish(invalidationLog, 2);
    publish(invalidationLog, 3);
    await start({ invalidationLog });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;

    const resumedController = new AbortController();
    const resumed = await fetch(`${address?.origin}/api/v1/invalidations`, {
      headers: { cookie: browser.cookie, "last-event-id": "1" },
      signal: resumedController.signal,
    });
    const resumedReader = resumed.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const replay = await readUntil(resumedReader, '"revision":3');
    expect(replay).toContain('"revision":2');
    expect(replay).not.toContain('"revision":1');
    resumedController.abort();
    await resumedReader.cancel().catch(() => undefined);

    const staleController = new AbortController();
    const stale = await fetch(`${address?.origin}/api/v1/invalidations`, {
      headers: { cookie: browser.cookie, "last-event-id": "0" },
      signal: staleController.signal,
    });
    const staleReader = stale.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const resync = await readUntil(staleReader, "resync.required");
    expect(resync).toContain('"reasonCode":"SOURCE_UNAVAILABLE"');
    expect(resync).toContain("id: 3");
    expect(resync).not.toContain('"type":"session.updated"');
    staleController.abort();
    await staleReader.cancel().catch(() => undefined);

    const invalidController = new AbortController();
    const invalid = await fetch(`${address?.origin}/api/v1/invalidations`, {
      headers: { cookie: browser.cookie, "last-event-id": "03" },
      signal: invalidController.signal,
    });
    const invalidReader = invalid.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const invalidResync = await readUntil(invalidReader, "resync.required");
    expect(invalidResync).toContain('"reasonCode":"INVALID_INPUT"');
    expect(invalidResync).toContain('"eventId":"resync-invalid-cursor-3"');
    invalidController.abort();
    await invalidReader.cancel().catch(() => undefined);
  });

  it("serves a bounded polling fallback contract with cursor and resync semantics", async () => {
    const invalidationLog = new BoundedInvalidationLog({ maximumEvents: 3, maximumBytes: 4_096 });
    publish(invalidationLog, 1);
    publish(invalidationLog, 2);
    publish(invalidationLog, 3);
    await start({ invalidationLog, pollingFallbackMs: 1_250 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const headers = authorizedHeaders(browser);
    const first = await fetch(`${address?.origin}/api/v1/invalidations/poll?afterRevision=0&limit=2`, { headers });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { result: { events: { revision: number }[]; nextRevision: number; hasMore: boolean; retryAfterMs: number } };
    expect(firstBody.result).toMatchObject({ nextRevision: 2, hasMore: true, retryAfterMs: 1_250 });
    expect(firstBody.result.events.map(({ revision }) => revision)).toEqual([1, 2]);
    const second = await fetch(`${address?.origin}/api/v1/invalidations/poll?afterRevision=${firstBody.result.nextRevision}&limit=2`, { headers });
    expect((await second.json() as { result: { events: { revision: number }[] } }).result.events.map(({ revision }) => revision)).toEqual([3]);
    const future = await fetch(`${address?.origin}/api/v1/invalidations/poll?afterRevision=4`, { headers });
    expect((await future.json() as { result: { resyncRequired: boolean; events: unknown[] } }).result).toMatchObject({ resyncRequired: true, events: [] });
    expect((await fetch(`${address?.origin}/api/v1/invalidations/poll?afterRevision=01`, { headers })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/invalidations/poll?afterRevision=0&afterRevision=1`, { headers })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/invalidations/poll?afterRevision=0&unknown=1`, { headers })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/invalidations/poll?afterRevision=0`, {
      method: "POST",
      headers: { ...headers, origin: address?.origin ?? "" },
    })).status).toBe(405);
  });

  it("rejects unsafe SSE connection, pending-buffer, heartbeat and fallback limits", async () => {
    const invalidationLog = new BoundedInvalidationLog({ maximumEvents: 2, maximumBytes: 4_096 });
    const base = { queryPort, staticRoot, bootstrapToken: BOOTSTRAP_TOKEN, invalidationLog };
    await expect(createConsoleGateway({ ...base, maximumSseConnections: 0 })).rejects.toThrow(/maximumSseConnections/u);
    await expect(createConsoleGateway({ ...base, maximumSsePendingBytes: 4_096 })).rejects.toThrow(/maximumSsePendingBytes/u);
    await expect(createConsoleGateway({ ...base, sseHeartbeatMs: 99 })).rejects.toThrow(/sseHeartbeatMs/u);
    await expect(createConsoleGateway({ ...base, pollingFallbackMs: 99 })).rejects.toThrow(/pollingFallbackMs/u);
  });

  it("caps concurrent SSE connections and advertises polling fallback", async () => {
    await start({ maximumSseConnections: 1, pollingFallbackMs: 1_250 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const controller = new AbortController();
    const first = await fetch(`${address?.origin}/api/v1/invalidations`, {
      headers: { cookie: browser.cookie },
      signal: controller.signal,
    });
    expect(first.status).toBe(200);
    const limited = await fetch(`${address?.origin}/api/v1/invalidations`, { headers: { cookie: browser.cookie } });
    expect(limited.status).toBe(503);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect(await limited.text()).toContain("polling fallback");
    controller.abort();
    await first.body?.cancel().catch(() => undefined);
  });

  it("binds capture preview and commit to strict authenticated commands", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const headers = { ...authorizedHeaders(browser), origin: address?.origin ?? "", "content-type": "application/json" };
    const preview = await fetch(`${address?.origin}/api/v1/capture-jobs`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-1", dryRun: true }) });
    expect(preview.status).toBe(200);
    expect((await preview.json() as { result: CapturePreview }).result.previewRevision).toBe(7);
    const commit = await fetch(`${address?.origin}/api/v1/capture-jobs`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-1", dryRun: false, previewRevision: 7, transcriptIdentityHash: "a".repeat(64), idempotencyKey: "capture:session-1:revision-7" }) });
    expect(commit.status).toBe(200);
    expect((await commit.json() as { result: CaptureCommitResult }).result.knowledgeCompileStage.reasonCode).toBe("KNOWLEDGE_WORKER_NOT_COMPOSED");
    expect(commandPort.calls).toEqual(["preview:session-1", "commit:session-1:7:capture:session-1:revision-7"]);
    const forged = await fetch(`${address?.origin}/api/v1/capture-jobs`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-1", dryRun: true, unexpected: "field" }) });
    expect(forged.status).toBe(400);
  });

  it("forwards strict revision-bound Job commands and publishes only safe results", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const headers = { ...authorizedHeaders(browser), origin: address?.origin ?? "", "content-type": "application/json" };
    const cancel = await fetch(`${address?.origin}/api/v1/jobs/job-1/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 3, idempotencyKey: "operator:cancel:gateway:one" }),
    });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ result: { action: "CANCEL", disposition: "APPLIED", job: { jobId: "job-1", revision: 4 } } });
    const retry = await fetch(`${address?.origin}/api/v1/jobs/job-1/retry`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 4, idempotencyKey: "operator:retry:gateway:one" }),
    });
    expect(retry.status).toBe(200);
    expect(commandPort.calls).toEqual([
      "job:cancel:job-1:3:operator:cancel:gateway:one",
      "job:retry:job-1:4:operator:retry:gateway:one",
    ]);
    expect((await fetch(`${address?.origin}/api/v1/jobs/job-1/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 3, idempotencyKey: "operator:cancel:gateway:two", extra: true }),
    })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/jobs/job-1/cancel`, {
      method: "POST",
      headers: { ...headers, "x-zhiloop-csrf": "forged-token-that-is-long-enough" },
      body: JSON.stringify({ expectedRevision: 3, idempotencyKey: "operator:cancel:gateway:three" }),
    })).status).toBe(403);
  });

  it("serves evolution operations with bounded reads and CSRF-protected revision-bound commands", async () => {
    const repositoryIdentity = "a".repeat(64); const summaryHash = "b".repeat(64);
    const operations = { schemaVersion: 1 as const, consistency: "CONSISTENT" as const, observedAt: NOW,
      sections: ["COMPILE", "REVALIDATE", "REPAIR", "CODEGRAPH", "FRESHNESS", "MIGRATION", "ALERT", "INJECTION"].map((area) => ({
        area, revision: 0, status: "EMPTY", reasonCode: `${area}_EMPTY`, queued: 0, running: 0, failed: 0, updatedAt: NOW,
      })) };
    const codeGraphPreview = { schemaVersion: 1 as const, previewId: "codegraph-preview-1", projectId: "project-1",
      repositoryIdentity, repositoryRootLabel: "project-1 · …/workspace/project-1", targetDirectoryLabel: "project-1/.codegraph",
      expectedRevision: 0, currentStatus: "NOT_CONFIGURED" as const, riskCodes: ["WRITES_CODEGRAPH_INDEX"], createdAt: NOW, expiresAt: NOW };
    const migration = { schemaVersion: 1 as const, migrationId: "migration-1", migrationVersion: "v1", projectId: "project-1",
      sourceRegistryRevision: 1, status: "READY" as const, revision: 1, scannedCount: 1, migratableCount: 1,
      alreadyCurrentCount: 0, skippedCount: 0, failedCount: 0, rollbackConflictCount: 0, summaryHash, createdAt: NOW, updatedAt: NOW };
    const repairDraft = { draftId: "draft-1", projectId: "project-1", assetId: "knowledge-1", assetVersion: 1,
      conflictRunId: "run-1", status: "READY" as const, revision: 1, changedAssertions: [],
      reasonCodes: ["ASSERTION_UNSUPPORTED"], proposedCandidate: { candidateId: "candidate-1", title: "更新标题",
        summary: "更新摘要", body: "更新正文" }, createdAt: NOW, updatedAt: NOW };
    const operatorState = { revision: 1, acknowledgedAt: NOW, acknowledgedBy: "local-console", updatedAt: NOW };
    Object.assign(queryPort, {
      getEvolutionOperations: async () => { queryPort.calls.push("evolution:operations"); return operations; },
      getKnowledgeEvolution: async (knowledgeId: string) => { queryPort.calls.push(`knowledge:evolution:${knowledgeId}`); return {
        schemaVersion: 1, revision: 0, knowledgeId, knowledgeVersion: 1, projectId: "project-1", freshnessRevision: 0,
        verificationRuns: [], repairDrafts: [], jobs: [], revalidationAction: { enabled: true,
          expectedKnowledgeVersion: 1, expectedFreshnessRevision: 0, reasonCode: "ACTION_READY" }, observedAt: NOW,
      }; },
      listCodeGraphProjects: async (limit: number) => { queryPort.calls.push(`codegraph:${limit}`); return { revision: 0,
        items: [{ schemaVersion: 1, projectId: "project-1", repositoryIdentity, repositoryRootLabel: "project-1",
          status: "NOT_CONFIGURED", reasonCode: "CODEGRAPH_CAPABILITY_NOT_OBSERVED", revision: 0, evidenceRefs: [], observedAt: NOW }],
        bounded: false, observedAt: NOW }; },
      listOperationalAlerts: async (projectId: string | undefined, limit: number) => { queryPort.calls.push(`alerts:${projectId ?? "ALL"}:${limit}`);
        return { revision: 0, items: [], bounded: false, observedAt: NOW }; },
      listLegacyMigrations: async (projectId: string, limit: number) => { queryPort.calls.push(`migrations:${projectId}:${limit}`); return { items: [migration] }; },
      getLegacyMigration: async () => migration,
      listLegacyMigrationItems: async () => ({ items: [] }),
    });
    Object.assign(commandPort, {
      previewCodeGraphInitialization: async (projectId: string) => { commandPort.calls.push(`codegraph:preview:${projectId}`); return codeGraphPreview; },
      commitCodeGraphInitialization: async (command: { projectId: string; idempotencyKey: string }) => {
        commandPort.calls.push(`codegraph:commit:${command.projectId}:${command.idempotencyKey}`);
        return { preview: codeGraphPreview, job: { ...job, jobId: "codegraph-job-1", jobType: "CODEGRAPH_INITIALIZE", status: "QUEUED", progress: 0 } };
      },
      acknowledgeOperationalAlert: async (command: { alertId: string }) => { commandPort.calls.push(`alert:ack:${command.alertId}`);
        return { alertId: command.alertId, alertRevision: 1, operatorState }; },
      suppressOperationalAlert: async (command: { alertId: string }) => { commandPort.calls.push(`alert:suppress:${command.alertId}`);
        return { alertId: command.alertId, alertRevision: 1,
          operatorState: { ...operatorState, revision: 2, suppressedUntil: "2026-08-19T13:00:00.000Z" } }; },
      previewLegacyMigration: async (projectId: string) => { commandPort.calls.push(`migration:preview:${projectId}`); return migration; },
      commitLegacyMigration: async (command: { migrationId: string }) => {
        commandPort.calls.push(`migration:commit:${command.migrationId}`);
        return { preview: { ...migration, status: "COMMITTING", revision: 2 },
          job: { ...job, jobId: "migration-job-1", jobType: "LEGACY_KNOWLEDGE_MIGRATION", status: "QUEUED", progress: 0 } };
      },
      rollbackLegacyMigration: async (command: { migrationId: string }) => { commandPort.calls.push(`migration:rollback:${command.migrationId}`);
        return { ...migration, status: "ROLLED_BACK", revision: 2 }; },
      revalidateKnowledge: async (command: { knowledgeId: string }) => { commandPort.calls.push(`knowledge:revalidate:${command.knowledgeId}`);
        return { knowledgeId: command.knowledgeId, knowledgeVersion: 1, disposition: "NO_CHANGES", reasonCode: "CODE_REVISION_ALREADY_CURRENT", observedAt: NOW }; },
      submitRepairCandidate: async (command: { draftId: string }) => { commandPort.calls.push(`repair:submit:${command.draftId}`);
        return { draft: repairDraft }; },
    });
    await start(); const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const readHeaders = authorizedHeaders(browser);
    for (const target of ["/api/v1/evolution/operations", "/api/v1/codegraph/projects?limit=10",
      "/api/v1/alerts?projectId=project-1&limit=10", "/api/v1/migrations?projectId=project-1&limit=10",
      "/api/v1/knowledge/knowledge-1/evolution"]) {
      expect((await fetch(`${address?.origin}${target}`, { headers: readHeaders })).status, target).toBe(200);
    }
    const commandHeaders = { ...readHeaders, origin: address?.origin ?? "", "content-type": "application/json" };
    const previewResponse = await fetch(`${address?.origin}/api/v1/codegraph/projects/project-1/preview`, {
      method: "POST", headers: commandHeaders, body: "{}",
    });
    expect(previewResponse.status).toBe(200);
    const commitBody = JSON.stringify({ previewId: codeGraphPreview.previewId, repositoryIdentity,
      expectedRevision: 0, idempotencyKey: "codegraph:commit:one" });
    const missingCsrf = await fetch(`${address?.origin}/api/v1/codegraph/projects/project-1/commit`, {
      method: "POST", headers: { cookie: browser.cookie, origin: address?.origin ?? "", "content-type": "application/json" }, body: commitBody,
    });
    expect(missingCsrf.status).toBe(403);
    const commit = await fetch(`${address?.origin}/api/v1/codegraph/projects/project-1/commit`, {
      method: "POST", headers: commandHeaders, body: commitBody,
    });
    expect(commit.status).toBe(202);
    const revalidate = await fetch(`${address?.origin}/api/v1/knowledge/knowledge-1/revalidate`, { method: "POST", headers: commandHeaders,
      body: JSON.stringify({ expectedKnowledgeVersion: 1, expectedFreshnessRevision: 0, idempotencyKey: "revalidate:one" }) });
    expect(revalidate.status).toBe(202);
    expect((await fetch(`${address?.origin}/api/v1/alerts/alert-1/acknowledge`, { method: "POST", headers: commandHeaders,
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: "alert:ack:one" }) })).status).toBe(200);
    expect((await fetch(`${address?.origin}/api/v1/alerts/alert-1/suppress`, { method: "POST", headers: commandHeaders,
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: "alert:suppress:one",
        suppressedUntil: "2026-08-19T13:00:00.000Z" }) })).status).toBe(200);
    expect((await fetch(`${address?.origin}/api/v1/migrations/preview`, { method: "POST", headers: commandHeaders,
      body: JSON.stringify({ projectId: "project-1" }) })).status).toBe(200);
    expect((await fetch(`${address?.origin}/api/v1/migrations/migration-1`, { headers: readHeaders })).status).toBe(200);
    expect((await fetch(`${address?.origin}/api/v1/migrations/migration-1/items?limit=10&afterOrdinal=0`,
      { headers: readHeaders })).status).toBe(200);
    expect((await fetch(`${address?.origin}/api/v1/migrations/migration-1/commit`, { method: "POST", headers: commandHeaders,
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: "migration:commit:one" }) })).status).toBe(202);
    expect((await fetch(`${address?.origin}/api/v1/migrations/migration-1/rollback`, { method: "POST", headers: commandHeaders,
      body: JSON.stringify({ expectedRevision: 2, idempotencyKey: "migration:rollback:one" }) })).status).toBe(200);
    expect((await fetch(`${address?.origin}/api/v1/repair-drafts/draft-1/submit`, { method: "POST", headers: commandHeaders,
      body: JSON.stringify({ expectedRevision: 0, idempotencyKey: "repair:submit:one", title: "更新标题",
        summary: "更新摘要", body: "更新正文" }) })).status).toBe(200);
    expect(commandPort.calls).toEqual(["codegraph:preview:project-1", "codegraph:commit:project-1:codegraph:commit:one",
      "knowledge:revalidate:knowledge-1", "alert:ack:alert-1", "alert:suppress:alert-1",
      "migration:preview:project-1", "migration:commit:migration-1", "migration:rollback:migration-1",
      "repair:submit:draft-1"]);
    expect((await fetch(`${address?.origin}/api/v1/alerts?limit=1&limit=2`, { headers: readHeaders })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/migrations/migration-1/items?unknown=1`, { headers: readHeaders })).status).toBe(400);
  });

  it("rejects malformed evolution-operation routes and repair payloads before reaching control ports", async () => {
    const unreachable = async () => { throw new Error("control port must not be called for invalid input"); };
    Object.assign(queryPort, { getEvolutionOperations: unreachable, getKnowledgeEvolution: unreachable,
      listCodeGraphProjects: unreachable, listOperationalAlerts: unreachable, listLegacyMigrations: unreachable,
      getLegacyMigration: unreachable, listLegacyMigrationItems: unreachable });
    Object.assign(commandPort, { previewCodeGraphInitialization: unreachable, commitCodeGraphInitialization: unreachable,
      acknowledgeOperationalAlert: unreachable, suppressOperationalAlert: unreachable, previewLegacyMigration: unreachable,
      commitLegacyMigration: unreachable, rollbackLegacyMigration: unreachable, revalidateKnowledge: unreachable,
      submitRepairCandidate: unreachable });
    await start(); const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const readHeaders = authorizedHeaders(browser);
    const jsonHeaders = { ...readHeaders, origin: address?.origin ?? "", "content-type": "application/json" };
    const noJsonHeaders = { ...readHeaders, origin: address?.origin ?? "" };
    const status = async (target: string, expected: number, init: RequestInit = { headers: readHeaders }) => {
      expect((await fetch(`${address?.origin}${target}`, init)).status, target).toBe(expected);
    };

    await status("/api/v1/evolution/operations", 405, { method: "POST", headers: jsonHeaders, body: "{}" });
    await status("/api/v1/evolution/operations?unexpected=1", 503);
    for (const target of ["/api/v1/codegraph/projects?unexpected=1", "/api/v1/codegraph/projects?limit=1&limit=2",
      "/api/v1/codegraph/projects?limit=0", "/api/v1/codegraph/projects?limit=1.5", "/api/v1/codegraph/projects?limit=101"]) {
      await status(target, 400);
    }
    await status("/api/v1/codegraph/projects", 400, { method: "POST", headers: jsonHeaders, body: "{}" });
    await status("/api/v1/codegraph/projects/project-1/preview", 400);
    await status("/api/v1/codegraph/projects/project-1/preview?unexpected=1", 400,
      { method: "POST", headers: jsonHeaders, body: "{}" });
    await status("/api/v1/codegraph/projects/project-1/preview", 400, { method: "POST", headers: noJsonHeaders, body: "{}" });
    await status("/api/v1/codegraph/projects/project-1/preview", 400, { method: "POST", headers: jsonHeaders, body: "{" });
    await status("/api/v1/codegraph/projects/project-1/preview", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ unexpected: true }) });
    await status("/api/v1/codegraph/projects/project-1/commit", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ previewId: "preview-1" }) });

    for (const target of ["/api/v1/alerts?unexpected=1", "/api/v1/alerts?projectId=a&projectId=b",
      "/api/v1/alerts?cursor=a&cursor=b", "/api/v1/alerts?limit=0", "/api/v1/alerts?limit=1.5",
      "/api/v1/alerts?limit=101", "/api/v1/alerts?projectId=%20bad"]) await status(target, 400);
    await status("/api/v1/alerts", 400, { method: "POST", headers: jsonHeaders, body: "{}" });
    await status("/api/v1/alerts/alert-1/acknowledge", 400);
    await status("/api/v1/alerts/alert-1/acknowledge?unexpected=1", 400,
      { method: "POST", headers: jsonHeaders, body: "{}" });
    await status("/api/v1/alerts/alert-1/acknowledge", 400, { method: "POST", headers: noJsonHeaders, body: "{}" });
    await status("/api/v1/alerts/alert-1/acknowledge", 400, { method: "POST", headers: jsonHeaders, body: "{" });
    await status("/api/v1/alerts/alert-1/acknowledge", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ expectedRevision: 1, idempotencyKey: "one", extra: true }) });
    await status("/api/v1/alerts/alert-1/suppress", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ expectedRevision: 1, idempotencyKey: "one" }) });

    for (const target of ["/api/v1/migrations", "/api/v1/migrations?unexpected=1",
      "/api/v1/migrations?projectId=a&projectId=b", "/api/v1/migrations?projectId=project-1&limit=0",
      "/api/v1/migrations?projectId=project-1&limit=1.5", "/api/v1/migrations?projectId=project-1&limit=101",
      "/api/v1/migrations?projectId=%20bad"]) await status(target, 400);
    await status("/api/v1/migrations/preview", 405);
    await status("/api/v1/migrations/preview?unexpected=1", 405, { method: "POST", headers: jsonHeaders, body: "{}" });
    await status("/api/v1/migrations/preview", 405, { method: "POST", headers: noJsonHeaders, body: "{}" });
    await status("/api/v1/migrations/preview", 400, { method: "POST", headers: jsonHeaders, body: "{" });
    await status("/api/v1/migrations/preview", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ projectId: " bad" }) });
    await status("/api/v1/migrations/%20bad", 400);
    await status("/api/v1/migrations/migration-1?unexpected=1", 405);
    for (const target of ["/api/v1/migrations/migration-1/items?unexpected=1",
      "/api/v1/migrations/migration-1/items?limit=1&limit=2", "/api/v1/migrations/migration-1/items?afterOrdinal=1&afterOrdinal=2",
      "/api/v1/migrations/migration-1/items?limit=0", "/api/v1/migrations/migration-1/items?limit=1.5",
      "/api/v1/migrations/migration-1/items?limit=101", "/api/v1/migrations/migration-1/items?afterOrdinal=-1",
      "/api/v1/migrations/migration-1/items?afterOrdinal=1.5"]) await status(target, 400);
    await status("/api/v1/migrations/migration-1/commit", 405);
    await status("/api/v1/migrations/migration-1/commit", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ expectedRevision: 1 }) });

    await status("/api/v1/knowledge/%20bad/evolution", 400);
    await status("/api/v1/knowledge/knowledge-1/evolution?unexpected=1", 400);
    await status("/api/v1/knowledge/knowledge-1/evolution", 405, { method: "POST", headers: jsonHeaders, body: "{}" });
    await status("/api/v1/knowledge/knowledge-1/revalidate", 405);
    await status("/api/v1/knowledge/knowledge-1/revalidate", 405, { method: "POST", headers: noJsonHeaders, body: "{}" });
    await status("/api/v1/knowledge/knowledge-1/revalidate", 400, { method: "POST", headers: jsonHeaders, body: "{" });
    await status("/api/v1/knowledge/knowledge-1/revalidate", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ expectedKnowledgeVersion: 1 }) });

    const validRepair = { expectedRevision: 0, idempotencyKey: "repair-one", title: "标题", summary: "摘要", body: "正文" };
    await status("/api/v1/repair-drafts/%20bad/submit", 405, { method: "POST", headers: jsonHeaders, body: JSON.stringify(validRepair) });
    await status("/api/v1/repair-drafts/draft-1/submit?unexpected=1", 405,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify(validRepair) });
    await status("/api/v1/repair-drafts/draft-1/submit", 405);
    await status("/api/v1/repair-drafts/draft-1/submit", 405,
      { method: "POST", headers: noJsonHeaders, body: JSON.stringify(validRepair) });
    await status("/api/v1/repair-drafts/draft-1/submit", 400, { method: "POST", headers: jsonHeaders, body: "{" });
    await status("/api/v1/repair-drafts/draft-1/submit", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...validRepair, extra: true }) });
    const invalidRepairs: readonly Record<string, unknown>[] = [
      { ...validRepair, expectedRevision: -1 }, { ...validRepair, expectedRevision: 1.5 },
      { ...validRepair, idempotencyKey: 1 }, { ...validRepair, idempotencyKey: "" },
      { ...validRepair, idempotencyKey: "x".repeat(501) }, { ...validRepair, title: 1 }, { ...validRepair, title: " " },
      { ...validRepair, title: "x".repeat(2_001) }, { ...validRepair, summary: 1 }, { ...validRepair, summary: " " },
      { ...validRepair, summary: "x".repeat(20_001) }, { ...validRepair, body: 1 }, { ...validRepair, body: " " },
      { ...validRepair, body: "x".repeat(64_001) }, { ...validRepair, body: "bad\0body" },
    ];
    for (const body of invalidRepairs) await status("/api/v1/repair-drafts/draft-1/submit", 400,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
    expect(commandPort.calls).toEqual([]);
  });

  it("rejects malformed P2 filters and percent-encoded targets at the HTTP boundary", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const headers = authorizedHeaders(browser);
    expect((await fetch(`${address?.origin}/api/v1/knowledge?eligible=yes`, { headers })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/knowledge?version=0`, { headers })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/knowledge/%E0%A4%A`, { headers })).status).toBe(400);
    expect((await fetch(`${address?.origin}/api/v1/sessions/%E0%A4%A/extraction`, { headers })).status).toBe(400);
  });

  it("exposes strict authenticated P3 search, ask, simulate, and trace views", async () => {
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const headers = { ...authorizedHeaders(browser), origin: address?.origin ?? "", "content-type": "application/json" };
    const body = {
      requestId: "request-gateway-p3",
      query: "How does ConfigService work?",
      projectId: "project-a",
      taskId: "task-p3",
      maxResults: 10,
      maxContextTokens: 800,
      timeoutMs: 1_000,
    };
    for (const operation of ["search", "ask", "simulate"] as const) {
      const response = await fetch(`${address?.origin}/api/v1/retrieval/${operation}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      expect(response.status, operation).toBe(200);
      expect((await response.json() as { ok: boolean }).ok).toBe(true);
    }
    const trace = await fetch(`${address?.origin}/api/v1/retrieval/traces/trace-gateway-p3?projectId=project-a&taskId=task-p3`, {
      headers: authorizedHeaders(browser),
    });
    expect(trace.status).toBe(200);
    expect((await trace.json() as { result: RetrievalTraceContract }).result.injectionResult).toBe("NO_CONTEXT");
    expect(queryPort.calls).toEqual(["p3:search", "p3:ask", "p3:simulate", "p3:trace"]);

    const forged = await fetch(`${address?.origin}/api/v1/retrieval/search`, {
      method: "POST", headers, body: JSON.stringify({ ...body, unexpectedPermission: "cross-project" }),
    });
    expect(forged.status).toBe(400);
    expect(queryPort.calls).toHaveLength(4);
    expect((await fetch(`${address?.origin}/api/v1/retrieval/traces/trace-gateway-p3?projectId=a&projectId=b`, {
      headers: authorizedHeaders(browser),
    })).status).toBe(400);
  });

  it("keeps ordinary queries short while allowing a separately bounded model-backed ask", async () => {
    queryPort.askDelayMs = 40;
    await start({ queryTimeoutMs: 20, modelQueryTimeoutMs: 100 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const response = await fetch(`${address?.origin}/api/v1/retrieval/ask`, {
      method: "POST",
      headers: { ...authorizedHeaders(browser), origin: address?.origin ?? "", "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request-long-ask", query: "How does ConfigService work?", projectId: "project-a",
        maxResults: 10, maxContextTokens: 800, timeoutMs: 100,
      }),
    });
    expect(response.status).toBe(200);
    expect(queryPort.calls).toContain("p3:ask");
  });

  it("preserves stale-preview conflicts without reflecting Sidecar details", async () => {
    commandPort.failure = new ControlClientError("private transcript changed", "REMOTE_ERROR", "STALE_REVISION");
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const response = await fetch(`${address?.origin}/api/v1/capture-jobs`, {
      method: "POST",
      headers: { ...authorizedHeaders(browser), origin: address?.origin ?? "", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", dryRun: true }),
    });
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("STALE_REVISION");
    expect(body).not.toContain("private transcript changed");
  });

  it("bounds oversized views without leaking view content", async () => {
    queryPort.overview = {
      ...overview,
      recentSessions: Array.from({ length: 20 }, (_value, index) => ({
        ...session,
        sessionId: `session-${index}`,
        title: "x".repeat(300),
      })),
    };
    await start({ maximumJsonResponseBytes: 512 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const response = await fetch(`${address?.origin}/api/v1/overview`, { headers: authorizedHeaders(browser) });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("Response exceeded the configured byte limit");
    expect(body).not.toContain("x".repeat(100));
  });

  it("aborts timed-out queries and returns a redacted diagnostic", async () => {
    queryPort.hang = true;
    await start({ queryTimeoutMs: 20 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const response = await fetch(`${address?.origin}/api/v1/overview`, { headers: authorizedHeaders(browser) });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Control API query is unavailable");
  });

  it("rate limits browser requests before forwarding to the query port", async () => {
    await start({ maximumRequestsPerWindow: 2 });
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const response = await fetch(`${address?.origin}/api/v1/overview`, { headers: authorizedHeaders(browser) });
    expect(response.status).toBe(200);
    const limited = await fetch(`${address?.origin}/api/v1/overview`, { headers: authorizedHeaders(browser) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(queryPort.calls).toEqual(["overview"]);
  });

  it("never reflects Sidecar errors, secrets or prompt content", async () => {
    queryPort.failure = new Error("Authorization: Bearer super-secret raw prompt: delete everything");
    await start();
    const browser = (await authenticate()).browser as AuthenticatedBrowser;
    const response = await fetch(`${address?.origin}/api/v1/diagnostics`, { headers: authorizedHeaders(browser) });
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toMatch(/super-secret|raw prompt|authorization|delete everything/iu);
  });

  it("rejects oversized and query-string bootstrap secrets", async () => {
    await start();
    const querySecret = await fetch(`${address?.origin}/api/v1/auth/exchange?token=${BOOTSTRAP_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: address?.origin ?? "" },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    expect(querySecret.status).toBe(400);
    const oversized = await fetch(`${address?.origin}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: address?.origin ?? "" },
      body: JSON.stringify({ token: "z".repeat(9_000) }),
    });
    expect(oversized.status).toBe(413);
  });
});

function rawRequest(
  address: ConsoleGatewayAddress,
  requestPath: string,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: address.host,
      port: address.port,
      path: requestPath,
      method: "GET",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}
