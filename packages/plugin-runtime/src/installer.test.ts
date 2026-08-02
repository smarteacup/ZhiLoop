import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HookConfigurationInstaller } from "./installer.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "zhiloop-plugin-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HookConfigurationInstaller", () => {
  it("round-trips an existing configuration byte-for-byte and is install-idempotent", async () => {
    const root = await temporaryRoot();
    const target = join(root, "codex", "hooks.json");
    const receipt = join(root, "zhiloop", "hook-install.json");
    await mkdir(join(root, "codex"));
    const original = ` {\n  "description": "CCM",\n  "hooks": {"PreToolUse": [{"hooks": [{"type":"command","command":"ccm guard"}]}]}\n}\n`;
    await writeFile(target, original);
    const installer = new HookConfigurationInstaller();
    const installed = await installer.install({ targetPath: target, receiptPath: receipt, clock: () => new Date("2026-08-02T10:00:00.000Z") });
    expect(installed).toMatchObject({ state: "ACTIVE", originallyExisted: true, inserted: { length: 4 } });
    expect(await installer.install({ targetPath: target, receiptPath: receipt })).toEqual(installed);
    const result = await installer.uninstall(target, receipt);
    expect(result).toEqual({ status: "REMOVED", restoredExactOriginal: true, removedEntries: 4, conflicts: 0 });
    expect(await readFile(target, "utf8")).toBe(original);
    expect(await installer.uninstall(target, receipt)).toMatchObject({ status: "NOT_INSTALLED" });
  });

  it("removes a configuration file created solely for ZhiLoop", async () => {
    const root = await temporaryRoot();
    const target = join(root, "codex", "hooks.json");
    const receipt = join(root, "zhiloop", "receipt.json");
    const installer = new HookConfigurationInstaller();
    await installer.install({ targetPath: target, receiptPath: receipt });
    expect((await lstat(target)).isFile()).toBe(true);
    if (process.platform !== "win32") expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect(await installer.uninstall(target, receipt)).toMatchObject({ status: "REMOVED", restoredExactOriginal: true });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unrelated post-install edits while removing owned hooks", async () => {
    const root = await temporaryRoot();
    const target = join(root, "hooks.json");
    const receipt = join(root, "receipt.json");
    const installer = new HookConfigurationInstaller();
    await writeFile(target, '{"hooks":{}}\n');
    await installer.install({ targetPath: target, receiptPath: receipt });
    const current = JSON.parse(await readFile(target, "utf8")) as { hooks: Record<string, unknown>; note?: string };
    current.note = "added later";
    current.hooks["PreToolUse"] = [{ hooks: [{ type: "command", command: "ccm guard" }] }];
    await writeFile(target, JSON.stringify(current));
    const result = await installer.uninstall(target, receipt);
    expect(result).toEqual({ status: "REMOVED", restoredExactOriginal: false, removedEntries: 4, conflicts: 0 });
    const after = JSON.parse(await readFile(target, "utf8")) as { hooks: Record<string, unknown>; note: string };
    expect(after).toEqual({ hooks: { PreToolUse: current.hooks["PreToolUse"] }, note: "added later" });
  });

  it("retains the receipt and configuration on modified-owned-hook conflict", async () => {
    const root = await temporaryRoot();
    const target = join(root, "hooks.json");
    const receipt = join(root, "receipt.json");
    const installer = new HookConfigurationInstaller();
    await installer.install({ targetPath: target, receiptPath: receipt });
    const current = JSON.parse(await readFile(target, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ timeout?: number }> }>> };
    current.hooks["Stop"]![0]!.hooks[0]!.timeout = 30;
    await writeFile(target, JSON.stringify(current));
    const result = await installer.uninstall(target, receipt);
    expect(result).toMatchObject({ status: "CONFLICT", conflicts: 1, removedEntries: 0 });
    expect((await lstat(receipt)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(current);
    await expect(installer.install({ targetPath: target, receiptPath: receipt })).rejects.toThrow("drifted");
  });

  it("rejects relative, identical, symlink, invalid clock, invalid JSON, and target-mismatched receipt paths", async () => {
    const root = await temporaryRoot();
    const target = join(root, "hooks.json");
    const receipt = join(root, "receipt.json");
    const installer = new HookConfigurationInstaller();
    await expect(installer.install({ targetPath: "hooks.json", receiptPath: receipt })).rejects.toThrow("absolute");
    await expect(installer.install({ targetPath: target, receiptPath: target })).rejects.toThrow("must differ");
    await writeFile(target, "not-json");
    await expect(installer.install({ targetPath: target, receiptPath: receipt })).rejects.toThrow("not valid JSON");
    await writeFile(target, '{"hooks":{}}');
    await expect(installer.install({ targetPath: target, receiptPath: receipt, clock: () => new Date(Number.NaN) })).rejects.toThrow("invalid Date");
    const real = join(root, "real.json");
    const linked = join(root, "linked.json");
    await writeFile(real, '{"hooks":{}}');
    await symlink(real, linked);
    await expect(installer.install({ targetPath: linked, receiptPath: receipt })).rejects.toThrow("regular file");
    await installer.install({ targetPath: real, receiptPath: receipt });
    await expect(installer.uninstall(target, receipt)).rejects.toThrow("target mismatch");
    await chmod(receipt, 0o600);
  });

  it("keeps a recovery receipt if an originally existing target disappears", async () => {
    const root = await temporaryRoot();
    const target = join(root, "hooks.json");
    const receipt = join(root, "receipt.json");
    const installer = new HookConfigurationInstaller();
    await writeFile(target, '{"hooks":{}}');
    await installer.install({ targetPath: target, receiptPath: receipt });
    const { unlink } = await import("node:fs/promises");
    await unlink(target);
    expect(await installer.uninstall(target, receipt)).toMatchObject({ status: "CONFLICT", conflicts: 4 });
    expect((await lstat(receipt)).isFile()).toBe(true);
  });

  it("recovers both prepared-before-write and prepared-after-write installation journals", async () => {
    const root = await temporaryRoot();
    const firstTarget = join(root, "first-hooks.json");
    const firstReceipt = join(root, "first-receipt.json");
    const installer = new HookConfigurationInstaller();
    await installer.install({ targetPath: firstTarget, receiptPath: firstReceipt });
    const firstJournal = JSON.parse(await readFile(firstReceipt, "utf8")) as { state: string };
    firstJournal.state = "PREPARED";
    await writeFile(firstReceipt, JSON.stringify(firstJournal));
    const { unlink } = await import("node:fs/promises");
    await unlink(firstTarget);
    expect(await installer.install({ targetPath: firstTarget, receiptPath: firstReceipt })).toMatchObject({ state: "ACTIVE" });

    const secondTarget = join(root, "second-hooks.json");
    const secondReceipt = join(root, "second-receipt.json");
    await writeFile(secondTarget, '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"ccm guard"}]}]}}');
    await installer.install({ targetPath: secondTarget, receiptPath: secondReceipt });
    const secondJournal = JSON.parse(await readFile(secondReceipt, "utf8")) as { state: string; originalText: string };
    secondJournal.state = "PREPARED";
    await writeFile(secondReceipt, JSON.stringify(secondJournal));
    await writeFile(secondTarget, secondJournal.originalText);
    expect(await installer.install({ targetPath: secondTarget, receiptPath: secondReceipt })).toMatchObject({ state: "ACTIVE" });
  });

  it("serializes concurrent installation attempts through the receipt journal", async () => {
    const root = await temporaryRoot();
    const target = join(root, "hooks.json");
    const receipt = join(root, "receipt.json");
    const installer = new HookConfigurationInstaller();
    const outcomes = await Promise.allSettled([
      installer.install({ targetPath: target, receiptPath: receipt }),
      installer.install({ targetPath: target, receiptPath: receipt }),
    ]);
    expect(outcomes.some(({ status }) => status === "fulfilled")).toBe(true);
    const installed = JSON.parse(await readFile(target, "utf8")) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(installed.hooks)).toHaveLength(4);
    expect(await installer.uninstall(target, receipt)).toMatchObject({ status: "REMOVED" });
  });
});
