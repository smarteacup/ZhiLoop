import type {
  ConfigAssertion,
  DependencyAssertion,
  FileAssertion,
  ProbeContext,
  VerificationObservation,
  VerificationProbe,
} from "@zhiloop/evidence-engine";

import type {
  ConfigurationProbeOptions,
  DependencyProbeOptions,
  FileProbeOptions,
  RepositoryFile,
  RepositoryReadPort,
} from "./types.js";
import { RepositoryReadError } from "./types.js";

const DEFAULT_MANIFESTS = ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "Cargo.toml", "go.mod"] as const;
const DEFAULT_CONFIGS = [
  "zhiloop.json", "config.json", "application.yml", "application.yaml", "config.yml", "config.yaml", "config.toml", "application.properties",
] as const;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/u;

type ParsedDependencies = ReadonlyMap<string, string | undefined>;
type ParseResult<T> = { readonly status: "PARSED"; readonly value: T }
  | { readonly status: "UNSUPPORTED" | "DAMAGED"; readonly reasonCode: string };

function source(file: RepositoryFile, kind: string): string {
  return `repository:${kind}:${file.path}:sha256:${file.contentHash}`;
}

function observation(
  status: VerificationObservation["status"],
  context: ProbeContext,
  target: string,
  sourceRef: string,
  reasonCode: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): VerificationObservation {
  return Object.freeze({ status, observedAt: context.requestedAt, target, sourceRef, reasonCode, ...(details === undefined ? {} : { details }) });
}

function unavailable(error: unknown): string {
  if (!(error instanceof RepositoryReadError)) return "REPOSITORY_READ_FAILED";
  return error.code;
}

function isMissing(error: unknown): boolean {
  return error instanceof RepositoryReadError && error.code === "REPOSITORY_FILE_NOT_FOUND";
}

