import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Writable } from "node:stream";

import { resolveDeploymentPaths } from "@zhiloop/local-deployment";

export interface ConsoleUiOptions {
  readonly home: string;
  readonly port: number;
  readonly openBrowser: boolean;
  readonly json: boolean;
}

export interface ConsoleProcessPort {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ConsoleUiDependencies {
  readonly homeDirectory?: () => string;
  readonly inspectEntrypoint?: (path: string) => Promise<void>;
  readonly spawnGateway?: (nodePath: string, entrypoint: string, args: readonly string[]) => ConsoleProcessPort;
}

function value(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((item, index) => item === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const selected = args[index + 1];
  if (selected === undefined || selected.startsWith("--")) throw new Error(`${name} requires a value`);
  return selected;
}

export function parseConsoleUiOptions(argv: readonly string[], defaultHome = homedir()): ConsoleUiOptions {
  const homeValue = value(argv, "--home") ?? defaultHome;
  const portValue = value(argv, "--port");
  const flags = new Set(["--no-open", "--json"]);
  const optionsWithValues = new Set(["--home", "--port"]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index] as string;
    if (flags.has(item)) continue;
    if (optionsWithValues.has(item)) {
      index += 1;
      continue;
    }
    throw new Error(`unknown ui option: ${item}`);
  }
  if (argv.filter((item) => item === "--no-open").length > 1 || argv.filter((item) => item === "--json").length > 1) {
    throw new Error("ui flags may only be specified once");
  }
  const home = resolve(homeValue);
  if (!isAbsolute(home) || home === "/" || home.includes("\0") || /[\r\n]/u.test(home)) throw new Error("ui home must be an absolute safe path");
  const port = portValue === undefined ? 0 : Number(portValue);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("ui port must be between 0 and 65535");
  return Object.freeze({ home, port, openBrowser: !argv.includes("--no-open"), json: argv.includes("--json") });
}

async function inspectGatewayEntrypoint(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024) {
    throw new Error("installed Console Gateway entrypoint is invalid");
  }
}

function spawnGatewayProcess(nodePath: string, entrypoint: string, args: readonly string[]): ConsoleProcessPort {
  const environment = Object.fromEntries(
    ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  return spawn(nodePath, [entrypoint, ...args], {
    stdio: "inherit",
    env: environment,
    windowsHide: true,
  });
}

export async function launchConsoleGateway(
  argv: readonly string[],
  dependencies: ConsoleUiDependencies = {},
): Promise<number> {
  const options = parseConsoleUiOptions(argv, dependencies.homeDirectory?.() ?? homedir());
  const paths = resolveDeploymentPaths(options.home, "0.0.0");
  const entrypoint = resolve(paths.currentLink, "apps", "console-gateway", "dist", "main.js");
  await (dependencies.inspectEntrypoint ?? inspectGatewayEntrypoint)(entrypoint);
  const child = (dependencies.spawnGateway ?? spawnGatewayProcess)(process.execPath, entrypoint, argv);
  return await new Promise<number>((resolvePromise, reject) => {
    let settled = false;
    const relay = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const sigint = (): void => relay("SIGINT");
    const sigterm = (): void => relay("SIGTERM");
    const cleanup = (): void => {
      process.removeListener("SIGINT", sigint);
      process.removeListener("SIGTERM", sigterm);
    };
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1));
    });
  });
}

export async function runConsoleUi(
  argv: readonly string[],
  stdout: Writable,
  stderr: Writable,
  dependencies: ConsoleUiDependencies = {},
): Promise<number> {
  void stdout;
  try {
    return await launchConsoleGateway(argv, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Error: ${message.replace(/[\0\r\n]/gu, " ").slice(0, 500)}\n`);
    return 1;
  }
}
