import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerHookTrustControl, CodexHookTrustInstaller } from "./codex-hook-trust.js";
import type {
  CodexHookMetadata,
  CodexHookState,
  CodexHookTrustControlPort,
  CodexHookTrustInspection,
  ManagedHookEntry,
} from "./types.js";

const roots: string[] = [];
const command = "'/home/.local/bin/zhiloop-sidecar' hook --config '/home/.ckl/config.json'";

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function metadata(targetPath: string, eventName: string, keyEvent: string, index: number): CodexHookMetadata {
  return Object.freeze({
    key: `${targetPath}:${keyEvent}:${index}:0`,
    eventName,
    handlerType: "command",
    command,
    sourcePath: targetPath,
    source: "user",
    enabled: true,
    isManaged: false,
    currentHash: hash(eventName),
    trustStatus: "untrusted",
  });
}

class FakeControl implements CodexHookTrustControlPort {
  hooks: readonly CodexHookMetadata[];
  states: Record<string, CodexHookState>;
  version = hash("version-0");
  writes = 0;
  failAfterNextWrite = false;
  disableHookAfterNextWrite = false;

  constructor(hooks: readonly CodexHookMetadata[], states: Record<string, CodexHookState> = {}) {
    this.hooks = hooks;
    this.states = structuredClone(states);
  }

  async inspect(): Promise<CodexHookTrustInspection> {
    return Object.freeze({ hooks: this.hooks, states: structuredClone(this.states), configVersion: this.version });
  }

  async replaceStates(input: { readonly expectedVersion?: string; readonly states: Readonly<Record<string, CodexHookState>> }): Promise<{ readonly configVersion: string }> {
    if (input.expectedVersion !== this.version) throw new Error("stale version");
    this.states = structuredClone(input.states);
    this.writes += 1;
    this.version = hash(`version-${this.writes}`);
    if (this.disableHookAfterNextWrite) {
      this.disableHookAfterNextWrite = false;
      this.hooks = this.hooks.map((hook) => hook.command === command && hook.eventName === "stop"
        ? Object.freeze({ ...hook, enabled: false })
        : hook);
    }
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false;
      throw new Error("lost response after atomic write");
    }
    return { configVersion: this.version };
  }
}