async function evaluateBounded(
  work: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<"MATCH" | "NO_MATCH" | "TIMEOUT" | "ERROR"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(work).then((matched) => matched ? "MATCH" as const : "NO_MATCH" as const),
      new Promise<"TIMEOUT">((resolve) => { timer = setTimeout(() => resolve("TIMEOUT"), timeoutMs); }),
    ]);
    return result;
  } catch {
    return "ERROR";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createRepositoryFileProbe(
  repository: RepositoryReadPort,
  options: FileProbeOptions = {},
): VerificationProbe<FileAssertion> {
  const timeoutMs = options.evaluationTimeoutMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000) throw new Error("FILE_PROBE_TIMEOUT_INVALID");
  if (options.regex !== undefined && !/^[a-z][a-z0-9-]{0,99}$/u.test(options.regex.evaluatorId)) {
    throw new Error("REGEX_EVALUATOR_ID_INVALID");
  }
  const structural = new Map<string, NonNullable<FileProbeOptions["structural"]>[number]>();
  for (const evaluator of options.structural ?? []) {
    if (!/^[a-z][a-z0-9-]{0,99}$/u.test(evaluator.evaluatorId)) throw new Error("STRUCTURAL_EVALUATOR_ID_INVALID");
    for (const raw of evaluator.extensions) {
      const extension = raw.toLowerCase();
      if (!/^\.[a-z0-9]{1,20}$/u.test(extension) || structural.has(extension)) throw new Error("STRUCTURAL_EXTENSION_INVALID");
      structural.set(extension, evaluator);
    }
  }
  return Object.freeze({
    observe: async (assertion: FileAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const target = `file:${assertion.parameters.path}:${assertion.parameters.matchMode}`;
      let file: RepositoryFile;
      try {
        file = await repository.read(assertion.parameters.path);
      } catch (error) {
        if (isMissing(error)) return observation("REFUTED", context, target, `repository:${assertion.parameters.path}`, "FILE_NOT_FOUND");
        if (error instanceof RepositoryReadError && ["REPOSITORY_PATH_INVALID", "REPOSITORY_PATH_ESCAPE", "REPOSITORY_FILE_NOT_REGULAR"].includes(error.code)) throw error;
        return observation("UNKNOWN", context, target, `repository:${assertion.parameters.path}`, unavailable(error));
      }
      if (assertion.parameters.matchMode === "EXACT") {
        const matched = file.content.includes(assertion.parameters.expected);
        return observation(matched ? "SUPPORTED" : "REFUTED", context, target, source(file, "file"), matched ? "FILE_LITERAL_FOUND" : "FILE_LITERAL_NOT_FOUND",
          { byteLength: file.byteLength });
      }
      if (assertion.parameters.matchMode === "REGEX") {
        if (options.regex === undefined) return observation("UNKNOWN", context, target, source(file, "file"), "REGEX_EVALUATOR_UNAVAILABLE");
        const result = await evaluateBounded(() => options.regex!.evaluate({ pattern: assertion.parameters.expected, content: file.content,
          deadlineMs: Date.now() + timeoutMs }), timeoutMs);
        if (result === "TIMEOUT" || result === "ERROR") return observation("UNKNOWN", context, target, source(file, "file"),
          result === "TIMEOUT" ? "REGEX_EVALUATION_TIMEOUT" : "REGEX_EVALUATION_FAILED");
        return observation(result === "MATCH" ? "SUPPORTED" : "REFUTED", context, target,
          `${source(file, "file")}:evaluator:${options.regex.evaluatorId}`,
          result === "MATCH" ? "REGEX_MATCHED" : "REGEX_NOT_MATCHED");
      }
      const extension = file.path.includes(".") ? `.${file.path.split(".").at(-1)!.toLowerCase()}` : "";
      const evaluator = structural.get(extension);
      if (evaluator === undefined) return observation("UNKNOWN", context, target, source(file, "file"), "STRUCTURAL_EVALUATOR_UNAVAILABLE");
      const result = await evaluateBounded(() => evaluator.contains({ expected: assertion.parameters.expected, content: file.content,
        path: file.path, deadlineMs: Date.now() + timeoutMs }), timeoutMs);
      if (result === "TIMEOUT" || result === "ERROR") return observation("UNKNOWN", context, target, source(file, "file"),
        result === "TIMEOUT" ? "STRUCTURAL_EVALUATION_TIMEOUT" : "STRUCTURAL_EVALUATION_FAILED");
      return observation(result === "MATCH" ? "SUPPORTED" : "REFUTED", context, target,
        `${source(file, "file")}:evaluator:${evaluator.evaluatorId}`,
        result === "MATCH" ? "STRUCTURAL_MATCHED" : "STRUCTURAL_NOT_MATCHED");
    },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageJson(content: string): ParseResult<ParsedDependencies> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!record(parsed)) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
    const dependencies = new Map<string, string | undefined>();
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const values = parsed[section];
      if (values === undefined) continue;
      if (!record(values)) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
      for (const [name, version] of Object.entries(values)) {
        if (typeof version !== "string" || name.length === 0 || name.length > 500) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
        dependencies.set(name, version.trim());
      }
    }
    return { status: "PARSED", value: dependencies };
  } catch {
    return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
  }
}

function pomXml(content: string): ParseResult<ParsedDependencies> {
  if (/<!DOCTYPE|<!ENTITY/iu.test(content)) return { status: "DAMAGED", reasonCode: "MANIFEST_XML_UNSAFE" };
  const dependencies = new Map<string, string | undefined>();
  const blocks = content.match(/<dependency\b[^>]*>[\s\S]*?<\/dependency>/giu) ?? [];
  for (const block of blocks) {
    const group = block.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/iu)?.[1];
    const artifact = block.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/iu)?.[1];
    const version = block.match(/<version>\s*([^<]+?)\s*<\/version>/iu)?.[1];
    if (group === undefined || artifact === undefined) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
    dependencies.set(`${group.trim()}:${artifact.trim()}`, version?.trim());
  }
  if (blocks.length === 0 && /<dependency\b/iu.test(content)) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
  return { status: "PARSED", value: dependencies };
}

function gradle(content: string): ParseResult<ParsedDependencies> {
  const dependencies = new Map<string, string | undefined>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.replace(/\/\/.*$/u, "").trim();
    if (trimmed.length === 0) continue;
    const match = trimmed.match(/^(?:api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*(?:\(\s*)?["']([^"']+)["']\s*\)?/u);
    if (match === null) continue;
    const parts = match[1]!.split(":");
    if (parts.length < 2) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
    dependencies.set(`${parts[0]}:${parts[1]}`, parts.length > 2 ? parts.slice(2).join(":") : undefined);
  }
  return { status: "PARSED", value: dependencies };
}

