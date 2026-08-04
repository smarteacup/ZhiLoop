import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

import { SqliteRealCodexAcceptanceEvidenceStore } from "@zhiloop/automatic-ingestion";
import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import { CONTROL_API_SCHEMA_VERSION, type CapabilitySnapshot, type ControlRequest, type ControlResponse } from "@zhiloop/control-api";
import { resolveDeploymentPaths } from "@zhiloop/local-deployment";
import { resolveQueryContext } from "@zhiloop/query-context";
import { snapshotIdempotencyKey } from "@zhiloop/session-extraction";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidecarApplication } from "./application.js";
import { loadSidecarConfig, parseSidecarConfig, type SidecarConfig } from "./config.js";
import { runDeploymentCli } from "./deployment-cli.js";
import { SafeDiagnosticLog } from "./diagnostic-log.js";
import { runHookCommand } from "./hook-command.js";
import { requestSidecar, startSidecarServer, stopSidecarServer } from "./transport.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function temporaryConfig(overrides: Partial<SidecarConfig> = {}): Promise<{ root: string; config: SidecarConfig }> {
  const root = await mkdtemp(join(tmpdir(), "zhiloop-sidecar-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const config: SidecarConfig = {
    schemaVersion: 1,
    rolloutMode: "SHADOW",
    socketPath: join(root, "run", "sidecar.sock"),
    codexSessionsRoot: join(root, ".codex", "sessions"),
    ledgerPath: join(root, "state", "events.sqlite"),
    spoolPath: join(root, "spool"),
    logPath: join(root, "logs", "sidecar.jsonl"),
    hookMaxInputBytes: 5_242_880,
    hookTimeoutMs: 100,
    logMaxBytes: 1_024,
    logRetainFiles: 2,
    ...overrides,
  };
  return { root, config };
}

function outputSink(): { output: Writable; text: () => string } {
  let value = "";
  const output = new Writable({ write(chunk, _encoding, callback) { value += String(chunk); callback(); } });
  return { output, text: () => value };
}

function rolloutRecord(type: string, timestamp: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type, timestamp, payload })}\n`;
}

async function writeRollout(config: SidecarConfig, sessionId: string): Promise<void> {
  const directory = join(config.codexSessionsRoot, "2026", "08", "03");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-${sessionId}.jsonl`), [
    rolloutRecord("session_meta", "2026-08-03T00:00:00.000Z", { id: sessionId, session_id: sessionId, cli_version: "0.145.0" }),
    rolloutRecord("event_msg", "2026-08-03T00:00:01.000Z", { type: "task_started", turn_id: "turn-1" }),
    rolloutRecord("event_msg", "2026-08-03T00:00:02.000Z", { type: "user_message", message: "capture me sk-abcdefghijklmnop" }),
    rolloutRecord("event_msg", "2026-08-03T00:00:03.000Z", { type: "task_complete", turn_id: "turn-1", last_agent_message: "captured" }),
  ].join(""));
}

async function writeFreshRollout(config: SidecarConfig, sessionId: string, createdAt: string): Promise<void> {
  const directory = join(config.codexSessionsRoot, "2026", "08", "04");
  await mkdir(directory, { recursive: true });
  const start = Date.parse(createdAt) + 100;
  await writeFile(join(directory, `rollout-${sessionId}.jsonl`), [
    rolloutRecord("session_meta", new Date(start).toISOString(), { id: sessionId, session_id: sessionId, cli_version: "0.145.0" }),
    rolloutRecord("event_msg", new Date(start + 100).toISOString(), { type: "task_started", turn_id: "acceptance-turn" }),
    rolloutRecord("event_msg", new Date(start + 200).toISOString(), { type: "user_message", message: "content-is-not-evidence" }),
  ].join(""));
}

function controlResult(response: unknown): unknown {
  const value = response as ControlResponse;
  expect(value).toMatchObject({ schemaVersion: CONTROL_API_SCHEMA_VERSION, ok: true });
  if (!value.ok) throw new Error("expected successful control response");
  return value.result;
}

