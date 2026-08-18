import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_CONSOLE_CONFIGURATION, consoleConfigurationSchema, migrateConsoleConfiguration, type ConsoleConfiguration } from "./schema.js";
import type {
  ConfigurationDiagnostic,
  ConfigurationAuditEntry,
  ConfigurationDraft,
  ConfigurationFieldSource,
  ConfigurationHistoryEntry,
  ConfigurationMutationResult,
  ConfigurationScope,
  ConfigurationServiceOptions,
  ConfigurationValidationResult,
  ConfigurationView,
  ConsumerCapability,
} from "./types.js";

const FUTURE_CAPABILITIES = Object.freeze({
  "future.injectionMaxTokens": "knowledge.retrieval",
  "future.compilerBatchSize": "knowledge.compile",
  "future.codexQueryTimeoutMs": "codex.query",
  "future.codexQueryConcurrency": "codex.query",
  "compilation.mode": "knowledge.auto-publication",
  "compilation.publication.enabled": "knowledge.auto-publication",
  "compilation.publication.allowedKindsCsv": "knowledge.auto-publication",
  "compilation.publication.allowedProjectIdsCsv": "knowledge.auto-publication",
  "compilation.publication.requireFreshCodeEvidence": "knowledge.auto-publication",
  "compilation.publication.goldenDatasetId": "knowledge.auto-publication",
  "compilation.publication.goldenDatasetVersion": "knowledge.auto-publication",
  "compilation.publication.goldenConfigFingerprint": "knowledge.auto-publication",
} as const);
const RESTART_PATHS = new Set([
  "runtime.workerPollIntervalMs",
  "runtime.workerConcurrency",
  "future.injectionMaxTokens",
  "future.compilerBatchSize",
  "future.codexQueryTimeoutMs",
  "future.codexQueryConcurrency",
  "evolution.maxMatchCandidates",
  "evolution.semanticJudgeEnabled",
  "codeIntelligence.provider",
  "codeIntelligence.initializeAutomatically",
  "codeIntelligence.queryTimeoutMs",
  "codeIntelligence.circuitBreakerFailures",
  "codeIntelligence.circuitBreakerResetMs",
]);

interface RevisionRow {
  readonly revision: number;
  readonly base_revision: number;
  readonly status: ConfigurationHistoryEntry["status"];
  readonly hash: string;
  readonly scope: ConfigurationScope;
  readonly project_id: string | null;
  readonly configuration_json: string;
  readonly changed_paths_json: string;
  readonly requires_restart: number;
  readonly created_at: string;
  readonly reason_code: string;
}

interface DraftRow {
  readonly draft_revision: number;
  readonly base_revision: number;
  readonly scope: ConfigurationScope;
  readonly project_id: string | null;
  readonly configuration_json: string;
  readonly changed_paths_json: string;
  readonly requires_restart: number;
  readonly activatable: number;
  readonly diagnostics_json: string;
}

function hash(configuration: ConsoleConfiguration): string {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (record(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value) as T;
  }
  return value;
}

