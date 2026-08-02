import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  configurationHash,
  mergeHookConfigurations,
  parseHookConfiguration,
  parseHookConfigurationText,
  unmergeHookConfiguration,
  ZHILOOP_HOOK_CONFIGURATION,
} from "./hook-configuration.js";
import type { HookConfiguration, HookInstallReceipt } from "./types.js";

const EMPTY_CONFIGURATION = Object.freeze({ hooks: Object.freeze({}) });
const MAX_RECEIPT_BYTES = 2_097_152;
const SHA256 = /^[a-f0-9]{64}$/u;

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

function validatePaths(targetPath: string, receiptPath: string): { targetPath: string; receiptPath: string } {
  if (!isAbsolute(targetPath) || !isAbsolute(receiptPath)) throw new Error("plugin configuration paths must be absolute");
  const target = resolve(targetPath);
  const receipt = resolve(receiptPath);
  if (target === receipt) throw new Error("targetPath and receiptPath must differ");
  return { targetPath: target, receiptPath: receipt };
}

function serializeConfiguration(configuration: HookConfiguration): string {
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

function parseReceipt(text: string): HookInstallReceipt {
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) throw new Error("plugin install receipt exceeds 2 MiB");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("plugin install receipt is not valid JSON");
  }
  if (
    typeof value !== "object" || value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !["PREPARED", "ACTIVE"].includes(String((value as { state?: unknown }).state)) ||
    typeof (value as { targetPath?: unknown }).targetPath !== "string" ||
    typeof (value as { originallyExisted?: unknown }).originallyExisted !== "boolean" ||
    !SHA256.test(String((value as { beforeHash?: unknown }).beforeHash)) ||
    !SHA256.test(String((value as { afterHash?: unknown }).afterHash)) ||
    typeof (value as { createdAt?: unknown }).createdAt !== "string" ||
    Number.isNaN(Date.parse(String((value as { createdAt?: unknown }).createdAt))) ||
    !Array.isArray((value as { inserted?: unknown }).inserted) ||
    !(value as { inserted: unknown[] }).inserted.every((entry) =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as { event?: unknown }).event === "string" &&
      (entry as { event: string }).event.length > 0 &&
      SHA256.test(String((entry as { fingerprint?: unknown }).fingerprint)) &&
      typeof (entry as { command?: unknown }).command === "string"
    )
  ) {
    throw new Error("plugin install receipt has an unsupported shape");
  }
  const receipt = value as HookInstallReceipt;
  if (!isAbsolute(receipt.targetPath)) throw new Error("plugin install receipt target must be absolute");
  if (new Set(receipt.inserted.map(({ event, fingerprint }) => `${event}\0${fingerprint}`)).size !== receipt.inserted.length) {
    throw new Error("plugin install receipt contains duplicate entries");
  }
  if (receipt.originallyExisted) {
    if (typeof receipt.originalText !== "string") throw new Error("plugin install receipt is missing the original configuration");
    if (configurationHash(parseHookConfigurationText(receipt.originalText)) !== receipt.beforeHash) {
      throw new Error("plugin install receipt original configuration hash mismatch");
    }
  } else if (receipt.originalText !== undefined || configurationHash(parseHookConfiguration(EMPTY_CONFIGURATION)) !== receipt.beforeHash) {
    throw new Error("plugin install receipt has an invalid empty original configuration");
  }
  return receipt;
}

async function readReceipt(path: string): Promise<HookInstallReceipt> {
  await assertRegularOrAbsent(path);
  return parseReceipt(await readFile(path, "utf8"));
}

export interface HookConfigurationInstallOptions {
  readonly targetPath: string;
  readonly receiptPath: string;
  readonly managedConfiguration?: HookConfiguration;
  readonly clock?: () => Date;
}

export interface HookConfigurationUninstallResult {
  readonly status: "REMOVED" | "NOT_INSTALLED" | "CONFLICT";
  readonly restoredExactOriginal: boolean;
  readonly removedEntries: number;
  readonly conflicts: number;
}