async function sendRawFrames(socketPath: string, serialized: string): Promise<unknown> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(serialized);
  const chunks: Buffer[] = [];
  return await new Promise<unknown>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("sidecar configuration", () => {
  it("loads a regular absolute SHADOW configuration and applies bounded defaults", async () => {
    const { root, config } = await temporaryConfig();
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      rolloutMode: "SHADOW",
      socketPath: config.socketPath,
      codexSessionsRoot: config.codexSessionsRoot,
      ledgerPath: config.ledgerPath,
      spoolPath: config.spoolPath,
      logPath: config.logPath,
    }));
    expect(await loadSidecarConfig(path)).toMatchObject({ rolloutMode: "SHADOW", hookTimeoutMs: 750, logRetainFiles: 3 });
  });

  it("rejects ACTIVE, relative paths, invalid bounds, and symlinked configuration", async () => {
    const { root, config } = await temporaryConfig();
    expect(() => parseSidecarConfig({ ...config, rolloutMode: "ACTIVE" })).toThrow("SHADOW");
    expect(() => parseSidecarConfig({ ...config, socketPath: "relative.sock" })).toThrow("absolute");
    expect(() => parseSidecarConfig({ ...config, hookTimeoutMs: 3_001 })).toThrow("hookTimeoutMs");
    const target = join(root, "target.json");
    const link = join(root, "config.json");
    await writeFile(target, JSON.stringify(config));
    await symlink(target, link);
    await expect(loadSidecarConfig(link)).rejects.toThrow("regular file");
  });

  it("strictly validates optional Codex query composition", async () => {
    const { config } = await temporaryConfig();
    expect(parseSidecarConfig({ ...config, codexQuery: { enabled: true, executable: "/usr/local/bin/codex", model: "gpt-test", userConfiguration: "IGNORE" } }))
      .toMatchObject({ codexQuery: { enabled: true, executable: "/usr/local/bin/codex", model: "gpt-test", userConfiguration: "IGNORE" } });
    expect(() => parseSidecarConfig({ ...config, codexQuery: { enabled: false, executable: "codex", userConfiguration: "ALLOW" } }))
      .toThrow("disabled codexQuery");
    expect(() => parseSidecarConfig({ ...config, codexQuery: { enabled: true, executable: "codex", userConfiguration: "ALLOW" } }))
      .toThrow("absolute path");
    expect(() => parseSidecarConfig({ ...config, codexQuery: { enabled: true, userConfiguration: "FORGED" } }))
      .toThrow("userConfiguration");
    expect(() => parseSidecarConfig({ ...config, unknownPermission: "cross-project" })).toThrow("unknown fields");
  });
});

