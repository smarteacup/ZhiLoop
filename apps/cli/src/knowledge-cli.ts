import { randomUUID } from "node:crypto";

import type { GovernanceMutationContext, KnowledgeGovernancePort } from "@zhiloop/knowledge-governance";

export interface CliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export interface KnowledgeCliDependencies {
  readonly governance: KnowledgeGovernancePort;
  readonly context?: () => GovernanceMutationContext;
}

class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

const COMMAND_HELP = Object.freeze({
  list: "Usage: zhiloop-knowledge list [--all] [--json]\nList current knowledge projections.",
  show: "Usage: zhiloop-knowledge show <asset-id> [--json]\nShow one current knowledge asset.",
  diff: "Usage: zhiloop-knowledge diff <asset-id> <from-version> <to-version> [--json]\nCompare two immutable versions.",
  trace: "Usage: zhiloop-knowledge trace <asset-id> [version] [--json]\nTrace source episodes, evidence, and relations.",
  "mark-stale": "Usage: zhiloop-knowledge mark-stale <asset-id> --reason <text> [--actor <name>] [--correlation-id <id>] [--json]\nPublish a new STALE version.",
  suppress: "Usage: zhiloop-knowledge suppress <asset-id> --reason <text> [--scope <key>] [--actor <name>] [--correlation-id <id>] [--json]\nSuppress an asset for a retrieval scope.",
  rebuild: "Usage: zhiloop-knowledge rebuild [--actor <name>] [--correlation-id <id>] [--json]\nRebuild the SQLite projection from Markdown.",
  doctor: "Usage: zhiloop-knowledge doctor [--json]\nDiagnose Markdown/SQLite consistency.",
});

export const KNOWLEDGE_CLI_HELP = `Usage: zhiloop-knowledge <command> [options]

Commands:
  list        List knowledge
  show        Show current knowledge
  diff        Compare versions
  trace       Trace provenance
  mark-stale  Publish a STALE version
  suppress    Record scoped suppression
  rebuild     Rebuild SQLite from Markdown
  doctor      Diagnose consistency

Use '<command> --help' for command details.`;

function success(stdout: string): CliResult {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`, stderr: "" };
}

function failure(message: string, usage = false): CliResult {
  return { exitCode: usage ? 2 : 1, stdout: "", stderr: `Error: ${message}\n` };
}

function json(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  if (args.includes(name)) throw new CliUsageError(`${name} may only be specified once`);
  return true;
}

function takeValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${name} requires a value`);
  args.splice(index, 2);
  if (args.includes(name)) throw new CliUsageError(`${name} may only be specified once`);
  return value;
}

function assertPositionals(args: readonly string[], expected: number, usage: string): void {
  if (args.length !== expected || args.some((item) => item.startsWith("--"))) throw new CliUsageError(usage);
}