function merge(base: unknown, patch: unknown): unknown {
  if (!record(base) || !record(patch)) return patch;
  return Object.fromEntries(Object.keys({ ...base, ...patch }).map((key) => [
    key,
    key in patch ? merge(base[key], patch[key]) : base[key],
  ]));
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (!record(value)) return prefix.length === 0 ? [] : [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`));
}

function changedPaths(left: unknown, right: unknown, prefix = ""): string[] {
  if (!record(left) || !record(right)) return JSON.stringify(left) === JSON.stringify(right) || prefix.length === 0 ? [] : [prefix];
  return [...new Set(Object.keys({ ...left, ...right }).flatMap((key) => changedPaths(
    left[key],
    right[key],
    prefix.length === 0 ? key : `${prefix}.${key}`,
  )))].sort();
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => record(current) ? current[key] : undefined, value);
}

function overlayPaths(base: ConsoleConfiguration, override: ConsoleConfiguration, paths: readonly string[]): ConsoleConfiguration {
  const output = structuredClone(base) as unknown as Record<string, unknown>;
  for (const path of paths) {
    const segments = path.split(".");
    let parent = output;
    for (const segment of segments.slice(0, -1)) {
      const child = parent[segment];
      if (!record(child)) throw new Error(`invalid configuration path: ${path}`);
      parent = child;
    }
    parent[segments.at(-1) as string] = valueAtPath(override, path);
  }
  return deepFreeze(consoleConfigurationSchema.parse(output));
}

function timestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("configuration clock returned an invalid date");
  return value.toISOString();
}

function safeProjectId(scope: ConfigurationScope, projectId: string | undefined): string | undefined {
  if (scope === "GLOBAL") {
    if (projectId !== undefined) throw new Error("GLOBAL configuration must not name a project");
    return undefined;
  }
  if (projectId === undefined || !/^[A-Za-z0-9._:-]{1,200}$/u.test(projectId)) throw new Error("PROJECT configuration requires a safe project id");
  return projectId;
}

function diagnostic(code: ConfigurationDiagnostic["code"], retryable: boolean, path?: string): ConfigurationDiagnostic {
  return Object.freeze({ code, retryable, ...(path === undefined ? {} : { path }) });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class SqliteConfigurationService {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  readonly #capabilities: () => Readonly<Record<string, ConsumerCapability>>;
  readonly #components: ConfigurationServiceOptions["components"];
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(filename: string, options: ConfigurationServiceOptions = {}) {
    this.#database = new DatabaseSync(filename);
    this.#clock = options.clock ?? (() => new Date());
    this.#capabilities = options.capabilities ?? (() => ({}));
    this.#components = Object.freeze([...(options.components ?? [])]);
    if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
    this.#database.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS configuration_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        current_revision INTEGER NOT NULL CHECK(current_revision >= 0)
      );
      CREATE TABLE IF NOT EXISTS configuration_revisions (
        revision INTEGER PRIMARY KEY,
        base_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('EFFECTIVE','REJECTED','ROLLED_BACK')),
        hash TEXT NOT NULL CHECK(length(hash) = 64),
        scope TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT')),
        project_id TEXT,
        configuration_json TEXT NOT NULL,
        changed_paths_json TEXT NOT NULL,
        requires_restart INTEGER NOT NULL CHECK(requires_restart IN (0,1)),
        created_at TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        CHECK((scope = 'GLOBAL' AND project_id IS NULL) OR (scope = 'PROJECT' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS configuration_revisions_scope_idx
        ON configuration_revisions(scope, project_id, revision DESC);
      CREATE TABLE IF NOT EXISTS configuration_drafts (
        draft_revision INTEGER PRIMARY KEY AUTOINCREMENT,
        base_revision INTEGER NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT')),
        project_id TEXT,
        configuration_json TEXT NOT NULL,
        changed_paths_json TEXT NOT NULL,
        requires_restart INTEGER NOT NULL CHECK(requires_restart IN (0,1)),
        activatable INTEGER NOT NULL CHECK(activatable IN (0,1)),
        diagnostics_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS configuration_command_receipts (
        idempotency_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS configuration_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        operator_id TEXT NOT NULL,
        component TEXT NOT NULL,
        code TEXT NOT NULL,
        changed_paths_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
    const exists = this.#database.prepare("SELECT current_revision FROM configuration_meta WHERE singleton = 1").get();
    if (exists !== undefined) return;
    const value = DEFAULT_CONSOLE_CONFIGURATION;
    const createdAt = timestamp(this.#clock);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("INSERT INTO configuration_meta(singleton, current_revision) VALUES (1, 0)").run();
      this.#database.prepare(`
        INSERT INTO configuration_revisions(
          revision, base_revision, status, hash, scope, project_id, configuration_json,
          changed_paths_json, requires_restart, created_at, reason_code
        ) VALUES (0, 0, 'EFFECTIVE', ?, 'GLOBAL', NULL, ?, '[]', 0, ?, 'DEFAULT_CONFIGURATION')
      `).run(hash(value), JSON.stringify(value), createdAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("configuration service is closed");
  }

  #currentRevision(): number {
    return (this.#database.prepare("SELECT current_revision AS revision FROM configuration_meta WHERE singleton = 1").get() as { revision: number }).revision;
  }

  #latest(scope: ConfigurationScope, projectId?: string): RevisionRow | undefined {
    return this.#database.prepare(`
      SELECT * FROM configuration_revisions
      WHERE scope = ? AND project_id IS ? AND status IN ('EFFECTIVE','ROLLED_BACK')
      ORDER BY revision DESC LIMIT 1
    `).get(scope, projectId ?? null) as unknown as RevisionRow | undefined;
  }

  get(projectId?: string): ConfigurationView {
    this.#assertOpen();
    const global = this.#latest("GLOBAL");
    if (global === undefined) throw new Error("global configuration is missing");
    const globalConfiguration = deepFreeze(migrateConsoleConfiguration(JSON.parse(global.configuration_json) as unknown));
    const project = projectId === undefined ? undefined : this.#latest("PROJECT", safeProjectId("PROJECT", projectId));
    const projectPaths = project === undefined ? new Set<string>() : new Set(JSON.parse(project.changed_paths_json) as string[]);
    const effective = project === undefined
      ? globalConfiguration
      : overlayPaths(
        globalConfiguration,
        migrateConsoleConfiguration(JSON.parse(project.configuration_json) as unknown),
        [...projectPaths],
      );
    const globalPaths = new Set(JSON.parse(global.changed_paths_json) as string[]);
    const sources = Object.fromEntries(leafPaths(effective).map((path) => [
      path,
      projectPaths.has(path) ? "PROJECT_OVERRIDE" : globalPaths.has(path) ? "GLOBAL" : "DEFAULT",
    ])) as Record<string, ConfigurationFieldSource>;
    return Object.freeze({
      revision: this.#currentRevision(),
      hash: hash(effective),
      effective,
      sources: Object.freeze(sources),
      ...(projectId === undefined ? {} : { projectId }),
    });
  }

  validateDraft(input: {
    readonly baseRevision: number;
    readonly scope: ConfigurationScope;
    readonly projectId?: string;
    readonly draft: unknown;
  }): ConfigurationValidationResult {
    this.#assertOpen();
    const projectId = safeProjectId(input.scope, input.projectId);
    const current = this.get(projectId);
    if (input.baseRevision !== current.revision) return { ok: false, diagnostics: [diagnostic("STALE_REVISION", false)] };
    const parsed = consoleConfigurationSchema.safeParse(merge(current.effective, input.draft));
    if (!parsed.success) {
      return {
        ok: false,
        diagnostics: Object.freeze(parsed.error.issues.slice(0, 50).flatMap((issue) => {
          const paths = issue.code === "unrecognized_keys"
            ? issue.keys.map((key) => [...issue.path, key].join("."))
            : [issue.path.join(".")];
          return paths.map((path) => diagnostic("INVALID_CONFIGURATION", false, path));
        }).slice(0, 50)),
      };
    }
    const paths = input.scope === "PROJECT"
      ? changedPaths(this.get().effective, parsed.data)
      : changedPaths(DEFAULT_CONSOLE_CONFIGURATION, parsed.data);
    const capabilities = this.#capabilities();
    const diagnostics = paths.flatMap((path) => {
      const capabilityId = FUTURE_CAPABILITIES[path as keyof typeof FUTURE_CAPABILITIES];
      return capabilityId !== undefined && capabilities[capabilityId] !== "READY"
        ? [diagnostic("CONSUMER_DISABLED", false, path)]
        : [];
    });
    const requiresRestart = paths.some((path) => RESTART_PATHS.has(path));
    const result = this.#database.prepare(`
      INSERT INTO configuration_drafts(
        base_revision, scope, project_id, configuration_json, changed_paths_json,
        requires_restart, activatable, diagnostics_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.baseRevision,
      input.scope,
      projectId ?? null,
      JSON.stringify(parsed.data),
      JSON.stringify(paths),
      requiresRestart ? 1 : 0,
      diagnostics.length === 0 ? 1 : 0,
      JSON.stringify(diagnostics),
      timestamp(this.#clock),
    );
    const draft: ConfigurationDraft = Object.freeze({
      draftRevision: Number(result.lastInsertRowid),
      baseRevision: input.baseRevision,
      scope: input.scope,
      ...(projectId === undefined ? {} : { projectId }),
      configuration: deepFreeze(parsed.data),
      changedPaths: Object.freeze(paths),
      requiresRestart,
      activatable: diagnostics.length === 0,
      diagnostics: Object.freeze(diagnostics),
    });
    return { ok: true, draft };
  }

  getDraft(revision: number): ConfigurationDraft | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM configuration_drafts WHERE draft_revision = ?").get(revision) as unknown as DraftRow | undefined;
    if (row === undefined) return undefined;
    return Object.freeze({
      draftRevision: row.draft_revision,
      baseRevision: row.base_revision,
      scope: row.scope,
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      configuration: deepFreeze(migrateConsoleConfiguration(JSON.parse(row.configuration_json) as unknown)),
      changedPaths: Object.freeze(JSON.parse(row.changed_paths_json) as string[]),
      requiresRestart: row.requires_restart === 1,
      activatable: row.activatable === 1,
      diagnostics: Object.freeze(JSON.parse(row.diagnostics_json) as ConfigurationDiagnostic[]),
    });
  }

  drafts(limit = 100): readonly ConfigurationDraft[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("draft limit must be within 1..500");
    const rows = this.#database.prepare("SELECT draft_revision FROM configuration_drafts ORDER BY draft_revision DESC LIMIT ?").all(limit) as unknown as Array<{ draft_revision: number }>;
    return Object.freeze(rows.map(({ draft_revision }) => this.getDraft(draft_revision) as ConfigurationDraft));
  }

  async activate(expectedRevision: number, draftRevision: number, idempotencyKey: string, operatorId = "local-console"): Promise<ConfigurationMutationResult> {
    return await this.#serialized(async () => {
      const command = { type: "activate", expectedRevision, draftRevision, idempotencyKey };
      const replay = this.#receipt(idempotencyKey, fingerprint(command));
      if (replay !== undefined) return replay;
      if (expectedRevision !== this.#currentRevision()) return this.#saveReceipt(idempotencyKey, fingerprint(command), { ok: false, diagnostic: diagnostic("STALE_REVISION", false) });
      const draft = this.getDraft(draftRevision);
      if (draft === undefined) return this.#saveReceipt(idempotencyKey, fingerprint(command), { ok: false, diagnostic: diagnostic("NOT_FOUND", false) });
      if (draft.baseRevision !== expectedRevision) return this.#saveReceipt(idempotencyKey, fingerprint(command), { ok: false, diagnostic: diagnostic("STALE_REVISION", false) });
      if (!draft.activatable) return this.#saveReceipt(idempotencyKey, fingerprint(command), { ok: false, diagnostic: diagnostic("CONSUMER_DISABLED", false) });
      if (this.#disabledPaths(draft.changedPaths).length > 0) {
        return this.#saveReceipt(idempotencyKey, fingerprint(command), { ok: false, diagnostic: diagnostic("CONSUMER_DISABLED", false) });
      }
      for (const component of this.#components ?? []) {
        try {
          await component.prepare(draft.configuration);
        } catch {
          const failure: ConfigurationMutationResult = { ok: false, diagnostic: diagnostic("COMPONENT_PREPARE_FAILED", true) };
          this.#commitRevision(draft, "REJECTED", "COMPONENT_PREPARE_FAILED", {
            idempotencyKey, commandFingerprint: fingerprint(command), result: failure,
            audit: { operatorId, component: component.componentId, code: "PREPARE_FAILED" },
          });
          return failure;
        }
      }
      const rollbacks: Array<{ readonly componentId: string; readonly rollback: () => Promise<void> }> = [];
      try {
        for (const component of this.#components ?? []) rollbacks.push({ componentId: component.componentId, rollback: await component.apply(draft.configuration) });
      } catch {
        let rollbackFailed = false;
        for (const entry of rollbacks.reverse()) await entry.rollback().catch(() => { rollbackFailed = true; });
        const code = rollbackFailed ? "COMPONENT_ROLLBACK_FAILED" : "COMPONENT_APPLY_FAILED";
        const failure: ConfigurationMutationResult = { ok: false, diagnostic: diagnostic(code, true) };
        this.#commitRevision(draft, "REJECTED", code, {
          idempotencyKey, commandFingerprint: fingerprint(command), result: failure,
          audit: { operatorId, component: "activation", code },
        });
        return failure;
      }
      let revision: number;
      try {
        const nextRevision = this.#currentRevision() + 1;
        const success: ConfigurationMutationResult = { ok: true, revision: nextRevision, hash: hash(draft.configuration), status: "EFFECTIVE" };
        revision = this.#commitRevision(draft, "EFFECTIVE", "CONFIGURATION_ACTIVATED", {
          idempotencyKey, commandFingerprint: fingerprint(command), result: success,
          audit: { operatorId, component: "activation", code: "ACTIVATED" },
        });
      } catch (error) {
        for (const entry of rollbacks.reverse()) await entry.rollback().catch(() => undefined);
        throw error;
      }
      return { ok: true, revision, hash: hash(draft.configuration), status: "EFFECTIVE" };
    });
  }

  async rollback(expectedRevision: number, targetRevision: number, idempotencyKey: string, operatorId = "local-console"): Promise<ConfigurationMutationResult> {
    return await this.#serialized(async () => {
      const command = { type: "rollback", expectedRevision, targetRevision, idempotencyKey };
      const commandHash = fingerprint(command);
      const replay = this.#receipt(idempotencyKey, commandHash);
      if (replay !== undefined) return replay;
      if (expectedRevision !== this.#currentRevision()) return this.#saveReceipt(idempotencyKey, commandHash, { ok: false, diagnostic: diagnostic("STALE_REVISION", false) });
      const target = this.#database.prepare("SELECT * FROM configuration_revisions WHERE revision = ?").get(targetRevision) as unknown as RevisionRow | undefined;
      if (target === undefined || target.status === "REJECTED") return this.#saveReceipt(idempotencyKey, commandHash, { ok: false, diagnostic: diagnostic("NOT_FOUND", false) });
      const configuration = deepFreeze(consoleConfigurationSchema.parse(JSON.parse(target.configuration_json) as unknown));
      const current = this.get(target.project_id ?? undefined);
      const draft: ConfigurationDraft = {
        draftRevision: 0,
        baseRevision: current.revision,
        scope: target.scope,
        ...(target.project_id === null ? {} : { projectId: target.project_id }),
        configuration,
        changedPaths: target.scope === "PROJECT"
          ? changedPaths(this.get().effective, configuration)
          : changedPaths(DEFAULT_CONSOLE_CONFIGURATION, configuration),
        requiresRestart: target.requires_restart === 1,
        activatable: true,
        diagnostics: [],
      };
      for (const component of this.#components ?? []) {
        try {
          await component.prepare(configuration);
        } catch {
          const failure: ConfigurationMutationResult = { ok: false, diagnostic: diagnostic("COMPONENT_PREPARE_FAILED", true) };
          this.#commitRevision(draft, "REJECTED", "ROLLBACK_COMPONENT_PREPARE_FAILED", {
            idempotencyKey, commandFingerprint: commandHash, result: failure,
            audit: { operatorId, component: component.componentId, code: "ROLLBACK_COMPONENT_PREPARE_FAILED" },
          });
          return failure;
        }
      }
      const rollbacks: Array<{ readonly componentId: string; readonly rollback: () => Promise<void> }> = [];
      try {
        for (const component of this.#components ?? []) rollbacks.push({ componentId: component.componentId, rollback: await component.apply(configuration) });
      } catch {
        let rollbackFailed = false;
        for (const entry of rollbacks.reverse()) await entry.rollback().catch(() => { rollbackFailed = true; });
        const code = rollbackFailed ? "COMPONENT_ROLLBACK_FAILED" : "COMPONENT_APPLY_FAILED";
        const failure: ConfigurationMutationResult = { ok: false, diagnostic: diagnostic(code, true) };
        this.#commitRevision(draft, "REJECTED", `ROLLBACK_${code}`, {
          idempotencyKey, commandFingerprint: commandHash, result: failure,
          audit: { operatorId, component: "rollback", code: `ROLLBACK_${code}` },
        });
        return failure;
      }
      let revision: number;
      try {
        const nextRevision = this.#currentRevision() + 1;
        const success: ConfigurationMutationResult = { ok: true, revision: nextRevision, hash: hash(configuration), status: "ROLLED_BACK" };
        revision = this.#commitRevision(draft, "ROLLED_BACK", `ROLLBACK_TO_${targetRevision}`, {
          idempotencyKey, commandFingerprint: commandHash, result: success,
          audit: { operatorId, component: "rollback", code: `ROLLBACK_TO_${targetRevision}` },
        });
      } catch (error) {
        for (const entry of rollbacks.reverse()) await entry.rollback().catch(() => undefined);
        throw error;
      }
      return { ok: true, revision, hash: hash(configuration), status: "ROLLED_BACK" };
    });
  }

  #commitRevision(
    draft: ConfigurationDraft,
    status: "EFFECTIVE" | "REJECTED" | "ROLLED_BACK",
    reasonCode: string,
    receipt?: {
      readonly idempotencyKey: string;
      readonly commandFingerprint: string;
      readonly result: ConfigurationMutationResult;
      readonly audit: { readonly operatorId: string; readonly component: string; readonly code: string };
    },
  ): number {
    const revision = this.#currentRevision() + 1;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO configuration_revisions(
          revision, base_revision, status, hash, scope, project_id, configuration_json,
          changed_paths_json, requires_restart, created_at, reason_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revision, draft.baseRevision, status, hash(draft.configuration), draft.scope, draft.projectId ?? null,
        JSON.stringify(draft.configuration), JSON.stringify(draft.changedPaths), draft.requiresRestart ? 1 : 0,
        timestamp(this.#clock), reasonCode,
      );
      this.#database.prepare("UPDATE configuration_meta SET current_revision = ? WHERE singleton = 1").run(revision);
      if (receipt !== undefined) {
        this.#insertReceipt(receipt.idempotencyKey, receipt.commandFingerprint, receipt.result);
        this.#insertAudit(revision, receipt.audit.operatorId, receipt.audit.component, receipt.audit.code, draft.changedPaths);
      }
      this.#database.exec("COMMIT");
      return revision;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  history(limit = 100): readonly ConfigurationHistoryEntry[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("history limit must be within 1..500");
    const rows = this.#database.prepare("SELECT * FROM configuration_revisions ORDER BY revision DESC LIMIT ?").all(limit) as unknown as RevisionRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      revision: row.revision,
      baseRevision: row.base_revision,
      status: row.status,
      hash: row.hash,
      scope: row.scope,
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      changedPaths: Object.freeze(JSON.parse(row.changed_paths_json) as string[]),
      requiresRestart: row.requires_restart === 1,
      createdAt: row.created_at,
      reasonCode: row.reason_code,
    })));
  }

  audit(limit = 100): readonly ConfigurationAuditEntry[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("audit limit must be within 1..500");
    const rows = this.#database.prepare("SELECT * FROM configuration_audit ORDER BY sequence DESC LIMIT ?").all(limit) as unknown as Array<{
      sequence: number; revision: number; operator_id: string; component: string; code: string; changed_paths_json: string; observed_at: string;
    }>;
    return Object.freeze(rows.map((row) => Object.freeze({
      sequence: row.sequence,
      revision: row.revision,
      operatorId: row.operator_id,
      component: row.component,
      code: row.code,
      changedPaths: Object.freeze(JSON.parse(row.changed_paths_json) as string[]),
      observedAt: row.observed_at,
    })));
  }

  #insertAudit(revision: number, operatorId: string, component: string, code: string, paths: readonly string[]): void {
    this.#database.prepare("INSERT INTO configuration_audit(revision, operator_id, component, code, changed_paths_json, observed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(revision, operatorId.slice(0, 200), component.slice(0, 200), code.slice(0, 200), JSON.stringify(paths), timestamp(this.#clock));
  }

  #disabledPaths(paths: readonly string[]): readonly string[] {
    const capabilities = this.#capabilities();
    return paths.filter((path) => {
      const capabilityId = FUTURE_CAPABILITIES[path as keyof typeof FUTURE_CAPABILITIES];
      return capabilityId !== undefined && capabilities[capabilityId] !== "READY";
    });
  }

  #receipt(idempotencyKey: string, expectedFingerprint: string): ConfigurationMutationResult | undefined {
    const row = this.#database.prepare("SELECT fingerprint, result_json FROM configuration_command_receipts WHERE idempotency_key = ?")
      .get(idempotencyKey) as { fingerprint: string; result_json: string } | undefined;
    if (row === undefined) return undefined;
    if (row.fingerprint !== expectedFingerprint) return { ok: false, diagnostic: diagnostic("CONFLICT", false) };
    return JSON.parse(row.result_json) as ConfigurationMutationResult;
  }

  #saveReceipt(idempotencyKey: string, commandFingerprint: string, result: ConfigurationMutationResult): ConfigurationMutationResult {
    this.#insertReceipt(idempotencyKey, commandFingerprint, result);
    return result;
  }

  #insertReceipt(idempotencyKey: string, commandFingerprint: string, result: ConfigurationMutationResult): void {
    if (!/^[A-Za-z0-9._:-]{16,200}$/u.test(idempotencyKey)) throw new Error("invalid configuration idempotency key");
    this.#database.prepare(`
      INSERT INTO configuration_command_receipts(idempotency_key, fingerprint, result_json) VALUES (?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(idempotencyKey, commandFingerprint, JSON.stringify(result));
  }

  async #serialized(operation: () => Promise<ConfigurationMutationResult>): Promise<ConfigurationMutationResult> {
    this.#assertOpen();
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return await result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#tail;
    this.#database.close();
    this.#closed = true;
  }
}
