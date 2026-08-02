import type {
  DoctorReport,
  KnowledgeDiff,
  KnowledgeGovernancePort,
  KnowledgeTrace,
  MutationResult,
  SuppressionRecord,
} from "@zhiloop/knowledge-governance";
import type { ProjectedKnowledgeAsset, ProjectionRebuildResult } from "@zhiloop/knowledge-registry";
import { describe, expect, it, vi } from "vitest";

import { KNOWLEDGE_CLI_HELP, runKnowledgeCli } from "./knowledge-cli.js";

const projected = {
  asset: {
    id: "knowledge.cli.asset", version: 2, status: "STALE", scope: { level: "PROJECT", projectId: "project-a" },
    title: "CLI asset",
  },
  tombstone: false,
  indexVersion: 3,
} as unknown as ProjectedKnowledgeAsset;

function dependencies(overrides: Partial<KnowledgeGovernancePort> = {}) {
  const governance: KnowledgeGovernancePort = {
    list: vi.fn(() => [projected]),
    show: vi.fn(() => projected),
    diff: vi.fn((): KnowledgeDiff => ({
      assetId: projected.asset.id, fromVersion: 1, toVersion: 2,
      changes: [{ field: "status", before: "IMPLEMENTED", after: "STALE" }],
    })),
    trace: vi.fn((): KnowledgeTrace => ({
      assetId: projected.asset.id, version: 2, sourceEpisodes: ["episode-cli"], evidence: [], relations: [],
    })),
    markStale: vi.fn(async (): Promise<MutationResult<ProjectedKnowledgeAsset>> => ({ auditId: "audit-stale", value: projected })),
    suppress: vi.fn((): MutationResult<SuppressionRecord> => ({
      auditId: "audit-suppress",
      value: {
        assetId: projected.asset.id, scopeKey: "PROJECT:project-a", reason: "noise", actor: "tester",
        correlationId: "correlation-cli", createdAt: "2026-08-02T12:00:00.000Z",
      },
    })),
    rebuild: vi.fn(async (): Promise<MutationResult<ProjectionRebuildResult>> => ({
      auditId: "audit-rebuild", value: { indexVersion: 4, assets: 1, versions: 2, diagnostics: [] },
    })),
    doctor: vi.fn(async (): Promise<DoctorReport> => ({
      healthy: true, markdownAssets: 1, projectedAssets: 1, diagnostics: [],
    })),
    ...overrides,
  };
  return {
    governance,
    context: () => ({ actor: "tester", correlationId: "correlation-cli", now: "2026-08-02T12:00:00.000Z" }),
  };
}

