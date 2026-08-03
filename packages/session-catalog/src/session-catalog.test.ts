import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APP_SERVER_CATALOG_FORMAT_V1,
  APP_SERVER_CATALOG_FORMAT_V2,
  AppServerSessionCatalogSource,
  EmptyCaptureProjection,
  ReadOnlySessionCatalog,
  TranscriptSessionCatalogSource,
  UnconfiguredAppServerCatalogProvider,
  toCatalogEntry,
  toControlSessionSummary,
  type AppServerCatalogProviderPort,
  type CapturedSessionState,
  type SessionCaptureProjectionPort,
  type SessionCatalogSourcePort,
  type SessionSourceSnapshot,
  type SourceSessionRecord,
} from "./index.js";

const roots: string[] = [];
const now = new Date("2026-08-03T12:00:00.000Z");

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "zhiloop-session-catalog-"));
  roots.push(value);
  return value;
}

function jsonl(...values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function sessionMeta(
  id: string,
  timestamp: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { type: "session_meta", timestamp, payload: { id, cli_version: "0.120.0", ...extra } };
}

function event(timestamp: string, payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { type: "event_msg", timestamp, payload };
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

class Projection implements SessionCaptureProjectionPort {
  constructor(readonly values: ReadonlyMap<string, CapturedSessionState>) {}
  async getMany(sessionIds: readonly string[]): Promise<ReadonlyMap<string, CapturedSessionState>> {
    return new Map(sessionIds.flatMap((id) => {
      const value = this.values.get(id);
      return value === undefined ? [] : [[id, value] as const];
    }));
  }
}

class FixedSource implements SessionCatalogSourcePort {
  calls = 0;
  constructor(readonly value: SessionSourceSnapshot) {}
  async scan(): Promise<SessionSourceSnapshot> {
    this.calls += 1;
    return this.value;
  }
}

function sourceRecord(overrides: Partial<SourceSessionRecord> = {}): SourceSessionRecord {
  return {
    sessionId: "session-a",
    source: "CODEX_APP_SERVER",
    sourceStatus: "AVAILABLE",
    sourceFormatVersion: APP_SERVER_CATALOG_FORMAT_V1,
    safeSourceAlias: "app-server:session-a",
    firstActivityAt: "2026-08-03T09:00:00.000Z",
    lastActivityAt: "2026-08-03T10:00:00.000Z",
    sourceRecordCount: 0,
    sourceTurnCount: 0,
    ignoredRecords: 0,
    ...overrides,
  };
}

function snapshot(
  source: "CODEX_APP_SERVER" | "CODEX_TRANSCRIPT",
  status: "AVAILABLE" | "UNAVAILABLE" | "UNSUPPORTED",
  sessions: readonly SourceSessionRecord[] = [],
): SessionSourceSnapshot {
  return {
    source,
    capability: {
      schemaVersion: 1,
      source,
      status,
      reason: status === "AVAILABLE" ? "READY" : status === "UNSUPPORTED" ? "UNSUPPORTED" : "UNAVAILABLE",
      observedAt: now.toISOString(),
      supportedFormatVersions: ["fixture-v1"],
      diagnosticCount: 0,
    },
    sessions,
    diagnostics: [],
    revision: `${source}:${status}:${String(sessions.length)}`,
    changed: false,
    scanStats: { filesVisited: 0, filesRead: 0, filesReused: 0 },
  };
}

describe("TranscriptSessionCatalogSource", () => {
  it("reads both supported transcript versions and excludes observable child sessions", async () => {
    const directory = await root();
    await mkdir(join(directory, "2026", "08"), { recursive: true });
    await writeFile(join(directory, "2026", "08", "v1.jsonl"), jsonl(
      sessionMeta("session-v1", "2026-08-03T08:00:00.000Z", { cwd: "/work/alpha" }),
      event("2026-08-03T10:00:00.000Z", { type: "user_message", turn_id: "turn-1", message: "Fix token=very-secret-value deployment" }),
      event("2026-08-03T10:01:00.000Z", { type: "task_complete", turn_id: "turn-1" }),
    ));
    await writeFile(join(directory, "v2.jsonl"), jsonl(
      sessionMeta("session-v2", "2026-08-02T08:00:00.000Z", { format_version: 2, title: "V2 planning" }),
      event("2026-08-02T09:00:00.000Z", { type: "task_started", turn_id: "turn-2" }),
    ));
    await writeFile(join(directory, "child.jsonl"), jsonl(
      sessionMeta("session-child", "2026-08-03T11:00:00.000Z", { parent_thread_id: "session-v1" }),
    ));

    const result = await new TranscriptSessionCatalogSource(directory, { clock: () => now }).scan();
    expect(result.capability.status).toBe("AVAILABLE");
    expect(result.sessions.map((item) => [item.sessionId, item.sourceFormatVersion])).toEqual([
      ["session-v1", "codex-rollout-jsonl-v1"],
      ["session-v2", "codex-rollout-jsonl-v2"],
    ]);
    expect(result.sessions[0]?.sourceTurnCount).toBe(1);
    expect(result.scanStats).toEqual({ filesVisited: 3, filesRead: 3, filesReused: 0 });
  });

  it("reuses unchanged files, discovers appends, and never mutates the source", async () => {
    const directory = await root();
    const path = join(directory, "active.jsonl");
    await writeFile(path, jsonl(sessionMeta("session-active", "2026-08-03T08:00:00.000Z")));
    await chmod(path, 0o640);
    const scanner = new TranscriptSessionCatalogSource(directory, { clock: () => now });
    const beforeContent = await readFile(path);
    const beforeStat = await lstat(path);

    const first = await scanner.scan();
    const unchanged = await scanner.scan();
    expect(first.changed).toBe(true);
    expect(unchanged.changed).toBe(false);
    expect(unchanged.scanStats).toEqual({ filesVisited: 1, filesRead: 0, filesReused: 1 });
    expect(digest(await readFile(path))).toBe(digest(beforeContent));
    const afterReadStat = await lstat(path);
    expect([afterReadStat.size, afterReadStat.mode & 0o777, afterReadStat.mtimeMs]).toEqual([
      beforeStat.size,
      beforeStat.mode & 0o777,
      beforeStat.mtimeMs,
    ]);

    await appendFile(path, jsonl(event("2026-08-03T11:00:00.000Z", { type: "user_message", turn_id: "turn-new", message: "New work" })));
    const appended = await scanner.scan();
    expect(appended.changed).toBe(true);
    expect(appended.scanStats).toEqual({ filesVisited: 1, filesRead: 1, filesReused: 0 });
    expect(appended.sessions[0]?.lastActivityAt).toBe("2026-08-03T11:00:00.000Z");
  });

  it("bounds malformed, unsupported, oversized, deep and symlink inputs with safe diagnostics", async () => {
    const directory = await root();
    const outside = await root();
    await writeFile(join(outside, "outside.jsonl"), jsonl(sessionMeta("outside", "2026-08-03T08:00:00.000Z")));
    await symlink(join(outside, "outside.jsonl"), join(directory, "link.jsonl"));
    await writeFile(join(directory, "unknown.jsonl"), jsonl(sessionMeta("unknown", "2026-08-03T08:00:00.000Z", { format_version: 99 })));
    await writeFile(join(directory, "malformed.jsonl"), `${jsonl(sessionMeta("malformed", "2026-08-03T08:00:00.000Z"))}not-json\n`);
    await writeFile(join(directory, "large.jsonl"), `${"x".repeat(600)}\n`);
    await writeFile(join(directory, "long-line.jsonl"), `${"x".repeat(350)}\n`);
    await mkdir(join(directory, "one", "two"), { recursive: true });
    await writeFile(join(directory, "one", "two", "deep.jsonl"), jsonl(sessionMeta("deep", "2026-08-03T08:00:00.000Z")));

    const result = await new TranscriptSessionCatalogSource(directory, {
      maxDepth: 1,
      maxFileBytes: 500,
      maxLineBytes: 300,
      clock: () => now,
    }).scan();
    expect(result.sessions).toEqual([]);
    expect(result.capability.status).toBe("UNSUPPORTED");
    expect(new Set(result.diagnostics.map((item) => item.code))).toEqual(new Set([
      "UNSAFE_PATH",
      "UNSUPPORTED_FORMAT",
      "MALFORMED_RECORD",
      "FILE_TOO_LARGE",
      "LINE_TOO_LARGE",
      "DEPTH_LIMIT_EXCEEDED",
    ]));
    expect(result.diagnostics.every((item) => !("message" in item))).toBe(true);
    expect(digest(await readFile(join(outside, "outside.jsonl")))).toBe(digest(Buffer.from(jsonl(sessionMeta("outside", "2026-08-03T08:00:00.000Z")))));
  });

  it("deduplicates IDs deterministically and reports unavailable roots", async () => {
    const directory = await root();
    await writeFile(join(directory, "b.jsonl"), jsonl(
      sessionMeta("duplicate", "2026-08-03T08:00:00.000Z", { title: "Older" }),
    ));
    await writeFile(join(directory, "a.jsonl"), jsonl(
      sessionMeta("duplicate", "2026-08-03T09:00:00.000Z", { title: "Newer" }),
    ));
    const result = await new TranscriptSessionCatalogSource(directory, { clock: () => now }).scan();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.explicitTitle).toBe("Newer");
    expect(result.diagnostics.map((item) => item.code)).toContain("DUPLICATE_SESSION_ID");

    const missing = await new TranscriptSessionCatalogSource(join(directory, "missing"), { clock: () => now }).scan();
    expect(missing.capability.status).toBe("UNAVAILABLE");
    expect(missing.diagnostics[0]?.code).toBe("UNSAFE_ROOT");
  });
});

describe("AppServerSessionCatalogSource", () => {
  it("adapts compatible v1/v2 metadata, excludes children, and deduplicates IDs", async () => {
    for (const formatVersion of [APP_SERVER_CATALOG_FORMAT_V1, APP_SERVER_CATALOG_FORMAT_V2]) {
      const provider: AppServerCatalogProviderPort = {
        async listPrimarySessions() {
          return {
            available: true,
            formatVersion,
            sourceVersion: "1.2.3",
            sessions: [
              { id: "same", title: "old", createdAt: 1_754_195_600, updatedAt: 1_754_195_700 },
              { id: "same", title: "new", createdAt: 1_754_195_600_000, updatedAt: 1_754_199_600_000 },
              { id: "child", parentThreadId: "same", createdAt: 1_754_195_600, updatedAt: 1_754_195_700 },
            ],
          };
        },
      };
      const result = await new AppServerSessionCatalogSource(provider, { clock: () => now }).scan();
      expect(result.capability.status).toBe("AVAILABLE");
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.explicitTitle).toBe("new");
      expect(result.sessions[0]?.sourceVersion).toBe("1.2.3");
      expect(result.diagnostics.map((item) => item.code)).toContain("DUPLICATE_SESSION_ID");
    }
  });

  it("returns bounded unsupported/unavailable capabilities without leaking provider errors", async () => {
    const unsupported = await new AppServerSessionCatalogSource({
      async listPrimarySessions() {
        return { available: true, formatVersion: "future-v99", sessions: [] };
      },
    }, { clock: () => now }).scan();
    expect(unsupported.capability.status).toBe("UNSUPPORTED");

    const malformed = await new AppServerSessionCatalogSource({
      async listPrimarySessions() {
        return { available: true, formatVersion: APP_SERVER_CATALOG_FORMAT_V1, sessions: [{ id: "missing-times" }] };
      },
    }, { clock: () => now }).scan();
    expect(malformed.capability.status).toBe("UNSUPPORTED");
    expect(malformed.sessions).toEqual([]);

    const throwing = await new AppServerSessionCatalogSource({
      async listPrimarySessions() {
        throw new Error("secret provider details");
      },
    }, { clock: () => now }).scan();
    expect(throwing.capability.status).toBe("UNAVAILABLE");
    expect(throwing.diagnostics).toEqual([{ code: "SOURCE_UNAVAILABLE", source: "CODEX_APP_SERVER", retryable: true }]);

    const unconfigured = await new AppServerSessionCatalogSource(new UnconfiguredAppServerCatalogProvider(), { clock: () => now }).scan();
    expect(unconfigured.capability.reason).toBe("NOT_CONFIGURED");
  });
});

