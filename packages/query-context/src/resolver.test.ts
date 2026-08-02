import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { resolveQueryContext } from "./index.js";

const project = {
  projectId: "project-query",
  repositoryRoot: "/workspace/query",
  repositoryRemote: "github.com/example/query",
  branch: "main",
  portable: true,
} as const;

describe("resolveQueryContext", () => {
  it("preserves exact explicit tokens while deduplicating by canonical value", () => {
    const result = resolveQueryContext({
      prompt: "Fix `packages/query-context/src/resolver.ts`, symbol KnowledgeGovernanceService() after ERR_CONTEXT-42; retrieval.max-results is wrong.",
      project,
      cwd: "/workspace/query/packages/query-context",
      hints: {
        paths: ["./packages/query-context/src/resolver.ts"],
        symbols: ["KnowledgeGovernanceService()"],
        errorCodes: ["ERR_CONTEXT-42"],
        configKeys: ["retrieval.max-results"],
      },
    });
    expect(result.prompt).toContain("KnowledgeGovernanceService()");
    expect(result.paths[0]).toEqual({
      exact: "./packages/query-context/src/resolver.ts",
      canonical: "packages/query-context/src/resolver.ts",
      source: "EXPLICIT",
    });
    expect(result.symbols).toContainEqual({
      exact: "KnowledgeGovernanceService()", canonical: "KnowledgeGovernanceService", source: "EXPLICIT",
    });
    expect(result.errorCodes).toContainEqual({ exact: "ERR_CONTEXT-42", canonical: "ERR_CONTEXT-42", source: "EXPLICIT" });
    expect(result.configKeys).toContainEqual({
      exact: "retrieval.max-results", canonical: "retrieval.max-results", source: "EXPLICIT",
    });
    expect(result.retrievalBoundary).toEqual({
      allowProjectKnowledge: true, allowGlobalKnowledge: true, projectId: project.projectId,
    });
  });

  it("extracts stack symbols, TypeScript/error codes, config keys, and relative paths without semantic rewriting", () => {
    const prompt = "TS2345 and EACCES at Resolver.resolve (packages/query/src/resolver.ts:42); config injection.token_budget failed";
    const result = resolveQueryContext({ prompt, project });
    expect(result.errorCodes.map((item) => item.exact)).toEqual(["TS2345", "EACCES"]);
    expect(result.symbols).toContainEqual(expect.objectContaining({ exact: "Resolver.resolve", canonical: "Resolver.resolve" }));
    expect(result.paths).toContainEqual(expect.objectContaining({ exact: "packages/query/src/resolver.ts" }));
    expect(result.configKeys).toContainEqual(expect.objectContaining({ exact: "injection.token_budget" }));
  });

  it("canonicalizes only repository-contained absolute paths and rejects traversal", () => {
    const result = resolveQueryContext({
      prompt: "inspect paths",
      project,
      hints: {
        paths: [
          "/workspace/query/src/index.ts",
          "/workspace/other/secret.txt",
          "/workspace/query/../other/secret.txt",
          "../escape.txt",
          "src\\windows.ts",
        ],
      },
    });
    expect(result.paths).toEqual([{
      exact: "/workspace/query/src/index.ts", canonical: "src/index.ts", source: "EXPLICIT",
    }, {
      exact: "src\\windows.ts", canonical: "src/windows.ts", source: "EXPLICIT",
    }]);
    expect(result.reasonCodes).toContain("INVALID_PATH_HINT_IGNORED");
  });

  it("fails closed without trusted project context but retains exact query terms", () => {
    const result = resolveQueryContext({
      prompt: "Fix `src/index.ts` and ERR_MISSING_PROJECT",
      taskId: "task-501",
    });
    expect(result.project).toBeUndefined();
    expect(result.paths).toContainEqual(expect.objectContaining({ exact: "src/index.ts" }));
    expect(result.retrievalBoundary).toEqual({
      allowProjectKnowledge: false, allowGlobalKnowledge: false, taskId: "task-501",
    });
    expect(result.reasonCodes).toContain("NO_TRUSTED_PROJECT_CONTEXT");
  });

  it("uses trusted project branch and ignores conflicting or out-of-project runtime hints", () => {
    const result = resolveQueryContext({
      prompt: "branch context",
      project,
      branch: "feature/untrusted",
      cwd: "/outside/query",
    });
    expect(result.branch).toBe("main");
    expect(result.cwd).toBeUndefined();
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["BRANCH_INPUT_CONFLICT", "CWD_OUTSIDE_PROJECT_IGNORED"]));
  });

  it("accepts the repository root as cwd and rejects unsafe project roots", () => {
    expect(resolveQueryContext({ prompt: "root", project, cwd: project.repositoryRoot }).cwd).toBe(project.repositoryRoot);
    for (const repositoryRoot of ["relative/root", "/", "//", "C:\\", "C://", "/workspace/query/../other"]) {
      const result = resolveQueryContext({ prompt: "unsafe root", project: { ...project, repositoryRoot } });
      expect(result.project).toBeUndefined();
      expect(result.reasonCodes).toContain("INVALID_PROJECT_CONTEXT_IGNORED");
    }
  });

  it("rejects relative and traversal cwd values even when no project is available", () => {
    for (const cwd of ["relative/path", "/workspace/query/../other"]) {
      const result = resolveQueryContext({ prompt: "cwd", cwd });
      expect(result.cwd).toBeUndefined();
      expect(result.reasonCodes).toContain("INVALID_CWD_IGNORED");
    }
  });

  it("ignores invalid optional context and enforces bounded term counts", () => {
    const result = resolveQueryContext({
      prompt: "bounded",
      project: { projectId: "", portable: true },
      cwd: "bad\0cwd",
      branch: "bad\nbranch",
      taskId: " ",
      hints: {
        symbols: [...Array.from({ length: 101 }, (_, index) => `Symbol${index}`), "invalid symbol!"],
        errorCodes: ["not-an-error"],
        configKeys: ["Not.Config"],
      },
    });
    expect(result.symbols).toHaveLength(100);
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "INVALID_PROJECT_CONTEXT_IGNORED", "NO_TRUSTED_PROJECT_CONTEXT", "INVALID_CWD_IGNORED",
      "INVALID_BRANCH_IGNORED", "INVALID_TASK_ID_IGNORED", "SYMBOL_LIMIT_REACHED",
      "INVALID_SYMBOL_HINT_IGNORED", "INVALID_ERROR_CODE_HINT_IGNORED", "INVALID_CONFIG_KEY_HINT_IGNORED",
      "BRANCH_UNAVAILABLE",
    ]));
  });

  it("rejects invalid prompts and returns a deeply immutable context", () => {
    expect(() => resolveQueryContext({ prompt: "" })).toThrow("1 to 100000");
    expect(() => resolveQueryContext({ prompt: "x".repeat(100_001) })).toThrow("1 to 100000");
    expect(() => resolveQueryContext({ prompt: "bad\0prompt" })).toThrow("without NUL");
    const result = resolveQueryContext({ prompt: "symbol Resolver", project });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.symbols)).toBe(true);
    expect(Object.isFrozen(result.retrievalBoundary)).toBe(true);
  });

  it("resolves a 10,000-character prompt below the local P95 budget", () => {
    const prompt = `${"diagnostic context ".repeat(580)} ERR_CONTEXT_LIMIT src/query/context.ts`;
    const durations = Array.from({ length: 50 }, () => {
      const started = performance.now();
      resolveQueryContext({ prompt, project });
      return performance.now() - started;
    }).sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThan(10);
  });
});
