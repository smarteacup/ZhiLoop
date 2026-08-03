import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventEnvelope } from "@zhiloop/domain";
import type { TranscriptCursor } from "@zhiloop/ingestion-codex";
import { afterEach, describe, expect, it } from "vitest";

import { locateCodexTranscript } from "./locator.js";
import { CodexSessionCaptureService } from "./service.js";
import { SessionCaptureError, type CaptureCursorStore, type CaptureEventSink } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zhiloop-capture-"));
  cleanups.push(async () => rm(path, { recursive: true, force: true }));
  return path;
}

function record(type: string, timestamp: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type, timestamp, payload })}\n`;
}

async function transcript(sessionsRoot: string, sessionId: string, suffix = ""): Promise<string> {
  const directory = join(sessionsRoot, "2026", "08", "03");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${sessionId}${suffix}.jsonl`);
  await writeFile(path, [
    record("session_meta", "2026-08-03T00:00:00.000Z", { session_id: sessionId, cli_version: "0.145.0", source: "vscode" }),
    record("event_msg", "2026-08-03T00:00:01.000Z", { type: "task_started", turn_id: "turn-1" }),
    record("event_msg", "2026-08-03T00:00:02.000Z", { type: "user_message", message: "Design the importer." }),
    record("event_msg", "2026-08-03T00:00:03.000Z", { type: "task_complete", turn_id: "turn-1", last_agent_message: "Done." }),
  ].join(""));
  return path;
}

function memoryPorts(): {
  sink: CaptureEventSink;
  cursors: CaptureCursorStore;
  events: Map<string, EventEnvelope>;
  cursorMap: Map<string, TranscriptCursor>;
} {
  const events = new Map<string, EventEnvelope>();
  const cursorMap = new Map<string, TranscriptCursor>();
  return {
    events,
    cursorMap,
    sink: {
      appendBatch: (batch) => batch.map((event) => {
        if (events.has(event.eventId)) return { status: "duplicate" as const };
        events.set(event.eventId, event);
        return { status: "appended" as const };
      }),
    },
    cursors: {
      load: (id) => cursorMap.get(id),
      commit: (id, cursor) => { cursorMap.set(id, cursor); },
    },
  };
}

