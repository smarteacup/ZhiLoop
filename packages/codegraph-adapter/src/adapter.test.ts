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
const statusReady = JSON.stringify({ initialized: true, fileCount: 12 });
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
      result(symbol), result(relation),
    ]);
    const adapter = new CodeGraphCliAdapter(process, { capabilityTtlMs: 10_000, clock: () => 1 });
    await adapter.findSymbols(project, { symbol: "Runtime" });
    await adapter.findSymbols(project, { symbol: "Runtime" });
    await adapter.findSymbols({ ...project, projectFingerprint: "head-2" }, { symbol: "Runtime" });
    const callers = await adapter.callers(project, "Runtime", 1);
    expect(callers.facts).toHaveLength(1);
    expect(process.calls.filter((call) => call.args[0] === "query")).toHaveLength(2);
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
