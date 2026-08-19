import { describe, expect, it } from "vitest";

import { CodeGraphCliAdapter } from "./adapter.js";
import type { CodeGraphProcessPort, CodeGraphProcessRequest, CodeGraphProcessResult } from "./process.js";

function result(stdout: string, overrides: Partial<CodeGraphProcessResult> = {}): CodeGraphProcessResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false, outputExceeded: false, ...overrides };
}

class ScriptedProcess implements CodeGraphProcessPort {
  readonly calls: CodeGraphProcessRequest[] = [];
  readonly replies: CodeGraphProcessResult[];
  constructor(replies: CodeGraphProcessResult[]) { this.replies = [...replies]; }
  async run(request: CodeGraphProcessRequest): Promise<CodeGraphProcessResult> {
    this.calls.push(request);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("unexpected process call");
    return reply;
  }
}

const project = { projectRoot: "/workspace/repo", projectFingerprint: "head-1" };
const statusReady = JSON.stringify({
  initialized: true,
  fileCount: 12,
  nodeCount: 120,
  edgeCount: 240,
  dbSizeBytes: 4_096,
  backend: "node-sqlite",
  nodesByKind: { function: 60, class: 20 },
  languages: ["typescript"],
  pendingChanges: { added: 0, modified: 0, removed: 0 },
});
const symbol = JSON.stringify([{ node: {
  id: "private-node-id",
  name: "Runtime",
  qualifiedName: "Runtime",
  kind: "class",
  filePath: "src/runtime.ts",
  startLine: 10,
  endLine: 40,
  language: "typescript",
  isExported: true,
} }]);

