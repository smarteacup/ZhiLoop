import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";

import type {
  CodexHookMetadata,
  CodexHookState,
  CodexHookTrustControlPort,
  CodexHookTrustInspection,
  HookTrustInstallReceipt,
  ManagedHookEntry,
  TrustedHookReceiptEntry,
} from "./types.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_RECEIPT_BYTES = 1_048_576;
const MAX_STDOUT_BYTES = 8_388_608;
const MAX_STDERR_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalExistingPath(path: string): string {
  try { return realpathSync(resolve(path)); } catch { return resolve(path); }
}

function sameFilePath(left: string, right: string): boolean {
  return canonicalExistingPath(left) === canonicalExistingPath(right);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularOrAbsent(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} must be a regular file`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertRegularOrAbsent(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function atomicCreate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertRegularOrAbsent(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function eventIdentity(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function validateAbsolutePaths<const T extends readonly string[]>(paths: T): { readonly [K in keyof T]: string } {
  const resolved = paths.map((path) => {
    if (!isAbsolute(path) || path.includes("\0") || /[\r\n]/u.test(path)) throw new Error("Codex Hook trust paths must be absolute and safe");
    return resolve(path);
  });
  if (new Set(resolved).size !== resolved.length) throw new Error("Codex Hook trust paths must differ");
  return resolved as { readonly [K in keyof T]: string };
}

function parseState(value: unknown, path: string): CodexHookState {
  if (!isRecord(value)) throw new Error(`${path} must be a Codex Hook state object`);
  const enabled = value["enabled"];
  const trustedHash = value["trusted_hash"];
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`${path}.enabled must be boolean`);
  if (trustedHash !== undefined && (typeof trustedHash !== "string" || !SHA256.test(trustedHash))) {
    throw new Error(`${path}.trusted_hash must be a SHA-256 value`);
  }
  return Object.freeze({ ...(enabled === undefined ? {} : { enabled }), ...(trustedHash === undefined ? {} : { trusted_hash: trustedHash }) });
}

function parseStates(value: unknown): Readonly<Record<string, CodexHookState>> {
  if (!isRecord(value)) throw new Error("Codex hooks.state must be an object");
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, state]) => {
    if (key.length === 0 || key.includes("\0") || /[\r\n]/u.test(key)) throw new Error("Codex Hook state key is unsafe");
    return [key, parseState(state, `hooks.state.${key}`)];
  })));
}

function parseHook(value: unknown): CodexHookMetadata {
  if (!isRecord(value)
    || typeof value["key"] !== "string" || typeof value["eventName"] !== "string"
    || typeof value["handlerType"] !== "string" || !(typeof value["command"] === "string" || value["command"] === null)
    || typeof value["sourcePath"] !== "string" || !isAbsolute(value["sourcePath"]) || value["sourcePath"].includes("\0") || /[\r\n]/u.test(value["sourcePath"])
    || typeof value["key"] !== "string" || value["key"].includes("\0") || /[\r\n]/u.test(value["key"])
    || typeof value["source"] !== "string"
    || typeof value["enabled"] !== "boolean" || typeof value["isManaged"] !== "boolean"
    || typeof value["currentHash"] !== "string" || !SHA256.test(value["currentHash"])
    || !["managed", "modified", "trusted", "untrusted"].includes(String(value["trustStatus"]))) {
    throw new Error("Codex hooks/list returned an unsupported Hook record");
  }
  return Object.freeze(value as unknown as CodexHookMetadata);
}

interface AppServerOptions {
  readonly codexExecutable?: string;
  readonly codexHome: string;
  readonly timeoutMs?: number;
}

class AppServerSession {
  readonly #child: ReturnType<typeof spawn>;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #stdoutBuffer = "";
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #closedError: Error | undefined;

  constructor(options: AppServerOptions, cwd: string) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("Codex app-server timeout is outside supported bounds");
    this.#timeoutMs = timeoutMs;
    this.#child = spawn(options.codexExecutable ?? "codex", ["app-server", "--stdio"], {
      cwd,
      env: { ...process.env, HOME: dirname(options.codexHome), CODEX_HOME: options.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.#child.stdout?.setEncoding("utf8");
    this.#child.stderr?.setEncoding("utf8");
    this.#child.stdout?.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr?.on("data", (chunk: string) => {
      this.#stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (this.#stderrBytes > MAX_STDERR_BYTES) {
        this.#close(new Error("Codex app-server diagnostics exceeded the safe limit"));
        this.close();
      }
    });
    this.#child.once("error", (error) => this.#close(new Error(`failed to start Codex app-server: ${error.message}`)));
    this.#child.once("exit", (code, signal) => this.#close(new Error(`Codex app-server exited before replying (${String(code ?? signal ?? "unknown")})`)));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "zhiloop-installer", title: "ZhiLoop Installer", version: "1" },
      capabilities: null,
    });
    this.notify("initialized");
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closedError !== undefined) return Promise.reject(this.#closedError);
    const id = this.#nextId++;
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
        this.close();
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#send({ method, id, params });
    });
  }

  notify(method: string): void {
    this.#send({ method });
  }

  close(): void {
    this.#child.stdin?.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
      }, 1_000);
      force.unref();
      this.#child.once("exit", () => clearTimeout(force));
    }
  }

  #send(value: unknown): void {
    if (this.#child.stdin === null || this.#child.stdin.destroyed || !this.#child.stdin.write(`${JSON.stringify(value)}\n`)) {
      if (this.#child.stdin === null || this.#child.stdin.destroyed) this.#close(new Error("Codex app-server input is unavailable"));
    }
  }

  #onStdout(chunk: string): void {
    this.#stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.#stdoutBytes > MAX_STDOUT_BYTES) {
      this.#close(new Error("Codex app-server output exceeded the safe limit"));
      this.close();
      return;
    }
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        this.#close(new Error("Codex app-server returned invalid JSON"));
        this.close();
        return;
      }
      if (!isRecord(value) || !(typeof value["id"] === "number" || typeof value["id"] === "string")) continue;
      const id = Number(value["id"]);
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      this.#pending.delete(id);
      if (isRecord(value["error"])) {
        const message = typeof value["error"]["message"] === "string" ? value["error"]["message"].slice(0, 512) : "unknown app-server error";
        pending.reject(new Error(`Codex app-server request failed: ${message}`));
      } else {
        pending.resolve(value["result"]);
      }
    }
  }

  #close(error: Error): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    for (const pending of this.#pending.values()) pending.reject(this.#closedError);
    this.#pending.clear();
  }
}

export class CodexAppServerHookTrustControl implements CodexHookTrustControlPort {
  readonly #options: AppServerOptions;

  constructor(options: AppServerOptions) {
    const [codexHome] = validateAbsolutePaths([options.codexHome]);
    this.#options = { ...options, codexHome };
  }

  async inspect(input: { readonly cwd: string; readonly targetPath: string; readonly configPath: string }): Promise<CodexHookTrustInspection> {
    const [cwd, , configPath] = validateAbsolutePaths([input.cwd, input.targetPath, input.configPath]);
    const session = new AppServerSession(this.#options, cwd);
    try {
      await session.initialize();
      const [hooksResult, configResult] = await Promise.all([
        session.request("hooks/list", { cwds: [cwd] }),
        session.request("config/read", { includeLayers: true, cwd }),
      ]);
      if (!isRecord(hooksResult) || !Array.isArray(hooksResult["data"]) || hooksResult["data"].length !== 1) {
        throw new Error("Codex hooks/list returned an unsupported response");
      }
      const list = hooksResult["data"][0];
      if (!isRecord(list) || !Array.isArray(list["hooks"]) || !Array.isArray(list["errors"])) {
        throw new Error("Codex hooks/list returned an unsupported entry");
      }
      if (list["errors"].length > 0) throw new Error("Codex hooks/list reported configuration errors");
      if (!isRecord(configResult) || !isRecord(configResult["config"]) || !isRecord(configResult["origins"])) {
        throw new Error("Codex config/read returned an unsupported response");
      }
      const hooksConfig = configResult["config"]["hooks"];
      const states = isRecord(hooksConfig) && hooksConfig["state"] !== undefined ? parseStates(hooksConfig["state"]) : Object.freeze({});
      const versions = new Set<string>();
      for (const origin of Object.values(configResult["origins"])) {
        if (!isRecord(origin) || !isRecord(origin["name"])) continue;
        if (typeof origin["name"]["file"] === "string" && sameFilePath(origin["name"]["file"], configPath)
          && typeof origin["version"] === "string" && SHA256.test(origin["version"])) versions.add(origin["version"]);
      }
      if (Array.isArray(configResult["layers"])) {
        for (const layer of configResult["layers"]) {
          if (!isRecord(layer) || !isRecord(layer["name"])) continue;
          if (layer["name"]["type"] === "user" && typeof layer["name"]["file"] === "string"
            && sameFilePath(layer["name"]["file"], configPath)
            && typeof layer["version"] === "string" && SHA256.test(layer["version"])) versions.add(layer["version"]);
        }
      }
      if (versions.size > 1) throw new Error("Codex config/read returned inconsistent user configuration versions");
      const configVersion = versions.values().next().value as string | undefined;
      if (configVersion === undefined) throw new Error("Codex config/read did not expose a version for the user configuration");
      return Object.freeze({
        hooks: Object.freeze(list["hooks"].map(parseHook)),
        states,
        configVersion,
      });
    } finally {
      session.close();
    }
  }

  async replaceStates(input: {
    readonly cwd: string;
    readonly configPath: string;
    readonly expectedVersion: string;
    readonly states: Readonly<Record<string, CodexHookState>>;
  }): Promise<{ readonly configVersion: string }> {
    const [cwd, configPath] = validateAbsolutePaths([input.cwd, input.configPath]);
    const states = parseStates(input.states);
    if (!SHA256.test(input.expectedVersion)) throw new Error("Codex config expected version is invalid");
    const session = new AppServerSession(this.#options, cwd);
    try {
      await session.initialize();
      const result = await session.request("config/batchWrite", {
        edits: [{ keyPath: "hooks.state", value: states, mergeStrategy: "replace" }],
        filePath: configPath,
        expectedVersion: input.expectedVersion,
        reloadUserConfig: true,
      });
      if (!isRecord(result) || (result["status"] !== "ok" && result["status"] !== "okOverridden")
        || typeof result["filePath"] !== "string"
        || !sameFilePath(result["filePath"], configPath)
        || typeof result["version"] !== "string" || !SHA256.test(result["version"])) {
        const status = isRecord(result) && typeof result["status"] === "string" ? result["status"].slice(0, 50) : "missing";
        const versionValid = isRecord(result) && typeof result["version"] === "string" && SHA256.test(result["version"]);
        const filePathMatches = isRecord(result) && typeof result["filePath"] === "string"
          && sameFilePath(result["filePath"], configPath);
        throw new Error(`Codex config/batchWrite returned an unsupported response (status=${status}, versionValid=${String(versionValid)}, filePathMatches=${String(filePathMatches)})`);
      }
      return Object.freeze({ configVersion: result["version"] });
    } finally {
      session.close();
    }
  }
}

function parseReceipt(value: unknown): HookTrustInstallReceipt {
  const safeText = (candidate: unknown, maximum: number): candidate is string => typeof candidate === "string"
    && candidate.length > 0 && candidate.length <= maximum && !candidate.includes("\0") && !/[\r\n]/u.test(candidate);
  if (!isRecord(value) || value["schemaVersion"] !== 1 || !["PREPARED", "ACTIVE"].includes(String(value["state"]))
    || typeof value["targetPath"] !== "string" || !isAbsolute(value["targetPath"])
    || typeof value["configPath"] !== "string" || !isAbsolute(value["configPath"])
    || typeof value["createdAt"] !== "string" || Number.isNaN(Date.parse(value["createdAt"]))
    || !Array.isArray(value["unsupportedEvents"]) || value["unsupportedEvents"].length > 64
    || !value["unsupportedEvents"].every((event) => safeText(event, 120))
    || !Array.isArray(value["entries"]) || value["entries"].length < 1 || value["entries"].length > 128
    || !value["entries"].every((entry) => isRecord(entry)
      && safeText(entry["key"], 4_096)
      && safeText(entry["event"], 120)
      && safeText(entry["command"], 8_192)
      && typeof entry["trustedHash"] === "string" && SHA256.test(entry["trustedHash"])
      && (entry["previousTrustedHash"] === undefined || (typeof entry["previousTrustedHash"] === "string" && SHA256.test(entry["previousTrustedHash"]))))) {
    throw new Error("Codex Hook trust receipt has an unsupported shape");
  }
  const receipt = value as unknown as HookTrustInstallReceipt;
  if (new Set(receipt.entries.map(({ key }) => key)).size !== receipt.entries.length) throw new Error("Codex Hook trust receipt contains duplicate keys");
  if (new Set(receipt.unsupportedEvents.map(eventIdentity)).size !== receipt.unsupportedEvents.length) {
    throw new Error("Codex Hook trust receipt contains duplicate unsupported events");
  }
  return receipt;
}

async function readReceipt(path: string): Promise<HookTrustInstallReceipt> {
  await assertRegularOrAbsent(path);
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) throw new Error("Codex Hook trust receipt exceeds 1 MiB");
  try {
    return parseReceipt(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Codex Hook trust receipt is not valid JSON", { cause: error });
    throw error;
  }
}

function cloneStates(states: Readonly<Record<string, CodexHookState>>): Record<string, CodexHookState> {
  return Object.fromEntries(Object.entries(states).map(([key, state]) => [key, { ...state }]));
}

function receiptStateMatches(inspection: CodexHookTrustInspection, entries: readonly TrustedHookReceiptEntry[], after: boolean): boolean {
  return entries.every((entry) => inspection.states[entry.key]?.trusted_hash === (after ? entry.trustedHash : entry.previousTrustedHash));
}

function metadataMatches(entry: TrustedHookReceiptEntry, hook: CodexHookMetadata, targetPath: string): boolean {
  return hook.key === entry.key && sameFilePath(hook.sourcePath, targetPath) && hook.source === "user" && !hook.isManaged
    && hook.enabled && hook.handlerType === "command" && hook.command === entry.command && eventIdentity(hook.eventName) === eventIdentity(entry.event)
    && hook.currentHash === entry.trustedHash;
}

export interface HookTrustInstallOptions {
  readonly targetPath: string;
  readonly configPath: string;
  readonly receiptPath: string;
  readonly cwd: string;
  readonly inserted: readonly ManagedHookEntry[];
  readonly requiredEvents: readonly string[];
  readonly optionalUndiscoveredEvents?: readonly string[];
  readonly control: CodexHookTrustControlPort;
  readonly clock?: () => Date;
}

export interface HookTrustUninstallResult {
  readonly status: "REMOVED" | "NOT_INSTALLED" | "CONFLICT";
  readonly restoredEntries: number;
  readonly conflicts: number;
  readonly removedReceipt?: HookTrustInstallReceipt;
}

export class CodexHookTrustInstaller {
  async install(options: HookTrustInstallOptions): Promise<HookTrustInstallReceipt> {
    const [targetPath, configPath, receiptPath, cwd] = validateAbsolutePaths([
      options.targetPath, options.configPath, options.receiptPath, options.cwd,
    ]);
    await assertRegularOrAbsent(targetPath);
    if (!(await exists(targetPath))) throw new Error("Codex hooks.json must exist before trust registration");
    await assertRegularOrAbsent(configPath);
    await assertRegularOrAbsent(receiptPath);
    const inspection = await options.control.inspect({ cwd, targetPath, configPath });

    if (await exists(receiptPath)) {
      const receipt = await readReceipt(receiptPath);
      if (receipt.targetPath !== targetPath || receipt.configPath !== configPath) throw new Error("Codex Hook trust receipt target mismatch");
      const registeredHooks = receipt.entries.map((entry) => inspection.hooks.find((hook) => metadataMatches(entry, hook, targetPath)));
      if (registeredHooks.some((hook) => hook === undefined)) {
        throw new Error("Codex Hook definition changed after trust registration");
      }
      if (registeredHooks.some((hook) => hook?.enabled === false)) throw new Error("an owned Codex Hook is disabled; refusing to override operator state");
      if (receipt.state === "PREPARED" && receiptStateMatches(inspection, receipt.entries, false)) {
        await this.#writeAndVerify(options.control, { cwd, targetPath, configPath, inspection, entries: receipt.entries, after: true });
      } else if (!receiptStateMatches(inspection, receipt.entries, true)) {
        throw new Error("Codex Hook trust state drifted after registration");
      }
      if (receipt.state === "ACTIVE") return receipt;
      const active = Object.freeze({ ...receipt, state: "ACTIVE" as const });
      await atomicWrite(receiptPath, `${JSON.stringify(active, null, 2)}\n`);
      return active;
    }

    const optional = new Set((options.optionalUndiscoveredEvents ?? []).map(eventIdentity));
    const unsupportedEvents: string[] = [];
    const entries: TrustedHookReceiptEntry[] = [];
    for (const inserted of options.inserted) {
      const matches = inspection.hooks.filter((hook) => sameFilePath(hook.sourcePath, targetPath) && hook.source === "user" && !hook.isManaged
        && hook.handlerType === "command" && hook.command === inserted.command && eventIdentity(hook.eventName) === eventIdentity(inserted.event));
      if (matches.length === 0 && optional.has(eventIdentity(inserted.event))) {
        unsupportedEvents.push(inserted.event);
        continue;
      }
      if (matches.length !== 1) throw new Error(`Codex Hook ${inserted.event} was not discovered exactly once`);
      const hook = matches[0]!;
      if (!hook.enabled) throw new Error(`Codex Hook ${inserted.event} is disabled; refusing to override operator state`);
      entries.push(Object.freeze({
        key: hook.key,
        event: inserted.event,
        command: inserted.command,
        trustedHash: hook.currentHash,
        ...(inspection.states[hook.key]?.trusted_hash === undefined ? {} : { previousTrustedHash: inspection.states[hook.key]!.trusted_hash }),
      }));
    }
    for (const required of options.requiredEvents) {
      if (!entries.some(({ event }) => eventIdentity(event) === eventIdentity(required))) throw new Error(`required Codex Hook ${required} is not discoverable`);
    }
    if (entries.length === 0) throw new Error("no installed Codex Hooks are eligible for trust registration");
    const timestamp = (options.clock ?? (() => new Date()))();
    if (Number.isNaN(timestamp.getTime())) throw new Error("Codex Hook trust installer clock returned an invalid Date");
    const prepared: HookTrustInstallReceipt = Object.freeze({
      schemaVersion: 1,
      state: "PREPARED",
      targetPath,
      configPath,
      entries: Object.freeze(entries),
      unsupportedEvents: Object.freeze(unsupportedEvents),
      createdAt: timestamp.toISOString(),
    });
    await atomicCreate(receiptPath, `${JSON.stringify(prepared, null, 2)}\n`);
    try {
      await this.#writeAndVerify(options.control, { cwd, targetPath, configPath, inspection, entries, after: true });
      const active = Object.freeze({ ...prepared, state: "ACTIVE" as const });
      await atomicWrite(receiptPath, `${JSON.stringify(active, null, 2)}\n`);
      return active;
    } catch (error) {
      const recovery = await options.control.inspect({ cwd, targetPath, configPath }).catch(() => undefined);
      if (recovery !== undefined && receiptStateMatches(recovery, entries, false)) await unlink(receiptPath).catch(() => undefined);
      throw error;
    }
  }

  async uninstall(input: {
    readonly targetPath: string;
    readonly configPath: string;
    readonly receiptPath: string;
    readonly cwd: string;
    readonly control: CodexHookTrustControlPort;
  }): Promise<HookTrustUninstallResult> {
    const [targetPath, configPath, receiptPath, cwd] = validateAbsolutePaths([input.targetPath, input.configPath, input.receiptPath, input.cwd]);
    await assertRegularOrAbsent(receiptPath);
    if (!(await exists(receiptPath))) return Object.freeze({ status: "NOT_INSTALLED", restoredEntries: 0, conflicts: 0 });
    const receipt = await readReceipt(receiptPath);
    if (receipt.targetPath !== targetPath || receipt.configPath !== configPath) throw new Error("Codex Hook trust receipt target mismatch");
    const inspection = await input.control.inspect({ cwd, targetPath, configPath });
    const conflicts = receipt.entries.filter((entry) => inspection.states[entry.key]?.trusted_hash !== entry.trustedHash);
    if (conflicts.length > 0) return Object.freeze({ status: "CONFLICT", restoredEntries: 0, conflicts: conflicts.length });
    await this.#writeAndVerify(input.control, {
      cwd, targetPath, configPath, inspection, entries: receipt.entries, after: false,
    });
    await unlink(receiptPath);
    return Object.freeze({ status: "REMOVED", restoredEntries: receipt.entries.length, conflicts: 0, removedReceipt: receipt });
  }

  async #writeAndVerify(control: CodexHookTrustControlPort, input: {
    readonly cwd: string;
    readonly targetPath: string;
    readonly configPath: string;
    readonly inspection: CodexHookTrustInspection;
    readonly entries: readonly TrustedHookReceiptEntry[];
    readonly after: boolean;
  }): Promise<void> {
    const states = cloneStates(input.inspection.states);
    for (const entry of input.entries) {
      const current = states[entry.key] ?? {};
      const trustedHash = input.after ? entry.trustedHash : entry.previousTrustedHash;
      if (trustedHash === undefined) {
        const rest: { enabled?: boolean; trusted_hash?: string } = { ...current };
        delete rest.trusted_hash;
        if (Object.keys(rest).length === 0) delete states[entry.key];
        else states[entry.key] = rest;
      } else {
        states[entry.key] = { ...current, trusted_hash: trustedHash };
      }
    }
    await control.replaceStates({
      cwd: input.cwd,
      configPath: input.configPath,
      expectedVersion: input.inspection.configVersion,
      states,
    });
    const verification = await control.inspect({ cwd: input.cwd, targetPath: input.targetPath, configPath: input.configPath });
    if (!receiptStateMatches(verification, input.entries, input.after)) throw new Error("Codex Hook trust write could not be verified");
    if (input.after && !input.entries.every((entry) => verification.hooks.some((hook) => metadataMatches(entry, hook, input.targetPath)))) {
      throw new Error("Codex Hook definition changed while trust was being registered");
    }
    const owned = new Set(input.entries.map(({ key }) => key));
    for (const [key, state] of Object.entries(input.inspection.states)) {
      if (owned.has(key)) continue;
      if (JSON.stringify(verification.states[key]) !== JSON.stringify(state)) throw new Error("Codex Hook trust write changed unrelated Hook state");
    }
  }
}