export class HookConfigurationInstaller {
  async install(options: HookConfigurationInstallOptions): Promise<HookInstallReceipt> {
    const paths = validatePaths(options.targetPath, options.receiptPath);
    await assertRegularOrAbsent(paths.targetPath);
    await assertRegularOrAbsent(paths.receiptPath);

    if (await exists(paths.receiptPath)) {
      const receipt = await readReceipt(paths.receiptPath);
      if (receipt.targetPath !== paths.targetPath) throw new Error("plugin install receipt target mismatch");
      if (!(await exists(paths.targetPath))) {
        if (receipt.state === "ACTIVE" || receipt.originallyExisted) {
          throw new Error("installed hook configuration is missing; restore or uninstall it first");
        }
        const recovered = mergeHookConfigurations(EMPTY_CONFIGURATION, options.managedConfiguration ?? ZHILOOP_HOOK_CONFIGURATION);
        if (configurationHash(recovered.configuration) !== receipt.afterHash) throw new Error("prepared hook installation does not match the requested version");
        await atomicWrite(paths.targetPath, serializeConfiguration(recovered.configuration));
      }
      const currentText = await readFile(paths.targetPath, "utf8");
      const current = parseHookConfigurationText(currentText);
      const currentHash = configurationHash(current);
      if (receipt.state === "PREPARED" && currentHash === receipt.beforeHash) {
        const recovered = mergeHookConfigurations(current, options.managedConfiguration ?? ZHILOOP_HOOK_CONFIGURATION);
        if (configurationHash(recovered.configuration) !== receipt.afterHash) throw new Error("prepared hook installation does not match the requested version");
        await atomicWrite(paths.targetPath, serializeConfiguration(recovered.configuration));
      } else if (currentHash !== receipt.afterHash) {
        throw new Error("installed hook configuration drifted; uninstall or repair it first");
      }
      if (receipt.state === "ACTIVE") return receipt;
      const active = Object.freeze({ ...receipt, state: "ACTIVE" as const });
      await atomicWrite(paths.receiptPath, `${JSON.stringify(active, null, 2)}\n`);
      return active;
    }

    const originallyExisted = await exists(paths.targetPath);
    const originalText = originallyExisted ? await readFile(paths.targetPath, "utf8") : undefined;
    const before = originalText === undefined ? parseHookConfiguration(EMPTY_CONFIGURATION) : parseHookConfigurationText(originalText);
    const merge = mergeHookConfigurations(before, options.managedConfiguration ?? ZHILOOP_HOOK_CONFIGURATION);
    const timestamp = (options.clock ?? (() => new Date()))();
    if (Number.isNaN(timestamp.getTime())) throw new Error("plugin installer clock returned an invalid Date");
    const prepared: HookInstallReceipt = Object.freeze({
      schemaVersion: 1,
      state: "PREPARED",
      targetPath: paths.targetPath,
      originallyExisted,
      ...(originalText === undefined ? {} : { originalText }),
      beforeHash: configurationHash(before),
      afterHash: configurationHash(merge.configuration),
      inserted: merge.inserted,
      createdAt: timestamp.toISOString(),
    });
    await atomicCreate(paths.receiptPath, `${JSON.stringify(prepared, null, 2)}\n`);
    const stillExists = await exists(paths.targetPath);
    if (stillExists !== originallyExisted) throw new Error("hook configuration changed while installation was being prepared");
    if (stillExists) {
      const latest = parseHookConfigurationText(await readFile(paths.targetPath, "utf8"));
      if (configurationHash(latest) !== prepared.beforeHash) throw new Error("hook configuration changed while installation was being prepared");
    }
    await atomicWrite(paths.targetPath, serializeConfiguration(merge.configuration));
    const active = Object.freeze({ ...prepared, state: "ACTIVE" as const });
    await atomicWrite(paths.receiptPath, `${JSON.stringify(active, null, 2)}\n`);
    return active;
  }

  async uninstall(targetPath: string, receiptPath: string): Promise<HookConfigurationUninstallResult> {
    const paths = validatePaths(targetPath, receiptPath);
    await assertRegularOrAbsent(paths.targetPath);
    await assertRegularOrAbsent(paths.receiptPath);
    if (!(await exists(paths.receiptPath))) {
      return Object.freeze({ status: "NOT_INSTALLED", restoredExactOriginal: false, removedEntries: 0, conflicts: 0 });
    }
    const receipt = await readReceipt(paths.receiptPath);
    if (receipt.targetPath !== paths.targetPath) throw new Error("plugin install receipt target mismatch");
    if (!(await exists(paths.targetPath))) {
      if (receipt.originallyExisted) {
        return Object.freeze({ status: "CONFLICT", restoredExactOriginal: false, removedEntries: 0, conflicts: receipt.inserted.length });
      }
      await unlink(paths.receiptPath);
      return Object.freeze({ status: "REMOVED", restoredExactOriginal: true, removedEntries: 0, conflicts: 0 });
    }

    const currentText = await readFile(paths.targetPath, "utf8");
    const current = parseHookConfigurationText(currentText);
    if (configurationHash(current) === receipt.afterHash) {
      if (receipt.originallyExisted) {
        if (receipt.originalText === undefined) throw new Error("plugin install receipt is missing the original configuration");
        await atomicWrite(paths.targetPath, receipt.originalText);
      } else {
        await unlink(paths.targetPath);
      }
      await unlink(paths.receiptPath);
      return Object.freeze({ status: "REMOVED", restoredExactOriginal: true, removedEntries: receipt.inserted.length, conflicts: 0 });
    }

    const unmerge = unmergeHookConfiguration(current, receipt.inserted);
    if (unmerge.conflicts.length > 0) {
      return Object.freeze({ status: "CONFLICT", restoredExactOriginal: false, removedEntries: 0, conflicts: unmerge.conflicts.length });
    }
    await atomicWrite(paths.targetPath, serializeConfiguration(unmerge.configuration));
    await unlink(paths.receiptPath);
    return Object.freeze({ status: "REMOVED", restoredExactOriginal: false, removedEntries: unmerge.removed.length, conflicts: 0 });
  }
}
