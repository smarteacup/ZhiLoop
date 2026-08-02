import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readPackage = async (name) => JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8"));

test("CKL-507: runtime MCP and proactive injection remain independently available", async () => {
  const mcp = await readPackage("knowledge-mcp");
  const injection = await readPackage("codex-context-injection");
  assert.equal(mcp.dependencies["@zhiloop/codex-context-injection"], undefined);
  assert.equal(injection.dependencies["@zhiloop/knowledge-mcp"], undefined);
  assert.equal(mcp.zhiloop.allowedWorkspaceDependencies.includes("@zhiloop/codex-context-injection"), false);
  assert.equal(injection.zhiloop.allowedWorkspaceDependencies.includes("@zhiloop/knowledge-mcp"), false);
});
