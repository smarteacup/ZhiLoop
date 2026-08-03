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
  filters: [], results: [],
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
  schemaVersion: 1 as const,
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

  public askKnowledge(command: P3ConsoleQueryBody, options: QueryOptions): Promise<P3AskResponse> {
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
    return { schemaVersion: 1, sessionId, previewRevision: 7, transcriptIdentityHash: "a".repeat(64), projectedEvents: 3, ignoredRecords: 0, eventTypes: { USER_PROMPT: 1 }, cursor: { byteOffset: 100, lineNumber: 4 }, hasMore: false, expiresAt: NOW };
  }

  public async commitCapture(command: CaptureCommitCommand): Promise<CaptureCommitResult> {
    if (this.failure) throw this.failure;
    this.calls.push(`commit:${command.sessionId}:${command.previewRevision}:${command.idempotencyKey}`);
    return { schemaVersion: 1, sessionId: command.sessionId, previewRevision: command.previewRevision, appendedEvents: 3, duplicateEvents: 0, cursor: { byteOffset: 100, lineNumber: 4 }, knowledgeCompileStage: { schemaVersion: 1, entityId: command.sessionId, stage: "KNOWLEDGE_COMPILE", status: "DISABLED", reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED", observedAt: NOW, lastTransitionAt: NOW, retryable: false, evidenceRefs: [] } };
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
