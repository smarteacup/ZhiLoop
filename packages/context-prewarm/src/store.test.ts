import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { buildStableContextCatalog } from "./prewarm.js";
import { SqliteContextPrewarmStore } from "./store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function catalog() {
  return buildStableContextCatalog({
    sessionId: "session-1", projectId: "project-1", worktree: "/repo", branch: "main",
    knowledgeRegistryRevision: "registry-1", retrievalPolicyHash: "retrieval-1", injectionPolicyHash: "injection-1",
    scopeHash: "scope-1", observedAt: "2026-08-19T00:00:00.000Z",
  }, { ttlMs: 60_000, maxItems: 8, maxTokens: 800 }, []);
}

describe("SqliteContextPrewarmStore", () => {
  it("is idempotent and rejects conflicting immutable keys", () => {
    using store = new SqliteContextPrewarmStore(":memory:");
    expect(store.put(catalog())).toBe("STORED");
    expect(store.put(catalog())).toBe("IDEMPOTENT");
    expect(() => store.put({ ...catalog(), projectId: "other" })).toThrow("CONTEXT_PREWARM_KEY_CONFLICT");
    expect(() => store.put({ ...catalog(), cacheKey: "invalid" })).toThrow("CONTEXT_PREWARM_CORRUPT");
  });

  it("detects payload corruption", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-prewarm-")); directories.push(directory);
    const filename = path.join(directory, "prewarm.sqlite");
    using store = new SqliteContextPrewarmStore(filename);
    const value = catalog(); store.put(value);
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE context_prewarm_entries SET payload_json=? WHERE cache_key=?").run("{}", value.cacheKey);
    database.close();
    expect(() => store.get(value.cacheKey, "2026-08-19T00:00:01.000Z")).toThrow("CONTEXT_PREWARM_INTEGRITY_FAILED");
  });
});