function cargoToml(content: string): ParseResult<ParsedDependencies> {
  const dependencies = new Map<string, string | undefined>();
  let dependencySection = false;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, "").trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      dependencySection = /^\[(?:dev-|build-)?dependencies(?:\.[^\]]+)?\]$/u.test(line);
      continue;
    }
    if (!dependencySection || line.length === 0) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u);
    if (match === null) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
    const value = match[2]!.trim();
    const direct = value.match(/^["']([^"']+)["']$/u)?.[1];
    const inline = value.match(/^\{[\s\S]*?\bversion\s*=\s*["']([^"']+)["'][\s\S]*\}$/u)?.[1];
    dependencies.set(match[1]!, direct ?? inline);
  }
  return { status: "PARSED", value: dependencies };
}

function goMod(content: string): ParseResult<ParsedDependencies> {
  const dependencies = new Map<string, string | undefined>();
  let block = false;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.replace(/\/\/.*$/u, "").trim();
    if (line === "require (") { block = true; continue; }
    if (block && line === ")") { block = false; continue; }
    const candidate = block ? line : line.startsWith("require ") ? line.slice(8).trim() : "";
    if (candidate.length === 0) continue;
    const parts = candidate.split(/\s+/u);
    if (parts.length !== 2) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
    dependencies.set(parts[0]!, parts[1]);
  }
  if (block) return { status: "DAMAGED", reasonCode: "MANIFEST_PARSE_FAILED" };
  return { status: "PARSED", value: dependencies };
}

function parseManifest(file: RepositoryFile): ParseResult<ParsedDependencies> {
  const name = file.path.split("/").at(-1)?.toLowerCase();
  if (name === "package.json") return packageJson(file.content);
  if (name === "pom.xml") return pomXml(file.content);
  if (name === "build.gradle" || name === "build.gradle.kts") return gradle(file.content);
  if (name === "cargo.toml") return cargoToml(file.content);
  if (name === "go.mod") return goMod(file.content);
  return { status: "UNSUPPORTED", reasonCode: "MANIFEST_FORMAT_UNSUPPORTED" };
}

function versionDecision(actual: string | undefined, expected: string): "SUPPORTED" | "REFUTED" | "UNKNOWN" {
  if (actual === undefined) return "UNKNOWN";
  const left = actual.trim();
  const right = expected.trim();
  if (left === right || left === right.replace(/^=\s*/u, "")) return "SUPPORTED";
  return SAFE_VERSION.test(left) && SAFE_VERSION.test(right.replace(/^=\s*/u, "")) ? "REFUTED" : "UNKNOWN";
}

export function createRepositoryDependencyProbe(
  repository: RepositoryReadPort,
  options: DependencyProbeOptions = {},
): VerificationProbe<DependencyAssertion> {
  const defaults = options.defaultManifestPaths ?? DEFAULT_MANIFESTS;
  return Object.freeze({
    observe: async (assertion: DependencyAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const target = `dependency:${assertion.parameters.name}${assertion.parameters.manifestPath === undefined ? "" : `:${assertion.parameters.manifestPath}`}`;
      const paths = assertion.parameters.manifestPath === undefined ? defaults : [assertion.parameters.manifestPath];
      let parsedCount = 0;
      for (const manifestPath of paths) {
        let file: RepositoryFile;
        try { file = await repository.read(manifestPath); }
        catch (error) {
          if (isMissing(error)) continue;
          if (error instanceof RepositoryReadError && ["REPOSITORY_PATH_INVALID", "REPOSITORY_PATH_ESCAPE", "REPOSITORY_FILE_NOT_REGULAR"].includes(error.code)) throw error;
          return observation("UNKNOWN", context, target, `repository:${manifestPath}`, unavailable(error));
        }
        const parsed = parseManifest(file);
        if (parsed.status !== "PARSED") return observation("UNKNOWN", context, target, source(file, "manifest"), parsed.reasonCode);
        parsedCount += 1;
        if (!parsed.value.has(assertion.parameters.name)) continue;
        if (assertion.parameters.versionConstraint === undefined) {
          return observation("SUPPORTED", context, target, source(file, "manifest"), "DEPENDENCY_FOUND", { manifestPath: file.path });
        }
        const decision = versionDecision(parsed.value.get(assertion.parameters.name), assertion.parameters.versionConstraint);
        return observation(decision, context, target, source(file, "manifest"),
          decision === "SUPPORTED" ? "DEPENDENCY_VERSION_MATCHED"
            : decision === "REFUTED" ? "DEPENDENCY_VERSION_MISMATCH" : "DEPENDENCY_VERSION_UNRESOLVED",
          { manifestPath: file.path });
      }
      return observation(parsedCount > 0 ? "REFUTED" : "UNKNOWN", context, target, "repository:manifests",
        parsedCount > 0 ? "DEPENDENCY_NOT_FOUND" : "MANIFEST_NOT_FOUND");
    },
  });
}

