import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIGURATION } from "../packages/config/dist/index.js";
import { normalizeConversations } from "../packages/conversation-normalizer/dist/index.js";
import { SqliteEventLedger } from "../packages/conversation-ledger/dist/index.js";
import { buildEpisodes } from "../packages/episode-builder/dist/index.js";
import { createMvpVerifierRegistry } from "../packages/evidence-engine/dist/index.js";
import { evaluateEvidencePolicy } from "../packages/evidence-policy/dist/index.js";
import { adaptCodexHook } from "../packages/ingestion-codex/dist/index.js";
import { SqliteKnowledgeRegistryProjection } from "../packages/knowledge-registry/dist/index.js";
import {
  DEFAULT_MVP_COMPILER_VERSION,
  DEFAULT_MVP_PROMPT_VERSION,
  MvpKnowledgeCompiler,
  runKnowledgeExtraction,
  toKnowledgeExtractionInput,
} from "../packages/knowledge-compiler/dist/index.js";
import {
  calculateKnowledgeContentHash,
  MarkdownKnowledgeRepository,
} from "../packages/markdown-repository/dist/index.js";
import { resolveKnowledgeScope } from "../packages/scope-resolver/dist/index.js";

const at = "2026-08-02T14:00:00.000Z";
const project = {
  projectId: "project-p4-golden",
  repositoryRoot: "/fixture/project-p4-golden",
  repositoryRemote: "github.com/smarteacup/zhiloop",
  branch: "main",
  portable: true,
};
const projectScope = { level: "PROJECT", projectId: project.projectId, repositoryRemote: project.repositoryRemote };

async function conversationEpisode() {
  const rows = (await readFile("fixtures/p2/v1/codex-hook-knowledge-session.jsonl", "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const events = rows.map((row) => {
    const result = adaptCodexHook(row.hook, { observedAt: row.observedAt });
    assert.equal(result.ok, true);
    return result.value;
  });
  const ledger = new SqliteEventLedger(":memory:", { clock: () => new Date(at) });
  ledger.appendBatch(events);
  const records = ledger.readAfter(0, 100);
  const normalized = normalizeConversations(records, { asOf: at });
  const episode = buildEpisodes(records, normalized.sessions, { projectResolver: () => project }).episodes[0];
  assert.ok(episode);
  return { episode, ledger };
}

function model() {
  return {
    generate: async () => ({
      schemaVersion: 1,
      candidates: [{
        subjectKey: "implementation.governance.audited-cli",
        kind: "IMPLEMENTATION",
        scopeHint: { level: "PROJECT", projectId: project.projectId, reasonCodes: ["P4_GOLDEN_EPISODE"] },
        title: "Use an audited knowledge governance CLI",
        summary: "Governance mutations retain audit records and preserve Markdown as the authority.",
        body: "The governance service applies Domain status gates, publishes immutable Markdown, and projects SQLite transactionally.",
        confidence: 0.96,
        assertions: [{
          kind: "SYMBOL_EXISTS",
          parameters: {
            projectId: project.projectId,
            symbol: "KnowledgeGovernanceService",
            path: "packages/knowledge-governance/src/service.ts",
          },
        }],
        evidenceHints: [],
      }],
    }),
  };
}

