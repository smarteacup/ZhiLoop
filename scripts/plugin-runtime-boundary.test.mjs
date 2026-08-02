import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  mergeHookConfigurations,
  ZHILOOP_HOOK_CONFIGURATION,
} from "../packages/plugin-runtime/dist/index.js";

const execute = promisify(execFile);
const pluginRoot = new URL("../plugins/zhiloop/", import.meta.url);

test("CKL-703: plugin hooks, MCP startup wrapper, fail-open launcher, and package boundary stay aligned", async () => {
  const pluginHooks = JSON.parse(await readFile(new URL("hooks/hooks.json", pluginRoot), "utf8"));
  assert.deepEqual(pluginHooks, ZHILOOP_HOOK_CONFIGURATION);

  const existing = {
    description: "CCM-owned",
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ccm capture" }] }],
    },
  };
  const merged = mergeHookConfigurations(existing);
  assert.deepEqual(merged.configuration.hooks.PostToolUse[0], existing.hooks.PostToolUse[0]);
  assert.equal(merged.inserted.length, 4);

  const mcp = JSON.parse(await readFile(new URL(".mcp.json", pluginRoot), "utf8"));
  assert.deepEqual(mcp, { mcpServers: { zhiloop: { command: "zhiloop-sidecar", args: ["mcp"] } } });
  const compatibility = JSON.parse(await readFile(new URL("compatibility.json", pluginRoot), "utf8"));
  assert.equal(compatibility.protocolVersion, 1);
  assert.equal(compatibility.failureMode, "fail-open");

  const launcher = new URL("scripts/zhiloop-sidecar", pluginRoot);
  const fallback = await execute(fileURLToPath(launcher), ["hook"], { env: { PATH: "/nonexistent" } });
  assert.equal(fallback.stdout, "");
  assert.equal(fallback.stderr, "");

  const sourceFiles = (await readdir(pluginRoot, { recursive: true }))
    .map(String)
    .filter((name) => /\.(?:cjs|js|mjs|ts|tsx)$/u.test(name));
  assert.deepEqual(sourceFiles, [], "plugin wrapper must not copy application or domain source");
  const runtimeManifest = JSON.parse(await readFile(new URL("../packages/plugin-runtime/package.json", import.meta.url), "utf8"));
  assert.deepEqual(runtimeManifest.zhiloop.allowedWorkspaceDependencies, []);
});
