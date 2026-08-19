import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { CodeGraphProcessPort } from "@zhiloop/codegraph-adapter";
import type { JobExecutionContext } from "@zhiloop/job-runtime";

import { CodeGraphLifecycleService, codeGraphCommitFingerprint } from "./p2-codegraph-lifecycle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zhiloop-codegraph-lifecycle-")); roots.push(root);
  let initialized = false; const calls: string[][] = [];
  const processPort: CodeGraphProcessPort = { run: async (request) => {
    calls.push([...request.args]);
    if (request.args[0] === "--version") return { exitCode: 0, stdout: "0.9.3\n", stderr: "", timedOut: false, outputExceeded: false };
    if (request.args[0] === "init") { initialized = true; return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, outputExceeded: false }; }
    if (request.args[0] === "status") return { exitCode: 0, stdout: JSON.stringify(initialized ? { initialized: true, fileCount: 2,
      nodeCount: 4, edgeCount: 3, dbSizeBytes: 100, backend: "sqlite", nodesByKind: { function: 4 }, languages: ["ts"],
      pendingChanges: { added: 0, modified: 0, removed: 0 } } : { initialized: false }), stderr: "", timedOut: false, outputExceeded: false };
    if (request.args[0] === "query") return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false, outputExceeded: false };
    return { exitCode: 1, stdout: "", stderr: "redacted", timedOut: false, outputExceeded: false };
  } };
  const service = new CodeGraphLifecycleService({ databasePath: path.join(root, "state.sqlite"), projectRoot: (id) => id === "project-1" ? root : undefined,
    process: processPort, clock: () => new Date("2026-08-19T02:00:00.000Z") });
  return { root, service, calls };
}

describe("CodeGraphLifecycleService", () => {
  it("creates a no-write preview and publishes capability only after all smoke checks", async () => {
    const value = await fixture(); const preview = await value.service.preview("project-1", "2026-08-19T01:55:00.000Z");
    expect(preview).toMatchObject({ projectId: "project-1", currentStatus: "NOT_CONFIGURED", expectedRevision: 0 });
    expect(value.calls.some((call) => call[0] === "init")).toBe(false);
    let checkpoint: unknown;
    const canonicalRoot = value.service.repository("project-1").root;
    const context = { jobId: "job-1", jobType: "CODEGRAPH_INITIALIZE", attemptId: "attempt-1", attempt: 1, fencingToken: 1,
      idempotencyKey: "job-key", input: { schemaVersion: 1, jobType: "CODEGRAPH_INITIALIZE", projectId: "project-1",
        repositoryRoot: canonicalRoot, repositoryIdentity: preview.repositoryIdentity, adapterVersion: "0.9.3" }, signal: new AbortController().signal,
      getCheckpoint: () => checkpoint as never, saveCheckpoint: (data: unknown, progress: number) => {
        if (progress < 0 || progress > 1) throw new Error("invalid progress");
        return (checkpoint = { data, progress }) as never;
      },
      heartbeat: () => ({ leaseExpiresAt: "2026-08-19T02:01:00.000Z", cancellationRequested: false }), isCancellationRequested: () => false,
      throwIfCancellationRequested: () => undefined, effectKey: (step: string) => `job-1:${step}` } satisfies JobExecutionContext;
    await value.service.handler()(context);
    expect(value.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["init", "status", "query"]));
    expect(value.service.storedCapability("project-1")).toMatchObject({ status: "READY", revision: 1, indexedFiles: 2 });
    expect(checkpoint).toMatchObject({ progress: 1 });
    value.service.close();
  });

  it("rejects unobserved and stale previews and enforces receipt identity", async () => {
    const value = await fixture();
    await expect(value.service.preview("missing", "2026-08-19T01:55:00.000Z")).rejects.toThrow("UNOBSERVED");
    const preview = await value.service.preview("project-1", "2026-08-19T01:55:00.000Z");
    expect(() => value.service.validateCommit({ projectId: "project-1", previewId: preview.previewId,
      repositoryIdentity: "0".repeat(64), expectedRevision: 0, idempotencyKey: "commit-1", requestedAt: "2026-08-19T01:56:00.000Z" }))
      .toThrow("PREVIEW_STALE");
    value.service.saveReceipt("key-1", "a".repeat(64), "job-1", "2026-08-19T01:56:00.000Z");
    expect(() => value.service.receipt("key-1", "b".repeat(64))).toThrow("IDEMPOTENCY_CONFLICT");
    value.service.close();
  });

  it("keeps the list projection side-effect free and rejects a non-directory index target", async () => {
    const value = await fixture();
    expect(value.service.view("project-1")).toMatchObject({ status: "NOT_CONFIGURED", revision: 0 });
    expect(value.calls).toEqual([]);
    value.service.close();

    const invalid = await fixture();
    await writeFile(path.join(invalid.root, ".codegraph"), "not a directory");
    expect(() => invalid.service.view("project-1")).toThrow("TARGET_INVALID");
    invalid.service.close();
  });

  it("keeps command identity stable when only the retry timestamp changes", () => {
    const command = { projectId: "project-1", previewId: "preview-1", repositoryIdentity: "a".repeat(64),
      expectedRevision: 3, idempotencyKey: "codegraph:commit:0001", requestedAt: "2026-08-19T01:00:00.000Z" };
    expect(codeGraphCommitFingerprint(command)).toBe(codeGraphCommitFingerprint({
      ...command, requestedAt: "2026-08-19T01:10:00.000Z",
    }));
    expect(codeGraphCommitFingerprint(command)).not.toBe(codeGraphCommitFingerprint({ ...command, expectedRevision: 4 }));
  });
});
