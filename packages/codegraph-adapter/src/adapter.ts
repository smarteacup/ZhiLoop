import { createHash } from "node:crypto";

import type {
  CodeCallPathFact,
  CodeFactResult,
  CodeIntelligenceCapability,
  CodeIntelligencePort,
  CodeProjectSnapshot,
  CodeRelationshipFact,
  CodeSymbolFact,
  CodeSymbolQuery,
} from "@zhiloop/code-intelligence";

import { NodeCodeGraphProcess, type CodeGraphProcessPort, type CodeGraphProcessResult } from "./process.js";

const MAX_LIMIT = 100;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_TRACE_DEPTH = 32;
const MAX_TRACE_VISITS = 100;

interface AdapterOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly cacheEntries?: number;
  readonly capabilityTtlMs?: number;
  readonly clock?: () => number;
}

interface CachedCapability {
  readonly expiresAt: number;
  readonly value: CodeIntelligenceCapability;
}

function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function unavailable(reasonCode = "CODEGRAPH_UNAVAILABLE"): CodeIntelligenceCapability {
  return frozen({ provider: "CODEGRAPH", status: "UNAVAILABLE", reasonCode });
}

function validText(value: unknown, max = 1_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/u.test(value);
}

function assertProject(project: CodeProjectSnapshot): void {
  if (!validText(project.projectRoot, 4_096) || !validText(project.projectFingerprint, 512)) {
    throw new Error("CODE_INTELLIGENCE_PROJECT_INVALID");
  }
}

function limit(value: number | undefined): number {
  const selected = value ?? 20;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_LIMIT) throw new Error("CODE_INTELLIGENCE_LIMIT_INVALID");
  return selected;
}

function parseJson(output: string): unknown {
  if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) throw new Error("CODEGRAPH_RESPONSE_INVALID");
  return JSON.parse(output) as unknown;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function statusRevision(status: Record<string, unknown>): { readonly revision: string; readonly pending: number } {
  const nodeKinds = status["nodesByKind"] as Record<string, unknown> | undefined;
  const languages = status["languages"];
  const pending = status["pendingChanges"] as Record<string, unknown> | undefined;
  if (!nonNegativeInteger(status["fileCount"]) || !nonNegativeInteger(status["nodeCount"])
    || !nonNegativeInteger(status["edgeCount"]) || !nonNegativeInteger(status["dbSizeBytes"])
    || !validText(status["backend"], 100) || nodeKinds === undefined || nodeKinds === null
    || typeof nodeKinds !== "object" || Array.isArray(nodeKinds)
    || !Object.entries(nodeKinds).every(([key, value]) => /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u.test(key) && nonNegativeInteger(value))
    || !Array.isArray(languages) || !languages.every((value) => validText(value, 100))
    || (pending !== undefined && (pending === null || typeof pending !== "object" || Array.isArray(pending)
      || !["added", "modified", "removed"].every((key) => nonNegativeInteger(pending[key]))))) {
    throw new Error("CODEGRAPH_STATUS_INVALID");
  }
  const normalized = {
    fileCount: status["fileCount"], nodeCount: status["nodeCount"], edgeCount: status["edgeCount"],
    dbSizeBytes: status["dbSizeBytes"], backend: status["backend"],
    languages: [...languages].sort(), nodesByKind: nodeKinds,
    pendingChanges: pending ?? { added: 0, modified: 0, removed: 0 },
  };
  const pendingCount = pending === undefined ? 0
    : Number(pending["added"]) + Number(pending["modified"]) + Number(pending["removed"]);
  return { revision: `cg_${createHash("sha256").update(canonical(normalized)).digest("hex")}`, pending: pendingCount };
}

function safePath(value: unknown): value is string {
  return validText(value, 4_096) && !value.startsWith("/") && !value.split(/[\\/]/u).includes("..");
}