async function fixture(): Promise<{
  root: string;
  targetPath: string;
  configPath: string;
  receiptPath: string;
  hooks: readonly CodexHookMetadata[];
  inserted: readonly ManagedHookEntry[];
}> {
  const root = await mkdtemp(join(tmpdir(), "zhiloop-hook-trust-"));
  roots.push(root);
  const targetPath = join(root, ".codex", "hooks.json");
  const configPath = join(root, ".codex", "config.toml");
  const receiptPath = join(root, ".ckl", "receipts", "codex-hook-trust.json");
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(targetPath, "{\"hooks\":{}}\n");
  await writeFile(configPath, "[features]\nhooks = true\n");
  const hooks = Object.freeze([
    metadata(targetPath, "userPromptSubmit", "user_prompt_submit", 1),
    metadata(targetPath, "postToolUse", "post_tool_use", 1),
    metadata(targetPath, "stop", "stop", 1),
    Object.freeze({ ...metadata(targetPath, "stop", "stop", 0), command: "/home/.ccm/codex-hook-handler.js", currentHash: hash("ccm") }),
  ]);
  const inserted = Object.freeze([
    { event: "UserPromptSubmit", command, fingerprint: "1".repeat(64) },
    { event: "PostToolUse", command, fingerprint: "2".repeat(64) },
    { event: "Stop", command, fingerprint: "3".repeat(64) },
    { event: "SessionEnd", command, fingerprint: "4".repeat(64) },
  ]);
  return { root, targetPath, configPath, receiptPath, hooks, inserted };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Codex Hook trust installer", () => {
  it("uses the bounded Codex app-server protocol for authoritative inspection and versioned writes", async () => {
    const value = await fixture();
    const executable = join(value.root, "fake-codex.cjs");
    const hook = metadata(value.targetPath, "stop", "stop", 1);
    const version = hash("app-server-version");
    const nextVersion = hash("app-server-next-version");
    const script = `#!${process.execPath}\nconst readline = require("node:readline");\nconst target = ${JSON.stringify(value.targetPath)};\nconst config = ${JSON.stringify(value.configPath)};\nconst hook = ${JSON.stringify(hook)};\nconst version = ${JSON.stringify(version)};\nconst nextVersion = ${JSON.stringify(nextVersion)};\nconst send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");\nreadline.createInterface({ input: process.stdin }).on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.method === "initialize") send(request.id, { codexHome: ${JSON.stringify(join(value.root, ".codex"))} });\n  if (request.method === "hooks/list") send(request.id, { data: [{ cwd: request.params.cwds[0], hooks: [hook], warnings: [], errors: [] }] });\n  if (request.method === "config/read") send(request.id, { config: { hooks: { state: { "ccm:key": { trusted_hash: ${JSON.stringify(hash("ccm"))} } } } }, origins: { one: { name: { type: "user", file: config }, version } } });\n  if (request.method === "config/batchWrite") send(request.id, { status: "ok", version: nextVersion, filePath: config, overriddenMetadata: null });\n});\n`;
    await writeFile(executable, script, { mode: 0o700 });
    await chmod(executable, 0o700);
    const control = new CodexAppServerHookTrustControl({
      codexExecutable: executable,
      codexHome: join(value.root, ".codex"),
      timeoutMs: 2_000,
    });
    await expect(control.inspect({ cwd: value.root, targetPath: value.targetPath, configPath: value.configPath })).resolves.toMatchObject({
      hooks: [{ key: hook.key, currentHash: hook.currentHash }],
      states: { "ccm:key": { trusted_hash: hash("ccm") } },
      configVersion: version,
    });
    await expect(control.replaceStates({
      cwd: value.root,
      configPath: value.configPath,
      expectedVersion: version,
      states: { "ccm:key": { trusted_hash: hash("ccm") } },
    })).resolves.toEqual({ configVersion: nextVersion });
  });

  it("trusts only exact inserted user hooks with Codex-provided hashes and preserves CCM and enabled state", async () => {
    const value = await fixture();
    const ccmKey = `${value.targetPath}:stop:0:0`;
    const promptKey = `${value.targetPath}:user_prompt_submit:1:0`;
    const oldHash = hash("old-positional-hook");
    const control = new FakeControl(value.hooks, {
      [ccmKey]: { trusted_hash: hash("ccm") },
      [promptKey]: { enabled: true, trusted_hash: oldHash },
      "unrelated:hook": { enabled: false, trusted_hash: hash("unrelated") },
    });
    const installer = new CodexHookTrustInstaller();
    const options = {
      ...value,
      cwd: value.root,
      requiredEvents: ["UserPromptSubmit", "PostToolUse", "Stop"],
      optionalUndiscoveredEvents: ["SessionEnd"],
      control,
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    };

    const receipt = await installer.install(options);
    expect(receipt).toMatchObject({ state: "ACTIVE", unsupportedEvents: ["SessionEnd"] });
    expect(receipt.entries).toHaveLength(3);
    expect(control.states[ccmKey]).toEqual({ trusted_hash: hash("ccm") });
    expect(control.states["unrelated:hook"]).toEqual({ enabled: false, trusted_hash: hash("unrelated") });
    expect(control.states[promptKey]).toEqual({ enabled: true, trusted_hash: hash("userPromptSubmit") });
    expect(control.writes).toBe(1);

    await expect(installer.install(options)).resolves.toEqual(receipt);
    expect(control.writes).toBe(1);

    control.states[promptKey] = { enabled: true, trusted_hash: hash("userPromptSubmit") };
    control.states["added:later"] = { trusted_hash: hash("added-later") };
    const removed = await installer.uninstall({ ...value, cwd: value.root, control });
    expect(removed).toMatchObject({ status: "REMOVED", restoredEntries: 3 });
    expect(control.states[promptKey]).toEqual({ enabled: true, trusted_hash: oldHash });
    expect(control.states[ccmKey]).toEqual({ trusted_hash: hash("ccm") });
    expect(control.states["added:later"]).toEqual({ trusted_hash: hash("added-later") });
  });

  it("retains a recovery receipt when the atomic Codex write succeeds but its response is lost", async () => {
    const value = await fixture();
    const control = new FakeControl(value.hooks);
    control.failAfterNextWrite = true;
    const installer = new CodexHookTrustInstaller();
    const options = {
      ...value, cwd: value.root, requiredEvents: ["UserPromptSubmit", "PostToolUse", "Stop"],
      optionalUndiscoveredEvents: ["SessionEnd"], control,
    };
    await expect(installer.install(options)).rejects.toThrow("lost response");
    expect((await lstat(value.receiptPath)).isFile()).toBe(true);
    await expect(installer.install(options)).resolves.toMatchObject({ state: "ACTIVE" });
    expect(control.writes).toBe(1);
  });

  it("refuses ambiguous, managed, wrong-source and missing required hooks", async () => {
    const value = await fixture();
    const installer = new CodexHookTrustInstaller();
    const base = {
      ...value, cwd: value.root, requiredEvents: ["UserPromptSubmit", "PostToolUse", "Stop"],
      optionalUndiscoveredEvents: ["SessionEnd"],
    };
    await expect(installer.install({ ...base, control: new FakeControl([...value.hooks, value.hooks[0]!]) })).rejects.toThrow("exactly once");
    await expect(installer.install({ ...base, control: new FakeControl(value.hooks.map((hook) => hook.eventName === "stop" && hook.command === command ? { ...hook, isManaged: true } : hook)) })).rejects.toThrow("exactly once");
    await expect(installer.install({ ...base, control: new FakeControl(value.hooks.filter((hook) => hook.eventName !== "postToolUse")) })).rejects.toThrow("not discovered exactly once");
    await expect(installer.install({ ...base, control: new FakeControl(value.hooks.map((hook) => hook.eventName === "stop" && hook.command === command ? { ...hook, enabled: false } : hook)) })).rejects.toThrow("disabled");
  });

  it("does not remove trust after an operator or Codex changes an owned hash", async () => {
    const value = await fixture();
    const control = new FakeControl(value.hooks);
    const installer = new CodexHookTrustInstaller();
    await installer.install({
      ...value, cwd: value.root, requiredEvents: ["UserPromptSubmit", "PostToolUse", "Stop"],
      optionalUndiscoveredEvents: ["SessionEnd"], control,
    });
    const ownedKey = `${value.targetPath}:stop:1:0`;
    control.states[ownedKey] = { enabled: false, trusted_hash: hash("operator-change") };
    await expect(installer.uninstall({ ...value, cwd: value.root, control })).resolves.toMatchObject({ status: "CONFLICT", conflicts: 1 });
    expect((await lstat(value.receiptPath)).isFile()).toBe(true);
    expect(control.states[ownedKey]).toEqual({ enabled: false, trusted_hash: hash("operator-change") });
  });

  it("rejects unsafe trust receipts", async () => {
    const value = await fixture();
    const installer = new CodexHookTrustInstaller();
    const control = new FakeControl(value.hooks);
    await mkdir(join(value.root, ".ckl", "receipts"), { recursive: true });
    await writeFile(value.receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      state: "ACTIVE",
      targetPath: value.targetPath,
      configPath: value.configPath,
      entries: [{
        key: "unsafe\nkey",
        event: "Stop",
        command,
        trustedHash: hash("stop"),
      }],
      unsupportedEvents: [],
      createdAt: "2026-08-04T00:00:00.000Z",
    })}\n`);
    await expect(installer.install({
      ...value,
      cwd: value.root,
      requiredEvents: ["UserPromptSubmit", "PostToolUse", "Stop"],
      optionalUndiscoveredEvents: ["SessionEnd"],
      control,
    })).rejects.toThrow("unsupported shape");
  });

  it("does not activate a receipt when a Hook is disabled during write verification", async () => {
    const value = await fixture();
    const control = new FakeControl(value.hooks);
    control.disableHookAfterNextWrite = true;
    const installer = new CodexHookTrustInstaller();
    const options = {
      ...value,
      cwd: value.root,
      requiredEvents: ["UserPromptSubmit", "PostToolUse", "Stop"],
      optionalUndiscoveredEvents: ["SessionEnd"],
      control,
    };
    await expect(installer.install(options)).rejects.toThrow("definition changed");
    expect((await lstat(value.receiptPath)).isFile()).toBe(true);
    await expect(installer.uninstall({ ...value, cwd: value.root, control })).resolves.toMatchObject({ status: "REMOVED" });
  });
});
