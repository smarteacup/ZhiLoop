import type { ProjectContext } from "@zhiloop/domain";

import type { QueryContext, QueryContextInput, QueryTerm, QueryTermSource } from "./types.js";

const MAX_PROMPT_CHARS = 100_000;
const MAX_TERM_CHARS = 1_000;
const MAX_TERMS_PER_KIND = 100;
const CONTROL = /[\0\r\n]/u;
const RELATIVE_PATH = /^(?:\.\/)?(?:[A-Za-z0-9_@+.,=-]+\/)*[A-Za-z0-9_@+.,=-]+$/u;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(\))?$/u;
const ERROR_CODE = /^(?:ERR_[A-Z0-9_]+|TS\d{3,6}|E[A-Z0-9_]{2,}|[A-Z][A-Z0-9_]+-\d{2,})$/u;
const CONFIG_KEY = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/u;

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function validText(value: string | undefined, maximum = MAX_TERM_CHARS): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !CONTROL.test(value);
}

function slash(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

function isSafeAbsolute(value: string): boolean {
  const normalized = slash(value);
  return isAbsolute(normalized) && !normalized.split("/").some((part) => part === "." || part === "..");
}

function isSafeRepositoryRoot(value: string): boolean {
  if (!validText(value) || !isSafeAbsolute(value)) return false;
  const normalized = slash(value.trim()).replace(/\/$/u, "");
  return normalized !== "" && !/^[A-Za-z]:$/u.test(normalized);
}

function withinRoot(value: string, repositoryRoot: string): boolean {
  const normalized = slash(value.trim()).replace(/\/$/u, "");
  const root = slash(repositoryRoot.trim()).replace(/\/$/u, "");
  const comparableRoot = /^[A-Za-z]:\//u.test(root) ? root.toLowerCase() : root;
  const comparableValue = /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
  return comparableValue === comparableRoot || comparableValue.startsWith(`${comparableRoot}/`);
}

function canonicalPath(value: string, repositoryRoot: string | undefined): string | undefined {
  if (!validText(value)) return undefined;
  let normalized = slash(value.trim());
  if (isAbsolute(normalized)) {
    if (!isSafeAbsolute(normalized)) return undefined;
    if (!validText(repositoryRoot)) return undefined;
    const root = slash(repositoryRoot.trim()).replace(/\/$/u, "");
    if (!withinRoot(normalized, root)) return undefined;
    normalized = normalized.slice(root.length).replace(/^\//u, "");
  }
  normalized = normalized.replace(/^\.\//u, "");
  if (!RELATIVE_PATH.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "." || part === ".." || part.length === 0)) return undefined;
  return parts.join("/");
}

function canonicalSymbol(value: string): string | undefined {
  if (!validText(value)) return undefined;
  const normalized = value.trim().normalize("NFKC");
  if (!SYMBOL.test(normalized)) return undefined;
  return normalized.endsWith("()") ? normalized.slice(0, -2) : normalized;
}

function canonicalError(value: string): string | undefined {
  if (!validText(value)) return undefined;
  const normalized = value.trim().normalize("NFKC");
  return ERROR_CODE.test(normalized) ? normalized : undefined;
}

function canonicalConfig(value: string): string | undefined {
  if (!validText(value)) return undefined;
  const normalized = value.trim().normalize("NFKC");
  return CONFIG_KEY.test(normalized) ? normalized : undefined;
}

type TermKind = "PATH" | "SYMBOL" | "ERROR_CODE" | "CONFIG_KEY";

class Terms {
  readonly values: QueryTerm[] = [];
  readonly #seen = new Set<string>();
  readonly #kind: TermKind;
  readonly #canonical: (value: string) => string | undefined;
  readonly #reasons: Set<string>;

  constructor(kind: TermKind, canonical: (value: string) => string | undefined, reasons: Set<string>) {
    this.#kind = kind;
    this.#canonical = canonical;
    this.#reasons = reasons;
  }

  add(exact: string, source: QueryTermSource): void {
    const canonical = this.#canonical(exact);
    if (canonical === undefined) {
      if (source === "EXPLICIT") this.#reasons.add(`INVALID_${this.#kind}_HINT_IGNORED`);
      return;
    }
    if (this.#seen.has(canonical)) return;
    if (this.values.length >= MAX_TERMS_PER_KIND) {
      this.#reasons.add(`${this.#kind}_LIMIT_REACHED`);
      return;
    }
    this.#seen.add(canonical);
    this.values.push({ exact, canonical, source });
  }
}

function validProject(value: ProjectContext | undefined): value is ProjectContext {
  return value !== undefined && validText(value.projectId, 500) && typeof value.portable === "boolean"
    && (value.repositoryRoot === undefined || isSafeRepositoryRoot(value.repositoryRoot))
    && (value.repositoryRemote === undefined || validText(value.repositoryRemote))
    && (value.branch === undefined || validText(value.branch))
    && (value.revision === undefined || (GIT_COMMIT.test(value.revision.commit)
      && typeof value.revision.dirty === "boolean"));
}

function matches(input: string, expression: RegExp): string[] {
  return [...input.matchAll(expression)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
}

export function resolveQueryContext(input: QueryContextInput): QueryContext {
  if (typeof input.prompt !== "string" || input.prompt.length === 0 || input.prompt.length > MAX_PROMPT_CHARS || input.prompt.includes("\0")) {
    throw new Error(`prompt must contain 1 to ${MAX_PROMPT_CHARS} characters without NUL`);
  }
  const reasons = new Set<string>();
  const project = validProject(input.project) ? input.project : undefined;
  if (input.project !== undefined && project === undefined) reasons.add("INVALID_PROJECT_CONTEXT_IGNORED");
  if (project === undefined) reasons.add("NO_TRUSTED_PROJECT_CONTEXT");

  const paths = new Terms("PATH", (value) => canonicalPath(value, project?.repositoryRoot), reasons);
  const symbols = new Terms("SYMBOL", canonicalSymbol, reasons);
  const errorCodes = new Terms("ERROR_CODE", canonicalError, reasons);
  const configKeys = new Terms("CONFIG_KEY", canonicalConfig, reasons);
  const taskIntents = new Terms("SYMBOL", (value) => validText(value) ? value.trim().normalize("NFKC") : undefined, reasons);
  const entryPoints = new Terms("PATH", (value) => validText(value) ? value.trim().normalize("NFKC") : undefined, reasons);
  for (const value of input.hints?.paths ?? []) paths.add(value, "EXPLICIT");
  for (const value of input.hints?.symbols ?? []) symbols.add(value, "EXPLICIT");
  for (const value of input.hints?.errorCodes ?? []) errorCodes.add(value, "EXPLICIT");
  for (const value of input.hints?.configKeys ?? []) configKeys.add(value, "EXPLICIT");
  for (const value of input.hints?.taskIntents ?? []) taskIntents.add(value, "EXPLICIT");
  for (const value of input.hints?.entryPoints ?? []) entryPoints.add(value, "EXPLICIT");

  for (const value of matches(input.prompt, /`([^`\r\n]{1,1000})`/gu)) {
    paths.add(value, "PROMPT");
    symbols.add(value, "PROMPT");
    errorCodes.add(value, "PROMPT");
    configKeys.add(value, "PROMPT");
  }
  for (const value of matches(input.prompt, /\b((?:\.\/)?(?:[A-Za-z0-9_@+.,=-]+\/)+[A-Za-z0-9_@+.,=-]+\.[A-Za-z0-9]{1,12})\b/gu)) paths.add(value, "PROMPT");
  for (const value of matches(input.prompt, /\b(?:symbol|class|function)\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(\))?)/giu)) symbols.add(value, "PROMPT");
  for (const value of matches(input.prompt, /\bat\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/gu)) symbols.add(value, "PROMPT");
  for (const value of matches(input.prompt, /\b(ERR_[A-Z0-9_]+|TS\d{3,6}|E[A-Z0-9_]{2,}|[A-Z][A-Z0-9_]+-\d{2,})\b/gu)) errorCodes.add(value, "PROMPT");
  for (const value of matches(input.prompt, /\b([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)\b/gu)) configKeys.add(value, "PROMPT");

  let cwd: string | undefined;
  if (input.cwd !== undefined) {
    if (!validText(input.cwd) || !isSafeAbsolute(input.cwd)) reasons.add("INVALID_CWD_IGNORED");
    else if (project?.repositoryRoot !== undefined && (!isAbsolute(slash(input.cwd)) || !withinRoot(input.cwd, project.repositoryRoot))) {
      reasons.add("CWD_OUTSIDE_PROJECT_IGNORED");
    } else cwd = input.cwd;
  } else reasons.add("CWD_UNAVAILABLE");
  let branch = project?.branch;
  if (branch === undefined && validText(input.branch)) branch = input.branch;
  else if (input.branch !== undefined && (!validText(input.branch) || input.branch !== branch)) {
    reasons.add(branch === undefined ? "INVALID_BRANCH_IGNORED" : "BRANCH_INPUT_CONFLICT");
  }
  if (branch === undefined) reasons.add("BRANCH_UNAVAILABLE");
  const commit = project?.revision?.commit;
  if (commit === undefined) reasons.add("COMMIT_UNAVAILABLE");
  const taskId = validText(input.taskId, 500) ? input.taskId : undefined;
  if (input.taskId !== undefined && taskId === undefined) reasons.add("INVALID_TASK_ID_IGNORED");

  return freeze({
    schemaVersion: 1,
    prompt: input.prompt,
    ...(project === undefined ? {} : { project }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(branch === undefined ? {} : { branch }),
    ...(commit === undefined ? {} : { commit }),
    ...(taskId === undefined ? {} : { taskId }),
    paths: paths.values,
    symbols: symbols.values,
    errorCodes: errorCodes.values,
    configKeys: configKeys.values,
    taskIntents: taskIntents.values,
    entryPoints: entryPoints.values,
    retrievalBoundary: {
      allowProjectKnowledge: project !== undefined,
      allowGlobalKnowledge: project !== undefined,
      ...(project === undefined ? {} : { projectId: project.projectId }),
      ...(taskId === undefined ? {} : { taskId }),
    },
    reasonCodes: [...reasons],
  });
}
