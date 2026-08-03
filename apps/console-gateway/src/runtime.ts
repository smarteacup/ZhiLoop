import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { UnixSocketControlClient } from "./control-client.js";
import { createConsoleGateway } from "./server.js";

export interface ConsoleRuntimeOptions {
  readonly home: string;
  readonly port: number;
  readonly openBrowser: boolean;
  readonly json: boolean;
}

export const CONSOLE_QUERY_TIMEOUT_MS = 15_000;
export const CONSOLE_MODEL_QUERY_TIMEOUT_MS = 120_000;

function optionValue(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((item, index) => item === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const selected = argv[index + 1];
  if (selected === undefined || selected.startsWith("--")) throw new Error(`${name} requires a value`);
  return selected;
}

export function parseConsoleRuntimeOptions(argv: readonly string[], defaultHome = homedir()): ConsoleRuntimeOptions {
  const knownFlags = new Set(["--no-open", "--json"]);
  const withValues = new Set(["--home", "--port"]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index] as string;
    if (knownFlags.has(item)) continue;
    if (withValues.has(item)) {
      index += 1;
      continue;
    }
    throw new Error(`unknown Console option: ${item}`);
  }
  if (argv.filter((item) => item === "--no-open").length > 1 || argv.filter((item) => item === "--json").length > 1) {
    throw new Error("Console flags may only be specified once");
  }
  const home = resolve(optionValue(argv, "--home") ?? defaultHome);
  if (!isAbsolute(home) || home === "/" || home.includes("\0") || /[\r\n]/u.test(home)) throw new Error("Console home must be an absolute safe path");
  const rawPort = optionValue(argv, "--port");
  const port = rawPort === undefined ? 0 : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("Console port must be between 0 and 65535");
  return Object.freeze({ home, port, openBrowser: !argv.includes("--no-open"), json: argv.includes("--json") });
}

export function resolveConsoleRuntimePaths(home: string, moduleUrl = import.meta.url): { readonly socketPath: string; readonly staticRoot: string } {
  return Object.freeze({
    socketPath: join(home, ".ckl", "run", "sidecar.sock"),
    staticRoot: fileURLToPath(new URL("../../console-web/dist/", moduleUrl)),
  });
}

function openLocalBrowser(url: string): boolean {
  if (process.platform !== "darwin") return false;
  const child = spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin" } });
  child.once("error", () => undefined);
  child.unref();
  return true;
}

export function formatConsoleRuntimeAnnouncement(
  options: Pick<ConsoleRuntimeOptions, "json" | "openBrowser">,
  address: { readonly origin: string; readonly bootstrapUrl: string },
  browserOpened: boolean,
): string {
  if (options.json) {
    return JSON.stringify({
      schemaVersion: 1,
      status: "RUNNING",
      origin: address.origin,
      browserOpened,
      ...(options.openBrowser ? {} : { bootstrapUrl: address.bootstrapUrl }),
    });
  }
  return options.openBrowser
    ? `ZhiLoop Console is running at ${address.origin}${browserOpened ? " (browser opened)" : ""}`
    : `ZhiLoop Console: ${address.bootstrapUrl}`;
}

export async function runConsoleGateway(argv: readonly string[]): Promise<void> {
  const options = parseConsoleRuntimeOptions(argv);
  const paths = resolveConsoleRuntimePaths(options.home);
  const controlClient = new UnixSocketControlClient({ socketPath: paths.socketPath, timeoutMs: CONSOLE_MODEL_QUERY_TIMEOUT_MS });
  const gateway = await createConsoleGateway({
    queryPort: controlClient,
    commandPort: controlClient,
    staticRoot: paths.staticRoot,
    port: options.port,
    queryTimeoutMs: CONSOLE_QUERY_TIMEOUT_MS,
    modelQueryTimeoutMs: CONSOLE_MODEL_QUERY_TIMEOUT_MS,
  });
  const address = await gateway.listen();
  const browserOpened = options.openBrowser && openLocalBrowser(address.bootstrapUrl);
  process.stdout.write(`${formatConsoleRuntimeAnnouncement(options, address, browserOpened)}\n`);
  await new Promise<void>((resolvePromise) => {
    const stop = (): void => resolvePromise();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await gateway.close();
}
