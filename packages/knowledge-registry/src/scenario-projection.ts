import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { deriveScenarioId, type ScenarioDefinition } from "@zhiloop/domain";

import type {
  ProjectedScenario,
  ScenarioProjectionRebuildResult,
  ScenarioProjectionWriteResult,
} from "./types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function validText(value: string, maximum = 4_096): boolean {
  return value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDefinition(value: ScenarioDefinition): void {
  const arrays = [value.taskIntents, value.entryPoints, value.applicability, value.nonApplicability, value.aliases];
  if (value.schemaVersion !== 1 || value.scenarioId !== deriveScenarioId(value.projectId, value.scenarioKey)
    || !Number.isSafeInteger(value.version) || value.version < 1 || !validText(value.title, 500)
    || !validText(value.summary) || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt)) || value.sourceKnowledgeVersions.length > 10_000
    || value.relations.length > 1_000 || arrays.some((items) => items.length > 100
      || new Set(items).size !== items.length || items.some((item) => !validText(item)))) {
    throw new Error("SCENARIO_DEFINITION_INVALID");
  }
  if (new Set(value.sourceKnowledgeVersions).size !== value.sourceKnowledgeVersions.length
    || value.sourceKnowledgeVersions.some((item) => !validText(item, 1_000))
    || value.relations.some((item) => !validText(item.targetScenarioId, 1_000) || item.reasonCodes.length > 100
      || item.reasonCodes.some((reason) => !/^[A-Z][A-Z0-9_]{0,99}$/u.test(reason)))) {
    throw new Error("SCENARIO_BINDING_INVALID");
  }
}

function parse(payload: string, expectedHash?: string): ScenarioDefinition {
  if (expectedHash !== undefined && hash(payload) !== expectedHash) throw new Error("SCENARIO_PROJECTION_CORRUPT");
  const value = JSON.parse(payload) as ScenarioDefinition;
  assertDefinition(value);
  return Object.freeze(value);
}