function version(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new CliUsageError(`invalid version: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliUsageError(`invalid version: ${value}`);
  return parsed;
}

function mutationContext(
  deps: KnowledgeCliDependencies,
  actor: string | undefined,
  correlationId: string | undefined,
): GovernanceMutationContext {
  const base = deps.context?.() ?? {
    actor: "cli",
    correlationId: randomUUID(),
    now: new Date().toISOString(),
  };
  return {
    actor: actor ?? base.actor,
    correlationId: correlationId ?? base.correlationId,
    now: base.now,
  };
}

function requireDependencies(deps: KnowledgeCliDependencies | undefined): KnowledgeCliDependencies {
  if (deps === undefined) throw new Error("CLI storage is not configured");
  return deps;
}

function renderList(value: ReturnType<KnowledgeGovernancePort["list"]>): string {
  if (value.length === 0) return "No knowledge assets.";
  return value.map((item) => [
    item.asset.id, `v${item.asset.version}`, item.asset.status, item.asset.scope.level,
    item.tombstone ? "tombstone" : item.asset.title,
  ].join("\t")).join("\n");
}

function renderDiff(value: ReturnType<KnowledgeGovernancePort["diff"]>): string {
  if (value.changes.length === 0) return `${value.assetId}: no differences`;
  return value.changes.map((change) => `${String(change.field)}:\n- ${json(change.before)}\n+ ${json(change.after)}`).join("\n");
}

export async function runKnowledgeCli(
  argv: readonly string[],
  dependencies?: KnowledgeCliDependencies,
): Promise<CliResult> {
  const [command, ...rawArgs] = argv;
  if (command === undefined || command === "--help" || command === "-h") return success(KNOWLEDGE_CLI_HELP);
  if (!(command in COMMAND_HELP)) return failure(`unknown command '${command}'\n${KNOWLEDGE_CLI_HELP}`, true);
  const help = COMMAND_HELP[command as keyof typeof COMMAND_HELP];
  const args = [...rawArgs];
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    if (args.length > 0) return failure(help, true);
    return success(help);
  }

  try {
    const asJson = takeFlag(args, "--json");
    const deps = requireDependencies(dependencies);
    switch (command) {
      case "list": {
        const all = takeFlag(args, "--all");
        assertPositionals(args, 0, help);
        const result = deps.governance.list(all);
        return success(asJson ? json(result) : renderList(result));
      }
      case "show": {
        assertPositionals(args, 1, help);
        const result = deps.governance.show(args[0] as string);
        return success(asJson ? json(result) : json(result));
      }
      case "diff": {
        assertPositionals(args, 3, help);
        const result = deps.governance.diff(args[0] as string, version(args[1] as string), version(args[2] as string));
        return success(asJson ? json(result) : renderDiff(result));
      }
      case "trace": {
        if (args.length < 1 || args.length > 2 || args.some((item) => item.startsWith("--"))) throw new CliUsageError(help);
        const result = deps.governance.trace(args[0] as string, args[1] === undefined ? undefined : version(args[1]));
        return success(asJson ? json(result) : json(result));
      }
      case "mark-stale": {
        const reason = takeValue(args, "--reason");
        const actor = takeValue(args, "--actor");
        const correlationId = takeValue(args, "--correlation-id");
        assertPositionals(args, 1, help);
        if (reason === undefined) throw new CliUsageError("--reason is required");
        const result = await deps.governance.markStale({
          assetId: args[0] as string, reason, ...mutationContext(deps, actor, correlationId),
        });
        return success(asJson ? json(result) : `Marked ${result.value.asset.id}@${result.value.asset.version} STALE (audit ${result.auditId})`);
      }
      case "suppress": {
        const reason = takeValue(args, "--reason");
        const scopeKey = takeValue(args, "--scope");
        const actor = takeValue(args, "--actor");
        const correlationId = takeValue(args, "--correlation-id");
        assertPositionals(args, 1, help);
        if (reason === undefined) throw new CliUsageError("--reason is required");
        const result = deps.governance.suppress({
          assetId: args[0] as string, reason, ...(scopeKey === undefined ? {} : { scopeKey }),
          ...mutationContext(deps, actor, correlationId),
        });
        return success(asJson ? json(result) : `Suppressed ${result.value.assetId} in ${result.value.scopeKey} (audit ${result.auditId})`);
      }
      case "rebuild": {
        const actor = takeValue(args, "--actor");
        const correlationId = takeValue(args, "--correlation-id");
        assertPositionals(args, 0, help);
        const result = await deps.governance.rebuild(mutationContext(deps, actor, correlationId));
        return success(asJson ? json(result) : `Rebuilt ${result.value.assets} assets / ${result.value.versions} versions (audit ${result.auditId})`);
      }
      case "doctor": {
        assertPositionals(args, 0, help);
        const result = await deps.governance.doctor();
        if (!result.healthy) return { exitCode: 1, stdout: `${asJson ? json(result) : result.diagnostics.map((item) => `${item.code}\t${item.assetId}\t${item.message}`).join("\n")}\n`, stderr: "" };
        return success(asJson ? json(result) : `Healthy: ${result.markdownAssets} Markdown / ${result.projectedAssets} projected assets`);
      }
    }
    return failure(`unknown command '${command}'`, true);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), error instanceof CliUsageError);
  }
}
