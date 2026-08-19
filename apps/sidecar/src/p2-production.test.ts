import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { EventEnvelope } from "@zhiloop/domain";
import type { ExtractionSnapshot } from "@zhiloop/control-api";
import type { KnowledgeExtractionPort } from "@zhiloop/knowledge-compiler";
import { resolveProjectIdentity } from "@zhiloop/project-identity";
import { afterEach, describe, expect, it } from "vitest";

import { P2ProductionComposition, deriveP2EpisodeProjectContext, deriveP2ProjectContext, readP2SnapshotRecords } from "./p2-production.js";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true }))));
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

function event(sessionId: string, index: number): EventEnvelope {
  return {
    schemaVersion: 1, eventId: sha(`${sessionId}:event:${index}`), source: "codex-hook", sourceItemId: `${sessionId}-${index}`,
    eventType: "user.prompted", sessionId, turnId: `${sessionId}-turn-${index}`,
    occurredAt: new Date(Date.UTC(2026, 7, 4, 8, 0, 0, index)).toISOString(), cwd: "/workspace/shared-project",
    projectHint: "github.com/org/shared-project", contentHash: sha(`${sessionId}:content:${index}`), correlationId: sha(sessionId),
    payload: { kind: "user-prompt", prompt: `prompt ${index}` },
  };
}

function snapshot(sessionId: string, from: number, to: number): ExtractionSnapshot {
  return {
    schemaVersion: 1, snapshotId: `snapshot_${sha(sessionId).slice(0, 48)}`, revision: 1, identityHash: sha(`${sessionId}:identity`),
    sessionId, transcriptIdentityHash: sha(`${sessionId}:transcript`), sourceSequence: { from, to }, cursor: { byteOffset: to, lineNumber: to },
    completeness: { status: "PARTIAL_SNAPSHOT", sourceClosed: false, unsupportedEventTypes: [] }, compilerVersion: "mvp-compiler-v4",
    policyHash: sha("policy"), configurationHash: sha("configuration"), createdAt: "2026-08-04T08:00:00.000Z",
  };
}