export class SqliteScenarioRegistryProjection {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    const resolved = filename === ":memory:" ? filename : path.resolve(filename);
    if (filename !== ":memory:") mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(resolved);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(resolved, 0o600);
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode=WAL;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS scenario_projection_meta (
          component TEXT PRIMARY KEY,
          migration_version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scenarios (
          scenario_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          scenario_key TEXT NOT NULL,
          current_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          UNIQUE(project_id, scenario_key)
        );
        CREATE TABLE IF NOT EXISTS scenario_versions (
          scenario_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          PRIMARY KEY(scenario_id, version)
        );
        CREATE TABLE IF NOT EXISTS scenario_bindings (
          scenario_id TEXT NOT NULL,
          scenario_version INTEGER NOT NULL,
          knowledge_version TEXT NOT NULL,
          PRIMARY KEY(scenario_id, scenario_version, knowledge_version),
          FOREIGN KEY(scenario_id, scenario_version) REFERENCES scenario_versions(scenario_id, version) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS scenario_binding_knowledge_idx ON scenario_bindings(knowledge_version);
        CREATE TABLE IF NOT EXISTS scenario_relations (
          scenario_id TEXT NOT NULL,
          scenario_version INTEGER NOT NULL,
          ordinal INTEGER NOT NULL,
          relation_type TEXT NOT NULL,
          target_scenario_id TEXT NOT NULL,
          reason_codes_json TEXT NOT NULL,
          PRIMARY KEY(scenario_id, scenario_version, ordinal),
          FOREIGN KEY(scenario_id, scenario_version) REFERENCES scenario_versions(scenario_id, version) ON DELETE CASCADE
        );
      `);
      this.#migrate();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  #migrate(): void {
    const current = this.#database.prepare(
      "SELECT migration_version FROM scenario_projection_meta WHERE component='scenario-registry'",
    ).get() as { migration_version: number } | undefined;
    if (current !== undefined && current.migration_version > 2) {
      throw new Error("SCENARIO_PROJECTION_VERSION_UNSUPPORTED");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (current === undefined || current.migration_version < 2) {
        const migrateTable = (table: "scenarios" | "scenario_versions"): void => {
          const rows = this.#database.prepare(`SELECT rowid, payload_json FROM ${table}`).all() as unknown as
            readonly { rowid: number; payload_json: string }[];
          const update = this.#database.prepare(`UPDATE ${table} SET payload_json=?, payload_hash=? WHERE rowid=?`);
          for (const row of rows) {
            const payload = canonical(parse(row.payload_json));
            update.run(payload, hash(payload), row.rowid);
          }
        };
        migrateTable("scenario_versions");
        migrateTable("scenarios");
      }
      this.#database.prepare(`
        INSERT INTO scenario_projection_meta(component, migration_version) VALUES ('scenario-registry', 2)
        ON CONFLICT(component) DO UPDATE SET migration_version=excluded.migration_version
      `).run();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("scenario projection is closed");
  }

  #write(definition: ScenarioDefinition): ScenarioProjectionWriteResult {
    assertDefinition(definition);
    const payload = canonical(definition);
    const payloadHash = hash(payload);
    const current = this.#database.prepare(
      "SELECT current_version, payload_hash FROM scenarios WHERE scenario_id=?",
    ).get(definition.scenarioId) as { current_version: number; payload_hash: string } | undefined;
    if (current !== undefined && current.current_version === definition.version) {
      if (current.payload_hash !== payloadHash) throw new Error("SCENARIO_VERSION_COLLISION");
      return { status: "IDEMPOTENT", scenarioId: definition.scenarioId, version: definition.version };
    }
    if ((current === undefined && definition.version !== 1)
      || (current !== undefined && definition.version !== current.current_version + 1)) {
      throw new Error("SCENARIO_VERSION_NON_MONOTONIC");
    }
    this.#database.prepare(
      "INSERT INTO scenario_versions(scenario_id, version, payload_json, payload_hash) VALUES (?, ?, ?, ?)",
    ).run(definition.scenarioId, definition.version, payload, payloadHash);
    this.#database.prepare(`
      INSERT INTO scenarios(scenario_id, project_id, scenario_key, current_version, payload_json, payload_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scenario_id) DO UPDATE SET current_version=excluded.current_version,
        payload_json=excluded.payload_json, payload_hash=excluded.payload_hash
    `).run(definition.scenarioId, definition.projectId, definition.scenarioKey, definition.version, payload, payloadHash);
    const binding = this.#database.prepare(
      "INSERT INTO scenario_bindings(scenario_id, scenario_version, knowledge_version) VALUES (?, ?, ?)",
    );
    for (const knowledge of [...definition.sourceKnowledgeVersions].sort()) {
      binding.run(definition.scenarioId, definition.version, knowledge);
    }
    const relation = this.#database.prepare(`
      INSERT INTO scenario_relations(scenario_id, scenario_version, ordinal, relation_type, target_scenario_id, reason_codes_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    definition.relations.forEach((item, index) => relation.run(
      definition.scenarioId, definition.version, index, item.type, item.targetScenarioId, canonical(item.reasonCodes),
    ));
    return { status: "PROJECTED", scenarioId: definition.scenarioId, version: definition.version };
  }

  project(definition: ScenarioDefinition): ScenarioProjectionWriteResult {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#write(definition);
      this.#database.exec("COMMIT");
      return Object.freeze(result);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  get(scenarioId: string, version?: number): ProjectedScenario | undefined {
    this.#assertOpen();
    if (!validText(scenarioId, 1_000)) return undefined;
    const row = version === undefined
      ? this.#database.prepare("SELECT payload_json, payload_hash FROM scenarios WHERE scenario_id=?").get(scenarioId)
      : this.#database.prepare("SELECT payload_json, payload_hash FROM scenario_versions WHERE scenario_id=? AND version=?").get(scenarioId, version);
    if (row === undefined) return undefined;
    const typed = row as { payload_json: string; payload_hash: string };
    const definition = parse(typed.payload_json, typed.payload_hash);
    return Object.freeze({ definition, knowledgeVersions: Object.freeze([...definition.sourceKnowledgeVersions]) });
  }

  list(projectId: string, limit = 100): readonly ProjectedScenario[] {
    this.#assertOpen();
    if (!validText(projectId, 500) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) return [];
    const rows = this.#database.prepare(
      "SELECT payload_json, payload_hash FROM scenarios WHERE project_id=? ORDER BY scenario_key LIMIT ?",
    ).all(projectId, limit) as Array<{ payload_json: string; payload_hash: string }>;
    return Object.freeze(rows.map((row) => {
      const definition = parse(row.payload_json, row.payload_hash);
      return Object.freeze({ definition, knowledgeVersions: Object.freeze([...definition.sourceKnowledgeVersions]) });
    }));
  }

  rebuild(definitions: readonly ScenarioDefinition[]): ScenarioProjectionRebuildResult {
    this.#assertOpen();
    const stable = [...definitions].sort((left, right) => left.scenarioId.localeCompare(right.scenarioId) || left.version - right.version);
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      this.#database.exec("DELETE FROM scenario_relations; DELETE FROM scenario_bindings; DELETE FROM scenarios; DELETE FROM scenario_versions;");
      for (const definition of stable) this.#write(definition);
      const count = (table: string): number => (this.#database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value;
      const result = { scenarios: count("scenarios"), versions: count("scenario_versions"),
        bindings: count("scenario_bindings"), relations: count("scenario_relations") };
      this.#database.exec("COMMIT");
      return Object.freeze(result);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  rollbackCurrent(scenarioId: string, expectedVersion: number): ProjectedScenario {
    this.#assertOpen();
    if (!validText(scenarioId, 1_000) || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 1) {
      throw new Error("SCENARIO_ROLLBACK_INVALID");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database.prepare("SELECT current_version FROM scenarios WHERE scenario_id=?")
        .get(scenarioId) as { current_version: number } | undefined;
      if (current?.current_version !== expectedVersion) throw new Error("SCENARIO_ROLLBACK_REVISION_CONFLICT");
      const row = this.#database.prepare(`SELECT payload_json, payload_hash FROM scenario_versions
        WHERE scenario_id=? AND version=?`).get(scenarioId, expectedVersion - 1) as {
          payload_json: string;
          payload_hash: string;
        } | undefined;
      if (row === undefined || hash(row.payload_json) !== row.payload_hash) throw new Error("SCENARIO_ROLLBACK_TARGET_INVALID");
      this.#database.prepare(`UPDATE scenarios SET current_version=?, payload_json=?, payload_hash=? WHERE scenario_id=?`)
        .run(expectedVersion - 1, row.payload_json, row.payload_hash, scenarioId);
      this.#database.exec("COMMIT");
      const definition = parse(row.payload_json, row.payload_hash);
      return Object.freeze({ definition, knowledgeVersions: Object.freeze([...definition.sourceKnowledgeVersions]) });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  renderMarkdown(scenarioId: string): string | undefined {
    const projected = this.get(scenarioId);
    if (projected === undefined) return undefined;
    const scenario = projected.definition;
    const lines = [
      `# ${scenario.title}`,
      "",
      scenario.summary,
      "",
      `- 项目：\`${scenario.projectId}\``,
      `- 场景键：\`${scenario.scenarioKey}\``,
      `- 版本：${scenario.version}`,
      `- 适用：${scenario.applicability.join("；") || "未声明"}`,
      `- 不适用：${scenario.nonApplicability.join("；") || "未声明"}`,
      `- 入口：${scenario.entryPoints.join("、") || "未声明"}`,
      `- 任务意图：${scenario.taskIntents.join("、") || "未声明"}`,
      "",
      "## 关联知识",
      "",
      ...(scenario.sourceKnowledgeVersions.length === 0
        ? ["- 暂无"]
        : scenario.sourceKnowledgeVersions.map((item) => `- \`${item}\``)),
    ];
    return `${lines.join("\n")}\n`;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
