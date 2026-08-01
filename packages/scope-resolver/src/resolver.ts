import type { KnowledgeCandidate, KnowledgeScope, ProjectContext } from "@zhiloop/domain";

import type { ScopeResolution, ScopeResolutionInput } from "./types.js";

const PROJECT_ASSERTIONS = new Set([
  "SYMBOL_EXISTS",
  "FILE_CONTAINS",
  "DEPENDENCY_PRESENT",
  "CONFIG_EQUALS",
  "COMMAND_SUCCEEDED",
  "TEST_PASSED",
]);
const PROJECT_EVIDENCE = new Set([
  "CODE_SYMBOL",
  "FILE_CONTENT",
  "DEPENDENCY",
  "CONFIGURATION",
  "COMMAND_RESULT",
  "TEST_RESULT",
]);
const PATH_SIGNAL = /(?:^|[\s`'"(])(?:\.\/|src\/|packages\/|apps\/|modules?\/|lib\/|test\/|[A-Za-z]:\\|\/[^\s]+)/iu;
const SAFE_SYMBOL = /^[\p{L}_$][\p{L}\p{N}_$.:#-]{0,499}$/u;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertText(value: string | undefined, field: string): void {
  if (value !== undefined && (value.trim().length === 0 || value.length > 500 || /[\0\r\n]/.test(value))) {
    throw new Error(`${field} is invalid`);
  }
}

function assertProject(candidate: KnowledgeCandidate, project: ProjectContext): void {
  assertText(project.projectId, "projectId");
  if (project.projectId.trim().length === 0) throw new Error("projectId is required");
  assertText(project.repositoryRemote, "repositoryRemote");
  assertText(project.branch, "branch");
  if (typeof project.portable !== "boolean") throw new Error("project portable flag is invalid");
  const hint = candidate.scopeHint;
  if (hint.projectId !== undefined && hint.projectId !== project.projectId) throw new Error("Candidate projectId conflicts with ProjectContext");
  if (
    hint.repositoryRemote !== undefined
    && hint.repositoryRemote !== project.repositoryRemote
  ) throw new Error("Candidate repositoryRemote conflicts with ProjectContext");
}

interface SymbolInputs {
  readonly symbols: readonly string[];
  readonly invalid: boolean;
  readonly assertionProjectConflict: boolean;
}

function symbolInputs(candidate: KnowledgeCandidate, project: ProjectContext): SymbolInputs {
  const symbolAssertions = candidate.assertions.filter((assertion) => assertion.kind === "SYMBOL_EXISTS");
  const values = [...(candidate.scopeHint.symbols ?? []), ...symbolAssertions.map((assertion) => assertion.parameters.symbol)];
  const normalized = values.map((item) => typeof item === "string" ? item.trim() : "");
  return {
    symbols: [...new Set(normalized.filter((item) => SAFE_SYMBOL.test(item)))],
    invalid: (candidate.scopeHint.level === "SYMBOL" && values.length === 0)
      || normalized.some((item) => !SAFE_SYMBOL.test(item)),
    assertionProjectConflict: symbolAssertions.some((assertion) => assertion.parameters.projectId !== project.projectId),
  };
}

interface ModuleInputs {
  readonly paths: readonly string[];
  readonly invalid: boolean;
}

function moduleInputs(candidate: KnowledgeCandidate): ModuleInputs {
  const values = candidate.scopeHint.modulePaths ?? [];
  const normalized = values.map((item) => typeof item === "string" ? item.trim().replace(/\\/g, "/") : "");
  const isSafe = (item: string): boolean => item.length > 0 && item.length <= 1_000 && !item.startsWith("/")
    && !/^[A-Za-z]:\//.test(item) && !item.split("/").some((part) => part === ".." || part === "");
  return {
    paths: [...new Set(normalized.filter(isSafe))],
    invalid: (candidate.scopeHint.level === "MODULE" && values.length === 0) || normalized.some((item) => !isSafe(item)),
  };
}

function derivedProjectTerms(project: ProjectContext): readonly string[] {
  const values = [project.repositoryRemote, project.repositoryRoot]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "")
    .map((value) => value.replace(/\.git$/i, "").trim())
    .filter((value) => value.length >= 3 && value.length <= 200);
  return [...new Set(values)];
}

function projectSpecificSignals(input: ScopeResolutionInput, symbols: readonly string[], modules: readonly string[]): readonly string[] {
  const candidate = input.candidate;
  const signals = new Set<string>();
  if (symbols.length > 0) signals.add("SYMBOL_REFERENCE");
  if (modules.length > 0) signals.add("MODULE_PATH");
  if (candidate.kind === "IMPLEMENTATION") signals.add("IMPLEMENTATION_KIND");
  if (candidate.assertions.some((assertion) => PROJECT_ASSERTIONS.has(assertion.kind))) signals.add("PROJECT_ASSERTION");
  if (candidate.evidenceHints.some((hint) => PROJECT_EVIDENCE.has(hint.type))) signals.add("PROJECT_EVIDENCE");
  const text = `${candidate.subjectKey}\n${candidate.title}\n${candidate.summary}\n${candidate.body}`;
  if (PATH_SIGNAL.test(text)) signals.add("PATH_REFERENCE");
  for (const term of input.projectTerms ?? []) {
    const normalized = term.trim();
    if (normalized.length < 3 || normalized.length > 200) throw new Error("projectTerms must contain 3 to 200 characters");
  }
  const projectTerms = [...derivedProjectTerms(input.projectContext), ...(input.projectTerms ?? [])];
  for (const term of projectTerms) {
    if (text.toLocaleLowerCase("en-US").includes(term.trim().toLocaleLowerCase("en-US"))) signals.add("PROJECT_TERM");
  }
  return [...signals].sort();
}

function projectCoordinates(project: ProjectContext): { projectId: string; repositoryRemote?: string } {
  return {
    projectId: project.projectId,
    ...(project.repositoryRemote === undefined ? {} : { repositoryRemote: project.repositoryRemote }),
  };
}

function result(
  scope: KnowledgeScope,
  confidence: number,
  reasonCodes: readonly string[],
  signals: readonly string[],
): ScopeResolution {
  return deepFreeze({ scope, confidence, reasonCodes: [...reasonCodes], projectSpecificSignals: [...signals] });
}

function projectFallback(project: ProjectContext, reason: string, signals: readonly string[]): ScopeResolution {
  return result({ level: "PROJECT", ...projectCoordinates(project) }, 0.7, [reason, "SAFE_PROJECT_FALLBACK"], signals);
}

export function resolveKnowledgeScope(input: ScopeResolutionInput): ScopeResolution {
  assertProject(input.candidate, input.projectContext);
  assertText(input.taskId, "taskId");
  assertText(input.userId, "userId");
  assertText(input.teamId, "teamId");
  const hint = input.candidate.scopeHint;
  const symbolResolution = symbolInputs(input.candidate, input.projectContext);
  const moduleResolution = moduleInputs(input.candidate);
  const symbols = symbolResolution.symbols;
  const modules = moduleResolution.paths;
  const signals = projectSpecificSignals(input, symbols, modules);
  const project = projectCoordinates(input.projectContext);

  if (hint.level === "TASK" || hint.taskId !== undefined) {
    if (input.taskId !== undefined && (hint.taskId === undefined || hint.taskId === input.taskId)) {
      return result({ level: "TASK", taskId: input.taskId, ...project }, 1, ["TRUSTED_TASK_ID", "MINIMUM_PROVABLE_SCOPE"], signals);
    }
    return projectFallback(input.projectContext, "UNTRUSTED_TASK_HINT", signals);
  }
  if (symbolResolution.assertionProjectConflict) {
    return projectFallback(input.projectContext, "SYMBOL_ASSERTION_PROJECT_CONFLICT", signals);
  }
  if (symbolResolution.invalid) return projectFallback(input.projectContext, "INVALID_SYMBOL_HINT", signals);
  if (symbols.length > 0) {
    return result(
      { level: "SYMBOL", symbols: symbols as readonly [string, ...string[]], ...project },
      0.95,
      ["VALIDATED_SYMBOLS", "MINIMUM_PROVABLE_SCOPE"],
      signals,
    );
  }
  if (moduleResolution.invalid) return projectFallback(input.projectContext, "INVALID_MODULE_HINT", signals);
  if (modules.length > 0) {
    return result(
      { level: "MODULE", modulePaths: modules as readonly [string, ...string[]], ...project },
      0.9,
      ["VALIDATED_MODULE_PATHS", "MINIMUM_PROVABLE_SCOPE"],
      signals,
    );
  }

  if (hint.level === "USER") {
    if (signals.length > 0) return projectFallback(input.projectContext, "USER_SCOPE_REJECTED_PROJECT_SPECIFIC", signals);
    if (input.userId !== undefined && hint.userId === input.userId) {
      return result({ level: "USER", userId: input.userId }, 0.9, ["TRUSTED_USER_ID", "EXPLICIT_UPWARD_SCOPE"], signals);
    }
    return projectFallback(input.projectContext, "UNTRUSTED_USER_HINT", signals);
  }
  if (hint.level === "TEAM") {
    if (signals.length > 0) return projectFallback(input.projectContext, "TEAM_SCOPE_REJECTED_PROJECT_SPECIFIC", signals);
    if (input.teamId !== undefined && hint.teamId === input.teamId) {
      return result({ level: "TEAM", teamId: input.teamId }, 0.9, ["TRUSTED_TEAM_ID", "EXPLICIT_UPWARD_SCOPE"], signals);
    }
    return projectFallback(input.projectContext, "UNTRUSTED_TEAM_HINT", signals);
  }
  if (hint.level === "GLOBAL") {
    if (signals.length > 0) return projectFallback(input.projectContext, "GLOBAL_REJECTED_PROJECT_SPECIFIC", signals);
    if (input.allowGlobal === true) return result({ level: "GLOBAL" }, 0.85, ["TRUSTED_GLOBAL_AUTHORIZATION"], signals);
    return projectFallback(input.projectContext, "GLOBAL_REQUIRES_POLICY_AUTHORIZATION", signals);
  }

  return result(
    { level: "PROJECT", ...project },
    hint.level === "PROJECT" ? 0.9 : 0.8,
    [hint.level === "PROJECT" ? "EXPLICIT_PROJECT_SCOPE" : "UNCERTAIN_SCOPE_DEFAULT_PROJECT"],
    signals,
  );
}
