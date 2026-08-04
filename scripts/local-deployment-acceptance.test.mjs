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
    sidecarVersion: "0.3.11",
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

async function waitForJsonLine(child) {
  return await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for Console startup")), 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = (code) => { cleanup(); reject(new Error(`Console exited before startup: ${code}`)); };
    const onData = (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

test("built release installs, captures in SHADOW, preserves CCM, and uninstalls recoverably", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "zhiloop-acceptance-"));
  const home = path.join(temporary, "home");
  const artifact = path.join(temporary, "artifact");
  let sidecar;
  let consoleProcess;
  try {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(home, ".ccm"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), "[features]\nhooks = true\ncodex_hooks = true\n");
    const originalHooks = `${JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/node ~/.ccm/codex-hook-handler.js" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "env CCM_HOOK_PLATFORM=codex /node ~/.ccm/prompt-security-hook.js" }] }],
    } }, null, 2)}\n`;
    const ccmConfig = `${JSON.stringify({ remoteUploadToken: "acceptance-secret", promptEnhanceEnabled: true }, null, 2)}\n`;
    await writeFile(path.join(home, ".codex", "hooks.json"), originalHooks);
    await writeFile(path.join(home, ".ccm", "config.json"), ccmConfig);
    await execFileAsync(process.execPath, [path.join(repository, "scripts", "build-local-release.mjs"), "--output", artifact], { cwd: repository });
    const release = JSON.parse(await readFile(path.join(artifact, "release.json"), "utf8"));
    const releaseFiles = new Set(release.files.map(({ path: filePath }) => filePath));
    for (const required of [
      "apps/cli/dist/ui-main.js",
      "apps/cli/dist/ui-cli.js",
      "apps/console-gateway/dist/main.js",
      "apps/console-web/dist/index.html",
      "node_modules/@zhiloop/console-gateway/package.json",
      "node_modules/@zhiloop/control-api/package.json",
      "node_modules/@zhiloop/local-deployment/package.json",
      "node_modules/zod/package.json",
    ]) assert.equal(releaseFiles.has(required), true, `missing Console release file: ${required}`);

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
    assert.doesNotMatch(await readFile(paths.sidecarLauncher, "utf8"), /console|gateway|ui-main/iu);

    consoleProcess = spawn(paths.zhiloopLauncher, ["ui", "--home", home, "--no-open", "--port", "0", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const consoleStarted = await waitForJsonLine(consoleProcess);
    assert.equal(consoleStarted.schemaVersion, 1);
    assert.match(consoleStarted.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(new URL(consoleStarted.bootstrapUrl).search, "");
    assert.match(new URL(consoleStarted.bootstrapUrl).hash, /^#bootstrap=/u);
    const consolePage = await fetch(consoleStarted.origin);
    assert.equal(consolePage.status, 200);
    assert.match(await consolePage.text(), /ZhiLoop/u);
    assert.equal(await readFile(path.join(home, ".ccm", "config.json"), "utf8"), ccmConfig);
    consoleProcess.kill("SIGTERM");
    await new Promise((resolve) => consoleProcess.once("close", resolve));
    consoleProcess = undefined;

    const missingConfig = await runHook(paths.sidecarLauncher, `${paths.configPath}.missing`, {
      hook_event_name: "UserPromptSubmit", session_id: "missing-config", turn_id: "1", cwd: home, prompt: "fail open",
    });
    assert.equal(missingConfig.code, 0, JSON.stringify(missingConfig));
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
    const transcriptPath = path.join(transcriptDirectory, "rollout-acceptance-history.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-03T00:00:00.000Z", payload: { id: "acceptance-history", session_id: "acceptance-history", cli_version: "0.145.0" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-03T00:00:01.000Z", payload: { type: "user_message", message: "historical prompt" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-03T00:00:02.000Z", payload: { type: "task_complete", turn_id: "turn-history", last_agent_message: "historical conclusion" } }),
    ].join("\n") + "\n");
    const transcriptBefore = await readFile(transcriptPath);

    consoleProcess = spawn(paths.zhiloopLauncher, ["ui", "--home", home, "--no-open", "--port", "0", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const interactiveConsole = await waitForJsonLine(consoleProcess);
    const bootstrap = new URL(interactiveConsole.bootstrapUrl);
    const token = new URLSearchParams(bootstrap.hash.slice(1)).get("bootstrap");
    assert.equal(typeof token, "string");
    const exchange = await fetch(`${interactiveConsole.origin}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: interactiveConsole.origin },
      body: JSON.stringify({ token }),
    });
    assert.equal(exchange.status, 200);
    const sessionCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    const { csrfToken } = await exchange.json();
    assert.equal(typeof sessionCookie, "string");
    assert.equal(typeof csrfToken, "string");
    const browserHeaders = { cookie: sessionCookie, "x-zhiloop-csrf": csrfToken, origin: interactiveConsole.origin };
    const overviewResponse = await fetch(`${interactiveConsole.origin}/api/v1/overview`, { headers: browserHeaders });
    assert.equal(overviewResponse.status, 200);
    assert.equal((await overviewResponse.json()).result.rolloutMode, "SHADOW");
    const sessionsResponse = await fetch(`${interactiveConsole.origin}/api/v1/sessions`, { headers: browserHeaders });
    const sessions = (await sessionsResponse.json()).result.items;
    assert.equal(sessions.some(({ sessionId }) => sessionId === "acceptance-history"), true);
    const detailResponse = await fetch(`${interactiveConsole.origin}/api/v1/sessions/acceptance-history`, { headers: browserHeaders });
    assert.equal((await detailResponse.json()).result.summary.sessionId, "acceptance-history");
    const commandHeaders = { ...browserHeaders, "content-type": "application/json" };
    const previewResponse = await fetch(`${interactiveConsole.origin}/api/v1/capture-jobs`, {
      method: "POST", headers: commandHeaders, body: JSON.stringify({ sessionId: "acceptance-history", dryRun: true }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).result;
    assert.equal(preview.projectedEvents, 3);
    const commitResponse = await fetch(`${interactiveConsole.origin}/api/v1/capture-jobs`, {
      method: "POST",
      headers: commandHeaders,
      body: JSON.stringify({ sessionId: "acceptance-history", dryRun: false, previewRevision: preview.previewRevision, transcriptIdentityHash: preview.transcriptIdentityHash, idempotencyKey: `acceptance:${preview.previewRevision}:${preview.transcriptIdentityHash.slice(0, 24)}` }),
    });
    assert.equal(commitResponse.status, 200);
    const committed = (await commitResponse.json()).result;
    assert.equal(committed.appendedEvents, 3);
    assert.equal(committed.knowledgeCompileStage.status, "PENDING");
    assert.equal(committed.knowledgeCompileStage.reasonCode, "NOT_APPLICABLE");
    assert.deepEqual(await readFile(transcriptPath), transcriptBefore);
    consoleProcess.kill("SIGTERM");
    await new Promise((resolve) => consoleProcess.once("close", resolve));
    consoleProcess = undefined;

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
    consoleProcess?.kill("SIGKILL");
    sidecar?.kill("SIGKILL");
    await rm(temporary, { recursive: true, force: true });
  }
});