function symbolFact(value: unknown): CodeSymbolFact {
  const record = value as Record<string, unknown>;
  const node = (record["node"] ?? record) as Record<string, unknown>;
  if (!validText(node["name"], 512) || !validText(node["qualifiedName"], 1_000)
    || !validText(node["kind"], 100) || !safePath(node["filePath"])
    || !Number.isSafeInteger(node["startLine"]) || (node["startLine"] as number) < 1
    || !Number.isSafeInteger(node["endLine"]) || (node["endLine"] as number) < (node["startLine"] as number)
    || !validText(node["language"], 100) || typeof node["isExported"] !== "boolean") {
    throw new Error("CODEGRAPH_SYMBOL_RESPONSE_INVALID");
  }
  return frozen({
    symbol: node["name"],
    qualifiedName: node["qualifiedName"],
    kind: node["kind"],
    path: node["filePath"],
    startLine: node["startLine"],
    endLine: node["endLine"],
    language: node["language"],
    exported: node["isExported"],
  } as CodeSymbolFact);
}

function relationshipFact(value: unknown): CodeRelationshipFact {
  const record = value as Record<string, unknown>;
  if (!validText(record["name"], 512) || !validText(record["kind"], 100) || !safePath(record["filePath"])
    || !Number.isSafeInteger(record["startLine"]) || (record["startLine"] as number) < 1) {
    throw new Error("CODEGRAPH_RELATION_RESPONSE_INVALID");
  }
  return frozen({ symbol: record["name"], kind: record["kind"], path: record["filePath"], startLine: record["startLine"] } as CodeRelationshipFact);
}

export class CodeGraphCliAdapter implements CodeIntelligencePort {
  readonly #process: CodeGraphProcessPort;
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #cacheEntries: number;
  readonly #capabilityTtlMs: number;
  readonly #clock: () => number;
  readonly #capabilities = new Map<string, CachedCapability>();
  readonly #facts = new Map<string, readonly unknown[]>();

