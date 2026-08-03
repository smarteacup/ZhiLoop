import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function countEvents(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return database.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  } finally {
    database.close();
  }
}

async function waitForNextEvent(filename, before) {
  let count = before;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    count = countEvents(filename);
    if (count >= before + 1) return count;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return count;
}

async function runHook(launcher, config, payload) {
  return await new Promise((resolve, reject) => {
    const child = spawn(launcher, ["hook", "--config", config], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function main() {
  const home = path.resolve(option("--home") ?? homedir());
  const expectedCcmHash = option("--expected-ccm-hash");
  const state = path.join(home, ".ckl");
  const ledger = path.join(state, "knowledge", "events.sqlite");
  const log = path.join(state, "logs", "sidecar.jsonl");
  const config = path.join(state, "config.json");
  const launcher = path.join(home, ".local", "bin", "zhiloop-sidecar");
  const hooksPath = path.join(home, ".codex", "hooks.json");
  const receiptPath = path.join(state, "install", "receipts", "codex-hooks.json");
  const pluginRuntime = path.join(home, ".local", "share", "zhiloop", "current", "node_modules", "@zhiloop", "plugin-runtime", "dist", "index.js");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  const plugin = await import(pathToFileURL(pluginRuntime).href);
  const unmerged = plugin.unmergeHookConfiguration(hooks, receipt.inserted);
  const hookOwnershipRestores = unmerged.conflicts.length === 0
    && plugin.configurationHash(unmerged.configuration) === receipt.beforeHash;
  const ccmHash = createHash("sha256").update(await readFile(path.join(home, ".ccm", "config.json"))).digest("hex");
  const before = countEvents(ledger);
  const marker = `zhiloop-shadow-smoke-${Date.now()}`;
  const result = await runHook(launcher, config, {
    hook_event_name: "UserPromptSubmit",
    session_id: "zhiloop-shadow-acceptance",
    turn_id: marker,
    cwd: home,
    prompt: marker,
  });
  const after = await waitForNextEvent(ledger, before);
  const logText = await readFile(log, "utf8");
  const report = {
    schemaVersion: 1,
    passed: result.code === 0 && result.stdout.length === 0 && after === before + 1
      && !logText.includes(marker) && hookOwnershipRestores
      && (expectedCcmHash === undefined || ccmHash === expectedCcmHash),
    checks: {
      hookExitCode: result.code,
      modelVisibleOutputBytes: Buffer.byteLength(result.stdout),
      hookStderrBytes: Buffer.byteLength(result.stderr),
      ledgerBefore: before,
      ledgerAfter: after,
      rawMarkerInDiagnosticLog: logText.includes(marker),
      codexHooksRestoreToPreinstallHash: hookOwnershipRestores,
      ccmConfigHashMatches: expectedCcmHash === undefined ? null : ccmHash === expectedCcmHash,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

await main();
