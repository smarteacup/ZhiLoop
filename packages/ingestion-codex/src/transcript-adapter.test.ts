import { appendFile, copyFile, mkdtemp, open, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readTranscriptIncrement } from "./transcript-adapter.js";

const FIXTURE_DIRECTORY = new URL("../../../test-fixtures/transcripts/", import.meta.url);
const temporaryDirectories: string[] = [];

async function temporaryTranscript(fixtureName = "v1.jsonl"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "zhiloop-transcript-test-"));
  temporaryDirectories.push(directory);
  const target = path.join(directory, "rollout.jsonl");
  await copyFile(new URL(fixtureName, FIXTURE_DIRECTORY), target);
  return target;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("versioned transcript adapter", () => {
  it("ignores a bounded multi-megabyte tool output without blocking later events", async () => {
    const transcript = await temporaryTranscript();
    const records = [
      {
        timestamp: "2026-08-01T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-large-tool-output",
          cli_version: "0.146.0-fixture",
          source: "vscode",
        },
      },
      {
        timestamp: "2026-08-01T10:00:01.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call_output", output: "x".repeat(2_500_000) },
      },
      {
        timestamp: "2026-08-01T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "question after tool output" },
      },
    ];
    await writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const result = await readTranscriptIncrement(transcript);

    expect(result).toMatchObject({
      ok: true,
      value: {
        ignoredRecords: 1,
        hasMore: false,
        events: [
          { eventType: "session.started" },
          { eventType: "user.prompted", payload: { prompt: "question after tool output" } },
        ],
      },
    });
  });

  it("projects only public session, user, and final assistant records", async () => {
    const transcript = await temporaryTranscript();
    const result = await readTranscriptIncrement(transcript);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events.map((event) => event.eventType)).toEqual([
        "session.started",
        "user.prompted",
        "turn.stopped",
      ]);
      expect(result.value.events[1]).toMatchObject({
        source: "codex-transcript",
        sourceVersion: "0.146.0-fixture",
        sessionId: "session-transcript-1",
        turnId: "turn-transcript-1",
        payload: { kind: "transcript-user-prompt", prompt: "Explain the retry policy." },
      });
      expect(result.value.ignoredRecords).toBe(2);
      expect(result.value.hasMore).toBe(false);
      expect(JSON.stringify(result.value.events)).not.toContain("hidden-reasoning");
      expect(JSON.stringify(result.value.events)).not.toContain("base_instructions");
      expect(result.value.cursor.formatVersion).toBe("codex-rollout-jsonl-v1");
    }
  });

  it("returns no events when the same cursor is read again", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await readTranscriptIncrement(transcript, first.value.cursor);
    expect(second).toMatchObject({
      ok: true,
      value: { events: [], ignoredRecords: 0, hasMore: false },
    });
    if (second.ok) expect(second.value.cursor).toEqual(first.value.cursor);
  });

  it("reads only appended records and retains the active turn across batches", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await appendFile(transcript, await readFile(new URL("v1-append.jsonl", FIXTURE_DIRECTORY)));
    const second = await readTranscriptIncrement(transcript, first.value.cursor);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.events.map((event) => event.eventType)).toEqual(["user.prompted", "turn.stopped"]);
      expect(second.value.events.map((event) => event.turnId)).toEqual(["turn-transcript-2", "turn-transcript-2"]);
      expect(second.value.ignoredRecords).toBe(1);
    }
  });

  it("keeps an incomplete final line pending until it is completed", async () => {
    const transcript = await temporaryTranscript();
    const content = await readFile(transcript, "utf8");
    await writeFile(transcript, content.trimEnd());

    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.events.map((event) => event.eventType)).toEqual(["session.started", "user.prompted"]);
    expect(first.value.hasMore).toBe(true);

    await appendFile(transcript, "\n");
    const second = await readTranscriptIncrement(transcript, first.value.cursor);
    expect(second).toMatchObject({ ok: true, value: { events: [{ eventType: "turn.stopped" }], hasMore: false } });
  });

  it("generates stable event ids when replayed from the beginning", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    const second = await readTranscriptIncrement(transcript);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.events.map((event) => event.eventId)).toEqual(second.value.events.map((event) => event.eventId));
    }
  });

  it("produces the same events across bounded read chunks", async () => {
    const transcript = await temporaryTranscript();
    const complete = await readTranscriptIncrement(transcript);
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;

    const ids: string[] = [];
    let cursor = undefined;
    let hasMore = true;
    while (hasMore) {
      const batch = await readTranscriptIncrement(transcript, cursor, { maxReadBytes: 512, maxLineBytes: 400 });
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      ids.push(...batch.value.events.map((event) => event.eventId));
      cursor = batch.value.cursor;
      hasMore = batch.value.hasMore;
    }
    expect(ids).toEqual(complete.value.events.map((event) => event.eventId));
  });

  it("handles an empty transcript without inventing a format", async () => {
    const transcript = await temporaryTranscript();
    await writeFile(transcript, "");
    expect(await readTranscriptIncrement(transcript)).toMatchObject({
      ok: true,
      value: { events: [], ignoredRecords: 0, hasMore: false, cursor: { byteOffset: 0, lineNumber: 0 } },
    });
  });
});

