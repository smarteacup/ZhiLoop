import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteLegacyLocalizationProjection, deriveLegacyLocalizationDraft } from "@zhiloop/knowledge-legacy-migration";
import { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";

const HELP = `Usage:
  npm run migrate:localization -- --registry <knowledge-registry.sqlite> --project <project-id> [--projection <sqlite>] [--commit]
  npm run migrate:localization -- --projection <sqlite> --rollback <rebuild-id>

Without --commit the command is a read-only preview. The projection never rewrites KnowledgeAsset or Markdown.`;

export function parseLegacyLocalizationArgs(args) {
  const options = { commit: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--commit") { options.commit = true; continue; }
    if (["--registry", "--project", "--projection", "--rollback"].includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value; index += 1; continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (options.rollback !== undefined) {
    if (options.commit || options.registry !== undefined || options.project !== undefined || options.projection === undefined) {
      throw new Error("rollback requires only --projection and --rollback");
    }
    return options;
  }
  if (options.registry === undefined || options.project === undefined) {
    throw new Error("--registry and --project are required");
  }
  options.registry = resolve(options.registry);
  options.projection = resolve(options.projection ?? `${options.registry}.localization.sqlite`);
  return options;
}

export function runLegacyLocalizationCommand(args, stdout = process.stdout) {
  const options = parseLegacyLocalizationArgs(args);
  if (options.help === true) { stdout.write(`${HELP}\n`); return 0; }
  if (options.rollback !== undefined) {
    using projection = new SqliteLegacyLocalizationProjection(resolve(options.projection));
    const removed = projection.rollback(options.rollback);
    stdout.write(`${JSON.stringify({ mode: "ROLLBACK", rebuildId: options.rollback, removed })}\n`);
    return removed === 0 ? 2 : 0;
  }
  using registry = new SqliteKnowledgeRegistryProjection(options.registry);
  const assets = registry.listAssets({ limit: 100_000 }).filter((item) => !item.tombstone).map((item) => item.asset);
  const drafts = assets.map(deriveLegacyLocalizationDraft).filter((item) => item?.locator.projectId === options.project);
  if (!options.commit) {
    stdout.write(`${JSON.stringify({ mode: "PREVIEW", projectId: options.project, sourceRevision: registry.activeIndexVersion,
      scanned: assets.length, projected: drafts.length, skipped: assets.length - drafts.length, drafts }, null, 2)}\n`);
    return 0;
  }
  using projection = new SqliteLegacyLocalizationProjection(options.projection);
  const result = projection.rebuild({ projectId: options.project, sourceRevision: registry.activeIndexVersion,
    assets, createdAt: new Date().toISOString() });
  stdout.write(`${JSON.stringify({ mode: "COMMIT", projection: options.projection, ...result })}\n`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exitCode = runLegacyLocalizationCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}\n`); process.exitCode = 1; }
}