describe("CodeGraphCliAdapter", () => {
  it("negotiates readiness, projects symbols, and never exposes node IDs", async () => {
    const process = new ScriptedProcess([result("0.9.4\n"), result(statusReady), result(symbol)]);
    const adapter = new CodeGraphCliAdapter(process, { executable: "/bin/codegraph", capabilityTtlMs: 10_000, clock: () => 1 });
    const output = await adapter.findSymbols(project, { symbol: "Runtime", limit: 5 });
    expect(output).toMatchObject({ capability: { status: "READY", providerVersion: "0.9.4" }, facts: [{ path: "src/runtime.ts" }] });
    expect(JSON.stringify(output)).not.toContain("private-node-id");
    expect(process.calls.map((call) => call.args[0])).toEqual(["--version", "status", "query"]);
    expect(process.calls.every((call) => call.executable === "/bin/codegraph")).toBe(true);
  });

  it("keys fact cache by fingerprint and bounds relation results", async () => {
    const relation = JSON.stringify({ symbol: "Runtime", callers: [
      { name: "a", kind: "function", filePath: "src/a.ts", startLine: 1 },
      { name: "b", kind: "function", filePath: "src/b.ts", startLine: 2 },
    ] });
    const process = new ScriptedProcess([
      result("0.9.4\n"), result(statusReady), result(symbol),
      result("0.9.4\n"), result(statusReady), result(symbol), result(relation),
    ]);
    const adapter = new CodeGraphCliAdapter(process, { capabilityTtlMs: 10_000, clock: () => 1 });
    await adapter.findSymbols(project, { symbol: "Runtime" });
    await adapter.findSymbols(project, { symbol: "Runtime" });
    await adapter.findSymbols({ ...project, projectFingerprint: "head-2" }, { symbol: "Runtime" });
    const callers = await adapter.callers(project, "Runtime", 1);
    expect(callers.facts).toHaveLength(1);
    expect(process.calls.filter((call) => call.args[0] === "query")).toHaveLength(2);
  });

  it("derives an index revision and rejects a status with pending changes", async () => {
    const ready = new ScriptedProcess([result("0.9.4\n"), result(statusReady)]);
    expect(await new CodeGraphCliAdapter(ready).capabilities(project)).toMatchObject({
      status: "READY", indexRevision: expect.stringMatching(/^cg_[a-f0-9]{64}$/u),
    });
    const staleStatus = JSON.stringify({ ...JSON.parse(statusReady), pendingChanges: { added: 0, modified: 1, removed: 0 } });
    const stale = new ScriptedProcess([result("0.9.4\n"), result(staleStatus)]);
    expect(await new CodeGraphCliAdapter(stale).capabilities(project)).toMatchObject({
      status: "UNAVAILABLE", reasonCode: "CODEGRAPH_INDEX_STALE", indexRevision: expect.stringMatching(/^cg_/u),
    });
  });

  it("finds and caches a call path through strictly bounded callee traversal", async () => {
    const first = JSON.stringify({ callees: [{ name: "Middle", kind: "function", filePath: "src/middle.ts", startLine: 2 }] });
    const second = JSON.stringify({ callees: [{ name: "Target", kind: "function", filePath: "src/target.ts", startLine: 3 }] });
    const process = new ScriptedProcess([result("0.9.4\n"), result(statusReady), result(first), result(second)]);
    const adapter = new CodeGraphCliAdapter(process, { timeoutMs: 1_000 });
    const output = await adapter.trace(project, "Start", "Target", 4, 10);
    expect(output).toMatchObject({ capability: { status: "READY" }, facts: [{
      from: "Start", to: "Target", symbols: ["Start", "Middle", "Target"], paths: ["src/middle.ts", "src/target.ts"],
    }] });
    await adapter.trace(project, "Start", "Target", 4, 10);
    expect(process.calls.filter((call) => call.args[0] === "callees")).toHaveLength(2);
  });

  it("returns bounded UNKNOWN capability when depth prevents a conclusive path result", async () => {
    const first = JSON.stringify({ callees: [{ name: "Middle", kind: "function", filePath: "src/middle.ts", startLine: 2 }] });
    const process = new ScriptedProcess([result("0.9.4\n"), result(statusReady), result(first)]);
    const output = await new CodeGraphCliAdapter(process, { timeoutMs: 1_000 }).trace(project, "Start", "Target", 1, 10);
    expect(output).toMatchObject({ capability: { status: "UNAVAILABLE", reasonCode: "CODEGRAPH_TRACE_BOUNDED" }, bounded: true, facts: [] });
  });

  it("classifies an exhausted trace deadline as bounded rather than provider unavailable", async () => {
    class DeadlineProcess extends ScriptedProcess {
      override async run(request: CodeGraphProcessRequest): Promise<CodeGraphProcessResult> {
        if (request.args[0] === "callees") {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return result("", { exitCode: null, timedOut: true });
        }
        return await super.run(request);
      }
    }
    const process = new DeadlineProcess([result("0.9.4\n"), result(statusReady)]);
    const output = await new CodeGraphCliAdapter(process, { timeoutMs: 10 }).trace(project, "Start", "Target", 4, 10);
    expect(output).toMatchObject({
      capability: { status: "UNAVAILABLE", reasonCode: "CODEGRAPH_TRACE_BOUNDED" },
      bounded: true,
      facts: [],
    });
  });

  it("reports not configured and incompatible without querying facts", async () => {
    const missing = new ScriptedProcess([result("0.9.4\n"), result(JSON.stringify({ initialized: false }))]);
    expect((await new CodeGraphCliAdapter(missing).findSymbols(project, { symbol: "Runtime" })).capability.status)
      .toBe("NOT_CONFIGURED");
    expect(missing.calls.some((call) => call.args[0] === "query")).toBe(false);

    const incompatible = new ScriptedProcess([result("1.0.0\n")]);
    expect((await new CodeGraphCliAdapter(incompatible).capabilities(project)).status).toBe("INCOMPATIBLE");
  });

  it("fails timeout, malformed, unbounded, and unsafe responses closed", async () => {
    const timeout = new ScriptedProcess([result("0.9.4\n", { timedOut: true })]);
    expect((await new CodeGraphCliAdapter(timeout).capabilities(project)).status).toBe("UNAVAILABLE");

    const malformed = new ScriptedProcess([result("0.9.4\n"), result(statusReady), result(JSON.stringify([{ node: {
      name: "Runtime", qualifiedName: "Runtime", kind: "class", filePath: "../secret", startLine: 1, endLine: 2,
      language: "typescript", isExported: true,
    } }]))]);
    expect((await new CodeGraphCliAdapter(malformed).findSymbols(project, { symbol: "Runtime" })).capability.status)
      .toBe("UNAVAILABLE");
    await expect(new CodeGraphCliAdapter(new ScriptedProcess([])).findSymbols(project, { symbol: "Runtime", limit: 101 }))
      .rejects.toThrow("CODE_INTELLIGENCE_LIMIT_INVALID");
  });

  it("normalizes impact facts and keeps initialization commands outside the adapter", async () => {
    const impact = JSON.stringify({ affected: [{ name: "Consumer", kind: "class", filePath: "src/consumer.ts", startLine: 20 }] });
    const process = new ScriptedProcess([result("0.9.4\n"), result(statusReady), result(impact)]);
    const output = await new CodeGraphCliAdapter(process).impact(project, "Runtime", 5);
    expect(output.facts).toEqual([{ symbol: "Consumer", kind: "class", path: "src/consumer.ts", startLine: 20 }]);
    expect(process.calls.flatMap((call) => call.args)).not.toEqual(expect.arrayContaining(["init", "index", "sync"]));
  });
});
