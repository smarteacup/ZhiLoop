import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { FeedbackProfile, KnowledgeFeedbackEvent, McpExpansionEvent, McpUsageEvent } from "./types.js";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const ACTIONS = new Set(["RELEVANT", "IRRELEVANT", "PIN", "SUPPRESS"]);

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validText(value: string, max = 1_000): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/u.test(value);
}

function time(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export class SqliteFeedbackStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(filename: string) {
    this.#database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
      this.#database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
      if (filename !== ":memory:") this.#database.exec("PRAGMA journal_mode=WAL;");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_feedback (
          event_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, scope_key TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('RELEVANT','IRRELEVANT','PIN','SUPPRESS')),
          trace_id TEXT NOT NULL, actor TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS feedback_scope_asset_idx ON knowledge_feedback(scope_key, asset_id, occurred_at, event_id);
        CREATE TABLE IF NOT EXISTS mcp_expansions (
          expansion_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, scope_key TEXT NOT NULL,
          trace_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mcp_expansion_scope_idx ON mcp_expansions(scope_key, asset_id);
        CREATE TABLE IF NOT EXISTS mcp_usage (
          usage_event_id TEXT PRIMARY KEY, expansion_id TEXT NOT NULL REFERENCES mcp_expansions(expansion_id) ON DELETE RESTRICT,
          trace_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_hash TEXT NOT NULL,
          UNIQUE(expansion_id)
        );
      `);
    } catch (error) {
      this.#database.close(); this.#closed = true; throw error;
    }
  }

  #open(): void { if (this.#closed) throw new Error("feedback store is closed"); }

  record(event: KnowledgeFeedbackEvent): "RECORDED" | "EXISTING" {
    this.#open();
    if (!SAFE.test(event.eventId) || !SAFE.test(event.assetId) || !validText(event.scopeKey)
      || !ACTIONS.has(event.action) || !SAFE.test(event.traceId) || !validText(event.actor) || !time(event.occurredAt)) throw new Error("feedback event is invalid");
    const digest = hash([event.eventId, event.assetId, event.scopeKey, event.action, event.traceId, event.actor, event.occurredAt]);
    const existing = this.#database.prepare("SELECT payload_hash FROM knowledge_feedback WHERE event_id=?").get(event.eventId) as { payload_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash !== digest) throw new Error("feedback event identity conflict");
      return "EXISTING";
    }
    this.#database.prepare("INSERT INTO knowledge_feedback VALUES (?,?,?,?,?,?,?,?)").run(
      event.eventId, event.assetId, event.scopeKey, event.action, event.traceId, event.actor, event.occurredAt, digest,
    );
    return "RECORDED";
  }

  recordExpansion(event: McpExpansionEvent): "RECORDED" | "EXISTING" {
    this.#open();
    if (!SAFE.test(event.expansionId) || !SAFE.test(event.assetId) || !validText(event.scopeKey)
      || !SAFE.test(event.traceId) || !time(event.occurredAt)) throw new Error("MCP expansion event is invalid");
    const digest = hash([event.expansionId, event.assetId, event.scopeKey, event.traceId, event.occurredAt]);
    const existing = this.#database.prepare("SELECT payload_hash FROM mcp_expansions WHERE expansion_id=?").get(event.expansionId) as { payload_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash !== digest) throw new Error("MCP expansion identity conflict");
      return "EXISTING";
    }
    this.#database.prepare("INSERT INTO mcp_expansions VALUES (?,?,?,?,?,?)").run(
      event.expansionId, event.assetId, event.scopeKey, event.traceId, event.occurredAt, digest,
    );
    return "RECORDED";
  }

  recordUsage(event: McpUsageEvent): "RECORDED" | "EXISTING" {
    this.#open();
    if (!SAFE.test(event.usageEventId) || !SAFE.test(event.expansionId) || !SAFE.test(event.traceId) || !time(event.occurredAt)) {
      throw new Error("MCP usage event is invalid");
    }
    const expansion = this.#database.prepare("SELECT trace_id FROM mcp_expansions WHERE expansion_id=?").get(event.expansionId) as { trace_id: string } | undefined;
    if (expansion === undefined || expansion.trace_id !== event.traceId) throw new Error("MCP usage has no matching expansion trace");
    const digest = hash([event.usageEventId, event.expansionId, event.traceId, event.occurredAt]);
    const existing = this.#database.prepare("SELECT payload_hash FROM mcp_usage WHERE usage_event_id=?").get(event.usageEventId) as { payload_hash: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash !== digest) throw new Error("MCP usage identity conflict");
      return "EXISTING";
    }
    const used = this.#database.prepare("SELECT usage_event_id FROM mcp_usage WHERE expansion_id=?").get(event.expansionId) as { usage_event_id: string } | undefined;
    if (used !== undefined) throw new Error("MCP expansion already has a different usage event");
    this.#database.prepare("INSERT INTO mcp_usage VALUES (?,?,?,?,?)").run(
      event.usageEventId, event.expansionId, event.traceId, event.occurredAt, digest,
    );
    return "RECORDED";
  }

  profile(scopeKey: string): FeedbackProfile {
    this.#open();
    if (!validText(scopeKey)) throw new Error("scopeKey is invalid");
    const rows = this.#database.prepare(`
      SELECT asset_id, action, occurred_at, event_id FROM knowledge_feedback
      WHERE scope_key=? ORDER BY occurred_at ASC, event_id ASC
    `).all(scopeKey) as unknown as Array<{ asset_id: string; action: KnowledgeFeedbackEvent["action"]; occurred_at: string; event_id: string }>;
    const byAsset = new Map<string, { relevant: number; irrelevant: number; lastControl?: "PIN" | "SUPPRESS" }>();
    for (const row of rows) {
      const item = byAsset.get(row.asset_id) ?? { relevant: 0, irrelevant: 0 };
      if (row.action === "RELEVANT") item.relevant += 1;
      if (row.action === "IRRELEVANT") item.irrelevant += 1;
      if (row.action === "PIN" || row.action === "SUPPRESS") item.lastControl = row.action;
      byAsset.set(row.asset_id, item);
    }
    const assets = [...byAsset.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([assetId, item]) => ({
      assetId, relevant: item.relevant, irrelevant: item.irrelevant, score: item.relevant - item.irrelevant,
      pinned: item.lastControl === "PIN", suppressed: item.lastControl === "SUPPRESS",
    }));
    const mcp = this.#database.prepare(`
      SELECT COUNT(*) AS expanded, COUNT(u.usage_event_id) AS used FROM mcp_expansions e
      LEFT JOIN mcp_usage u ON u.expansion_id=e.expansion_id WHERE e.scope_key=?
    `).get(scopeKey) as { expanded: number; used: number };
    const relevant = assets.reduce((sum, item) => sum + item.relevant, 0);
    const irrelevant = assets.reduce((sum, item) => sum + item.irrelevant, 0);
    const sampleCount = relevant + irrelevant;
    let preferredLevel: FeedbackProfile["preferredLevel"] = "L2_COMPACT";
    const reasons: string[] = ["FEEDBACK_DEFAULT_COMPACT"];
    if (irrelevant >= 2 && irrelevant > relevant) {
      preferredLevel = "L1_POINTER"; reasons.splice(0, 1, "IRRELEVANT_FEEDBACK_REDUCED_DEPTH");
    } else if (relevant >= 3 && mcp.expanded >= 2 && mcp.used * 2 >= mcp.expanded) {
      preferredLevel = "L3_EVIDENCED"; reasons.splice(0, 1, "RELEVANT_AND_USED_FEEDBACK_INCREASED_DEPTH");
    }
    return Object.freeze({
      scopeKey, assets: Object.freeze(assets.map((item) => Object.freeze(item))),
      pinnedAssetIds: Object.freeze(assets.filter((item) => item.pinned).map((item) => item.assetId)),
      suppressedAssetIds: Object.freeze(assets.filter((item) => item.suppressed).map((item) => item.assetId)),
      preferredLevel, sampleCount, mcpExpanded: mcp.expanded, mcpUsed: mcp.used, reasonCodes: Object.freeze(reasons),
    });
  }

  close(): void { if (!this.#closed) { this.#database.close(); this.#closed = true; } }
}
