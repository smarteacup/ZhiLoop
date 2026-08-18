import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AutomaticPreviewDispatchRequest,
  CompilationSessionObservation,
} from "@zhiloop/knowledge-compilation-scheduler";
import type {
  SessionCatalogEntry,
  SessionCatalogQueryPort,
} from "@zhiloop/session-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";

import { P2AutomaticCompilationRuntime } from "./p2-automatic-compilation.js";

const directories: string[] = [];
const now = () => new Date("2026-08-18T10:10:00.000Z");
const pipeline = {
  compilerVersion: "compiler-v1",
  promptVersion: "prompt-v1",
  policyHash: "policy-v1",
  configurationHash: "configuration-v1",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

function entry(): SessionCatalogEntry {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    title: "Session",
    titleSource: "SOURCE",
    source: "CODEX_TRANSCRIPT",
    sourceStatus: "AVAILABLE",
    sourceVersion: "source-v1",
    sourceFormatVersion: "1",
    safeSourceAlias: "session.jsonl",
    captureStatus: "CAPTURED_CURRENT",
    firstActivityAt: "2026-08-18T10:00:00.000Z",
    lastActivityAt: "2026-08-18T10:09:00.000Z",
    timeGroup: "TODAY",
    eventCount: 5,
    turnCount: 3,
    ignoredRecords: 0,
    redactionCount: 0,
  };
}

class Catalog implements SessionCatalogQueryPort {
  async list() {
    return { items: [entry()], sourceCapabilities: [], diagnostics: [], revision: "v1", changed: false };
  }

  async get(sessionId: string) {
    return sessionId === "session-1" ? entry() : undefined;
  }
}

function observation(): CompilationSessionObservation {
  return {
    sessionId: "session-1",
    ledgerSequence: 5,
    effectiveEventCount: 5,
    effectiveTurnCount: 3,
    sourceVersion: "source-v1",
    lastActivityAt: "2026-08-18T10:09:00.000Z",
  };
}

async function fixture(dispatch?: (request: AutomaticPreviewDispatchRequest) => Promise<{
  readonly status: "ENQUEUED";
  readonly snapshotId: string;
  readonly jobId: string;
  readonly compiledThroughSequence: number;
}>) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zhiloop-auto-runtime-"));
  directories.push(stateDirectory);
  const dispatchPreview = vi.fn(dispatch ?? (async (request) => ({
    status: "ENQUEUED" as const,
    snapshotId: "snapshot-1",
    jobId: "job-1",
    compiledThroughSequence: request.expectedLedgerSequence,
  })));
  const adapter = { inspect: async () => observation(), dispatchPreview };
  const runtime = new P2AutomaticCompilationRuntime({
    stateDirectory,
    catalog: new Catalog(),
    adapter,
    pipeline,
    now,
  });
  return { runtime, stateDirectory, adapter, dispatchPreview };
}

describe("P2AutomaticCompilationRuntime", () => {
  it("exposes lifecycle state, aggregate reports and durable restart progress", async () => {
    const first = await fixture();
    expect(first.runtime.state()).toEqual({ automaticCompile: "STOPPED" });
    expect(first.runtime.start()).toBe(true);
    expect(first.runtime.state()).toEqual({ automaticCompile: "READY" });
    await expect(first.runtime.trigger()).resolves.toMatchObject({ queuedSessions: 1, failedSessions: 0 });
    expect(first.runtime.state()).toMatchObject({ automaticCompile: "READY", lastAutomaticCompileReport: { queuedSessions: 1 } });
    await first.runtime.close();

    const replayDispatch = vi.fn(async (request: AutomaticPreviewDispatchRequest) => ({
      status: "ENQUEUED" as const,
      snapshotId: "duplicate",
      jobId: "duplicate",
      compiledThroughSequence: request.expectedLedgerSequence,
    }));
    const restarted = new P2AutomaticCompilationRuntime({
      stateDirectory: first.stateDirectory,
      catalog: new Catalog(),
      adapter: { inspect: async () => observation(), dispatchPreview: replayDispatch },
      pipeline,
      now,
    });
    restarted.start();
    await expect(restarted.trigger()).resolves.toMatchObject({ currentSessions: 1, queuedSessions: 0 });
    expect(replayDispatch).not.toHaveBeenCalled();
    await restarted.close();
  });

  it("keeps the last valid configuration and supports rollback", async () => {
    const value = await fixture();
    value.runtime.start();
    await expect(value.runtime.applyConfiguration({ pageSize: 101 }, pipeline)).rejects.toThrow("pageSize");
    expect(value.runtime.state().automaticCompile).toBe("READY");
    const rollback = await value.runtime.applyConfiguration({ enabled: false }, pipeline);
    expect(value.runtime.state().automaticCompile).toBe("DISABLED");
    await rollback();
    expect(value.runtime.state().automaticCompile).toBe("READY");
    await value.runtime.close();
  });

  it("degrades on an isolated permanent dispatch failure without throwing from the scan", async () => {
    const value = await fixture(async () => { throw Object.assign(new Error("failed"), { retryable: false }); });
    value.runtime.start();
    await expect(value.runtime.trigger()).resolves.toMatchObject({ failedSessions: 1, queuedSessions: 0 });
    expect(value.runtime.state().automaticCompile).toBe("DEGRADED");
    await value.runtime.close();
  });
});
