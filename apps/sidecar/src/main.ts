#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import type { McpExpansionResult } from "@zhiloop/active-knowledge-runtime";
import { resolveProjectIdentity } from "@zhiloop/project-identity";
import { resolveQueryContext } from "@zhiloop/query-context";

import { SidecarApplication } from "./application.js";
import { loadSidecarConfig, type SidecarConfig } from "./config.js";
import { runHookCommand } from "./hook-command.js";
import { runMcpCommand } from "./mcp-command.js";
import { requestSidecar, startSidecarServer, stopSidecarServer } from "./transport.js";

function configurationPath(args: readonly string[]): string {
  const index = args.indexOf("--config");
  const explicit = index < 0 ? undefined : args[index + 1];
  const selected = explicit ?? process.env["ZHILOOP_CONFIG"];
  if (selected === undefined || selected.length === 0) throw new Error("--config must name an absolute sidecar configuration file");
  if (!isAbsolute(selected)) throw new Error("--config must name an absolute sidecar configuration file");
  return resolve(selected);
}

async function serve(config: SidecarConfig): Promise<number> {
  const application = await SidecarApplication.create(config);
  await application.start();
  const server = await startSidecarServer(config.socketPath, application);
  let stopping = false;
  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await stopSidecarServer(server, config.socketPath);
  await application.close();
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command !== "serve" && command !== "hook" && command !== "mcp" && command !== "health" && command !== "worker") {
    process.stderr.write("usage: zhiloop-sidecar <serve|hook|mcp|health|worker> --config <absolute-path>\n");
    return 64;
  }
  let config: SidecarConfig;
  try {
    config = await loadSidecarConfig(configurationPath(args));
  } catch (error) {
    if (command === "hook") return 0;
    throw error;
  }
  if (command === "serve") return serve(config);
  if (command === "hook") return runHookCommand(process.stdin, process.stdout, config);
  if (command === "mcp") return await runMcpCommand(process.stdin, process.stdout, {
    authority: async (cwd) => {
      const project = (await resolveProjectIdentity(cwd)).context;
      return resolveQueryContext({ prompt: "ZhiLoop local MCP knowledge request", cwd, project });
    },
    handle: async (request) => await requestSidecar(
      config.socketPath,
      { type: "mcp", request },
      2_000,
    ) as McpExpansionResult,
  });
  const result = command === "health"
    ? await requestSidecar(config.socketPath, { type: "health" }, 1_000)
    : await requestSidecar(config.socketPath, { type: "worker" }, 10_000);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.replace(/[\0\r\n]/gu, " ").slice(0, 500)}\n`);
  process.exitCode = 1;
});
