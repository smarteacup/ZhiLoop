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
  type Diagnostics,
  type EventMetadata,
  type JobSnapshot,
  type Overview,
  type SessionDetail,
  type SessionSummary,
} from "@zhiloop/control-api";

import type { CaptureCommitCommand, ControlCommandPort, ControlQueryPort, Page, PageQuery, QueryOptions } from "./ports.js";
import { ControlClientError } from "./control-client.js";
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