describe("runKnowledgeCli", () => {
  it("provides global and per-command help without opening storage", async () => {
    expect((await runKnowledgeCli([])).stdout).toContain("Commands:");
    expect((await runKnowledgeCli(["--help"])).stdout).toBe(`${KNOWLEDGE_CLI_HELP}\n`);
    for (const command of ["list", "show", "diff", "trace", "mark-stale", "suppress", "rebuild", "doctor"]) {
      const result = await runKnowledgeCli([command, "--help"]);
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain(`zhiloop-knowledge ${command}`);
    }
    expect(await runKnowledgeCli(["show", "--help", "extra"])).toMatchObject({ exitCode: 2 });
  });

  it("routes all read commands and renders text or JSON", async () => {
    const deps = dependencies();
    expect((await runKnowledgeCli(["list", "--all"], deps)).stdout).toContain("knowledge.cli.asset\tv2\tSTALE");
    expect(deps.governance.list).toHaveBeenCalledWith(true);
    expect(JSON.parse((await runKnowledgeCli(["show", projected.asset.id, "--json"], deps)).stdout)).toMatchObject({ asset: { id: projected.asset.id } });
    expect((await runKnowledgeCli(["diff", projected.asset.id, "1", "2"], deps)).stdout).toContain("status:");
    expect((await runKnowledgeCli(["trace", projected.asset.id, "2"], deps)).stdout).toContain("episode-cli");
    await runKnowledgeCli(["trace", projected.asset.id], deps);
    expect(deps.governance.trace).toHaveBeenLastCalledWith(projected.asset.id, undefined);
    const empty = dependencies({ list: vi.fn(() => []) });
    expect((await runKnowledgeCli(["list"], empty)).stdout).toBe("No knowledge assets.\n");
    const unchanged = dependencies({ diff: vi.fn(() => ({
      assetId: projected.asset.id, fromVersion: 1, toVersion: 2, changes: [],
    })) });
    expect((await runKnowledgeCli(["diff", projected.asset.id, "1", "2"], unchanged)).stdout).toContain("no differences");
  });

  it("routes mutations with deterministic audit context", async () => {
    const deps = dependencies();
    const stale = await runKnowledgeCli(["mark-stale", projected.asset.id, "--reason", "changed"], deps);
    expect(stale).toMatchObject({ exitCode: 0, stderr: "" });
    expect(deps.governance.markStale).toHaveBeenCalledWith(expect.objectContaining({
      assetId: projected.asset.id, reason: "changed", actor: "tester", correlationId: "correlation-cli",
    }));
    const suppress = await runKnowledgeCli([
      "suppress", projected.asset.id, "--reason", "noise", "--scope", "PROJECT:project-a",
    ], deps);
    expect(suppress.stdout).toContain("audit audit-suppress");
    expect(deps.governance.suppress).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "PROJECT:project-a" }));
    expect((await runKnowledgeCli(["rebuild", "--json"], deps)).stdout).toContain("audit-rebuild");
    await runKnowledgeCli([
      "mark-stale", projected.asset.id, "--reason", "changed", "--actor", "owner",
      "--correlation-id", "manual-correlation", "--json",
    ], deps);
    expect(deps.governance.markStale).toHaveBeenLastCalledWith(expect.objectContaining({
      actor: "owner", correlationId: "manual-correlation",
    }));
    await runKnowledgeCli(["suppress", projected.asset.id, "--reason", "noise"], deps);
    expect(deps.governance.suppress).toHaveBeenLastCalledWith(expect.not.objectContaining({ scopeKey: expect.anything() }));
    expect((await runKnowledgeCli(["rebuild"], deps)).stdout).toContain("Rebuilt 1 assets");
  });

  it("uses nonzero exit codes for usage, execution, and unhealthy doctor results", async () => {
    expect(await runKnowledgeCli(["unknown"])).toMatchObject({ exitCode: 2, stdout: "" });
    expect(await runKnowledgeCli(["show"] , dependencies())).toMatchObject({ exitCode: 2, stdout: "" });
    expect(await runKnowledgeCli(["diff", projected.asset.id, "zero", "2"], dependencies())).toMatchObject({ exitCode: 2 });
    expect(await runKnowledgeCli(["mark-stale", projected.asset.id], dependencies())).toMatchObject({ exitCode: 2 });
    expect(await runKnowledgeCli(["list"], undefined)).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("not configured") });
    expect(await runKnowledgeCli(["list", "--json", "--json"], dependencies())).toMatchObject({ exitCode: 2 });
    expect(await runKnowledgeCli(["suppress", projected.asset.id, "--reason"], dependencies())).toMatchObject({ exitCode: 2 });
    expect(await runKnowledgeCli([
      "suppress", projected.asset.id, "--reason", "a", "--reason", "b",
    ], dependencies())).toMatchObject({ exitCode: 2 });
    expect(await runKnowledgeCli(["trace", projected.asset.id, "1", "extra"], dependencies())).toMatchObject({ exitCode: 2 });
    const failed = dependencies({ show: vi.fn(() => { throw new Error("projection corrupt"); }) });
    expect(await runKnowledgeCli(["show", projected.asset.id], failed)).toMatchObject({ exitCode: 1, stderr: "Error: projection corrupt\n" });
    const unhealthy = dependencies({ doctor: vi.fn(async (): Promise<DoctorReport> => ({
      healthy: false, markdownAssets: 1, projectedAssets: 1,
      diagnostics: [{ severity: "ERROR", code: "HASH_MISMATCH", assetId: projected.asset.id, message: "hash differs" }],
    })) });
    expect(await runKnowledgeCli(["doctor"], unhealthy)).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse((await runKnowledgeCli(["doctor", "--json"], unhealthy)).stdout)).toMatchObject({ healthy: false });
    expect((await runKnowledgeCli(["doctor"], dependencies())).stdout).toContain("Healthy: 1 Markdown");
    expect(JSON.parse((await runKnowledgeCli(["doctor", "--json"], dependencies())).stdout)).toMatchObject({ healthy: true });
    const nonError = dependencies({ show: vi.fn(() => { throw "non-error failure"; }) });
    expect(await runKnowledgeCli(["show", projected.asset.id], nonError)).toMatchObject({ stderr: "Error: non-error failure\n" });
  });
});