async function compile(episode) {
  const result = await runKnowledgeExtraction({
    input: toKnowledgeExtractionInput(episode),
    compilerVersion: DEFAULT_MVP_COMPILER_VERSION,
    promptVersion: DEFAULT_MVP_PROMPT_VERSION,
    requestedAt: at,
    correlationId: "p4-golden-correlation",
  }, new MvpKnowledgeCompiler({ model: model() }), {
    maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000,
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.candidates.length, 1);
  return result.candidates[0];
}

function probe(status, sourceRef) {
  if (status === "ERROR") return { observe: async () => { throw new Error("shadow verifier outage"); } };
  return {
    observe: async (assertion) => ({
      status,
      sourceRef,
      observedAt: at,
      target: assertion.kind === "SYMBOL_EXISTS"
        ? `symbol:${assertion.parameters.projectId}:${assertion.parameters.symbol}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`
        : `test:${assertion.parameters.testId}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`,
      reasonCode: `${status}_BY_P4_FIXTURE`,
    }),
  };
}

async function decide(candidate, probeStatus, includeTest = false) {
  const scope = resolveKnowledgeScope({ candidate, projectContext: project });
  const probes = {
    symbol: probe(probeStatus, `event-shadow-symbol-${candidate.candidateId}`),
    ...(includeTest ? { test: probe(probeStatus, `event-shadow-test-${candidate.candidateId}`) } : {}),
  };
  const verificationResults = await createMvpVerifierRegistry().verifyAll(candidate.assertions, {
    project,
    correlationId: candidate.correlationId,
    requestedAt: at,
    probes,
  });
  const decision = evaluateEvidencePolicy({
    candidate,
    currentStatus: "PROPOSED",
    resolvedScope: scope.scope,
    projectScope,
    projectSpecificSignals: scope.projectSpecificSignals,
    verificationResults,
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
  });
  return { decision, verificationResults };
}

function assetFrom(candidate, decision, verificationResults) {
  const draft = {
    schemaVersion: 1,
    id: candidate.subjectKey,
    subjectKey: candidate.subjectKey,
    kind: candidate.kind,
    scope: decision.effectiveScope,
    version: 1,
    status: decision.targetStatus,
    title: candidate.title,
    summary: candidate.summary,
    body: candidate.body,
    aliases: ["audited governance CLI"],
    keywords: ["governance", "audit", "Markdown"],
    applicability: ["ZhiLoop local knowledge governance"],
    nonApplicability: ["remote model configuration"],
    symbols: ["KnowledgeGovernanceService"],
    relations: [],
    evidence: verificationResults.flatMap((result) => result.evidence === undefined ? [] : [{
      evidenceId: result.evidence.evidenceId,
      verdict: result.evidence.verdict,
    }]),
    confidence: candidate.confidence,
    sourceEpisodes: candidate.sourceEpisodes,
    contentHash: "",
    correlationId: candidate.correlationId,
    createdAt: candidate.createdAt,
    updatedAt: at,
  };
  return Object.freeze({ ...draft, contentHash: calculateKnowledgeContentHash(draft) });
}

function snapshot(registry) {
  return registry.listAssets({ includeTombstones: true, limit: 1_000 }).map((current) => ({
    asset: current.asset,
    tombstone: current.tombstone,
    tombstoneReason: current.tombstoneReason,
    versions: registry.listVersions(current.asset.id).map((version) => ({
      asset: version.asset,
      tombstone: version.tombstone,
      tombstoneReason: version.tombstoneReason,
      relations: registry.getRelations(version.asset.id, version.asset.version).relations,
      evidence: registry.getEvidence(version.asset.id, version.asset.version).evidence,
    })),
  }));
}

test("P4 Gate: a simulated conversation is verified and published as readable Markdown", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "zhiloop-p4-gate-"));
  const { episode, ledger } = await conversationEpisode();
  let registry;
  try {
    const candidate = await compile(episode);
    assert.deepEqual(candidate.sourceEpisodes, [episode.episodeId]);
    const verified = await decide(candidate, "SUPPORTED");
    assert.equal(verified.decision.targetStatus, "IMPLEMENTED");
    assert.equal(verified.decision.shouldPublish, true);
    assert.equal(verified.verificationResults[0]?.status, "SUPPORTED");

    const knowledge = assetFrom(candidate, verified.decision, verified.verificationResults);
    const markdown = new MarkdownKnowledgeRepository(path.join(temporaryRoot, "knowledge"));
    const published = await markdown.publish(knowledge, { expectedCurrentVersion: 0 });
    const text = await readFile(published.value.documentPath, "utf8");
    assert.match(text, /^---\n/u);
    assert.match(text, /status: IMPLEMENTED/u);
    assert.match(text, /Use an audited knowledge governance CLI/u);
    assert.match(text, /The governance service applies Domain status gates/u);

    const databasePath = path.join(temporaryRoot, "registry.sqlite");
    registry = new SqliteKnowledgeRegistryProjection(databasePath);
    registry.projectCurrent(published.value);
    assert.equal(registry.search("governance audit")[0]?.asset.id, knowledge.id);
    const before = snapshot(registry);
    registry.close();
    registry = undefined;
    await rm(databasePath, { force: true });

    registry = new SqliteKnowledgeRegistryProjection(databasePath);
    const rebuilt = await registry.rebuildFromMarkdown(markdown);
    assert.deepEqual(rebuilt, { indexVersion: 1, assets: 1, versions: 1, diagnostics: [] });
    assert.deepEqual(snapshot(registry), before);
    assert.equal(registry.search("governance audit")[0]?.asset.id, knowledge.id);
  } finally {
    registry?.close();
    ledger.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("P4 Gate: Shadow Mode incorrect auto-confirmation rate stays below one percent", async () => {
  const dataset = JSON.parse(await readFile("fixtures/p4/v1/shadow-dataset.json", "utf8"));
  assert.equal(dataset.schemaVersion, 1);
  const outcomes = [];
  for (const group of dataset.groups) {
    for (let index = 0; index < group.count; index += 1) {
      const candidateId = `p4-${group.id}-${index}`;
      const symbol = {
        assertionId: `${candidateId}-symbol`, candidateId, kind: "SYMBOL_EXISTS",
        parameters: { projectId: project.projectId, symbol: `Symbol${index}` }, createdAt: at,
      };
      const testAssertion = {
        assertionId: `${candidateId}-test`, candidateId, kind: "TEST_PASSED",
        parameters: { testId: `Test${index}` }, createdAt: at,
      };
      const candidate = {
        schemaVersion: 1,
        candidateId,
        compilerVersion: "p4-shadow-compiler-v1",
        status: "PROPOSED",
        subjectKey: `knowledge.p4.${group.id}-${index}`,
        kind: group.kind,
        scopeHint: { level: "PROJECT", projectId: project.projectId, reasonCodes: ["P4_SHADOW"] },
        title: "P4 Shadow Candidate",
        summary: "Deterministic shadow policy evaluation.",
        body: "No Shadow Mode candidate is published.",
        sourceEpisodes: [`episode-shadow-${index}`],
        confidence: 0.9,
        assertions: group.kind === "EXPERIENCE" ? [symbol, testAssertion] : [symbol],
        evidenceHints: [],
        createdAt: at,
        correlationId: `correlation-${candidateId}`,
      };
      const result = await decide(candidate, group.probeStatus, group.kind === "EXPERIENCE");
      outcomes.push({ expected: group.expectedShouldPublish, actual: result.decision.shouldPublish });
    }
  }
  const positives = outcomes.filter((item) => item.expected).length;
  const negatives = outcomes.length - positives;
  const falsePositives = outcomes.filter((item) => !item.expected && item.actual).length;
  const falseNegatives = outcomes.filter((item) => item.expected && !item.actual).length;
  const incorrectAutoConfirmationRate = falsePositives / negatives;
  const shadowWrites = 0;
  assert.ok(outcomes.length >= dataset.gate.minimumCases);
  assert.ok(positives > 0 && negatives > 0);
  assert.equal(falseNegatives, 0);
  assert.equal(shadowWrites, 0);
  assert.ok(incorrectAutoConfirmationRate < dataset.gate.maximumIncorrectAutoConfirmationRate, JSON.stringify({
    total: outcomes.length, positives, negatives, falsePositives, falseNegatives, incorrectAutoConfirmationRate,
  }));
});
