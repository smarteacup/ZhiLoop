import { createHash } from "node:crypto";

import type {
  HookConfiguration,
  HookHandlerConfiguration,
  HookMatcherGroup,
  HookMergeResult,
  HookUnmergeResult,
  JsonValue,
  ManagedHookEntry,
} from "./types.js";

const ZHILOOP_COMMAND = /(?:^|[\\/\s"'])zhiloop-sidecar(?:\.cmd)?(?:[\s"']|$)/u;

export const ZHILOOP_HOOK_CONFIGURATION: HookConfiguration = Object.freeze({
  description: "ZhiLoop knowledge capture, controlled injection, and closure verification",
  hooks: Object.freeze({
    UserPromptSubmit: Object.freeze([
      Object.freeze({
        hooks: Object.freeze([
          Object.freeze({
            type: "command" as const,
            command: '"$PLUGIN_ROOT/scripts/zhiloop-sidecar" hook',
            commandWindows: '"%PLUGIN_ROOT%\\scripts\\zhiloop-sidecar.cmd" hook',
            timeout: 1,
            statusMessage: "Loading relevant ZhiLoop knowledge",
            additionalContextLimit: 12_000,
          }),
        ]),
      }),
    ]),
    PostToolUse: Object.freeze([
      Object.freeze({
        hooks: Object.freeze([
          Object.freeze({
            type: "command" as const,
            command: '"$PLUGIN_ROOT/scripts/zhiloop-sidecar" hook',
            commandWindows: '"%PLUGIN_ROOT%\\scripts\\zhiloop-sidecar.cmd" hook',
            timeout: 1,
          }),
        ]),
      }),
    ]),
    Stop: Object.freeze([
      Object.freeze({
        hooks: Object.freeze([
          Object.freeze({
            type: "command" as const,
            command: '"$PLUGIN_ROOT/scripts/zhiloop-sidecar" hook',
            commandWindows: '"%PLUGIN_ROOT%\\scripts\\zhiloop-sidecar.cmd" hook',
            timeout: 3,
            statusMessage: "Checking ZhiLoop task closure",
          }),
        ]),
      }),
    ]),
    SessionEnd: Object.freeze([
      Object.freeze({
        hooks: Object.freeze([
          Object.freeze({
            type: "command" as const,
            command: '"$PLUGIN_ROOT/scripts/zhiloop-sidecar" hook',
            commandWindows: '"%PLUGIN_ROOT%\\scripts\\zhiloop-sidecar.cmd" hook',
            timeout: 3,
          }),
        ]),
      }),
    ]),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJson(value: unknown, path = "$", ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain a finite JSON number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} must contain only JSON values`);
  if (ancestors.has(value)) throw new Error(`${path} must not contain a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain only plain JSON objects`);
    for (const [key, entry] of Object.entries(value)) assertJson(entry, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function configurationHash(configuration: HookConfiguration): string {
  return createHash("sha256").update(canonical(configuration)).digest("hex");
}

export function hookGroupFingerprint(event: string, group: HookMatcherGroup): string {
  return createHash("sha256").update(event).update("\0").update(canonical(group)).digest("hex");
}

function assertHandler(value: unknown, path: string): asserts value is HookHandlerConfiguration {
  if (!isRecord(value) || typeof value["type"] !== "string" || value["type"].length === 0) {
    throw new Error(`${path} must be a hook handler`);
  }
  if (value["type"] === "command" && (typeof value["command"] !== "string" || value["command"].length === 0)) {
    throw new Error(`${path} command hook must define command`);
  }
}

export function parseHookConfiguration(value: unknown): HookConfiguration {
  assertJson(value);
  if (!isRecord(value)) throw new Error("hook configuration must be a JSON object");
  const cloned = cloneJson(value);
  const hooksValue = cloned["hooks"] ?? {};
  if (!isRecord(hooksValue)) throw new Error("hook configuration hooks must be an object");
  for (const [event, groups] of Object.entries(hooksValue)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    groups.forEach((group, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group["hooks"]) || group["hooks"].length === 0) {
        throw new Error(`hooks.${event}[${groupIndex}] must contain hooks`);
      }
      group["hooks"].forEach((handler, handlerIndex) =>
        assertHandler(handler, `hooks.${event}[${groupIndex}].hooks[${handlerIndex}]`),
      );
    });
  }
  cloned["hooks"] = hooksValue;
  return cloned as HookConfiguration;
}

function commandOf(group: HookMatcherGroup): string {
  return group.hooks.map((handler) => handler.command ?? "").join(" && ");
}

function containsZhiLoopCommand(group: HookMatcherGroup): boolean {
  return group.hooks.some((handler) =>
    (handler.command !== undefined && ZHILOOP_COMMAND.test(handler.command)) ||
    (handler.commandWindows !== undefined && ZHILOOP_COMMAND.test(handler.commandWindows)),
  );
}

function assertManagedGroup(group: HookMatcherGroup, event: string): void {
  if (group.hooks.some((handler) => handler.type !== "command" || handler.command === undefined)) {
    throw new Error(`managed hooks.${event} must contain only command hooks`);
  }
}

function entry(event: string, group: HookMatcherGroup): ManagedHookEntry {
  return Object.freeze({ event, fingerprint: hookGroupFingerprint(event, group), command: commandOf(group) });
}

export function mergeHookConfigurations(existing: unknown, managed: unknown = ZHILOOP_HOOK_CONFIGURATION): HookMergeResult {
  const base = parseHookConfiguration(existing);
  const addition = parseHookConfiguration(managed);
  const hooks = cloneJson(base.hooks) as Record<string, HookMatcherGroup[]>;
  const inserted: ManagedHookEntry[] = [];
  const preexisting: ManagedHookEntry[] = [];

  for (const [event, managedGroups] of Object.entries(addition.hooks)) {
    const current = hooks[event] ?? [];
    for (const managedGroup of managedGroups) {
      assertManagedGroup(managedGroup, event);
      const managedEntry = entry(event, managedGroup);
      const exact = current.some((group) => hookGroupFingerprint(event, group) === managedEntry.fingerprint);
      if (exact) {
        preexisting.push(managedEntry);
        continue;
      }
      if (current.some(containsZhiLoopCommand)) {
        throw new Error(`hooks.${event} already contains a different ZhiLoop hook`);
      }
      current.push(cloneJson(managedGroup));
      inserted.push(managedEntry);
    }
    hooks[event] = current;
  }

  return Object.freeze({
    configuration: parseHookConfiguration({ ...cloneJson(base), hooks }),
    inserted: Object.freeze(inserted),
    preexisting: Object.freeze(preexisting),
  });
}

export function unmergeHookConfiguration(current: unknown, inserted: readonly ManagedHookEntry[]): HookUnmergeResult {
  const configuration = parseHookConfiguration(current);
  const hooks = cloneJson(configuration.hooks) as Record<string, HookMatcherGroup[]>;
  const removed: ManagedHookEntry[] = [];
  const conflicts: ManagedHookEntry[] = [];

  for (const expected of inserted) {
    const groups = hooks[expected.event] ?? [];
    const exact = groups.some((group) => hookGroupFingerprint(expected.event, group) === expected.fingerprint);
    if (!exact && groups.some(containsZhiLoopCommand)) conflicts.push(expected);
  }
  if (conflicts.length > 0) {
    return Object.freeze({
      configuration,
      removed: Object.freeze([]),
      conflicts: Object.freeze(conflicts),
    });
  }

  for (const expected of inserted) {
    const groups = hooks[expected.event] ?? [];
    const index = groups.findIndex((group) => hookGroupFingerprint(expected.event, group) === expected.fingerprint);
    if (index >= 0) {
      groups.splice(index, 1);
      removed.push(expected);
    }
    if (groups.length === 0) delete hooks[expected.event];
    else hooks[expected.event] = groups;
  }

  return Object.freeze({
    configuration: parseHookConfiguration({ ...cloneJson(configuration), hooks }),
    removed: Object.freeze(removed),
    conflicts: Object.freeze(conflicts),
  });
}

export function parseHookConfigurationText(text: string): HookConfiguration {
  if (Buffer.byteLength(text, "utf8") > 1_048_576) throw new Error("hook configuration exceeds 1 MiB");
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    throw new Error("hook configuration is not valid JSON");
  }
  return parseHookConfiguration(parsed);
}