  constructor(processPort: CodeGraphProcessPort = new NodeCodeGraphProcess(), options: AdapterOptions = {}) {
    this.#process = processPort;
    this.#executable = options.executable ?? "codegraph";
    this.#timeoutMs = options.timeoutMs ?? 300;
    this.#cacheEntries = options.cacheEntries ?? 256;
    this.#capabilityTtlMs = options.capabilityTtlMs ?? 5_000;
    this.#clock = options.clock ?? (() => Date.now());
    if (!validText(this.#executable, 4_096) || !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 10 || this.#timeoutMs > 10_000
      || !Number.isSafeInteger(this.#cacheEntries) || this.#cacheEntries < 1 || this.#cacheEntries > 10_000
      || !Number.isSafeInteger(this.#capabilityTtlMs) || this.#capabilityTtlMs < 0 || this.#capabilityTtlMs > 60_000) {
      throw new Error("CODEGRAPH_ADAPTER_OPTIONS_INVALID");
    }
  }

  async #run(projectRoot: string, args: readonly string[], timeoutMs = this.#timeoutMs): Promise<CodeGraphProcessResult> {
    return this.#process.run({
      executable: this.#executable,
      args,
      cwd: projectRoot,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  }

  async capabilities(project: CodeProjectSnapshot, options: { readonly refresh?: boolean } = {}): Promise<CodeIntelligenceCapability> {
    assertProject(project);
    const capabilityKey = JSON.stringify([project.projectRoot, project.projectFingerprint]);
    const cached = this.#capabilities.get(capabilityKey);
    if (options.refresh !== true && cached !== undefined && cached.expiresAt >= this.#clock()) return cached.value;
    let capability: CodeIntelligenceCapability;
    try {
      const versionResult = await this.#run(project.projectRoot, ["--version"]);
      const version = versionResult.stdout.trim();
      if (versionResult.exitCode !== 0 || versionResult.timedOut || versionResult.outputExceeded) {
        capability = unavailable();
      } else if (!/^0\.9\.\d+$/u.test(version)) {
        capability = /^\d+\.\d+\.\d+$/u.test(version)
          ? frozen({ provider: "CODEGRAPH", status: "INCOMPATIBLE", reasonCode: "CODEGRAPH_VERSION_INCOMPATIBLE", providerVersion: version })
          : unavailable();
      } else {
        const statusResult = await this.#run(project.projectRoot, ["status", project.projectRoot, "--json"]);
        if (statusResult.exitCode !== 0 || statusResult.timedOut || statusResult.outputExceeded) capability = unavailable();
        else {
          const status = parseJson(statusResult.stdout) as Record<string, unknown>;
          if (status["initialized"] === false) {
            capability = frozen({ provider: "CODEGRAPH", status: "NOT_CONFIGURED", reasonCode: "CODEGRAPH_NOT_INITIALIZED", providerVersion: version });
          } else if (status["initialized"] === true) {
            const graph = statusRevision(status);
            capability = graph.pending > 0
              ? frozen({ provider: "CODEGRAPH", status: "UNAVAILABLE", reasonCode: "CODEGRAPH_INDEX_STALE",
                providerVersion: version, indexedFiles: status["fileCount"] as number, indexRevision: graph.revision })
              : frozen({
                provider: "CODEGRAPH",
                status: "READY",
                reasonCode: "CODEGRAPH_READY",
                providerVersion: version,
                indexedFiles: status["fileCount"] as number,
                indexRevision: graph.revision,
              });
          } else capability = unavailable("CODEGRAPH_STATUS_INVALID");
        }
      }
    } catch {
      capability = unavailable();
    }
    this.#capabilities.set(capabilityKey, { expiresAt: this.#clock() + this.#capabilityTtlMs, value: capability });
    return capability;
  }

  #cached<T>(key: string): readonly T[] | undefined {
    const value = this.#facts.get(key) as readonly T[] | undefined;
    if (value !== undefined) {
      this.#facts.delete(key);
      this.#facts.set(key, value);
    }
    return value;
  }

  #save(key: string, value: readonly unknown[]): void {
    this.#facts.set(key, value);
    while (this.#facts.size > this.#cacheEntries) this.#facts.delete(this.#facts.keys().next().value as string);
  }

  async findSymbols(project: CodeProjectSnapshot, query: CodeSymbolQuery): Promise<CodeFactResult<CodeSymbolFact>> {
    assertProject(project);
    if (!validText(query.symbol, 512) || (query.path !== undefined && !safePath(query.path))) {
      throw new Error("CODE_INTELLIGENCE_SYMBOL_QUERY_INVALID");
    }
    const max = limit(query.limit);
    const capability = await this.capabilities(project);
    if (capability.status !== "READY") return frozen({ capability, facts: [] });
    const key = JSON.stringify([project.projectRoot, project.projectFingerprint, "query", query.symbol, query.path ?? "", max]);
    const cached = this.#cached<CodeSymbolFact>(key);
    if (cached !== undefined) return frozen({ capability, facts: cached });
    try {
      const result = await this.#run(project.projectRoot, ["query", query.symbol, "-p", project.projectRoot, "-l", String(max), "-j"]);
      if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) return frozen({ capability: unavailable(), facts: [] });
      const payload = parseJson(result.stdout);
      if (!Array.isArray(payload) || payload.length > max) throw new Error("CODEGRAPH_SYMBOL_RESPONSE_INVALID");
      const facts = payload.map(symbolFact)
        .filter((fact) => query.path === undefined || fact.path === query.path)
        .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine);
      this.#save(key, facts);
      return frozen({ capability, facts });
    } catch {
      return frozen({ capability: unavailable("CODEGRAPH_RESPONSE_INVALID"), facts: [] });
    }
  }

