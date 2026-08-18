import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { EventEnvelope } from "@zhiloop/domain";
import type { ExtractionSnapshot } from "@zhiloop/control-api";
import type { KnowledgeExtractionPort } from "@zhiloop/knowledge-compiler";
import { afterEach, describe, expect, it } from "vitest";

import { P2ProductionComposition, deriveP2ProjectContext, readP2SnapshotRecords } from "./p2-production.js";

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
    completeness: { status: "PARTIAL_SNAPSHOT", sourceClosed: false, unsupportedEventTypes: [] }, compilerVersion: "mvp-compiler-v3",
    policyHash: sha("policy"), configurationHash: sha("configuration"), createdAt: "2026-08-04T08:00:00.000Z",
  };
}

describe("P2 production Ledger boundary", () => {
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
