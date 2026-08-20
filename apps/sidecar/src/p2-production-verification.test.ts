import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { ExtractionSnapshot } from "@zhiloop/control-api";
import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { EventEnvelope } from "@zhiloop/domain";
import { snapshotCommandHash, snapshotTestId } from "@zhiloop/evidence-probes";
import type { KnowledgeExtractionPort } from "@zhiloop/knowledge-compiler";
import type { KnowledgeVerificationRequest } from "@zhiloop/knowledge-verification";
import { resolveProjectIdentity } from "@zhiloop/project-identity";

import { deriveP2ProjectContext, P2ProductionComposition, refineP2VerificationRequest } from "./p2-production.js";

const cleanup: string[] = [];
const at = "2026-08-19T00:00:00.000Z";
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });

function event(index: number, root: string, eventType: EventEnvelope["eventType"], payload: unknown, turnId?: string): EventEnvelope {
  return { schemaVersion: 1, eventId: `event-${index}`, source: "codex-app-server", sourceItemId: `source-${index}`,
    eventType, sessionId: "session-1", ...(turnId === undefined ? {} : { turnId }), occurredAt: new Date(Date.parse(at) + index * 1_000).toISOString(),
    cwd: root, contentHash: sha(`content-${index}`), correlationId: "correlation-1", payload };
}

function extractionSnapshot(): ExtractionSnapshot {
  return { schemaVersion: 1, snapshotId: `snapshot_${"a".repeat(48)}`, revision: 1, identityHash: sha("identity"), sessionId: "session-1",
    transcriptIdentityHash: sha("transcript"), sourceSequence: { from: 1, to: 4 }, cursor: { byteOffset: 400, lineNumber: 4 },
    completeness: { status: "COMPLETE_SNAPSHOT", sourceClosed: true, unsupportedEventTypes: [] }, compilerVersion: "mvp-compiler-v4",
    policyHash: sha("policy"), configurationHash: sha("configuration"), createdAt: "2026-08-19T00:01:00.000Z" };
}

