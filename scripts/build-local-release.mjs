import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION = "0.1.8";
const WORKSPACES = [
  ["apps/console-gateway", "console-gateway"],
  ["packages/codex-session-capture", "codex-session-capture"],
  ["packages/control-api", "control-api"],
  ["packages/daemon-runtime", "daemon"],
  ["packages/conversation-ledger", "conversation-ledger"],
  ["packages/domain", "domain"],
  ["packages/hook-runtime", "hook-runtime"],
  ["packages/ingestion-codex", "ingestion-codex"],
  ["packages/local-deployment", "local-deployment"],
  ["packages/operational-read-model", "operational-read-model"],
  ["packages/plugin-runtime", "plugin-runtime"],
  ["packages/schemas", "schemas"],
  ["packages/session-catalog", "session-catalog"],
];
const EXTERNALS = [
  ["packages/schemas/node_modules/ajv", "ajv"],
  ["node_modules/ajv-formats", "ajv-formats"],
  ["node_modules/fast-deep-equal", "fast-deep-equal"],
  ["node_modules/fast-uri", "fast-uri"],
  ["packages/schemas/node_modules/json-schema-traverse", "json-schema-traverse"],
  ["node_modules/require-from-string", "require-from-string"],
  ["node_modules/zod", "zod"],
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyTree(source, target, filter = () => true) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`release source must not be a symlink: ${source}`);
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) {
      if (filter(entry)) await copyTree(path.join(source, entry), path.join(target, entry), filter);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`release source contains an unsupported file: ${source}`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
}

async function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await listFiles(directory, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`release output contains an unsupported entry: ${name}`);
  }
  return result.sort();
}

function releaseMode(relativePath) {
  return relativePath === "apps/sidecar/dist/main.js"
    || relativePath === "apps/sidecar/dist/deploy-main.js"
    || relativePath === "apps/cli/dist/ui-main.js"
    || relativePath === "apps/console-gateway/dist/main.js"
    || relativePath.startsWith("plugins/zhiloop/scripts/")
    ? 0o555
    : 0o444;
}

async function gitText(args) {
  const result = await execFileAsync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return result.stdout.trim();
}

async function main() {
  const outputArgument = option("--output");
  if (outputArgument === undefined || !path.isAbsolute(outputArgument)) {
    throw new Error("usage: npm run release:local -- --output /absolute/path");
  }
  const output = path.resolve(outputArgument);
  if (output === "/" || output === process.cwd() || await exists(output)) throw new Error("release output must be a new, explicit directory");
  const temporary = `${output}.tmp-${randomUUID()}`;
  try {
    const sidecarDist = path.join(process.cwd(), "apps", "sidecar", "dist");
    const cliDist = path.join(process.cwd(), "apps", "cli", "dist");
    const gatewayDist = path.join(process.cwd(), "apps", "console-gateway", "dist");
    if (!(await exists(path.join(sidecarDist, "main.js"))) || !(await exists(path.join(sidecarDist, "deploy-main.js")))
      || !(await exists(path.join(cliDist, "ui-main.js"))) || !(await exists(path.join(cliDist, "ui-cli.js")))
      || !(await exists(path.join(gatewayDist, "index.js"))) || !(await exists(path.join(gatewayDist, "main.js")))) {
      throw new Error("build the repository before creating a local release");
    }
    const viteEntrypoint = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    if (!(await exists(viteEntrypoint))) throw new Error("the local Vite runtime is required to build Console assets");
    await execFileAsync(process.execPath, [viteEntrypoint, "build"], {
      cwd: path.join(process.cwd(), "apps", "console-web"),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const webDist = path.join(process.cwd(), "apps", "console-web", "dist");
    if (!(await exists(path.join(webDist, "index.html")))) throw new Error("Console Web build did not produce index.html");
    await copyTree(sidecarDist, path.join(temporary, "apps", "sidecar", "dist"), (name) => name !== ".tsbuildinfo");
    await copyTree(path.join(cliDist, "ui-main.js"), path.join(temporary, "apps", "cli", "dist", "ui-main.js"));
    await copyTree(path.join(cliDist, "ui-cli.js"), path.join(temporary, "apps", "cli", "dist", "ui-cli.js"));
    await copyTree(gatewayDist, path.join(temporary, "apps", "console-gateway", "dist"), (name) => name !== ".tsbuildinfo");
    await copyTree(webDist, path.join(temporary, "apps", "console-web", "dist"));
    for (const [workspace, packageName] of WORKSPACES) {
      const source = path.join(process.cwd(), workspace);
      const target = path.join(temporary, "node_modules", "@zhiloop", packageName);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await copyFile(path.join(source, "package.json"), path.join(target, "package.json"));
      await copyTree(path.join(source, "dist"), path.join(target, "dist"), (name) => name !== ".tsbuildinfo");
    }
    for (const [source, packageName] of EXTERNALS) {
      await copyTree(path.join(process.cwd(), source), path.join(temporary, "node_modules", packageName), (name) => name !== "node_modules");
    }
    await copyTree(path.join(process.cwd(), "plugins", "zhiloop"), path.join(temporary, "plugins", "zhiloop"));

    const payloadPaths = (await listFiles(temporary)).filter((name) => name !== "release.json");
    const files = [];
    for (const relativePath of payloadPaths) {
      const absolutePath = path.join(temporary, ...relativePath.split("/"));
      const mode = releaseMode(relativePath);
      await chmod(absolutePath, mode);
      files.push({
        path: relativePath,
        sha256: createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
        mode,
      });
    }
    const sourceCommit = await gitText(["rev-parse", "HEAD"]);
    const createdAt = await gitText(["show", "-s", "--format=%cI", "HEAD"]);
    const metadata = {
      schemaVersion: 1,
      version: VERSION,
      pluginVersion: "0.1.0",
      protocolVersion: 1,
      sourceCommit,
      nodePath: process.execPath,
      nodeVersion: process.versions.node,
      createdAt,
      files,
    };
    await writeFile(path.join(temporary, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o444 });
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await rename(temporary, output);
    process.stdout.write(`${JSON.stringify({ output, version: VERSION, files: files.length }, null, 2)}\n`);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

await main();
