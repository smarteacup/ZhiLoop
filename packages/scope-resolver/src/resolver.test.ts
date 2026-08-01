import { describe, expect, it } from "vitest";

import type { KnowledgeCandidate, ScopeHint } from "@zhiloop/domain";

import { resolveKnowledgeScope } from "./resolver.js";

const project = {
  projectId: "project-1",
  repositoryRoot: "/workspace/zhiloop",
  repositoryRemote: "github.com/smarteacup/zhiloop",
  branch: "main",
  portable: true,
} as const;

function candidate(scopeHint: ScopeHint, overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    schemaVersion: 1,
    candidateId: "candidate-1",
    compilerVersion: "compiler-v1",
    status: "PROPOSED",
    subjectKey: "experience.scope.resolution",
    kind: "EXPERIENCE",
    scopeHint,
    title: "Resolve the narrowest provable scope",
    summary: "Use trusted context and project-specific signals.",
    body: "Uncertain knowledge remains project scoped.",
    sourceEpisodes: ["episode-1"],
    confidence: 0.9,
    assertions: [],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-1", correlationId: "correlation-1" }],
    createdAt: "2026-08-01T08:00:00.000Z",
    correlationId: "correlation-1",
    ...overrides,
  } as KnowledgeCandidate;
}

describe("resolveKnowledgeScope", () => {
  it("uses a matching trusted task as the narrowest scope", () => {
    const result = resolveKnowledgeScope({
      candidate: candidate({ level: "TASK", taskId: "task-1", projectId: "project-1", reasonCodes: ["MODEL_HINT"] }),
      projectContext: project,
      taskId: "task-1",
    });
    expect(result).toMatchObject({
      scope: { level: "TASK", taskId: "task-1", projectId: "project-1" },
      confidence: 1,
      reasonCodes: ["TRUSTED_TASK_ID", "MINIMUM_PROVABLE_SCOPE"],
    });
  });

  it("rejects an untrusted or conflicting task hint to PROJECT", () => {
    const result = resolveKnowledgeScope({
      candidate: candidate({ level: "TASK", taskId: "model-task", reasonCodes: [] }),
      projectContext: project,
      taskId: "trusted-task",
    });
    expect(result).toMatchObject({ scope: { level: "PROJECT" }, reasonCodes: ["UNTRUSTED_TASK_HINT", "SAFE_PROJECT_FALLBACK"] });
  });

  it("prefers validated symbols over broader module and project hints", () => {
    const result = resolveKnowledgeScope({
      candidate: candidate({
        level: "PROJECT",
        projectId: "project-1",
        symbols: ["OrderService", "OrderService"],
        modulePaths: ["src/order"],
        reasonCodes: [],
      }),
      projectContext: project,
    });
    expect(result.scope).toMatchObject({ level: "SYMBOL", symbols: ["OrderService"], projectId: "project-1" });
    expect(result.projectSpecificSignals).toContain("SYMBOL_REFERENCE");
  });

  it("derives symbol scope from a verifiable SYMBOL_EXISTS assertion", () => {
    const base = candidate({ projectId: "project-1", reasonCodes: [] });
    const result = resolveKnowledgeScope({
      candidate: { ...base, assertions: [{
        assertionId: "assertion-1",
        candidateId: base.candidateId,
        kind: "SYMBOL_EXISTS",
        parameters: { projectId: "project-1", symbol: "KnowledgeCompiler" },
        createdAt: base.createdAt,
      }] } as KnowledgeCandidate,
      projectContext: project,
    });
    expect(result.scope).toMatchObject({ level: "SYMBOL", symbols: ["KnowledgeCompiler"] });
  });

  it("fails closed when a symbol assertion belongs to another project", () => {
    const base = candidate({ reasonCodes: [] });
    const result = resolveKnowledgeScope({
      candidate: { ...base, assertions: [{
        assertionId: "assertion-1",
        candidateId: base.candidateId,
        kind: "SYMBOL_EXISTS",
        parameters: { projectId: "other-project", symbol: "KnowledgeCompiler" },
        createdAt: base.createdAt,
      }] } as KnowledgeCandidate,
      projectContext: project,
    });
    expect(result).toMatchObject({
      scope: { level: "PROJECT" },
      reasonCodes: ["SYMBOL_ASSERTION_PROJECT_CONFLICT", "SAFE_PROJECT_FALLBACK"],
    });
  });

  it("normalizes safe module paths and rejects unsafe paths to PROJECT", () => {
    const valid = resolveKnowledgeScope({
      candidate: candidate({ modulePaths: ["packages\\compiler", "packages/compiler"], reasonCodes: [] }),
      projectContext: project,
    });
    expect(valid.scope).toMatchObject({ level: "MODULE", modulePaths: ["packages/compiler"] });
    const unsafe = resolveKnowledgeScope({
      candidate: candidate({ modulePaths: ["../other", "/absolute/path"], reasonCodes: [] }),
      projectContext: project,
    });
    expect(unsafe).toMatchObject({ scope: { level: "PROJECT" }, reasonCodes: ["INVALID_MODULE_HINT", "SAFE_PROJECT_FALLBACK"] });
  });

  it("rejects missing and partially invalid SYMBOL or MODULE targets", () => {
    const missingSymbol = resolveKnowledgeScope({
      candidate: candidate({ level: "SYMBOL", reasonCodes: [] }),
      projectContext: project,
    });
    expect(missingSymbol.reasonCodes).toContain("INVALID_SYMBOL_HINT");
    const partialSymbol = resolveKnowledgeScope({
      candidate: candidate({ symbols: ["KnowledgeCompiler", "bad symbol"], reasonCodes: [] }),
      projectContext: project,
    });
    expect(partialSymbol.reasonCodes).toContain("INVALID_SYMBOL_HINT");
    const missingModule = resolveKnowledgeScope({
      candidate: candidate({ level: "MODULE", reasonCodes: [] }),
      projectContext: project,
    });
    expect(missingModule.reasonCodes).toContain("INVALID_MODULE_HINT");
    const partialModule = resolveKnowledgeScope({
      candidate: candidate({ modulePaths: ["packages/compiler", "../escape"], reasonCodes: [] }),
      projectContext: project,
    });
    expect(partialModule.reasonCodes).toContain("INVALID_MODULE_HINT");
  });

  it("defaults uncertain scope to PROJECT and preserves project coordinates", () => {
    const uncertain = resolveKnowledgeScope({ candidate: candidate({ reasonCodes: [] }), projectContext: project });
    expect(uncertain).toMatchObject({
      scope: { level: "PROJECT", projectId: "project-1", repositoryRemote: project.repositoryRemote },
      confidence: 0.8,
      reasonCodes: ["UNCERTAIN_SCOPE_DEFAULT_PROJECT"],
    });
    const explicit = resolveKnowledgeScope({ candidate: candidate({ level: "PROJECT", reasonCodes: [] }), projectContext: project });
    expect(explicit.confidence).toBe(0.9);
  });

  it("allows USER and TEAM only with matching trusted identities and generic content", () => {
    const user = resolveKnowledgeScope({
      candidate: candidate({ level: "USER", userId: "user-1", reasonCodes: [] }),
      projectContext: project,
      userId: "user-1",
    });
    expect(user.scope).toEqual({ level: "USER", userId: "user-1" });
    const team = resolveKnowledgeScope({
      candidate: candidate({ level: "TEAM", teamId: "team-1", reasonCodes: [] }),
      projectContext: project,
      teamId: "team-1",
    });
    expect(team.scope).toEqual({ level: "TEAM", teamId: "team-1" });
    const untrusted = resolveKnowledgeScope({
      candidate: candidate({ level: "USER", userId: "model-user", reasonCodes: [] }),
      projectContext: project,
      userId: "trusted-user",
    });
    expect(untrusted.reasonCodes).toContain("UNTRUSTED_USER_HINT");
  });

  it("blocks project-specific USER, TEAM, and GLOBAL expansion", () => {
    const pathSpecific = candidate(
      { level: "USER", userId: "user-1", reasonCodes: [] },
      { body: "Edit packages/compiler/src/index.ts before running this workflow." },
    );
    expect(resolveKnowledgeScope({ candidate: pathSpecific, projectContext: project, userId: "user-1" }).reasonCodes)
      .toContain("USER_SCOPE_REJECTED_PROJECT_SPECIFIC");
    const teamSpecific = candidate(
      { level: "TEAM", teamId: "team-1", reasonCodes: [] },
      { title: "ZhiLoop release rule" },
    );
    expect(resolveKnowledgeScope({
      candidate: teamSpecific,
      projectContext: project,
      teamId: "team-1",
    }).reasonCodes).toContain("TEAM_SCOPE_REJECTED_PROJECT_SPECIFIC");
    const globalSpecific = candidate(
      { level: "GLOBAL", symbols: ["OrderService"], reasonCodes: [] },
    );
    expect(resolveKnowledgeScope({ candidate: globalSpecific, projectContext: project, allowGlobal: true }).scope)
      .toMatchObject({ level: "SYMBOL", symbols: ["OrderService"] });
  });

  it("requires explicit trusted authorization for GLOBAL", () => {
    const source = candidate({ level: "GLOBAL", reasonCodes: [] });
    expect(resolveKnowledgeScope({ candidate: source, projectContext: project }).reasonCodes)
      .toContain("GLOBAL_REQUIRES_POLICY_AUTHORIZATION");
    const allowed = resolveKnowledgeScope({ candidate: source, projectContext: project, allowGlobal: true });
    expect(allowed).toMatchObject({ scope: { level: "GLOBAL" }, confidence: 0.85 });
    expect(Object.isFrozen(allowed)).toBe(true);
    expect(Object.isFrozen(allowed.reasonCodes)).toBe(true);
  });

  it("derives project business names from trusted project coordinates", () => {
    const source = candidate(
      { level: "GLOBAL", reasonCodes: [] },
      { title: "ZhiLoop release rule" },
    );
    const result = resolveKnowledgeScope({ candidate: source, projectContext: project, allowGlobal: true });
    expect(result.reasonCodes).toContain("GLOBAL_REJECTED_PROJECT_SPECIFIC");
    expect(result.projectSpecificSignals).toContain("PROJECT_TERM");
  });

  it("fails closed on Candidate project conflicts and invalid trusted context", () => {
    expect(() => resolveKnowledgeScope({
      candidate: candidate({ projectId: "other-project", reasonCodes: [] }),
      projectContext: project,
    })).toThrow("projectId conflicts");
    expect(() => resolveKnowledgeScope({
      candidate: candidate({ repositoryRemote: "github.com/other/repo", reasonCodes: [] }),
      projectContext: project,
    })).toThrow("repositoryRemote conflicts");
    expect(() => resolveKnowledgeScope({
      candidate: candidate({ reasonCodes: [] }),
      projectContext: project,
      projectTerms: ["x"],
    })).toThrow("projectTerms");
  });
});