describe("P2 production verification composition", () => {
  it("narrows aggregate workspaces to the uniquely matching candidate repository", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "zhiloop-p2-aggregate-"));
    const repository = path.join(workspace, "command-service");
    cleanup.push(workspace);
    mkdirSync(path.join(repository, ".git"), { recursive: true });
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src", "fact.txt"), "fact\n");
    const request = {
      project: { projectId: "aggregate-project", repositoryRoot: workspace, portable: false },
      requestedAt: at,
      purpose: "CANDIDATE",
      candidate: {
        schemaVersion: 2, candidateId: sha("candidate"), compilerVersion: "mvp-compiler-v5", status: "PROPOSED",
        subjectKey: "service.fact", kind: "FACT", scopeHint: { level: "PROJECT", reasonCodes: ["PROJECT_BOUND"] },
        title: "Fact", summary: "Fact summary", body: "Fact body", sourceEpisodes: ["episode-1"], confidence: 0.9,
        createdAt: at, correlationId: "correlation-1", claimMode: "CURRENT_STATE",
        locator: { schemaVersion: 1, projectId: "aggregate-project", observedRevision: { dirty: false },
          branchApplicability: { mode: "ALL_BRANCHES", reason: "NO_AUTHORITATIVE_BRANCH" }, scenarioId: "scenario-1",
          scenarioKey: "service.fact", scenarioTitle: "Service fact", scenarioSummary: "Service fact summary",
          modulePaths: ["command-service"], symbols: [], entryPoints: [], taskIntents: ["verify fact"],
          applicability: ["service fact lookup"], nonApplicability: ["other services"] },
        assertions: [{ assertionId: sha("assertion"), candidateId: sha("candidate"), kind: "FILE_CONTAINS",
          parameters: { path: "command-service/src/fact.txt", expected: "fact", matchMode: "EXACT" }, createdAt: at }],
        evidenceHints: [],
      },
    } as KnowledgeVerificationRequest;
    const refined = refineP2VerificationRequest(request);
    expect(refined.project.repositoryRoot).toBe(realpathSync(repository));
    expect(refined.candidate.assertions[0]?.parameters).toMatchObject({ path: "src/fact.txt" });
  });

  it("skips repository revision IO for candidates without code-backed assertions", () => {
    const request = {
      project: { projectId: "aggregate-project", repositoryRoot: "/workspace/aggregate", portable: false },
      candidate: { assertions: [{ kind: "USER_ACCEPTED" }] },
    } as unknown as KnowledgeVerificationRequest;
    expect(refineP2VerificationRequest(request).project).toEqual({ projectId: "aggregate-project", portable: false });
  });

  it.each(["COMMAND_SUCCEEDED", "TEST_PASSED"] as const)(
    "retains repository revision checks for %s snapshot evidence",
    (kind) => {
      const request = {
        project: { projectId: "aggregate-project", repositoryRoot: "/workspace/aggregate", portable: false },
        candidate: { assertions: [{ kind }] },
      } as unknown as KnowledgeVerificationRequest;
      expect(refineP2VerificationRequest(request)).toBe(request);
    },
  );

  it("uses real Snapshot/local probes, stays Preview-only by default, and projects a recipe only after explicit commit", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "zhiloop-p2-verification-state-"));
    const repository = mkdtempSync(path.join(tmpdir(), "zhiloop-p2-verification-repo-"));
    cleanup.push(state, repository);
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src", "fact.txt"), "production evidence hub\n");
    writeFileSync(path.join(repository, "package.json"), JSON.stringify({ dependencies: { typescript: "6.0.3" } }));
    writeFileSync(path.join(repository, "config.json"), JSON.stringify({ retry: 3 }));
    execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: repository, stdio: "ignore" });
    const ledger = new SqliteEventLedger(path.join(state, "ledger.sqlite"));
    const commandHash = snapshotCommandHash("npm test")!;
    for (const item of [
      event(1, repository, "user.prompted", { prompt: "implement production evidence" }, "turn-1"),
      event(2, repository, "tool.completed", { toolName: "commandExecution", toolInput: { command: "npm test", projectPath: repository },
        toolResponse: { exitCode: 0, aggregatedOutput: "private output" } }, "turn-1"),
      event(3, repository, "turn.stopped", { lastAssistantMessage: "implemented", stopHookActive: false }, "turn-1"),
      event(4, repository, "session.ended", { reason: "other" }),
    ]) ledger.append(item);
    const snapshot = extractionSnapshot();
    const project = deriveP2ProjectContext(snapshot, ledger, state);
    const compiler: KnowledgeExtractionPort = { extract: async () => ({ schemaVersion: 1, candidates: [{
      subjectKey: "experience.production.evidence", kind: "EXPERIENCE", scopeHint: { level: "PROJECT", reasonCodes: ["PROJECT_BOUND"] },
      title: "Production evidence", summary: "Verify current facts", body: "The production verifier reads bounded current facts.", confidence: 0.95,
      assertions: [
        { kind: "FILE_CONTAINS", parameters: { path: "src/fact.txt", expected: "evidence hub", matchMode: "EXACT" } },
        { kind: "DEPENDENCY_PRESENT", parameters: { name: "typescript", versionConstraint: "6.0.3", manifestPath: "package.json" } },
        { kind: "CONFIG_EQUALS", parameters: { key: "retry", expected: "3", path: "config.json" } },
        { kind: "COMMAND_SUCCEEDED", parameters: { commandHash, expectedExitCode: 0 } },
        { kind: "TEST_PASSED", parameters: { testId: snapshotTestId(commandHash), commandHash } },
      ], evidenceHints: [],
    }] }) };
    const production = await P2ProductionComposition.create({ stateDirectory: state, ledger,
      extraction: () => ({ getSnapshot: (id: string) => id === snapshot.snapshotId ? snapshot : undefined }) as never,
      compilerTimeoutMs: 1_000, compilerBatchSize: 10, codeGraphTimeoutMs: 5_000, verificationTimeoutMs: 10_000, compiler });
    try {
      const preview = await production.worker.runtime.run(await production.worker.requestFor(snapshot));
      expect(preview.payload.episodes?.[0]?.projectContext).toEqual((await resolveProjectIdentity(repository)).context);
      expect(preview.stages.CANDIDATE_POLICY.error).toBeUndefined();
      expect(preview.status).toBe("AWAITING_COMMIT");
      expect(preview.payload.policies?.[0]?.verificationResults.map((result) => [result.assertionKind, result.status]))
        .toEqual([["FILE_CONTAINS", "SUPPORTED"], ["DEPENDENCY_PRESENT", "SUPPORTED"], ["CONFIG_EQUALS", "SUPPORTED"],
          ["COMMAND_SUCCEEDED", "SUPPORTED"], ["TEST_PASSED", "SUPPORTED"]]);
      expect(preview.payload.policies?.[0]?.decision.targetStatus).toBe("VERIFIED");
      expect(production.registry.listAssets()).toEqual([]);
      const compiled = preview.payload.candidates?.[0];
      if (compiled === undefined) throw new Error("compiled candidate missing");
      const historical = await production.verification.verifyBatch({
        candidate: compiled, project: { projectId: project.projectId, portable: false }, requestedAt: "2026-08-19T00:02:00.000Z", purpose: "FRESHNESS",
        assertionIds: compiled.assertions.filter((item) => item.kind === "COMMAND_SUCCEEDED" || item.kind === "TEST_PASSED")
          .map((item) => item.assertionId),
        knowledgeVersion: { assetId: "asset-historical", assetVersion: 1 },
      });
      expect(historical.results.map((result) => [result.assertionKind, result.status]))
        .toEqual([["COMMAND_SUCCEEDED", "UNKNOWN"], ["TEST_PASSED", "UNKNOWN"]]);
      const runDatabase = new DatabaseSync(path.join(state, "knowledge-verification.sqlite"), { readOnly: true });
      const persisted = runDatabase.prepare("SELECT result_summary_json FROM code_verification_runs").all() as unknown as Array<{ result_summary_json: string }>;
      expect(persisted.map((row) => row.result_summary_json).join("\n")).not.toMatch(/private output|production verifier reads/iu);
      runDatabase.close();

      const committed = await production.worker.runtime.run(await production.worker.requestFor(snapshot), {
        executionMode: "SAFE_AUTO_PUBLICATION", publicationAuthorization: { kind: "EXPLICIT_COMMIT", authorizationId: "commit-1" },
      });
      expect(committed.status).toBe("COMPLETED");
      const asset = production.registry.listAssets()[0]!.asset;
      expect(production.verificationStore.getRecipe(asset.id, asset.version, "evidence-recipe-v1")?.assertions).toEqual(
        committed.payload.candidates?.[0]?.assertions,
      );
      expect(project.repositoryRoot).toBe(repository);
    } finally { production.close(); ledger.close(); }
  });

  it("fails closed when required CodeGraph evidence is unavailable", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "zhiloop-p2-verification-state-"));
    const repository = mkdtempSync(path.join(tmpdir(), "zhiloop-p2-verification-repo-"));
    cleanup.push(state, repository);
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src", "runtime.ts"), "export class Runtime {}\n");
    execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: repository, stdio: "ignore" });
    const ledger = new SqliteEventLedger(path.join(state, "ledger.sqlite"));
    for (const item of [
      event(1, repository, "user.prompted", { prompt: "implement runtime" }, "turn-1"),
      event(2, repository, "turn.stopped", { lastAssistantMessage: "implemented", stopHookActive: false }, "turn-1"),
      event(3, repository, "session.ended", { reason: "other" }),
      event(4, repository, "session.ended", { reason: "other" }),
    ]) ledger.append(item);
    const snapshot = extractionSnapshot();
    const project = deriveP2ProjectContext(snapshot, ledger, state);
    const compiler: KnowledgeExtractionPort = { extract: async () => ({ schemaVersion: 1, candidates: [{
      subjectKey: "implementation.production.graph", kind: "IMPLEMENTATION", scopeHint: { level: "PROJECT", reasonCodes: ["PROJECT_BOUND"] },
      title: "Runtime implementation", summary: "Runtime exists", body: "The Runtime symbol is implemented.", confidence: 0.95,
      assertions: [{ kind: "SYMBOL_EXISTS", parameters: { projectId: project.projectId, symbol: "Runtime", path: "src/runtime.ts" } }],
      evidenceHints: [],
    }] }) };
    const production = await P2ProductionComposition.create({ stateDirectory: state, ledger,
      extraction: () => ({ getSnapshot: (id: string) => id === snapshot.snapshotId ? snapshot : undefined }) as never,
      compilerTimeoutMs: 1_000, compilerBatchSize: 10, codeGraphTimeoutMs: 5_000, verificationTimeoutMs: 10_000, compiler });
    try {
      const preview = await production.worker.runtime.run(await production.worker.requestFor(snapshot));
      expect(preview.status).toBe("AWAITING_COMMIT");
      expect(preview.payload.policies?.[0]?.verificationResults.map((result) => [result.assertionKind, result.status]))
        .toEqual([["SYMBOL_EXISTS", "UNKNOWN"]]);
      expect(preview.payload.policies?.[0]?.decision.targetStatus).toBe("PROPOSED");
      expect(preview.payload.policies?.[0]?.decision.shouldPublish).toBe(false);
      expect(production.registry.listAssets()).toEqual([]);
    } finally { production.close(); ledger.close(); }
  }, 10_000);
});
