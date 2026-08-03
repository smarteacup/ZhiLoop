import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = process.cwd();
const compatibility = {
  pluginVersion: "0.1.0",
  minimumSidecarVersion: "0.1.0",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
};

class FakeService {
  running = false;
  calls = [];
  async bootstrap(plistPath) { this.calls.push(["bootstrap", plistPath]); }
  async kickstart() { this.calls.push(["kickstart"]); this.running = true; }
  async bootout() { this.calls.push(["bootout"]); this.running = false; }
  async status() { return this.running ? "RUNNING" : "STOPPED"; }
}

function ready() {
  return {
    schemaVersion: 1,
    status: "READY",
    pluginVersion: "0.1.0",
    sidecarVersion: "0.1.3",
    protocolVersion: 1,
    hookSchemaVersion: "codex-hooks-v1",
    appServerSchemaVersion: "codex-app-server-v2",
    startedAt: "2026-08-03T00:00:00.000Z",
    rolloutMode: "SHADOW",
  };
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

async function waitForHealth(launcher, config) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await execFileAsync(launcher, ["health", "--json", "--config", config], { encoding: "utf8", timeout: 1_000 });
      return JSON.parse(result.stdout);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

test("built release installs, captures in SHADOW, preserves CCM, and uninstalls recoverably", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "zhiloop-acceptance-"));
  const home = path.join(temporary, "home");
  const artifact = path.join(temporary, "artifact");
  let sidecar;
  try {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(home, ".ccm"), { recursive: true });
    const originalHooks = `${JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/node ~/.ccm/codex-hook-handler.js" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "env CCM_HOOK_PLATFORM=codex /node ~/.ccm/prompt-security-hook.js" }] }],
    } }, null, 2)}\n`;
    const ccmConfig = `${JSON.stringify({ remoteUploadToken: "acceptance-secret", promptEnhanceEnabled: true }, null, 2)}\n`;
    await writeFile(path.join(home, ".codex", "hooks.json"), originalHooks);
    await writeFile(path.join(home, ".ccm", "config.json"), ccmConfig);
    await execFileAsync(process.execPath, [path.join(repository, "scripts", "build-local-release.mjs"), "--output", artifact], { cwd: repository });

    const deployment = await import(pathToFileURL(path.join(repository, "packages", "local-deployment", "dist", "index.js")).href);
    const service = new FakeService();
    const options = {
      home,
      artifactDirectory: artifact,
      service,
      health: { health: async () => ready() },
      compatibility,
      readinessAttempts: 1,
      readinessDelayMs: 0,
      randomId: () => "acceptance-install",
    };
    await deployment.installLocalRelease(options);
    await deployment.installLocalRelease({ ...options, randomId: () => "acceptance-repeat" });
    const paths = deployment.resolveDeploymentPaths(home, "0.1.0");
    assert.equal(await readFile(path.join(home, ".ccm", "config.json"), "utf8"), ccmConfig);
    assert.match(await readFile(paths.codexHooksPath, "utf8"), /zhiloop-sidecar/u);

    const missingConfig = await runHook(paths.sidecarLauncher, `${paths.configPath}.missing`, {
      hook_event_name: "UserPromptSubmit", session_id: "missing-config", turn_id: "1", cwd: home, prompt: "fail open",
    });
    assert.equal(missingConfig.code, 0);
    assert.equal(missingConfig.stdout, "");

    sidecar = spawn(paths.sidecarLauncher, ["serve", "--config", paths.configPath], { stdio: "ignore" });
    const health = await waitForHealth(paths.sidecarLauncher, paths.configPath);
    assert.equal(health.status, "READY");
    assert.equal(health.rolloutMode, "SHADOW");
    const secretPrompt = "acceptance prompt secret sk-should-never-enter-log";
    const hook = await runHook(paths.sidecarLauncher, paths.configPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "acceptance-session",
      turn_id: "acceptance-turn",
      cwd: home,
      prompt: secretPrompt,
    });
    assert.equal(hook.code, 0);
    assert.equal(hook.stdout, "");
    assert.doesNotMatch(await readFile(paths.sidecarLogPath, "utf8"), new RegExp(secretPrompt, "u"));

    const transcriptDirectory = path.join(paths.codexSessionsRoot, "2026", "08", "03");
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(path.join(transcriptDirectory, "rollout-acceptance-history.jsonl"), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-03T00:00:00.000Z", payload: { session_id: "acceptance-history", cli_version: "0.145.0" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-03T00:00:01.000Z", payload: { type: "user_message", message: "historical prompt" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-03T00:00:02.000Z", payload: { type: "task_complete", turn_id: "turn-history", last_agent_message: "historical conclusion" } }),
    ].join("\n") + "\n");
    const preview = JSON.parse((await execFileAsync(paths.zhiloopLauncher, [
      "capture", "--home", home, "--session", "acceptance-history", "--dry-run", "--json",
    ])).stdout);
    assert.equal(preview.status, "PREVIEWED");
    assert.equal(preview.projectedEvents, 3);
    assert.equal(preview.appendedEvents, 0);
    const captured = JSON.parse((await execFileAsync(paths.zhiloopLauncher, [
      "capture", "--home", home, "--session", "acceptance-history", "--json",
    ])).stdout);
    assert.equal(captured.status, "CAPTURED");
    assert.equal(captured.appendedEvents, 3);
    assert.equal(captured.knowledgeCompiled, false);
    const repeated = JSON.parse((await execFileAsync(paths.zhiloopLauncher, [
      "capture", "--home", home, "--session", "acceptance-history", "--json",
    ])).stdout);
    assert.equal(repeated.appendedEvents, 0);
    sidecar.kill("SIGTERM");
    await new Promise((resolve) => sidecar.once("close", resolve));
    sidecar = undefined;

    const drifted = JSON.parse(await readFile(paths.codexHooksPath, "utf8"));
    drifted.hooks.SessionStart = [{ hooks: [{ type: "command", command: "/user/after-install-hook" }] }];
    await writeFile(paths.codexHooksPath, `${JSON.stringify(drifted, null, 2)}\n`);
    await deployment.uninstallLocalRelease({ home, service, randomId: () => "acceptance-uninstall", removalToken: "acceptance" });
    const after = await readFile(paths.codexHooksPath, "utf8");
    assert.match(after, /after-install-hook/u);
    assert.doesNotMatch(after, /zhiloop-sidecar/u);
    assert.equal(await readFile(path.join(home, ".ccm", "config.json"), "utf8"), ccmConfig);
    assert.equal((await readFile(paths.ledgerPath)).length > 0, true);
  } finally {
    sidecar?.kill("SIGKILL");
    await rm(temporary, { recursive: true, force: true });
  }
});