describe("ReadOnlySessionCatalog", () => {
  it("uses App Server exclusively when available and falls back as a whole when unsupported", async () => {
    const appSession = sourceRecord({ sessionId: "app" });
    const transcriptSession = sourceRecord({
      sessionId: "transcript",
      source: "CODEX_TRANSCRIPT",
      sourceFormatVersion: "codex-rollout-jsonl-v1",
      safeSourceAlias: "2026/08/transcript.jsonl",
    });
    const primary = new FixedSource(snapshot("CODEX_APP_SERVER", "AVAILABLE", [appSession]));
    const fallback = new FixedSource(snapshot("CODEX_TRANSCRIPT", "AVAILABLE", [transcriptSession]));
    const selected = await new ReadOnlySessionCatalog(primary, fallback, { clock: () => now }).list();
    expect(selected.items.map((item) => item.sessionId)).toEqual(["app"]);
    expect(fallback.calls).toBe(0);

    const unsupported = new FixedSource(snapshot("CODEX_APP_SERVER", "UNSUPPORTED"));
    const fallbackCatalog = await new ReadOnlySessionCatalog(unsupported, fallback, { clock: () => now }).list();
    expect(fallbackCatalog.items.map((item) => item.sessionId)).toEqual(["transcript"]);
    expect(fallbackCatalog.sourceCapabilities.map((item) => item.status)).toEqual(["UNSUPPORTED", "AVAILABLE"]);
  });

  it("applies stable ordering, grouping, title fallbacks, capture status, pagination and DTO mapping", async () => {
    const records = [
      sourceRecord({ sessionId: "b", explicitTitle: "  Explicit\nTitle  ", lastActivityAt: "2026-08-03T10:00:00.000Z" }),
      sourceRecord({ sessionId: "a", firstUserPrompt: "Deploy api_key=top-secret now", lastActivityAt: "2026-08-03T10:00:00.000Z" }),
      sourceRecord({ sessionId: "yesterday", cwd: "/work/project-x", firstActivityAt: "2026-08-02T08:00:00.000Z", lastActivityAt: "2026-08-02T10:00:00.000Z" }),
      sourceRecord({ sessionId: "week", firstActivityAt: "2026-07-29T08:00:00.000Z", lastActivityAt: "2026-07-29T10:00:00.000Z" }),
      sourceRecord({ sessionId: "old", firstActivityAt: "2026-07-01T08:00:00.000Z", lastActivityAt: "2026-07-01T10:00:00.000Z" }),
    ];
    const capture = new Projection(new Map([
      ["a", { current: false, eventCount: 2, turnCount: 1, ignoredRecords: 3, redactionCount: 1, projectHint: "project-a", cwdAlias: "~/project-a" }],
      ["b", { current: true, eventCount: 4, turnCount: 2, ignoredRecords: 0, redactionCount: 0 }],
    ]));
    const source = new FixedSource(snapshot("CODEX_APP_SERVER", "AVAILABLE", records));
    const fallback = new FixedSource(snapshot("CODEX_TRANSCRIPT", "AVAILABLE"));
    const catalog = new ReadOnlySessionCatalog(source, fallback, { captureProjection: capture, clock: () => now });
    const first = await catalog.list({ limit: 2 });
    expect(first.items.map((item) => item.sessionId)).toEqual(["a", "b"]);
    expect(first.items.map((item) => item.captureStatus)).toEqual(["CAPTURED_PARTIAL", "CAPTURED_CURRENT"]);
    expect(first.items[0]?.title).toBe("Deploy [REDACTED] now");
    expect(first.items[1]?.title).toBe("Explicit Title");
    expect(first.nextPosition).toEqual({ lastActivityAt: "2026-08-03T10:00:00.000Z", sessionId: "b" });
    const nextPosition = first.nextPosition;
    if (nextPosition === undefined) throw new Error("expected a second page");
    const second = await catalog.list({ limit: 2, after: nextPosition });
    expect(second.changed).toBe(false);
    expect(second.items.map((item) => item.sessionId)).toEqual(["yesterday", "week"]);
    expect(second.items.map((item) => item.timeGroup)).toEqual(["YESTERDAY", "PREVIOUS_7_DAYS"]);
    expect((await catalog.get("old"))?.timeGroup).toBe("OLDER");
    expect(toControlSessionSummary(first.items[0] as NonNullable<(typeof first.items)[0]>)).toEqual({
      schemaVersion: 1,
      sessionId: "a",
      title: "Deploy [REDACTED] now",
      source: "CODEX_APP_SERVER",
      sourceStatus: "AVAILABLE",
      captureStatus: "CAPTURED_PARTIAL",
      projectHint: "project-a",
      cwdAlias: "~/project-a",
      firstActivityAt: "2026-08-03T09:00:00.000Z",
      lastActivityAt: "2026-08-03T10:00:00.000Z",
      eventCount: 2,
      turnCount: 1,
      ignoredRecords: 3,
      redactionCount: 1,
    });
  });

  it("represents every status and rejects unbounded or malformed queries", async () => {
    const missingSource = toCatalogEntry(sourceRecord({ sourceStatus: "UNAVAILABLE" }), undefined, now);
    expect(missingSource.captureStatus).toBe("SOURCE_UNAVAILABLE");
    const discovered = toCatalogEntry(sourceRecord(), undefined, now);
    expect(discovered.captureStatus).toBe("DISCOVERED_NOT_CAPTURED");
    expect(discovered.title).toBe("Session session-a");
    expect(await new EmptyCaptureProjection().getMany(["x"])).toEqual(new Map());

    const retainedProjection: SessionCaptureProjectionPort = {
      async getMany() {
        return new Map([["retained", { current: false, eventCount: 1, turnCount: 1, ignoredRecords: 0, redactionCount: 0 }]]);
      },
      async listKnownSessions(maximum) {
        expect(maximum).toBe(50_000);
        return [sourceRecord({ sessionId: "retained" })];
      },
    };
    const unavailableCatalog = new ReadOnlySessionCatalog(
      new FixedSource(snapshot("CODEX_APP_SERVER", "UNAVAILABLE")),
      new FixedSource(snapshot("CODEX_TRANSCRIPT", "UNAVAILABLE")),
      { captureProjection: retainedProjection, clock: () => now },
    );
    expect((await unavailableCatalog.list()).items[0]?.captureStatus).toBe("SOURCE_UNAVAILABLE");

    const source = new FixedSource(snapshot("CODEX_APP_SERVER", "AVAILABLE", [sourceRecord()]));
    const catalog = new ReadOnlySessionCatalog(source, new FixedSource(snapshot("CODEX_TRANSCRIPT", "AVAILABLE")), { clock: () => now });
    await expect(catalog.list({ limit: 101 })).rejects.toThrow(/limit/);
    await expect(catalog.list({ after: { lastActivityAt: "invalid", sessionId: "x" } })).rejects.toThrow(/page position/);
    await expect(catalog.get("../unsafe")).rejects.toThrow(/invalid session id/);
  });

  it("queries a session beyond the first page with one bounded source scan", async () => {
    const records = Array.from({ length: 250 }, (_, index) => sourceRecord({
      sessionId: `session-${String(index).padStart(3, "0")}`,
      lastActivityAt: new Date(Date.parse("2026-08-03T10:00:00.000Z") - index * 1_000).toISOString(),
    }));
    const source = new FixedSource(snapshot("CODEX_APP_SERVER", "AVAILABLE", records));
    const fallback = new FixedSource(snapshot("CODEX_TRANSCRIPT", "AVAILABLE"));
    const catalog = new ReadOnlySessionCatalog(source, fallback, { clock: () => now });
    expect((await catalog.get("session-249"))?.sessionId).toBe("session-249");
    expect(source.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it("discovers at least 99 percent of the bounded P0 catalog fixture", async () => {
    const records = Array.from({ length: 250 }, (_value, index) => sourceRecord({
      sessionId: `coverage-${String(index).padStart(3, "0")}`,
      lastActivityAt: new Date(Date.parse("2026-08-03T10:00:00.000Z") - index * 1_000).toISOString(),
    }));
    const catalog = new ReadOnlySessionCatalog(
      new FixedSource(snapshot("CODEX_APP_SERVER", "AVAILABLE", records)),
      new FixedSource(snapshot("CODEX_TRANSCRIPT", "AVAILABLE")),
      { clock: () => now },
    );
    const discovered = new Set<string>();
    let after: { readonly lastActivityAt: string; readonly sessionId: string } | undefined;
    do {
      const page = await catalog.list({ limit: 100, ...(after === undefined ? {} : { after }) });
      for (const item of page.items) discovered.add(item.sessionId);
      after = page.nextPosition;
    } while (after !== undefined);
    expect(discovered.size / records.length).toBeGreaterThanOrEqual(0.99);
    expect(discovered.size).toBe(records.length);
  });
});