describe("sidecar service", () => {
  it("serves strict P3 SHADOW retrieval and reports derived capabilities", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    cleanups.push(async () => { await stopSidecarServer(server, config.socketPath); await application.close(); });

    const response = await requestSidecar(config.socketPath, {
      schemaVersion: 1,
      requestId: "request-sidecar-p3",
      type: "p3.knowledge.search",
      query: "ConfigService",
      projectId: "project-a",
      maxResults: 10,
      maxContextTokens: 800,
      timeoutMs: 100,
    }, 1_000) as ControlResponse;
    expect(response).toMatchObject({
      requestId: "request-sidecar-p3",
      ok: true,
      result: { schemaVersion: 1, kind: "SEARCH", trace: { results: [], injectionResult: "NO_CONTEXT" } },
    });
    const capabilities = controlResult(await requestSidecar(config.socketPath, {
      schemaVersion: 1,
      requestId: "request-sidecar-p3-capabilities",
      type: "capabilities.list",
      page: { limit: 100 },
    }, 1_000)) as { items: CapabilitySnapshot[] };
    expect(capabilities.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "knowledge.retrieval", status: "READY", reasonCode: "COMPONENT_READY" }),
      expect.objectContaining({ capabilityId: "codex.query", status: "NOT_CONFIGURED", reasonCode: "CAPABILITY_NOT_CONFIGURED" }),
    ]));
    expect(await sendRawFrames(config.socketPath, `${JSON.stringify({
      schemaVersion: 1,
      requestId: "request-sidecar-p3-forged",
      type: "p3.knowledge.search",
      query: "ConfigService",
      maxResults: 10,
      maxContextTokens: 800,
      unexpectedPermission: "cross-project",
    })}\n`)).toEqual({ ok: false, errorCode: "INVALID_REQUEST" });
  });

  it("captures a hook into the ledger while returning no SHADOW context", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    cleanups.push(async () => { await stopSidecarServer(server, config.socketPath); await application.close(); });

    expect(await requestSidecar(config.socketPath, { type: "health" }, 100)).toMatchObject({
      status: "READY",
      sidecarVersion: "0.3.11",
      rolloutMode: "SHADOW",
      socketStatus: "READY",
    });
    const secretPrompt = "implement the design with token sk-test-secret-value";
    const result = await requestSidecar(config.socketPath, {
      type: "hook",
      input: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/tmp/project",
        prompt: secretPrompt,
      },
    }, 100);
    expect(result).toBe("");
    let workerHealth: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      workerHealth = await requestSidecar(config.socketPath, { type: "health" }, 100);
      if ((workerHealth as { lastWorkerCycle?: { cursor?: number } }).lastWorkerCycle?.cursor === 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(workerHealth).toMatchObject({ lastWorkerCycle: { cursor: 1 } });
    const events = controlResult(await requestSidecar(config.socketPath, {
      schemaVersion: 1,
      requestId: "hook-events-request",
      type: "session.events.list",
      sessionId: "session-1",
      page: { limit: 10 },
    }, 1_000)) as { items: Array<{ sessionId: string; eventType: string }> };
    expect(events.items).toEqual([expect.objectContaining({ sessionId: "session-1", eventType: "user.prompted" })]);
    expect(await readFile(config.logPath, "utf8")).not.toContain(secretPrompt);

    await stopSidecarServer(server, config.socketPath);
    await application.close();
    cleanups.pop();
    const ledger = new SqliteEventLedger(config.ledgerPath);
    expect(ledger.count()).toBe(1);
    ledger.close();
  });

  it("keeps synchronous acceptance persistence off the Hook response path", async () => {
    const delayMs = 300;
    let persisted = false;
    const recordMany = vi.spyOn(SqliteRealCodexAcceptanceEvidenceStore.prototype, "recordMany")
      .mockImplementation(() => {
        persisted = true;
        const until = Date.now() + delayMs;
        while (Date.now() < until) { /* Simulate a slow FULL SQLite transaction. */ }
        return Object.freeze([]);
      });
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    try {
      const startedAt = Date.now();
      await application.handleHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "non-blocking-acceptance",
        turn_id: "turn-1",
        prompt: "never persisted as acceptance evidence",
      });
      expect(Date.now() - startedAt).toBeLessThan(delayMs / 2);
    } finally {
      await application.close();
      recordMany.mockRestore();
    }
    expect(persisted).toBe(true);
  });

  it("verifies an exact fresh task through Hook, spool, Ledger, catalog and cursor via the deployed CLI", async () => {
    const temporary = await temporaryConfig();
    const paths = resolveDeploymentPaths(temporary.root, "0.0.0");
    const config = { ...temporary.config, socketPath: paths.socketPath };
    const sessionId = "real-acceptance-session";
    const taskCreatedAt = new Date(Date.now() - 1_000).toISOString();
    await writeFreshRollout(config, sessionId, taskCreatedAt);
    let application = await SidecarApplication.create(config);
    await application.start();
    let server = await startSidecarServer(config.socketPath, application);
    try {
      const privatePrompt = "acceptance prompt sk-private-value";
      expect(await application.handleHook({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        turn_id: "acceptance-turn",
        cwd: "/Users/private/acceptance-project",
        prompt: privatePrompt,
      })).toBe("");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const health = await application.health();
        if (health.lastWorkerCycle?.cursor !== undefined && health.lastWorkerCycle.cursor > 0) break;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      await application.captureSession({ sessionId, dryRun: false });

      const stdout = outputSink();
      const stderr = outputSink();
      expect(await runDeploymentCli([
        "acceptance",
        "--session", sessionId,
        "--created-at", taskCreatedAt,
        "--home", temporary.root,
        "--json",
      ], stdout.output, stderr.output)).toBe(0);
      expect(JSON.parse(stdout.text())).toMatchObject({
        request: { sessionId, taskCreatedAt },
        result: { status: "VERIFIED", verifiedStages: ["HOOK", "SPOOL", "LEDGER", "CATALOG", "CURSOR"] },
        evidenceRef: expect.stringMatching(/^acceptance:[a-f0-9]{64}$/u),
      });
      expect(stderr.text()).toBe("");
      const capabilities = controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "real-acceptance-capability",
        type: "capabilities.list",
        page: { limit: 50 },
      })) as { items: Array<{ capabilityId: string; status: string }> };
      expect(capabilities.items).toContainEqual(expect.objectContaining({ capabilityId: "codex.live-hook", status: "READY" }));

      await stopSidecarServer(server, config.socketPath);
      await application.close();
      const evidenceBytes = await readFile(join(dirname(config.ledgerPath), "real-codex-acceptance.sqlite"), "utf8");
      expect(evidenceBytes).not.toContain(privatePrompt);
      expect(evidenceBytes).not.toContain("/Users/private/acceptance-project");

      application = await SidecarApplication.create(config);
      await application.start();
      server = await startSidecarServer(config.socketPath, application);
      const restored = controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "real-acceptance-restored",
        type: "capabilities.list",
        page: { limit: 50 },
      })) as { items: Array<{ capabilityId: string; status: string }> };
      expect(restored.items).toContainEqual(expect.objectContaining({ capabilityId: "codex.live-hook", status: "READY" }));
    } finally {
      await stopSidecarServer(server, config.socketPath).catch(() => undefined);
      await application.close().catch(() => undefined);
    }
  });

  it("previews and serializes active session captures while Hook capture remains independent", async () => {
    const { config } = await temporaryConfig();
    await writeRollout(config, "session-capture");
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    cleanups.push(async () => { await stopSidecarServer(server, config.socketPath); await application.close(); });

    await expect(requestSidecar(config.socketPath, {
      type: "capture-session",
      sessionId: "session-capture",
      dryRun: true,
    }, 1_000)).resolves.toMatchObject({ status: "PREVIEWED", projectedEvents: 3, appendedEvents: 0 });

    const [first, second, hook] = await Promise.all([
      requestSidecar(config.socketPath, { type: "capture-session", sessionId: "session-capture", dryRun: false }, 1_000),
      requestSidecar(config.socketPath, { type: "capture-session", sessionId: "session-capture", dryRun: false }, 1_000),
      requestSidecar(config.socketPath, {
        type: "hook",
        input: {
          hook_event_name: "UserPromptSubmit",
          session_id: "live-session",
          turn_id: "live-turn",
          prompt: "live prompt",
        },
      }, 1_000),
    ]);
    expect(hook).toBe("");
    expect([first, second].map((value) => (value as { appendedEvents: number }).appendedEvents).sort()).toEqual([0, 3]);

    await stopSidecarServer(server, config.socketPath);
    await application.close();
    cleanups.pop();
    const ledger = new SqliteEventLedger(config.ledgerPath);
    expect(ledger.count()).toBe(4);
    expect(ledger.loadIngestionCursor("codex-transcript:session-capture")).toBeDefined();
    ledger.close();
  });

  it("rejects malformed capture transport requests with a stable content-free code", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      await expect(requestSidecar(config.socketPath, {
        type: "capture-session",
        sessionId: 42,
        dryRun: false,
      } as never, 1_000)).rejects.toMatchObject({ code: "REQUEST_FAILED" });
      await expect(requestSidecar(config.socketPath, {
        type: "acceptance.verify",
        sessionId: "unsafe session",
        taskCreatedAt: "not-a-timestamp",
      } as never, 1_000)).rejects.toMatchObject({ code: "INVALID_ACCEPTANCE_REQUEST" });
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });

  it("returns numeric transcript diagnostics without returning the malformed content", async () => {
    const { config } = await temporaryConfig();
    const directory = join(config.codexSessionsRoot, "2026", "08", "03");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "rollout-session-malformed.jsonl"), [
      rolloutRecord("session_meta", "2026-08-03T00:00:00.000Z", { session_id: "session-malformed", cli_version: "0.145.0" }),
      "malformed-secret-content\n",
    ].join(""));
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      await expect(requestSidecar(config.socketPath, {
        type: "capture-session",
        sessionId: "session-malformed",
        dryRun: true,
      }, 1_000)).rejects.toMatchObject({
        code: "MALFORMED_TRANSCRIPT_LINE",
        lineNumber: 2,
        byteOffset: expect.any(Number),
      });
      expect(await readFile(config.logPath, "utf8")).not.toContain("malformed-secret-content");
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });

  it("fails malformed and oversized hook input open without echoing it", async () => {
    const { config } = await temporaryConfig({ hookMaxInputBytes: 8 });
    const malformedOutput = outputSink();
    expect(await runHookCommand(Readable.from(["not-json"]), malformedOutput.output, config)).toBe(0);
    expect(malformedOutput.text()).toBe("");
    const oversizedOutput = outputSink();
    expect(await runHookCommand(Readable.from(["secret-content"]), oversizedOutput.output, config)).toBe(0);
    expect(oversizedOutput.text()).toBe("");
    const log = await readFile(config.logPath, "utf8");
    expect(log).toContain("INVALID_OR_OVERSIZED_INPUT");
    expect(log).not.toContain("secret-content");
  });

  it("acknowledges an injection only after the Hook output is accepted", async () => {
    const { config } = await temporaryConfig({ hookTimeoutMs: 500 });
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => {
      let buffered = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        requests.push(request);
        const result = request["type"] === "hook"
          ? { schemaVersion: 1, hookOutput: "injected context", delivery: { attemptId: "attempt-ack", expectedRevision: 1, alreadyAcknowledged: false } }
          : { attemptId: "attempt-ack", status: "INJECTED", revision: 2 };
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      });
    });
    await mkdir(dirname(config.socketPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socketPath, resolve);
    });
    try {
      const sink = outputSink();
      await expect(runHookCommand(
        Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-ack", turn_id: "turn-ack" })]),
        sink.output,
        config,
      )).resolves.toBe(0);
      expect(sink.text()).toBe("injected context");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        type: "injection-delivery.ack",
        attemptId: "attempt-ack",
        expectedRevision: 1,
        deliveryEvidenceRef: expect.stringMatching(/^hook-client:[a-f0-9]{64}$/u),
        deliveredAt: expect.any(String),
      });
      requests.splice(0);
      const rejectedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("consumer rejected output")); } });
      rejectedOutput.on("error", () => undefined);
      await expect(runHookCommand(
        Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-ack", turn_id: "turn-rejected" })]),
        rejectedOutput,
        config,
      )).resolves.toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ type: "hook" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it("fails open when the socket is unavailable and bounds request timeouts", async () => {
    const { config } = await temporaryConfig({ hookTimeoutMs: 20 });
    const sink = outputSink();
    const input = Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit" })]);
    expect(await runHookCommand(input, sink.output, config)).toBe(0);
    expect(sink.text()).toBe("");

    let accepted: Socket | undefined;
    const hanging = createServer((socket) => { accepted = socket; });
    await mkdir(dirname(config.socketPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      hanging.once("error", reject);
      hanging.listen(config.socketPath, resolve);
    });
    await expect(requestSidecar(config.socketPath, { type: "health" }, 20)).rejects.toMatchObject({ code: "SIDECAR_UNAVAILABLE" });
    accepted?.destroy();
    await new Promise<void>((resolve, reject) => hanging.close((error) => error === undefined ? resolve() : reject(error)));
  });

  it("refuses to replace a regular file at the socket path", async () => {
    const { config } = await temporaryConfig();
    await mkdir(dirname(config.socketPath), { recursive: true });
    await writeFile(config.socketPath, "owned by someone else");
    const application = await SidecarApplication.create(config);
    await application.start();
    await expect(startSidecarServer(config.socketPath, application)).rejects.toThrow("Unix socket");
    await application.close();
  });

  it("survives a client that disconnects before reading the response", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    const abandoned = createConnection(config.socketPath);
    await new Promise<void>((resolve, reject) => {
      abandoned.once("connect", resolve);
      abandoned.once("error", reject);
    });
    abandoned.write(`${JSON.stringify({ type: "health" })}\n`);
    abandoned.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(await requestSidecar(config.socketPath, { type: "health" }, 100)).toMatchObject({ status: "READY" });
    await stopSidecarServer(server, config.socketPath);
    await application.close();
  });

  it("does not unlink a socket owned by a live sidecar", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    await expect(startSidecarServer(config.socketPath, application)).rejects.toThrow("already owns");
    expect(await requestSidecar(config.socketPath, { type: "health" }, 100)).toMatchObject({ status: "READY" });
    await stopSidecarServer(server, config.socketPath);
    await application.close();
  });

  it("serves strict bounded Control API views with composed P2 and SHADOW-ready P4", async () => {
    const { config } = await temporaryConfig();
    await writeRollout(config, "session-control-view");
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      const overview = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "overview-request",
        type: "overview.get",
      }, 1_000)) as { capabilities: Array<{ capabilityId: string; status: string; reasonCode: string }> };
      expect(overview.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ capabilityId: "session.extraction", status: "READY", reasonCode: "COMPONENT_READY" }),
        expect.objectContaining({ capabilityId: "knowledge.provenance", status: "READY", reasonCode: "COMPONENT_READY" }),
        expect.objectContaining({ capabilityId: "knowledge.compile", status: "READY", reasonCode: "COMPONENT_READY" }),
        expect.objectContaining({ capabilityId: "knowledge.automatic-compile", status: "DISABLED", reasonCode: "CAPABILITY_DISABLED" }),
        expect.objectContaining({ capabilityId: "context.injection", status: "READY", reasonCode: "COMPONENT_READY" }),
        expect.objectContaining({ capabilityId: "knowledge.mcp", status: "READY", reasonCode: "COMPONENT_READY" }),
        expect.objectContaining({ capabilityId: "closure.verification", status: "NOT_VERIFIED", reasonCode: "CAPABILITY_NOT_VERIFIED" }),
      ]));

      const sessions = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "sessions-request",
        type: "sessions.list",
        page: { limit: 10 },
      }, 1_000)) as { items: Array<{ sessionId: string; captureStatus: string }> };
      expect(sessions.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-control-view", captureStatus: "DISCOVERED_NOT_CAPTURED" }),
      ]));

      const detail = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "session-detail-request",
        type: "session.get",
        sessionId: "session-control-view",
      }, 1_000)) as { injections: unknown[] };
      expect(detail.injections).toEqual([]);

      expect(controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "jobs-request",
        type: "jobs.list",
        page: { limit: 10 },
      }, 1_000))).toEqual({ items: [] });
      expect(controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "diagnostics-request",
        type: "diagnostics.get",
      }, 1_000))).toMatchObject({ ledgerSequence: 0, spoolDepth: 0 });
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });

  it("composes the P4 Hook, MCP, delivery and Console paths through the real Sidecar boundary", async () => {
    const { root, config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      expect(await requestSidecar(config.socketPath, { schemaVersion: 1, requestId: "p4-capabilities", type: "p4.capabilities" }, 1_000)).toMatchObject({
        ok: true,
        result: expect.arrayContaining([expect.objectContaining({ capability: "INJECTION_AUDIT", state: "READY" })]),
      });
      expect(await requestSidecar(config.socketPath, { schemaVersion: 1, requestId: "p4-rollout", type: "p4.rollout.get" }, 1_000)).toMatchObject({ ok: true, result: { state: { effective: { mode: "SHADOW" } } } });
      expect(await requestSidecar(config.socketPath, { schemaVersion: 1, requestId: "p4-governance", type: "p4.high-risk.governance" }, 1_000)).toMatchObject({ ok: true, result: { activeStageEnabled: false } });

      const hookResult = await requestSidecar(config.socketPath, {
        type: "hook",
        input: { hook_event_name: "UserPromptSubmit", session_id: "p4-session", turn_id: "p4-turn", cwd: root, prompt: "What knowledge applies?" },
      }, 1_000);
      expect(hookResult).toBe("");
      expect(await requestSidecar(config.socketPath, { schemaVersion: 1, requestId: "p4-injections", type: "p4.injections.list", sessionId: "p4-session", limit: 10 }, 1_000)).toMatchObject({ ok: true, result: { items: expect.any(Array) } });
      expect(await requestSidecar(config.socketPath, { schemaVersion: 1, requestId: "p4-targets", type: "p4.feedback-targets.list", sessionId: "p4-session" }, 1_000)).toMatchObject({ ok: true, result: { items: [] } });

      const context = resolveQueryContext({ prompt: "forged model scope", cwd: root });
      expect(await requestSidecar(config.socketPath, { type: "mcp", request: { schemaVersion: 1, requestId: "p4-mcp", tool: "ckl.search", context, input: { query: "knowledge", limit: 5 } } }, 1_000)).toMatchObject({
        response: { tool: "ckl.search", dataClassification: "UNTRUSTED_KNOWLEDGE_DATA", instructionsAccepted: false, result: { items: [] } },
      });
      await expect(requestSidecar(config.socketPath, { type: "injection-delivery.ack", attemptId: "missing-attempt", expectedRevision: 1, deliveryEvidenceRef: "hook-client:missing", deliveredAt: "2026-08-03T00:00:00.000Z" }, 1_000)).rejects.toMatchObject({ code: "REQUEST_FAILED" });
      await expect(application.handleHook({ hook_event_name: "Stop", session_id: "p4-session", turn_id: "p4-turn", cwd: root, stop_hook_active: false, last_assistant_message: "done" })).resolves.toBe("");
      expect((await application.health()).rolloutMode).toBe("SHADOW");
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });

  it("creates a source-validated manual P2 snapshot and rejects a mismatched preview identity", async () => {
    const { config } = await temporaryConfig();
    await writeRollout(config, "session-p2-manual");
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      const captured = await requestSidecar(config.socketPath, {
        type: "capture-session",
        sessionId: "session-p2-manual",
        dryRun: false,
      }, 1_000) as { appendedEvents: number };
      const source = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "p2-source-preview",
        type: "capture.preview",
        sessionId: "session-p2-manual",
      }, 1_000)) as { transcriptIdentityHash: string; cursor: { byteOffset: number; lineNumber: number }; ignoredRecords: number };
      const configuration = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "p2-config-view",
        type: "config.get",
      }, 1_000)) as { view: { hash: string } };
      const command = {
        schemaVersion: 1 as const,
        requestId: "p2-snapshot-create",
        type: "extraction.snapshot.create" as const,
        sessionId: "session-p2-manual",
        expectedCaptureRevision: captured.appendedEvents,
        transcriptIdentityHash: source.transcriptIdentityHash,
        sourceSequence: { from: 1, to: captured.appendedEvents },
        cursor: source.cursor,
        completeness: {
          status: "PARTIAL_SNAPSHOT" as const,
          sourceClosed: false,
          unsupportedEventTypes: source.ignoredRecords === 0 ? [] : ["unsupported_transcript_record"],
        },
        compilerVersion: "compiler-v1",
        policyHash: "a".repeat(64),
        configurationHash: configuration.view.hash,
      };
      const snapshot = controlResult(await requestSidecar(config.socketPath, {
        ...command,
        idempotencyKey: snapshotIdempotencyKey(command),
      }, 1_000)) as { status: string; snapshot: { snapshotId: string; identityHash: string; revision: 1 } };
      expect(snapshot).toMatchObject({ status: "CREATED", snapshot: { revision: 1 } });
      expect(controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "p2-snapshot-list",
        type: "extraction.snapshots.list",
        sessionId: "session-p2-manual",
        limit: 10,
      }, 1_000))).toMatchObject({ items: [expect.objectContaining({ snapshotId: snapshot.snapshot.snapshotId })] });
      expect(controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "p2-provenance-get",
        type: "extraction.provenance.get",
        root: { type: "SNAPSHOT", snapshotId: snapshot.snapshot.snapshotId, revision: 1 },
        limit: 20,
      }, 1_000))).toMatchObject({ root: { type: "SNAPSHOT" }, upstream: expect.any(Array) });

      const previewResponse = await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "p2-preview-conflict",
        type: "extraction.candidates.preview",
        snapshot: {
          snapshotId: snapshot.snapshot.snapshotId,
          revision: snapshot.snapshot.revision,
          identityHash: snapshot.snapshot.identityHash,
        },
        compilerVersion: "compiler-v1",
        policyHash: "a".repeat(64),
        idempotencyKey: `candidate:preview:${"b".repeat(64)}`,
      }, 1_000) as ControlResponse;
      expect(previewResponse).toMatchObject({
        ok: false,
        error: { code: "CONFLICT", retryable: false },
      });
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });

  it("defers transcript catalog discovery until a catalog query so service readiness stays bounded", async () => {
    const { config } = await temporaryConfig();
    await writeRollout(config, "session-lazy-catalog");
    const application = await SidecarApplication.create(config);
    await application.start();
    try {
      const before = controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "capabilities-before-catalog",
        type: "capabilities.list",
        page: { limit: 50 },
      })) as { items: Array<{ capabilityId: string; status: string }> };
      expect(before.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ capabilityId: "session.catalog", status: "STARTING" }),
      ]));
      expect(controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "overview-before-catalog",
        type: "overview.get",
      }))).toMatchObject({ rolloutMode: "SHADOW" });
      const afterOverview = controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "capabilities-after-overview",
        type: "capabilities.list",
        page: { limit: 50 },
      })) as { items: Array<{ capabilityId: string; status: string }> };
      expect(afterOverview.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ capabilityId: "session.catalog", status: "STARTING" }),
      ]));

      const sessions = controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "lazy-catalog-query",
        type: "sessions.list",
        page: { limit: 10 },
      })) as { items: Array<{ sessionId: string }> };
      expect(sessions.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-lazy-catalog" }),
      ]));
      const after = controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "capabilities-after-catalog",
        type: "capabilities.list",
        page: { limit: 50 },
      })) as { items: Array<{ capabilityId: string; status: string }> };
      expect(after.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ capabilityId: "session.catalog", status: "READY" }),
      ]));
    } finally {
      await application.close();
    }
  });

  it("keeps preview dry-run side-effect free, rejects stale source, and commits idempotently", async () => {
    const { config } = await temporaryConfig();
    await writeRollout(config, "session-controlled-capture");
    await writeRollout(config, "session-other-capture");
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      const previewRequest: ControlRequest = {
        schemaVersion: 1,
        requestId: "preview-request-1",
        type: "capture.preview",
        sessionId: "session-controlled-capture",
      };
      const preview = controlResult(await requestSidecar(config.socketPath, previewRequest, 1_000)) as {
        previewRevision: number;
        transcriptIdentityHash: string;
        projectedEvents: number;
        items: Array<{ eventId: string; eventType: string; contentPreview: string; contentTruncated: boolean }>;
      };
      expect(preview).toMatchObject({ previewRevision: 1, projectedEvents: 3 });
      expect(preview.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "user.prompted", contentPreview: "capture me [REDACTED]", contentTruncated: false }),
        expect.objectContaining({ eventType: "turn.stopped", contentPreview: "captured", contentTruncated: false }),
      ]));
      expect(controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "diagnostics-after-preview",
        type: "diagnostics.get",
      }, 1_000))).toMatchObject({ ledgerSequence: 0 });

      const transcript = join(config.codexSessionsRoot, "2026", "08", "03", "rollout-session-controlled-capture.jsonl");
      await appendFile(transcript, rolloutRecord("turn_context", "2026-08-03T00:00:04.000Z", { turn_id: "turn-2" }));
      const stale = await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "stale-commit-request",
        type: "capture.commit",
        sessionId: "session-controlled-capture",
        previewRevision: preview.previewRevision,
        transcriptIdentityHash: preview.transcriptIdentityHash,
        idempotencyKey: "capture:controlled:revision:1",
      }, 1_000) as ControlResponse;
      expect(stale).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });

      const fresh = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "preview-request-2",
        type: "capture.preview",
        sessionId: "session-controlled-capture",
      }, 1_000)) as { previewRevision: number; transcriptIdentityHash: string };
      const commit = {
        schemaVersion: 1 as const,
        type: "capture.commit" as const,
        sessionId: "session-controlled-capture",
        previewRevision: fresh.previewRevision,
        transcriptIdentityHash: fresh.transcriptIdentityHash,
        idempotencyKey: "capture:controlled:revision:2",
      };
      const first = controlResult(await requestSidecar(config.socketPath, { ...commit, requestId: "commit-request-1" }, 1_000));
      expect(first).toMatchObject({
        appendedEvents: 3,
        duplicateEvents: 0,
        appendedEventIds: expect.arrayContaining(preview.items.map((item) => item.eventId)),
        duplicateEventIds: [],
        eventIdsTruncated: false,
        knowledgeCompileStage: { status: "PENDING", reasonCode: "NOT_APPLICABLE" },
      });
      const replay = controlResult(await requestSidecar(config.socketPath, { ...commit, requestId: "commit-request-retry" }, 1_000));
      expect(replay).toEqual(first);
      const conflict = await requestSidecar(config.socketPath, {
        ...commit,
        requestId: "commit-request-conflict",
        transcriptIdentityHash: "b".repeat(64),
      }, 1_000) as ControlResponse;
      expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

      const otherPreview = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "other-preview",
        type: "capture.preview",
        sessionId: "session-other-capture",
      }, 1_000)) as { previewRevision: number; transcriptIdentityHash: string };
      const crossSessionConflict = await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "cross-session-conflict",
        type: "capture.commit",
        sessionId: "session-other-capture",
        previewRevision: otherPreview.previewRevision,
        transcriptIdentityHash: otherPreview.transcriptIdentityHash,
        idempotencyKey: commit.idempotencyKey,
      }, 1_000) as ControlResponse;
      expect(crossSessionConflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

      const events = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "events-after-commit",
        type: "session.events.list",
        sessionId: "session-controlled-capture",
        page: { limit: 10 },
      }, 1_000)) as { items: Array<{ eventId: string; contentPreview?: string; contentTruncated?: boolean }> };
      expect(events.items).toHaveLength(3);
      expect(events.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ contentPreview: "capture me [REDACTED]", contentTruncated: false }),
        expect.objectContaining({ contentPreview: "captured", contentTruncated: false }),
      ]));
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
    const ledger = new SqliteEventLedger(config.ledgerPath);
    expect(ledger.count()).toBe(3);
    ledger.close();
  });

  it("continues an accepted capture after client disconnect and safely replays the command", async () => {
    const { config } = await temporaryConfig();
    await writeRollout(config, "session-abandoned-capture");
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      const preview = controlResult(await requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "abandoned-preview",
        type: "capture.preview",
        sessionId: "session-abandoned-capture",
      }, 1_000)) as { previewRevision: number; transcriptIdentityHash: string };
      const command = {
        schemaVersion: 1 as const,
        type: "capture.commit" as const,
        sessionId: "session-abandoned-capture",
        previewRevision: preview.previewRevision,
        transcriptIdentityHash: preview.transcriptIdentityHash,
        idempotencyKey: "capture:abandoned:revision:1",
      };
      const abandoned = createConnection(config.socketPath);
      await new Promise<void>((resolve, reject) => {
        abandoned.once("connect", resolve);
        abandoned.once("error", reject);
      });
      abandoned.write(`${JSON.stringify({ ...command, requestId: "abandoned-commit" })}\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      abandoned.destroy();
      const replay = controlResult(await requestSidecar(config.socketPath, { ...command, requestId: "abandoned-replay" }, 2_000));
      expect(replay).toMatchObject({ appendedEvents: 3 });
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });

  it("replays an exact capture receipt after Sidecar restart without requiring a new preview", async () => {
    const { config } = await temporaryConfig();
    await writeRollout(config, "session-restart-replay");
    let application = await SidecarApplication.create(config);
    await application.start();
    const preview = controlResult(await application.handleControl({
      schemaVersion: 1,
      requestId: "restart-preview",
      type: "capture.preview",
      sessionId: "session-restart-replay",
    })) as { previewRevision: number; transcriptIdentityHash: string };
    const command = {
      schemaVersion: 1 as const,
      type: "capture.commit" as const,
      sessionId: "session-restart-replay",
      previewRevision: preview.previewRevision,
      transcriptIdentityHash: preview.transcriptIdentityHash,
      idempotencyKey: "capture:restart:revision:1",
    };
    const committed = controlResult(await application.handleControl({ ...command, requestId: "restart-commit" }));
    await application.close();

    application = await SidecarApplication.create(config);
    await application.start();
    try {
      expect(controlResult(await application.handleControl({ ...command, requestId: "restart-replay" }))).toEqual(committed);
      const conflict = await application.handleControl({
        ...command,
        requestId: "restart-conflict",
        transcriptIdentityHash: "c".repeat(64),
      });
      expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    } finally {
      await application.close();
    }
  });

  it("reports an unreadable spool as an unhealthy retryable diagnostic", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    try {
      await rm(config.spoolPath, { recursive: true, force: true });
      await writeFile(config.spoolPath, "not-a-directory");
      expect(controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "unreadable-spool-diagnostics",
        type: "diagnostics.get",
      }))).toMatchObject({
        spoolDepth: 0,
        worker: { healthy: false, retryableFailures: 1 },
      });
    } finally {
      await application.close();
    }
  });

  it("rejects a pre-existing cursor secret with group or world access", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.close();
    await chmod(join(dirname(config.ledgerPath), "control-cursor.key"), 0o644);
    await expect(SidecarApplication.create(config)).rejects.toThrow("permissions are too broad");
  });

  it("rejects oversized Control API messages and same-chunk trailing frames before side effects", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    try {
      await expect(requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "oversized-control-request",
        type: "config.validate",
        baseRevision: 0,
        scope: "GLOBAL",
        draft: { padding: "x".repeat(1_100_000) },
      }, 2_000)).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
      await expect(requestSidecar(config.socketPath, {
        schemaVersion: 2,
        requestId: "unknown-version",
        type: "overview.get",
      } as never, 1_000)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA_VERSION" });
      await expect(requestSidecar(config.socketPath, {
        schemaVersion: 1,
        requestId: "unknown-field",
        type: "overview.get",
        rawPrompt: "must not cross the boundary",
      } as never, 1_000)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const trailing = await sendRawFrames(
        config.socketPath,
        `${JSON.stringify({ type: "worker" })}\n${JSON.stringify({ type: "worker" })}\n`,
      );
      expect(trailing).toMatchObject({ ok: false, errorCode: "INVALID_JSON" });
      expect(await requestSidecar(config.socketPath, { type: "health" }, 1_000)).toMatchObject({ status: "READY" });
    } finally {
      await stopSidecarServer(server, config.socketPath);
      await application.close();
    }
  });

  it("validates, activates, persists, and rolls back configuration through the Control API", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    try {
      expect(controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "configuration-get-default",
        type: "config.get",
      }))).toMatchObject({ view: { revision: 0, effective: { runtime: { sessionScanIntervalMs: 60_000 } } }, drafts: [], history: [{ revision: 0 }] });

      const validation = controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "configuration-validate",
        type: "config.validate",
        baseRevision: 0,
        scope: "GLOBAL",
        draft: { runtime: { sessionScanIntervalMs: 5_000 } },
      })) as { ok: boolean; draft?: { draftRevision: number } };
      expect(validation).toMatchObject({ ok: true, draft: { activatable: true } });
      const draftRevision = validation.draft?.draftRevision as number;
      expect(controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "configuration-activate",
        type: "config.activate",
        expectedRevision: 0,
        draftRevision,
        idempotencyKey: "sidecar-configuration-activate-0001",
      }))).toMatchObject({ ok: true, revision: 1, status: "EFFECTIVE" });
      expect(controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "configuration-get-active",
        type: "config.get",
      }))).toMatchObject({ view: { revision: 1, effective: { runtime: { sessionScanIntervalMs: 5_000 } } } });
      expect(controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "configuration-stale-draft",
        type: "config.validate",
        baseRevision: 0,
        scope: "GLOBAL",
        draft: {},
      }))).toMatchObject({ ok: false, diagnostics: [{ code: "STALE_REVISION" }] });
      expect(controlResult(await application.handleControl({
        schemaVersion: 1,
        requestId: "configuration-rollback",
        type: "config.rollback",
        expectedRevision: 1,
        targetRevision: 0,
        idempotencyKey: "sidecar-configuration-rollback-0001",
      }))).toMatchObject({ ok: true, revision: 2, status: "ROLLED_BACK" });
    } finally {
      await application.close();
    }
  });
});

describe("privacy-safe log", () => {
  it("rotates bounded records and sanitizes attacker-controlled codes", async () => {
    const { config } = await temporaryConfig({ logMaxBytes: 1_024, logRetainFiles: 2 });
    const log = new SafeDiagnosticLog(config.logPath, config.logMaxBytes, config.logRetainFiles, () => new Date("2026-08-03T00:00:00.000Z"));
    for (let index = 0; index < 30; index += 1) {
      await log.write({ component: "service", code: `bad\nsecret-${index}`, count: index });
    }
    const current = await readFile(config.logPath, "utf8");
    const rotated = await readFile(`${config.logPath}.1`, "utf8");
    expect(`${current}${rotated}`).not.toContain("bad\nsecret");
    expect(`${current}${rotated}`).toContain("bad_secret-");
  });
});
