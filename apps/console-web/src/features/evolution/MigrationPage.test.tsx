// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegacyMigrationPreviewView } from "@zhiloop/control-api";

import { MigrationPage } from "./MigrationPage.js";
import { codeGraphPage, observedAt, testApi } from "./test-api.js";

afterEach(() => cleanup());

const migration = { schemaVersion: 1 as const, migrationId: "migration-1", migrationVersion: "1.0.0", projectId: "project-1",
  sourceRegistryRevision: 4, status: "READY" as const, revision: 0, scannedCount: 2, migratableCount: 1, alreadyCurrentCount: 0,
  skippedCount: 1, failedCount: 0, rollbackConflictCount: 0, summaryHash: "b".repeat(64), createdAt: observedAt, updatedAt: observedAt };

describe("MigrationPage", () => {
  it("shows dry-run counts, bounded item reasons, and requires explicit commit", async () => {
    const commit = vi.fn(async () => ({ preview: { ...migration, status: "COMMITTING" as const, revision: 1 }, job: { schemaVersion: 1 as const,
      jobId: "job-migration", jobType: "LEGACY_KNOWLEDGE_MIGRATION", revision: 1, status: "QUEUED" as const, attempt: 0, maxAttempts: 5,
      progress: 0, reasonCode: "JOB_QUEUED" as const, observedAt, lastTransitionAt: observedAt, retryable: false, evidenceRefs: [] } }));
    const items = vi.fn(async (_migrationId: string, afterOrdinal?: number) => afterOrdinal === 1 ? ({ items: [{ schemaVersion: 1 as const,
      migrationId: "migration-1", ordinal: 1, assetId: "asset-2", assetVersion: 1, assetContentHash: "e".repeat(64), assetIndexVersion: 2,
      classification: "SKIPPED" as const, source: "NONE" as const, assertionKinds: [], reasonCodes: ["NO_LEGACY_EVIDENCE"],
      status: "SKIPPED" as const, updatedAt: observedAt }] }) : ({ items: [{ schemaVersion: 1 as const, migrationId: "migration-1", ordinal: 0, assetId: "asset-1", assetVersion: 1,
        assetContentHash: "c".repeat(64), assetIndexVersion: 1, classification: "MIGRATABLE" as const, source: "RECIPE" as const, candidateId: "candidate-1",
        assertionsHash: "d".repeat(64), assertionKinds: ["SYMBOL_EXISTS"], reasonCodes: ["LEGACY_RECIPE_FOUND"], status: "PENDING" as const, updatedAt: observedAt }],
      nextOrdinal: 1 }));
    render(<MigrationPage api={testApi({ codeGraphProjects: async () => codeGraphPage, previewLegacyMigration: async () => migration,
      legacyMigrationItems: items,
      commitLegacyMigration: commit })} />);
    const user = userEvent.setup(); await user.selectOptions(await screen.findByLabelText("项目"), "project-1");
    await user.click(screen.getByRole("button", { name: "生成迁移预览" }));
    expect(await screen.findByText("asset-1@1")).toBeTruthy(); expect(screen.getAllByText("可迁移").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "查看下一页明细" }));
    expect(await screen.findByText("asset-2@1")).toBeTruthy(); expect(items).toHaveBeenLastCalledWith("migration-1", 1);
    await user.click(screen.getByRole("button", { name: "确认迁移" }));
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ migrationId: "migration-1", expectedRevision: 0 }));
  });

  it("requires a rollback preview and reports rollback conflicts", async () => {
    const completed = { ...migration, status: "COMPLETED" as const, revision: 2 };
    let current: LegacyMigrationPreviewView = completed;
    const rollback = vi.fn(async () => (current = { ...completed, status: "ROLLBACK_CONFLICT" as const, revision: 3,
      rollbackConflictCount: 1, failureCode: "LEGACY_MIGRATION_TARGET_DRIFT" }));
    render(<MigrationPage api={testApi({ codeGraphProjects: async () => codeGraphPage,
      previewLegacyMigration: async () => completed, legacyMigrationItems: async () => ({ items: [] }),
      rollbackLegacyMigration: rollback, legacyMigration: async () => current })} />);
    const user = userEvent.setup(); await user.selectOptions(await screen.findByLabelText("项目"), "project-1");
    await user.click(screen.getByRole("button", { name: "生成迁移预览" }));
    await user.click(await screen.findByRole("button", { name: "生成回滚预览" }));
    expect(screen.getByText("回滚影响预览")).toBeTruthy(); await user.click(screen.getByRole("button", { name: "确认安全回滚" }));
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ migrationId: "migration-1", expectedRevision: 2 }));
    expect(await screen.findByText(/迁移目标已被后续修改/u)).toBeTruthy();
  });

  it("shows project-load and preview failures", async () => {
    const { rerender } = render(<MigrationPage api={testApi({ codeGraphProjects: async () => { throw new Error("projects unavailable"); } })} />);
    expect(await screen.findByText(/projects unavailable/u)).toBeTruthy();
    rerender(<MigrationPage api={testApi({ codeGraphProjects: async () => codeGraphPage,
      previewLegacyMigration: async () => { throw new Error("preview conflict"); } })} />);
    const user = userEvent.setup(); await user.selectOptions(await screen.findByLabelText("项目"), "project-1");
    await user.click(screen.getByRole("button", { name: "生成迁移预览" })); expect(await screen.findByText(/preview conflict/u)).toBeTruthy();
  });
});