function scalar(value: string): string | number | boolean | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if (!/[{}[\]#&*!|>]/u.test(trimmed)) return trimmed;
  return undefined;
}

function setNested(root: Record<string, unknown>, keys: readonly string[], value: unknown): boolean {
  let cursor = root;
  for (const key of keys.slice(0, -1)) {
    const current = cursor[key];
    if (current === undefined) cursor[key] = {};
    else if (!record(current)) return false;
    cursor = cursor[key] as Record<string, unknown>;
  }
  const last = keys.at(-1);
  if (last === undefined || Object.hasOwn(cursor, last)) return false;
  cursor[last] = value;
  return true;
}

function yaml(content: string): ParseResult<Record<string, unknown>> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; keys: string[] }> = [{ indent: -1, keys: [] }];
  for (const raw of content.split(/\r?\n/u)) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) continue;
    if (/\t/u.test(raw) || /^\s*[-?!]/u.test(raw)) return { status: "UNSUPPORTED", reasonCode: "CONFIG_YAML_UNSUPPORTED" };
    const indent = raw.length - raw.trimStart().length;
    const match = raw.trim().match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/u);
    if (match === null) return { status: "DAMAGED", reasonCode: "CONFIG_PARSE_FAILED" };
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!;
    const keys = [...parent.keys, match[1]!];
    const rawValue = match[2] ?? "";
    if (rawValue.length === 0) { stack.push({ indent, keys }); continue; }
    const value = scalar(rawValue);
    if (value === undefined || !setNested(root, keys, value)) return { status: "UNSUPPORTED", reasonCode: "CONFIG_YAML_UNSUPPORTED" };
  }
  return { status: "PARSED", value: root };
}

function stripHashComment(line: string): string | undefined {
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && quote === "\"") { index += 1; continue; }
    if (character === "'" || character === "\"") {
      quote = quote === character ? undefined : quote === undefined ? character : quote;
      continue;
    }
    if (character === "#" && quote === undefined) return line.slice(0, index);
  }
  return quote === undefined ? line : undefined;
}

function toml(content: string): ParseResult<Record<string, unknown>> {
  const root: Record<string, unknown> = {};
  let section: string[] = [];
  for (const raw of content.split(/\r?\n/u)) {
    const uncommented = stripHashComment(raw);
    if (uncommented === undefined) return { status: "DAMAGED", reasonCode: "CONFIG_PARSE_FAILED" };
    const line = uncommented.trim();
    if (line.length === 0) continue;
    const header = line.match(/^\[([A-Za-z0-9_.-]+)\]$/u);
    if (header !== null) { section = header[1]!.split("."); continue; }
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u);
    if (pair === null) return { status: "UNSUPPORTED", reasonCode: "CONFIG_TOML_UNSUPPORTED" };
    const value = scalar(pair[2]!);
    if (value === undefined || !setNested(root, [...section, ...pair[1]!.split(".")], value)) {
      return { status: "UNSUPPORTED", reasonCode: "CONFIG_TOML_UNSUPPORTED" };
    }
  }
  return { status: "PARSED", value: root };
}

