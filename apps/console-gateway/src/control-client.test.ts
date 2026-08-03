import { mkdtemp, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONTROL_API_SCHEMA_VERSION, type ControlRequest } from "@zhiloop/control-api";

import { ControlClientError, UnixSocketControlClient } from "./control-client.js";

const NOW = "2026-08-03T12:00:00.000Z";

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
        default:
          throw new Error(`unexpected request ${request.type}`);
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
    await expect(client.getDiagnostics(options)).resolves.toMatchObject({ ledgerSequence: 0 });
    await expect(client.previewCapture("session-1", options)).resolves.toMatchObject({ previewRevision: 1 });
    await expect(client.commitCapture({
      sessionId: "session-1",
      previewRevision: 1,
      transcriptIdentityHash: "a".repeat(64),
      idempotencyKey: "capture:session-1:revision-1",
    }, options)).resolves.toMatchObject({ appendedEvents: 0 });
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