describe("P2 production Ledger boundary", () => {
  it("resolves a nested Git project from structured opening-turn tool input only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-project-")); directories.push(directory);
    const project = join(directory, "black-hole");
    await mkdir(join(project, ".git"), { recursive: true });
    const source = event("session-project", 1);
    const record = {
      sequence: 1,
      event: {
        ...source,
        eventType: "tool.completed" as const,
        cwd: directory,
        payload: { kind: "tool-completed", toolName: "codegraph_context", toolInput: { projectPath: project } },
      },
      storedPayloadHash: sha("stored"), redactionCount: 0, payloadPurged: false,
      insertedAt: source.occurredAt,
    };
    const fallback = { projectId: "workspace", repositoryRoot: directory, portable: false } as const;
    const canonical = (await resolveProjectIdentity(project)).context;
    const canonicalRoot = await realpath(project);
    expect(deriveP2EpisodeProjectContext([record], fallback)).toMatchObject({ repositoryRoot: canonicalRoot, portable: false });
    expect(deriveP2EpisodeProjectContext([record], fallback, new Map([[canonicalRoot, canonical]]))).toEqual(canonical);
    const forged = { ...record, event: { ...record.event,
      payload: { kind: "tool-completed", toolInput: { command: `cd ${project}` } } } };
    expect(deriveP2EpisodeProjectContext([forged], fallback)).toEqual(fallback);
  });

  it("keeps the session fallback when Episode project evidence is missing or tied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-project-tie-")); directories.push(directory);
    const left = join(directory, "left");
    const right = join(directory, "right");
    await Promise.all([mkdir(join(left, ".git"), { recursive: true }), mkdir(join(right, ".git"), { recursive: true })]);
    const source = event("session-project-tie", 1);
    const makeRecord = (projectPath: string, sequence: number) => ({
      sequence,
      event: { ...source, eventId: sha(`tie:${sequence}`), eventType: "tool.completed" as const,
        payload: { kind: "tool-completed", toolInput: { projectPath } } },
      storedPayloadHash: sha(`stored:${sequence}`), redactionCount: 0, payloadPurged: false,
      insertedAt: source.occurredAt,
    });
    const fallback = { projectId: "workspace", repositoryRoot: directory, portable: false } as const;
    expect(deriveP2EpisodeProjectContext([], fallback)).toEqual(fallback);
    expect(deriveP2EpisodeProjectContext([makeRecord(left, 1), makeRecord(right, 2)], fallback)).toEqual(fallback);
    expect(deriveP2EpisodeProjectContext([makeRecord(join(directory, "missing"), 3)], fallback)).toEqual(fallback);
  });

  it("does not compose semantic arbitration while disabled and truthfully reports injected readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-semantic-")); directories.push(directory);
    const ledger = new SqliteEventLedger(join(directory, "ledger.sqlite"));
    const compiler: KnowledgeExtractionPort = { extract: async () => ({ schemaVersion: 1, candidates: [] }) };
    const common = { stateDirectory: directory, ledger, extraction: () => ({}) as never,
      compilerTimeoutMs: 1_000, compilerBatchSize: 10, compiler };
    const disabled = await P2ProductionComposition.create(common);
    expect(disabled.semanticEvolutionCapability()).toEqual({ status: "DISABLED", reasonCode: "SEMANTIC_EVOLUTION_DISABLED" });
    disabled.close();
    const enabled = await P2ProductionComposition.create({ ...common, semanticJudgeEnabled: true,
      semanticJudge: { arbitrate: async () => { throw new Error("unused"); } } });
    expect(enabled.semanticEvolutionCapability()).toEqual({ status: "READY", reasonCode: "SEMANTIC_EVOLUTION_READY" });
    enabled.close();
    ledger.close();
  });

  it("pages beyond SQLite's 1000-row read cap and keeps project identity stable across sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-production-")); directories.push(directory);
    const ledger = new SqliteEventLedger(join(directory, "ledger.sqlite"));
    try {
      for (let index = 1; index <= 1_500; index += 1) ledger.append(event("session-a", index));
      ledger.append(event("session-b", 1));
      const first = snapshot("session-a", 1, 1_500);
      const second = snapshot("session-b", 1_501, 1_501);
      expect(readP2SnapshotRecords(ledger, first, 1_501)).toHaveLength(1_500);
      // max+1 is an intentional sentinel: the worker can detect oversized
      // snapshots instead of silently compiling a truncated prefix.
      expect(readP2SnapshotRecords(ledger, first, 1_001)).toHaveLength(1_001);
      expect(deriveP2ProjectContext(first, ledger, directory)).toEqual(deriveP2ProjectContext(second, ledger, directory));
      expect(deriveP2ProjectContext(first, ledger, directory)).toMatchObject({ repositoryRoot: "/workspace/shared-project", portable: false });
    } finally {
      ledger.close();
    }
  });

  it("reads immutable snapshots across legal AUTOINCREMENT gaps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-production-gaps-")); directories.push(directory);
    const ledger = new SqliteEventLedger(join(directory, "ledger.sqlite"));
    try {
      const first = event("session-gaps", 1);
      ledger.append(first);
      ledger.append(first); // INSERT OR IGNORE still consumes an AUTOINCREMENT value.
      ledger.append(event("session-gaps", 2));

      const records = readP2SnapshotRecords(ledger, snapshot("session-gaps", 1, 3), 10);
      expect(records.map(({ sequence }) => sequence)).toEqual([1, 3]);
    } finally {
      ledger.close();
    }
  });

  it("fails closed when a snapshot exceeds the 5000-record compiler boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-production-limit-")); directories.push(directory);
    const ledger = new SqliteEventLedger(join(directory, "ledger.sqlite"));
    try {
      for (let index = 1; index <= 5_001; index += 1) ledger.append(event("session-limit", index));
      const oversized = snapshot("session-limit", 1, 5_001);
      expect(readP2SnapshotRecords(ledger, oversized, 5_001)).toHaveLength(5_001);
      expect(() => deriveP2ProjectContext(oversized, ledger, directory)).toThrow("bounded compiler input");
    } finally {
      ledger.close();
    }
  });
});
