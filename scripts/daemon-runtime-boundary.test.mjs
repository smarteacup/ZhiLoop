import assert from "node:assert/strict";
import test from "node:test";

import { ZhiLoopDaemonRuntime } from "../apps/daemon/dist/index.js";
import { evaluateSidecarCompatibility } from "../packages/plugin-runtime/dist/index.js";

const compatibility = {
  pluginVersion: "0.1.0",
  minimumSidecarVersion: "0.1.0",
  protocolVersion: 1,
  hookSchemaVersion: "codex-hooks-v1",
  appServerSchemaVersion: "codex-app-server-v2",
};

test("CKL-704: the Daemon composition root owns lifecycle, fast paths, worker single-flight, and health", async () => {
  const calls = [];
  let workerCalls = 0;
  const runtime = new ZhiLoopDaemonRuntime({
    components: ["ledger", "registry", "retrieval"].map((name) => ({
      name,
      start: async () => { calls.push(`start:${name}`); },
      stop: async () => { calls.push(`stop:${name}`); },
      health: async () => ({ healthy: true }),
    })),
    hook: { handle: async (input) => JSON.stringify({ continue: true, observed: input.hook_event_name }) },
    mcp: { handle: async (input) => ({ jsonrpc: "2.0", id: input.id, result: { tool: "ckl.search" } }) },
    worker: { runOnce: async () => {
      workerCalls += 1;
      await Promise.resolve();
      return { consumed: 3, produced: 1, cursor: 3, retryableFailures: 0 };
    } },
  }, {
    compatibility,
    sidecarVersion: "0.1.0",
    clock: () => new Date("2026-08-02T12:30:00.000Z"),
  });

  await runtime.start();
  assert.equal(await runtime.handleHook({ hook_event_name: "UserPromptSubmit" }), '{"continue":true,"observed":"UserPromptSubmit"}');
  assert.deepEqual(await runtime.handleMcp({ id: 7 }), { jsonrpc: "2.0", id: 7, result: { tool: "ckl.search" } });
  assert.deepEqual(await Promise.all([runtime.runWorkerOnce(), runtime.runWorkerOnce()]), [
    { consumed: 3, produced: 1, cursor: 3, retryableFailures: 0 },
    { consumed: 3, produced: 1, cursor: 3, retryableFailures: 0 },
  ]);
  assert.equal(workerCalls, 1);
  const health = await runtime.health();
  assert.equal(evaluateSidecarCompatibility(health, compatibility).compatible, true);
  assert.deepEqual(health.lastWorkerCycle, { consumed: 3, produced: 1, cursor: 3, retryableFailures: 0 });
  await runtime.stop();
  assert.deepEqual(calls, [
    "start:ledger", "start:registry", "start:retrieval",
    "stop:retrieval", "stop:registry", "stop:ledger",
  ]);
});
