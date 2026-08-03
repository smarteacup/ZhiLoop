import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const WORKSPACE_ROOTS = ["apps", "packages"];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function hasDirectTest(directory) {
  const src = path.join(directory, "src");
  if (!(await exists(src))) return false;
  const pending = [src];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) return true;
    }
  }
  return false;
}

export async function validateRequiredDirectTests(rootDirectory) {
  const errors = [];
  for (const root of WORKSPACE_ROOTS) {
    const parent = path.join(rootDirectory, root);
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(parent, entry.name);
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.zhiloop?.requireDirectTests !== true) continue;
      if (!(await hasDirectTest(directory))) errors.push(`${manifest.name} requires at least one direct src/**/*.test.ts`);
    }
  }
  return errors;
}

async function main() {
  const errors = await validateRequiredDirectTests(process.cwd());
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("required direct test check passed");
  }
}

const invokedFile = process.argv[1];
if (invokedFile && import.meta.url === pathToFileURL(invokedFile).href) await main();
