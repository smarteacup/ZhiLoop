import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { loadWorkspaces } from "./check-workspace-dependencies.mjs";

function packageName(specifier) {
  if (specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

export function collectModuleSpecifiers(sourceText, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

export function validateSourceImports(sourceText, fileName, workspace, workspaceNames) {
  const errors = [];

  for (const specifier of collectModuleSpecifiers(sourceText, fileName)) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) continue;

    const importedPackage = packageName(specifier);
    if (workspaceNames.has(importedPackage)) {
      if (!workspace.allowedWorkspaceDependencies.includes(importedPackage)) {
        errors.push(`${fileName}: undeclared workspace import ${specifier}`);
      }
      continue;
    }

    const allowedExternal = workspace.allowedExternalDependencies;
    const allowed =
      allowedExternal.includes(importedPackage) ||
      allowedExternal.includes(specifier) ||
      (specifier.startsWith("node:") && allowedExternal.includes("node:*"));
    if (!allowed) errors.push(`${fileName}: undeclared external import ${specifier}`);
  }

  return errors;
}

async function listSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(absolutePath)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function main() {
  const rootDirectory = process.cwd();
  const workspaces = await loadWorkspaces(rootDirectory);
  const workspaceNames = new Set(workspaces.keys());
  const errors = [];

  for (const workspace of workspaces.values()) {
    if (workspace.kind !== "packages") continue;
    for (const fileName of await listSourceFiles(path.join(workspace.directory, "src"))) {
      const relativeName = path.relative(rootDirectory, fileName);
      errors.push(
        ...validateSourceImports(
          await readFile(fileName, "utf8"),
          relativeName,
          workspace,
          workspaceNames,
        ),
      );
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("source import policy check passed");
  }
}

const invokedFile = process.argv[1];
if (invokedFile && import.meta.url === pathToFileURL(invokedFile).href) await main();

