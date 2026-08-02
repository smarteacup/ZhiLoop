import { describe, expect, it } from "vitest";

import { SqliteBackfillCheckpointStore } from "./checkpoint.js";
import { CodexBackfillService } from "./service.js";
import type { CodexHistoryPort, HistoricalThread, HistoricalThreadSummary } from "./types.js";

const CWD = "/workspace/project";
const NOW = "2026-08-02T09:00:00.000Z";

function turn(id: string, status: "completed" | "failed" | "interrupted" | "inProgress" = "completed") {
  return {
    id,
    status,
    itemsView: "full",
    items: [
      { type: "userMessage", id: `${id}-user`, content: [{ type: "text", text: `prompt ${id}`, text_elements: [] }] },
      { type: "commandExecution", id: `${id}-tool`, command: "npm test", cwd: CWD, commandActions: [], status: "completed", aggregatedOutput: "ok", exitCode: 0, durationMs: 10 },
      { type: "agentMessage", id: `${id}-agent`, text: `answer ${id}`, phase: "final_answer", memoryCitation: null },
    ],
    error: status === "failed" ? { message: "failed" } : null,
    startedAt: 1785643200,
    completedAt: status === "inProgress" ? null : 1785643201,
    durationMs: status === "inProgress" ? null : 1000,
  };
}

function thread(id: string, options: { cwd?: string; preview?: string; turns?: readonly unknown[] } = {}): HistoricalThread {
  const turns = options.turns ?? [turn(`${id}-1`), turn(`${id}-2`)];
  return {
    id, sessionId: id, preview: options.preview ?? `thread ${id}`, cwd: options.cwd ?? CWD,
    createdAt: 1785643200, updatedAt: 1785643202, cliVersion: "0.144.4", archived: false,
    modelProvider: "openai", ephemeral: false, source: "appServer", turns,
  };
}

class FakeHistory implements CodexHistoryPort {
  readonly pages: ReadonlyMap<string, { data: readonly HistoricalThreadSummary[]; nextCursor?: string }>;
  readonly threads: ReadonlyMap<string, HistoricalThread>;
  readonly listCalls: unknown[] = [];
  readonly readCalls: string[] = [];
  failOnce: string | undefined;

  constructor(pages: ReadonlyMap<string, { data: readonly HistoricalThreadSummary[]; nextCursor?: string }>, threads: ReadonlyMap<string, HistoricalThread>) {
    this.pages = pages; this.threads = threads;
  }

  async listThreads(request: Parameters<CodexHistoryPort["listThreads"]>[0]) {
    this.listCalls.push(request);
    const page = this.pages.get(request.cursor ?? "first");
    if (page === undefined) throw new Error("missing page");
    return page;
  }

  async readThread(threadId: string) {
    this.readCalls.push(threadId);
    if (this.failOnce === threadId) { this.failOnce = undefined; throw new Error("temporary read failure"); }
    const value = this.threads.get(threadId);
    if (value === undefined) throw new Error("missing thread");
    return value;
  }
}

function summary(value: HistoricalThread): HistoricalThreadSummary {
  return {
    id: value.id, preview: value.preview, cwd: value.cwd, createdAt: value.createdAt,
    updatedAt: value.updatedAt, ...(value.cliVersion === undefined ? {} : { cliVersion: value.cliVersion }),
    ...(value.archived === undefined ? {} : { archived: value.archived }),
  };
}

function sink() {
  const ids = new Set<string>();
  return {
    events: [] as string[],
    append(event: { eventId: string }) {
      const duplicate = ids.has(event.eventId);
      ids.add(event.eventId); this.events.push(event.eventId);
      return { status: duplicate ? "duplicate" as const : "appended" as const };
    },
  };
}