  async #relations(
    operation: "callers" | "callees" | "impact",
    project: CodeProjectSnapshot,
    symbol: string,
    requestedLimit?: number,
    deadline?: number,
  ): Promise<CodeFactResult<CodeRelationshipFact>> {
    assertProject(project);
    if (!validText(symbol, 512)) throw new Error("CODE_INTELLIGENCE_RELATION_QUERY_INVALID");
    const max = limit(requestedLimit);
    const capability = await this.capabilities(project);
    if (capability.status !== "READY") return frozen({ capability, facts: [] });
    const key = JSON.stringify([project.projectRoot, project.projectFingerprint, operation, symbol, max]);
    const cached = this.#cached<CodeRelationshipFact>(key);
    if (cached !== undefined) return frozen({ capability, facts: cached });
    try {
      const remaining = deadline === undefined ? this.#timeoutMs : deadline - Date.now();
      if (remaining < 10) return frozen({ capability: unavailable("CODEGRAPH_TRACE_TIMEOUT"), facts: [], bounded: true });
      const result = await this.#run(project.projectRoot, [operation, symbol, "-p", project.projectRoot, "-j"], Math.min(this.#timeoutMs, remaining));
      if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) return frozen({ capability: unavailable(), facts: [] });
      const record = parseJson(result.stdout) as Record<string, unknown>;
      const values = operation === "callers" ? record["callers"] : operation === "callees" ? record["callees"] : record["affected"];
      if (!Array.isArray(values)) throw new Error("CODEGRAPH_RELATION_RESPONSE_INVALID");
      const facts = values.slice(0, max).map(relationshipFact)
        .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine);
      this.#save(key, facts);
      return frozen({ capability, facts, ...(values.length > max ? { bounded: true } : {}) });
    } catch {
      return frozen({ capability: unavailable("CODEGRAPH_RESPONSE_INVALID"), facts: [] });
    }
  }

  callers(project: CodeProjectSnapshot, symbol: string, requestedLimit?: number): Promise<CodeFactResult<CodeRelationshipFact>> {
    return this.#relations("callers", project, symbol, requestedLimit);
  }

  impact(project: CodeProjectSnapshot, symbol: string, requestedLimit?: number): Promise<CodeFactResult<CodeRelationshipFact>> {
    return this.#relations("impact", project, symbol, requestedLimit);
  }

  async trace(
    project: CodeProjectSnapshot,
    from: string,
    to: string,
    requestedDepth = 8,
    requestedLimit?: number,
  ): Promise<CodeFactResult<CodeCallPathFact>> {
    assertProject(project);
    if (!validText(from, 512) || !validText(to, 512)) throw new Error("CODE_INTELLIGENCE_TRACE_QUERY_INVALID");
    if (!Number.isSafeInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > MAX_TRACE_DEPTH) {
      throw new Error("CODE_INTELLIGENCE_TRACE_DEPTH_INVALID");
    }
    const max = limit(requestedLimit);
    const capability = await this.capabilities(project);
    if (capability.status !== "READY") return frozen({ capability, facts: [] });
    const key = JSON.stringify([project.projectRoot, project.projectFingerprint, "trace", from, to, requestedDepth, max]);
    const cached = this.#cached<CodeCallPathFact>(key);
    if (cached !== undefined) return frozen({ capability, facts: cached });
    if (from === to) {
      const facts = frozen([{ from, to, symbols: [from], paths: [] }] as const);
      this.#save(key, facts);
      return frozen({ capability, facts });
    }
    const deadline = Date.now() + this.#timeoutMs;
    const queue: Array<{ readonly symbol: string; readonly symbols: readonly string[]; readonly paths: readonly string[]; readonly depth: number }> = [
      { symbol: from, symbols: [from], paths: [], depth: 0 },
    ];
    const visited = new Set<string>([from]);
    let bounded = false;
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth >= requestedDepth) { bounded = true; continue; }
      if (visited.size > MAX_TRACE_VISITS || Date.now() >= deadline) { bounded = true; break; }
      const next = await this.#relations("callees", project, current.symbol, max, deadline);
      if (next.capability.status !== "READY") return frozen({ capability: next.capability, facts: [], bounded: true });
      if (next.bounded === true) bounded = true;
      for (const fact of next.facts) {
        const symbols = [...current.symbols, fact.symbol];
        const paths = [...current.paths, fact.path];
        if (fact.symbol === to) {
          const facts = frozen([{ from, to, symbols, paths }] as const);
          this.#save(key, facts);
          return frozen({ capability, facts });
        }
        if (!visited.has(fact.symbol)) {
          visited.add(fact.symbol);
          if (visited.size <= MAX_TRACE_VISITS) queue.push({ symbol: fact.symbol, symbols, paths, depth: current.depth + 1 });
          else bounded = true;
        }
      }
    }
    return bounded
      ? frozen({ capability: unavailable("CODEGRAPH_TRACE_BOUNDED"), facts: [], bounded: true })
      : frozen({ capability, facts: [] });
  }
}
