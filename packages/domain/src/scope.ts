export const SCOPE_LEVELS = [
  "TASK",
  "SYMBOL",
  "MODULE",
  "PROJECT",
  "USER",
  "TEAM",
  "GLOBAL",
] as const;

export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

interface ProjectCoordinates {
  readonly projectId: string;
  readonly repositoryRemote?: string;
}

export type KnowledgeScope =
  | ({ readonly level: "TASK"; readonly taskId: string } & Partial<ProjectCoordinates>)
  | ({ readonly level: "SYMBOL"; readonly symbols: readonly [string, ...string[]] } &
      ProjectCoordinates)
  | ({ readonly level: "MODULE"; readonly modulePaths: readonly [string, ...string[]] } &
      ProjectCoordinates)
  | ({ readonly level: "PROJECT" } & ProjectCoordinates)
  | { readonly level: "USER"; readonly userId: string }
  | { readonly level: "TEAM"; readonly teamId: string }
  | { readonly level: "GLOBAL" };

export interface ScopeHint {
  readonly level?: ScopeLevel;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly repositoryRemote?: string;
  readonly modulePaths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly userId?: string;
  readonly teamId?: string;
  readonly reasonCodes: readonly string[];
}

export interface ProjectContext {
  readonly projectId: string;
  readonly repositoryRoot?: string;
  readonly repositoryRemote?: string;
  readonly branch?: string;
  readonly portable: boolean;
}

export interface ScopeInput {
  readonly level?: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly repositoryRemote?: string;
  readonly modulePaths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly userId?: string;
  readonly teamId?: string;
}

export type ScopeValidationResult =
  | { readonly valid: true; readonly scope: KnowledgeScope }
  | { readonly valid: false; readonly errors: readonly string[] };

const PROJECT_ONLY_FIELDS = [
  "taskId",
  "projectId",
  "repositoryRemote",
  "modulePaths",
  "symbols",
] as const;

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasItems(values: readonly string[] | undefined): values is readonly [string, ...string[]] {
  return Array.isArray(values) && values.length > 0 && values.every(hasText);
}

function rejectUnexpected(
  input: ScopeInput,
  allowedFields: readonly (keyof ScopeInput)[],
): string[] {
  const allowed = new Set<keyof ScopeInput>(["level", ...allowedFields]);
  return Object.keys(input)
    .filter((key) => !allowed.has(key as keyof ScopeInput))
    .filter((key) => input[key as keyof ScopeInput] !== undefined)
    .map((key) => `${input.level ?? "UNKNOWN"} scope must not define ${key}`);
}

export function validateKnowledgeScope(input: ScopeInput): ScopeValidationResult {
  const errors: string[] = [];

  switch (input.level) {
    case "TASK":
      if (!hasText(input.taskId)) errors.push("TASK scope requires taskId");
      errors.push(...rejectUnexpected(input, ["taskId", "projectId", "repositoryRemote"]));
      break;
    case "SYMBOL":
      if (!hasText(input.projectId)) errors.push("SYMBOL scope requires projectId");
      if (!hasItems(input.symbols)) errors.push("SYMBOL scope requires symbols");
      errors.push(...rejectUnexpected(input, ["projectId", "repositoryRemote", "symbols"]));
      break;
    case "MODULE":
      if (!hasText(input.projectId)) errors.push("MODULE scope requires projectId");
      if (!hasItems(input.modulePaths)) errors.push("MODULE scope requires modulePaths");
      errors.push(...rejectUnexpected(input, ["projectId", "repositoryRemote", "modulePaths"]));
      break;
    case "PROJECT":
      if (!hasText(input.projectId)) errors.push("PROJECT scope requires projectId");
      errors.push(...rejectUnexpected(input, ["projectId", "repositoryRemote"]));
      break;
    case "USER":
      if (!hasText(input.userId)) errors.push("USER scope requires userId");
      errors.push(...rejectUnexpected(input, ["userId"]));
      break;
    case "TEAM":
      if (!hasText(input.teamId)) errors.push("TEAM scope requires teamId");
      errors.push(...rejectUnexpected(input, ["teamId"]));
      break;
    case "GLOBAL":
      errors.push(...rejectUnexpected(input, []));
      break;
    default:
      errors.push(`unsupported scope level: ${input.level ?? "missing"}`);
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, scope: input as KnowledgeScope };
}

export function hasProjectSpecificScopeFields(input: ScopeInput): boolean {
  return PROJECT_ONLY_FIELDS.some((field) => input[field] !== undefined);
}

