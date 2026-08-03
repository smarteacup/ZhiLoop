#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runDeploymentCli } from "./deployment-cli.js";
import { SIDECAR_VERSION } from "./metadata.js";

runDeploymentCli(process.argv.slice(2), process.stdout, process.stderr, {
  currentVersion: SIDECAR_VERSION,
  currentEntrypoint: fileURLToPath(import.meta.url),
}).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.replace(/[\0\r\n]/gu, " ").slice(0, 500)}\n`);
  process.exitCode = 1;
});