function properties(content: string): ParseResult<Record<string, unknown>> {
  const root: Record<string, unknown> = {};
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.includes("\\")) return { status: "UNSUPPORTED", reasonCode: "CONFIG_PROPERTIES_UNSUPPORTED" };
    const separator = line.search(/[=:]/u);
    if (separator < 1) return { status: "DAMAGED", reasonCode: "CONFIG_PARSE_FAILED" };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!setNested(root, key.split("."), value)) return { status: "DAMAGED", reasonCode: "CONFIG_PARSE_FAILED" };
  }
  return { status: "PARSED", value: root };
}

function parseConfig(file: RepositoryFile): ParseResult<Record<string, unknown>> {
  const name = file.path.toLowerCase();
  if (name.endsWith(".json")) {
    try {
      const parsed = JSON.parse(file.content) as unknown;
      return record(parsed) ? { status: "PARSED", value: parsed } : { status: "DAMAGED", reasonCode: "CONFIG_PARSE_FAILED" };
    } catch { return { status: "DAMAGED", reasonCode: "CONFIG_PARSE_FAILED" }; }
  }
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return yaml(file.content);
  if (name.endsWith(".toml")) return toml(file.content);
  if (name.endsWith(".properties")) return properties(file.content);
  return { status: "UNSUPPORTED", reasonCode: "CONFIG_FORMAT_UNSUPPORTED" };
}

function lookup(root: Record<string, unknown>, key: string, maxDepth: number): { readonly found: boolean; readonly value?: unknown } {
  const parts = key.split(".");
  if (parts.length > maxDepth || parts.some((part) => part.length === 0)) return { found: false };
  let cursor: unknown = root;
  for (const part of parts) {
    if (!record(cursor) || !Object.hasOwn(cursor, part)) return { found: false };
    cursor = cursor[part];
  }
  return { found: true, value: cursor };
}

function canonicalScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean" || value === null) return JSON.stringify(value);
  return undefined;
}

export function createRepositoryConfigurationProbe(
  repository: RepositoryReadPort,
  options: ConfigurationProbeOptions = {},
): VerificationProbe<ConfigAssertion> {
  const defaults = options.defaultConfigPaths ?? DEFAULT_CONFIGS;
  const maxDepth = options.maxKeyDepth ?? 16;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) throw new Error("CONFIG_KEY_DEPTH_INVALID");
  return Object.freeze({
    observe: async (assertion: ConfigAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const target = `config:${assertion.parameters.key}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`;
      const paths = assertion.parameters.path === undefined ? defaults : [assertion.parameters.path];
      let parsedCount = 0;
      for (const configPath of paths) {
        let file: RepositoryFile;
        try { file = await repository.read(configPath); }
        catch (error) {
          if (isMissing(error)) continue;
          if (error instanceof RepositoryReadError && ["REPOSITORY_PATH_INVALID", "REPOSITORY_PATH_ESCAPE", "REPOSITORY_FILE_NOT_REGULAR"].includes(error.code)) throw error;
          return observation("UNKNOWN", context, target, `repository:${configPath}`, unavailable(error));
        }
        const parsed = parseConfig(file);
        if (parsed.status !== "PARSED") return observation("UNKNOWN", context, target, source(file, "config"), parsed.reasonCode);
        parsedCount += 1;
        const found = lookup(parsed.value, assertion.parameters.key, maxDepth);
        if (!found.found) continue;
        const actual = canonicalScalar(found.value);
        if (actual === undefined) return observation("UNKNOWN", context, target, source(file, "config"), "CONFIG_VALUE_NON_SCALAR");
        const matched = actual === assertion.parameters.expected;
        return observation(matched ? "SUPPORTED" : "REFUTED", context, target, source(file, "config"),
          matched ? "CONFIG_VALUE_MATCHED" : "CONFIG_VALUE_MISMATCH", { configPath: file.path });
      }
      return observation(parsedCount > 0 ? "REFUTED" : "UNKNOWN", context, target, "repository:configurations",
        parsedCount > 0 ? "CONFIG_KEY_NOT_FOUND" : "CONFIG_FILE_NOT_FOUND");
    },
  });
}