describe("transcript change diagnostics", () => {
  it("detects truncation", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await truncate(transcript, 10);
    expect(await readTranscriptIncrement(transcript, first.value.cursor)).toMatchObject({
      ok: false,
      error: { code: "TRANSCRIPT_TRUNCATED", recoverable: true },
    });
  });

  it("detects file replacement", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await rename(transcript, `${transcript}.old`);
    await copyFile(new URL("v1.jsonl", FIXTURE_DIRECTORY), transcript);
    expect(await readTranscriptIncrement(transcript, first.value.cursor)).toMatchObject({
      ok: false,
      error: { code: "TRANSCRIPT_REPLACED", recoverable: true },
    });
  });

  it("detects in-place changes before the cursor", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const handle = await open(transcript, "r+");
    await handle.write(Buffer.from("X"), 0, 1, first.value.cursor.anchorStart);
    await handle.close();
    expect(await readTranscriptIncrement(transcript, first.value.cursor)).toMatchObject({
      ok: false,
      error: { code: "TRANSCRIPT_ANCHOR_MISMATCH", recoverable: true },
    });
  });

  it("returns a partial cursor and diagnostic for malformed appended JSON", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await appendFile(transcript, "{not-json}\n");
    const result = await readTranscriptIncrement(transcript, first.value.cursor);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "MALFORMED_TRANSCRIPT_LINE", recoverable: true },
      partial: { events: [], cursor: first.value.cursor },
    });
  });

  it("rejects a corrupted persisted cursor before reading", async () => {
    const transcript = await temporaryTranscript();
    const first = await readTranscriptIncrement(transcript);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const corrupted = { ...first.value.cursor, anchorStart: first.value.cursor.byteOffset + 1 };
    expect(await readTranscriptIncrement(transcript, corrupted)).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRANSCRIPT_CURSOR", recoverable: false },
    });
  });

  it("degrades an unknown first-record format without exposing it", async () => {
    const transcript = await temporaryTranscript("unsupported.jsonl");
    const result = await readTranscriptIncrement(transcript);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_TRANSCRIPT_FORMAT", lineNumber: 1, recoverable: false },
      partial: { events: [] },
    });
    expect(JSON.stringify(result)).not.toContain("future-session");
  });

  it("degrades an unsupported transcript CLI version", async () => {
    const transcript = await temporaryTranscript();
    await writeFile(
      transcript,
      '{"timestamp":"2026-08-01T10:00:00.000Z","type":"session_meta","payload":{"session_id":"s1","cli_version":"1.0.0"}}\n',
    );
    expect(await readTranscriptIncrement(transcript)).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_TRANSCRIPT_FORMAT", recoverable: false },
    });
  });

  it("rejects an oversized line before parsing its contents", async () => {
    const transcript = await temporaryTranscript();
    await writeFile(transcript, `${"x".repeat(101)}\n`);
    expect(await readTranscriptIncrement(transcript, undefined, { maxReadBytes: 200, maxLineBytes: 100 })).toMatchObject({
      ok: false,
      error: { code: "TRANSCRIPT_LINE_TOO_LARGE", lineNumber: 1, recoverable: false },
    });
  });

  it("rejects unsafe reader options and missing files diagnostically", async () => {
    expect(await readTranscriptIncrement("/does/not/exist", undefined, { maxReadBytes: 20, maxLineBytes: 20 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRANSCRIPT_OPTIONS", recoverable: false },
    });
    expect(await readTranscriptIncrement("/does/not/exist")).toMatchObject({
      ok: false,
      error: { code: "TRANSCRIPT_IO_ERROR", recoverable: true },
    });
  });
});
