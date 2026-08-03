import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import { afterEach, describe, expect, it } from "vitest";

import { SidecarApplication } from "./application.js";
import { loadSidecarConfig, parseSidecarConfig, type SidecarConfig } from "./config.js";
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
    rolloutRecord("event_msg", "2026-08-03T00:00:02.000Z", { type: "user_message", message: "capture me" }),
    rolloutRecord("event_msg", "2026-08-03T00:00:03.000Z", { type: "task_complete", turn_id: "turn-1", last_agent_message: "captured" }),
  ].join(""));
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
});

describe("sidecar service", () => {
  it("captures a hook into the ledger while returning no SHADOW context", async () => {
    const { config } = await temporaryConfig();
    const application = await SidecarApplication.create(config);
    await application.start();
    const server = await startSidecarServer(config.socketPath, application);
    cleanups.push(async () => { await stopSidecarServer(server, config.socketPath); await application.close(); });

    expect(await requestSidecar(config.socketPath, { type: "health" }, 100)).toMatchObject({
      status: "READY",
      sidecarVersion: "0.1.4",
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
    expect(await readFile(config.logPath, "utf8")).not.toContain(secretPrompt);

    await stopSidecarServer(server, config.socketPath);
    await application.close();
    cleanups.pop();
    const ledger = new SqliteEventLedger(config.ledgerPath);
    expect(ledger.count()).toBe(1);
    ledger.close();
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