describe("CodexBackfillService", () => {
  it("defaults to a read-only dry-run and reports scope, size, and policy decisions", async () => {
    const eligible = thread("eligible");
    const short = thread("short", { turns: [turn("short-1")] });
    const sensitive = thread("sensitive", { preview: "rotate secret token" });
    const processed = thread("processed");
    const outside = thread("outside", { cwd: "/workspace/other" });
    const active = thread("active", { turns: [turn("active-1"), turn("active-2", "inProgress")] });
    const all = [eligible, short, sensitive, processed, outside, active];
    const history = new FakeHistory(new Map([["first", { data: all.map(summary) }]]), new Map(all.map((item) => [item.id, item])));
    const service = new CodexBackfillService(history, { processedThreads: { isProcessed: (id) => id === "processed" } });
    const result = await service.execute({ scope: { level: "PROJECT", projectId: "project-1", cwd: CWD } });

    expect(result).toMatchObject({ dryRun: true, status: "DRY_RUN", scannedThreads: 6, eligibleThreads: 1, processedThreads: 0, skippedThreads: 5, appendedEvents: 0 });
    expect(result.threads.map((item) => item.decision)).toEqual(["ELIGIBLE", "SHORT_SESSION", "SENSITIVE_SESSION", "ALREADY_PROCESSED", "OUT_OF_SCOPE", "ACTIVE_SESSION"]);
    expect(result.estimatedBytes).toBeGreaterThan(0);
    expect(history.readCalls).toEqual(["eligible", "short", "active"]);
    expect(history.listCalls[0]).toMatchObject({ archived: false, limit: 50, cwd: CWD, sourceKinds: ["appServer", "cli", "vscode"] });
  });

  it("explicit live mode checkpoints each thread, pauses at the bound, and resumes without duplicate writes", async () => {
    const first = thread("first");
    const second = thread("second");
    const history = new FakeHistory(new Map([["first", { data: [summary(first), summary(second)] }]]), new Map([[first.id, first], [second.id, second]]));
    const checkpoint = new SqliteBackfillCheckpointStore(":memory:", { clock: () => new Date(NOW), runIdFactory: () => "run-live" });
    const eventSink = sink();
    const service = new CodexBackfillService(history, { checkpoint, eventSink });
    const request = { scope: { level: "PROJECT" as const, projectId: "project-1", cwd: CWD }, dryRun: false, maxThreads: 1 };

    const paused = await service.execute(request);
    expect(paused).toMatchObject({ runId: "run-live", resumed: false, status: "PAUSED", pauseReason: "MAX_THREADS", processedThreads: 1, appendedEvents: 7 });
    expect(checkpoint.get("run-live").status).toBe("RUNNING");
    const completed = await service.execute(request);
    expect(completed).toMatchObject({ runId: "run-live", resumed: true, status: "COMPLETED", processedThreads: 1, appendedEvents: 7 });
    expect(checkpoint.get("run-live").status).toBe("COMPLETED");
    expect(new Set(eventSink.events).size).toBe(14);
    checkpoint.close();
  });

  it("replays a PROCESSING thread after failure and lets the sink deduplicate partial writes", async () => {
    const value = thread("retry");
    const history = new FakeHistory(new Map([["first", { data: [summary(value)] }]]), new Map([[value.id, value]]));
    history.failOnce = "retry";
    const checkpoint = new SqliteBackfillCheckpointStore(":memory:", { runIdFactory: () => "run-retry" });
    const eventSink = sink();
    const service = new CodexBackfillService(history, { checkpoint, eventSink });
    const request = { scope: { level: "PROJECT" as const, projectId: "project-1", cwd: CWD }, dryRun: false };
    await expect(service.execute(request)).rejects.toThrow("temporary read failure");
    expect(checkpoint.threadStatus("run-retry", "retry")).toBe("PROCESSING");
    const result = await service.execute(request);
    expect(result).toMatchObject({ resumed: true, status: "COMPLETED", processedThreads: 1, appendedEvents: 7 });
    checkpoint.close();
  });

  it("supports abort checkpoints, pagination, and duplicate listing detection", async () => {
    const one = thread("one");
    const two = thread("two");
    const history = new FakeHistory(new Map([
      ["first", { data: [summary(one)], nextCursor: "page-2" }],
      ["page-2", { data: [summary(one), summary(two)] }],
    ]), new Map([[one.id, one], [two.id, two]]));
    const dry = await new CodexBackfillService(history).execute({ scope: { level: "PROJECT", projectId: "p", cwd: CWD } });
    expect(dry).toMatchObject({ status: "DRY_RUN", scannedThreads: 3, eligibleThreads: 2, skippedThreads: 1 });
    expect(dry.threads.map((item) => item.decision)).toEqual(["ELIGIBLE", "DUPLICATE_LISTING", "ELIGIBLE"]);

    const controller = new AbortController(); controller.abort();
    const checkpoint = new SqliteBackfillCheckpointStore(":memory:", { runIdFactory: () => "run-abort" });
    const paused = await new CodexBackfillService(history, { checkpoint, eventSink: sink() }).execute({ scope: { level: "PROJECT", projectId: "p", cwd: CWD }, dryRun: false, signal: controller.signal });
    expect(paused).toMatchObject({ status: "PAUSED", pauseReason: "ABORTED", runId: "run-abort" });
    expect(checkpoint.get("run-abort").status).toBe("RUNNING");
    checkpoint.close();
  });

  it("requires write ports only for explicit live mode and validates unsafe requests and history", async () => {
    const value = thread("valid");
    const history = new FakeHistory(new Map([["first", { data: [summary(value)] }]]), new Map([[value.id, value]]));
    const service = new CodexBackfillService(history);
    await expect(service.execute({ scope: { level: "PROJECT", projectId: "p", cwd: CWD }, dryRun: false })).rejects.toThrow("requires checkpoint");
    await expect(service.execute({ scope: { level: "PROJECT", projectId: "", cwd: CWD } })).rejects.toThrow("projectId");
    await expect(service.execute({ scope: { level: "GLOBAL", projectId: "p" } })).rejects.toThrow("cannot contain projectId");
    await expect(service.execute({ scope: { level: "GLOBAL" }, pageSize: 0 })).rejects.toThrow("pageSize");
    await expect(service.execute({ scope: { level: "GLOBAL" }, sourceKinds: ["bad-kind"] })).rejects.toThrow("sourceKinds");

    const loop = new FakeHistory(new Map([["first", { data: [], nextCursor: "loop" }], ["loop", { data: [], nextCursor: "loop" }]]), new Map());
    await expect(new CodexBackfillService(loop).execute({ scope: { level: "GLOBAL" } })).rejects.toThrow("cursor loop");
    const badPage: CodexHistoryPort = { listThreads: async () => ({ data: null as never }), readThread: async () => value };
    await expect(new CodexBackfillService(badPage).execute({ scope: { level: "GLOBAL" } })).rejects.toThrow("invalid data");
  });

  it("uses exact path boundaries and configured sensitive policies", async () => {
    const sibling = thread("sibling", { cwd: "/workspace/project-other" });
    const explicit = thread("explicit");
    const privatePath = thread("private", { cwd: "/workspace/project/private/repo" });
    const history = new FakeHistory(new Map([["first", { data: [summary(sibling), summary(explicit), summary(privatePath)] }]]), new Map([[sibling.id, sibling], [explicit.id, explicit], [privatePath.id, privatePath]]));
    const result = await new CodexBackfillService(history).execute({
      scope: { level: "GLOBAL" },
      policy: { sensitiveThreadIds: ["explicit"], sensitivePreviewTerms: [], sensitiveCwdPrefixes: ["/workspace/project/private/"] },
    });
    expect(result.threads.map((item) => item.decision)).toEqual(["ELIGIBLE", "SENSITIVE_SESSION", "SENSITIVE_SESSION"]);

    const windows = thread("windows", { cwd: "C:\\Workspace\\Project\\repo" });
    const windowsHistory = new FakeHistory(new Map([["first", { data: [summary(windows)] }]]), new Map([[windows.id, windows]]));
    const windowsResult = await new CodexBackfillService(windowsHistory).execute({ scope: { level: "PROJECT", projectId: "windows-project", cwd: "c:/workspace/project" } });
    expect(windowsResult.threads[0]?.decision).toBe("ELIGIBLE");
  });
});