describe("Codex transcript locator", () => {
  it("selects exact session_meta identity and ignores content-only occurrences", async () => {
    const sessionsRoot = await root();
    const selected = await transcript(sessionsRoot, "session-target");
    const other = await transcript(sessionsRoot, "session-other");
    await appendFile(other, record("event_msg", "2026-08-03T00:00:04.000Z", { type: "user_message", message: "session-target" }));
    await expect(locateCodexTranscript(sessionsRoot, "session-target")).resolves.toEqual({
      path: await realpath(selected),
      sessionId: "session-target",
    });
  });

  it("reports missing and ambiguous exact identities", async () => {
    const sessionsRoot = await root();
    await transcript(sessionsRoot, "session-a");
    await expect(locateCodexTranscript(sessionsRoot, "missing")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await transcript(sessionsRoot, "session-a", "-copy");
    await expect(locateCodexTranscript(sessionsRoot, "session-a")).rejects.toMatchObject({ code: "SESSION_AMBIGUOUS" });
  });

  it("validates selectors, skips symlinks, and enforces discovery limits", async () => {
    const sessionsRoot = await root();
    const selected = await transcript(sessionsRoot, "session-a");
    await symlink(selected, join(sessionsRoot, "session-link.jsonl"));
    await expect(locateCodexTranscript(sessionsRoot, "../session-a")).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    await expect(locateCodexTranscript(sessionsRoot, "session-a", { maxFiles: 1 })).resolves.toMatchObject({ sessionId: "session-a" });
    await transcript(sessionsRoot, "session-b");
    await expect(locateCodexTranscript(sessionsRoot, "session-a", { maxFiles: 1 })).rejects.toMatchObject({ code: "DISCOVERY_LIMIT_EXCEEDED" });
  });

  it("rejects an oversized likely metadata record without echoing content", async () => {
    const sessionsRoot = await root();
    await writeFile(join(sessionsRoot, "rollout-session-large.jsonl"), "x".repeat(100));
    await expect(locateCodexTranscript(sessionsRoot, "session-large", { maxMetadataBytes: 16 })).rejects.toEqual(
      expect.objectContaining({ code: "TRANSCRIPT_METADATA_TOO_LARGE", message: "TRANSCRIPT_METADATA_TOO_LARGE" }),
    );
  });
});

describe("Codex session capture service", () => {
  it("previews without mutation, captures, and repeats idempotently", async () => {
    const sessionsRoot = await root();
    await transcript(sessionsRoot, "session-a");
    const ports = memoryPorts();
    const service = new CodexSessionCaptureService(sessionsRoot, ports.sink, ports.cursors);

    const preview = await service.capture({ sessionId: "session-a", dryRun: true });
    expect(preview).toMatchObject({
      status: "PREVIEWED",
      projectedEvents: 3,
      appendedEvents: 0,
      ignoredRecords: 1,
      eventTypes: { "session.started": 1, "user.prompted": 1, "turn.stopped": 1 },
      knowledgeCompiled: false,
    });
    expect(ports.events.size).toBe(0);
    expect(ports.cursorMap.size).toBe(0);

    const first = await service.capture({ sessionId: "session-a" });
    expect(first).toMatchObject({ status: "CAPTURED", appendedEvents: 3, duplicateEvents: 0 });
    expect(ports.events.size).toBe(3);
    const second = await service.capture({ sessionId: "session-a" });
    expect(second).toMatchObject({ appendedEvents: 0, duplicateEvents: 0, projectedEvents: 0 });
    expect(ports.events.size).toBe(3);
  });

  it("resumes a growing transcript and leaves the cursor before malformed input", async () => {
    const sessionsRoot = await root();
    const path = await transcript(sessionsRoot, "session-a");
    const ports = memoryPorts();
    const service = new CodexSessionCaptureService(sessionsRoot, ports.sink, ports.cursors);
    await service.capture({ sessionId: "session-a" });
    const cursorBefore = ports.cursorMap.get("codex-transcript:session-a");
    await appendFile(path, [
      record("event_msg", "2026-08-03T00:01:00.000Z", { type: "task_started", turn_id: "turn-2" }),
      record("event_msg", "2026-08-03T00:01:01.000Z", { type: "user_message", message: "Continue." }),
      record("event_msg", "2026-08-03T00:01:02.000Z", { type: "task_complete", turn_id: "turn-2", last_agent_message: "Continued." }),
    ].join(""));
    await expect(service.capture({ sessionId: "session-a" })).resolves.toMatchObject({ appendedEvents: 2 });
    const safeCursor = ports.cursorMap.get("codex-transcript:session-a");
    expect(safeCursor?.byteOffset).toBeGreaterThan(cursorBefore?.byteOffset ?? 0);
    await appendFile(path, "not-json\n");
    await expect(service.capture({ sessionId: "session-a" })).rejects.toMatchObject({ code: "MALFORMED_TRANSCRIPT_LINE" });
    expect(ports.cursorMap.get("codex-transcript:session-a")).toEqual(safeCursor);
  });

  it("absorbs deterministic replay when a cursor commit was lost", async () => {
    const sessionsRoot = await root();
    await transcript(sessionsRoot, "session-a");
    const ports = memoryPorts();
    const service = new CodexSessionCaptureService(sessionsRoot, ports.sink, ports.cursors);
    await service.capture({ sessionId: "session-a" });
    ports.cursorMap.clear();
    await expect(service.capture({ sessionId: "session-a" })).resolves.toMatchObject({ appendedEvents: 0, duplicateEvents: 3 });
    expect(ports.events.size).toBe(3);
  });

  it("stops without spinning when an active transcript ends in an incomplete line", async () => {
    const sessionsRoot = await root();
    const path = await transcript(sessionsRoot, "session-a");
    const ports = memoryPorts();
    const service = new CodexSessionCaptureService(sessionsRoot, ports.sink, ports.cursors);
    await service.capture({ sessionId: "session-a" });
    const cursorBefore = ports.cursorMap.get("codex-transcript:session-a");
    await appendFile(path, "{\"type\":\"event_msg\"");
    await expect(service.capture({ sessionId: "session-a" })).resolves.toMatchObject({
      batches: 1,
      projectedEvents: 0,
      hasMore: true,
    });
    expect(ports.cursorMap.get("codex-transcript:session-a")).toEqual(cursorBefore);
  });

  it("keeps diagnostic messages content-free", () => {
    const error = new SessionCaptureError("MALFORMED_TRANSCRIPT_LINE", { lineNumber: 5, byteOffset: 10 });
    expect(error.message).toBe("MALFORMED_TRANSCRIPT_LINE");
    expect(error).toMatchObject({ lineNumber: 5, byteOffset: 10 });
  });
});
