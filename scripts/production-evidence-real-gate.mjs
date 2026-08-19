import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { CodeGraphCliAdapter } from "@zhiloop/codegraph-adapter";
import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import { readTranscriptIncrement } from "@zhiloop/ingestion-codex";

import { P2ProductionComposition } from "../apps/sidecar/dist/p2-production.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function transcriptArgument(argv) {
  const index = argv.indexOf("--transcript");
  const candidate = index < 0 ? process.env.ZHILOOP_REAL_TRANSCRIPT : argv[index + 1];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("pass --transcript <absolute Codex rollout JSONL path> or set ZHILOOP_REAL_TRANSCRIPT");
  }
  const path = resolve(candidate);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error("transcript path is not a readable file");
  return path;
}

function appendBounded(ledger, events) {
  for (let offset = 0; offset < events.length; offset += 1_000) {
    ledger.appendBatch(events.slice(offset, offset + 1_000));
  }
}

async function projectTranscript(path, ledger) {
  let cursor;
  let ignoredRecords = 0;
  const eventTypes = new Map();
  do {
    const previousOffset = cursor?.byteOffset ?? -1;
    const result = await readTranscriptIncrement(path, cursor, {
      maxReadBytes: 16 * 1024 * 1024,
      maxLineBytes: 8 * 1024 * 1024,
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    appendBounded(ledger, result.value.events);
    for (const event of result.value.events) {
      eventTypes.set(event.eventType, (eventTypes.get(event.eventType) ?? 0) + 1);
    }
    ignoredRecords += result.value.ignoredRecords;
    cursor = result.value.cursor;
    if (result.value.hasMore && cursor.byteOffset <= previousOffset) {
      throw new Error("transcript reader made no progress while more input remained");
    }
  } while (cursor?.byteOffset !== undefined && cursor.byteOffset < statSync(path).size);
  if (cursor === undefined || cursor.sessionId === undefined) throw new Error("transcript did not contain supported session metadata");
  return Object.freeze({
    cursor,
    ignoredRecords,
    eventTypes: Object.fromEntries([...eventTypes.entries()].sort(([left], [right]) => left.localeCompare(right))),
  });
}

function markdownFileCount(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += markdownFileCount(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) count += 1;
  }
  return count;
}

async function replayCodexTranscript(transcriptPath, root) {
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const ledger = new SqliteEventLedger(join(stateDirectory, "ledger.sqlite"));
  let production;
  try {
    const projection = await projectTranscript(transcriptPath, ledger);
    const records = ledger.readAfter(0, 1_000);
    const first = records[0];
    const lastSequence = ledger.count();
    if (first === undefined || lastSequence < 1) throw new Error("real transcript projected no supported Ledger events");
    const lastPage = ledger.readAfter(Math.max(0, lastSequence - 1), 1);
    const last = lastPage[0];
    if (last === undefined) throw new Error("last projected Ledger event is unavailable");
    const snapshotIdentity = sha256(JSON.stringify([
      projection.cursor.transcriptKey,
      first.event.sessionId,
      1,
      lastSequence,
      projection.cursor.byteOffset,
      projection.cursor.lineNumber,
    ]));
    const snapshot = Object.freeze({
      schemaVersion: 1,
      snapshotId: `snapshot_${snapshotIdentity.slice(0, 48)}`,
      revision: 1,
      identityHash: snapshotIdentity,
      sessionId: first.event.sessionId,
      transcriptIdentityHash: projection.cursor.transcriptKey,
      sourceSequence: Object.freeze({ from: 1, to: lastSequence }),
      cursor: Object.freeze({ byteOffset: projection.cursor.byteOffset, lineNumber: projection.cursor.lineNumber }),
      completeness: Object.freeze({
        status: "PARTIAL_SNAPSHOT",
        sourceClosed: false,
        unsupportedEventTypes: projection.ignoredRecords === 0 ? [] : ["unsupported_transcript_record"],
      }),
      compilerVersion: "mvp-compiler-v4",
      policyHash: sha256("production-evidence-real-gate-policy-v1"),
      configurationHash: sha256("production-evidence-real-gate-configuration-v1"),
      createdAt: last.event.occurredAt,
    });
    writeFileSync(join(stateDirectory, "real-replay-marker.txt"), "bounded immutable preview\n");
    const compiler = {
      extract: async (input) => ({
        schemaVersion: 1,
        candidates: [{
          subjectKey: "gate.real.codex.transcript.preview",
          kind: "FACT",
          scopeHint: { level: "PROJECT", reasonCodes: ["PROJECT_BOUND_REAL_REPLAY"] },
          title: "Real Codex transcript is replayable",
          summary: "A bounded immutable Snapshot can drive evidence-backed Preview evaluation.",
          body: "This gate candidate exists only in the isolated Preview run and is never published.",
          confidence: 0.95,
          assertions: [{
            kind: "FILE_CONTAINS",
            parameters: { path: "real-replay-marker.txt", expected: "bounded immutable preview", matchMode: "EXACT" },
          }],
          evidenceHints: [{ type: "USER_STATEMENT", sourceRef: input.goalRef }],
        }],
      }),
    };
    production = await P2ProductionComposition.create({
      stateDirectory,
      ledger,
      extraction: () => ({ getSnapshot: (snapshotId) => snapshotId === snapshot.snapshotId ? snapshot : undefined }),
      compilerTimeoutMs: 5_000,
      compilerBatchSize: 10,
      verificationTimeoutMs: 5_000,
      codeGraphTimeoutMs: 1_000,
      compiler,
    });
    const preview = await production.worker.runtime.run(production.worker.requestFor(snapshot), {
      executionMode: "PREVIEW_ONLY",
    });
    const policies = preview.payload.policies ?? [];
    const failedStages = Object.entries(preview.stages)
      .filter(([, stage]) => stage.status === "RETRYABLE" || stage.status === "FAILED")
      .map(([name, stage]) => ({ name, status: stage.status, error: stage.error }));
    assert.equal(preview.status, "AWAITING_COMMIT", JSON.stringify(failedStages));
    assert.equal(production.registry.listAssets().length, 0);
    assert.equal(markdownFileCount(join(stateDirectory, "knowledge")), 0);
    assert.ok((preview.payload.candidates?.length ?? 0) > 0);
    assert.equal(policies.length, preview.payload.candidates?.length);
    assert.ok(policies.every((policy) => policy.decision.shouldPublish === false));
    assert.ok(policies.every((policy) => policy.verificationResults.every((result) => result.status === "SUPPORTED")));
    return Object.freeze({
      transcriptFile: basename(transcriptPath),
      sessionId: first.event.sessionId,
      transcriptBytes: statSync(transcriptPath).size,
      transcriptLines: projection.cursor.lineNumber,
      projectedEvents: lastSequence,
      ignoredRecords: projection.ignoredRecords,
      eventTypes: projection.eventTypes,
      snapshotId: snapshot.snapshotId,
      snapshotIdentityHash: snapshot.identityHash,
      executionMode: "PREVIEW_ONLY",
      checkpointStatus: preview.status,
      candidateCount: preview.payload.candidates?.length ?? 0,
      verification: policies.map((policy) => policy.verificationResults.map((result) => ({
        assertionKind: result.assertionKind,
        status: result.status,
        reasonCodes: result.reasonCodes,
      }))),
      targetStatuses: [...new Set(policies.map((policy) => policy.decision.targetStatus))].sort(),
      shouldPublish: policies.some((policy) => policy.decision.shouldPublish),
      registryAssets: production.registry.listAssets().length,
      markdownFiles: markdownFileCount(join(stateDirectory, "knowledge")),
      compiler: "DETERMINISTIC_GATE_FIXTURE",
    });
  } finally {
    production?.close();
    ledger.close();
  }
}

function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function replayCodeGraph(root) {
  const repository = join(root, "codegraph-repository");
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, "src", "flow.ts"), [
    "export function leaf(): number { return 1; }",
    "export function middle(): number { return leaf(); }",
    "export function root(): number { return middle(); }",
    "",
  ].join("\n"));
  command("git", ["init"], repository);
  command("git", ["add", "."], repository);
  command("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], repository);

  const adapter = new CodeGraphCliAdapter(undefined, { timeoutMs: 5_000, capabilityTtlMs: 0 });
  const beforeProject = { projectRoot: repository, projectFingerprint: sha256("uninitialized") };
  const before = await adapter.capabilities(beforeProject, { refresh: true });
  assert.equal(before.status, "NOT_CONFIGURED");
  assert.equal(existsSync(join(repository, ".codegraph")), false, "capability detection must not initialize CodeGraph");

  command("codegraph", ["init", "-i", repository], repository);
  const baselineProject = { projectRoot: repository, projectFingerprint: sha256("baseline") };
  const ready = await adapter.capabilities(baselineProject, { refresh: true });
  assert.equal(ready.status, "READY");
  const symbols = await adapter.findSymbols(baselineProject, { symbol: "root", path: "src/flow.ts", limit: 10 });
  const trace = await adapter.trace(baselineProject, "root", "leaf", 4, 20);
  const impact = await adapter.impact(baselineProject, "leaf", 20);
  assert.equal(symbols.capability.status, "READY");
  assert.ok(symbols.facts.some((fact) => fact.symbol === "root"));
  assert.equal(trace.capability.status, "READY");
  assert.ok(trace.facts.some((fact) => fact.symbols[0] === "root" && fact.symbols.at(-1) === "leaf"));
  assert.equal(impact.capability.status, "READY");
  assert.ok(impact.facts.length > 0);

  writeFileSync(join(repository, "src", "flow.ts"), [
    "export function leaf(): number { return 2; }",
    "export function middle(): number { return leaf(); }",
    "export function root(): number { return middle(); }",
    "export function changed(): number { return root(); }",
    "",
  ].join("\n"));
  const changedProject = { projectRoot: repository, projectFingerprint: sha256("changed") };
  const stale = await adapter.capabilities(changedProject, { refresh: true });
  assert.equal(stale.status, "UNAVAILABLE");
  assert.equal(stale.reasonCode, "CODEGRAPH_INDEX_STALE");

  command("codegraph", ["sync", repository], repository);
  const reindexed = await adapter.capabilities(changedProject, { refresh: true });
  assert.equal(reindexed.status, "READY");
  assert.notEqual(reindexed.indexRevision, ready.indexRevision);
  const changed = await adapter.findSymbols(changedProject, { symbol: "changed", path: "src/flow.ts", limit: 10 });
  assert.ok(changed.facts.some((fact) => fact.symbol === "changed"));
  return Object.freeze({
    automaticInitialization: false,
    before: { status: before.status, reasonCode: before.reasonCode },
    ready: { status: ready.status, reasonCode: ready.reasonCode, indexRevision: ready.indexRevision },
    queryFacts: symbols.facts.length,
    traceFacts: trace.facts.length,
    impactFacts: impact.facts.length,
    afterChange: { status: stale.status, reasonCode: stale.reasonCode, indexRevision: stale.indexRevision },
    afterSync: { status: reindexed.status, reasonCode: reindexed.reasonCode, indexRevision: reindexed.indexRevision },
    changedSymbolFacts: changed.facts.length,
  });
}

const transcriptPath = transcriptArgument(process.argv.slice(2));
const temporaryRoot = mkdtempSync(join(tmpdir(), "zhiloop-production-evidence-gate-"));
try {
  const report = Object.freeze({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    codexReplay: await replayCodexTranscript(transcriptPath, temporaryRoot),
    codeGraphReplay: await replayCodeGraph(temporaryRoot),
    mutationBoundary: "ISOLATED_TEMPORARY_STATE_ONLY",
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
