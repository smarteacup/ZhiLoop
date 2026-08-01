import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const WORKSPACE_ROOTS = ["apps", "packages"];

export async function loadWorkspaces(rootDirectory) {
  const workspaces = new Map();

  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const absoluteRoot = path.join(rootDirectory, workspaceRoot);
    const entries = await readdir(absoluteRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const directory = path.join(absoluteRoot, entry.name);
      const manifest = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      );
      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        throw new Error(`${directory}/package.json must define a non-empty name`);
      }
      if (workspaces.has(manifest.name)) {
        throw new Error(`duplicate workspace package name: ${manifest.name}`);
      }

      workspaces.set(manifest.name, {
        name: manifest.name,
        directory,
        kind: workspaceRoot,
        allowedWorkspaceDependencies:
          manifest.zhiloop?.allowedWorkspaceDependencies ?? null,
        allowedExternalDependencies:
          manifest.zhiloop?.allowedExternalDependencies ?? null,
        dependencies: Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
        }),
      });
    }
  }

  return workspaces;
}

export function assertAllowedDirections(workspaces) {
  const errors = [];

  for (const workspace of workspaces.values()) {
    if (
      workspace.kind === "packages" &&
      (!Array.isArray(workspace.allowedWorkspaceDependencies) ||
        !Array.isArray(workspace.allowedExternalDependencies))
    ) {
      errors.push(`${workspace.name} must declare its ZhiLoop dependency policy`);
      continue;
    }

    for (const dependencyName of workspace.dependencies) {
      const dependency = workspaces.get(dependencyName);
      if (!dependency) {
        if (
          workspace.kind === "packages" &&
          !workspace.allowedExternalDependencies.includes(dependencyName)
        ) {
          errors.push(
            `${workspace.name} has undeclared external dependency ${dependencyName}`,
          );
        }
        continue;
      }

      if (dependency.kind === "apps") {
        errors.push(`${workspace.name} must not depend on application ${dependency.name}`);
      } else if (
        workspace.kind === "packages" &&
        !workspace.allowedWorkspaceDependencies.includes(dependencyName)
      ) {
        errors.push(
          `${workspace.name} has undeclared workspace dependency ${dependencyName}`,
        );
      }
    }
  }

  return errors;
}

export function findCycles(workspaces) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(name, route) {
    if (visiting.has(name)) {
      const cycleStart = route.indexOf(name);
      cycles.push([...route.slice(cycleStart), name].join(" -> "));
      return;
    }
    if (visited.has(name)) return;

    visiting.add(name);
    const workspace = workspaces.get(name);
    for (const dependency of workspace?.dependencies ?? []) {
      if (workspaces.has(dependency)) visit(dependency, [...route, name]);
    }
    visiting.delete(name);
    visited.add(name);
  }

  for (const name of workspaces.keys()) visit(name, []);
  return [...new Set(cycles)];
}

export function validateWorkspaces(workspaces) {
  return [
    ...assertAllowedDirections(workspaces),
    ...findCycles(workspaces).map((cycle) => `circular dependency: ${cycle}`),
  ];
}

async function main() {
  const workspaces = await loadWorkspaces(process.cwd());
  const errors = validateWorkspaces(workspaces);

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`workspace dependency check passed (${workspaces.size} workspaces)`);
  }
}

const invokedFile = process.argv[1];
if (invokedFile && import.meta.url === pathToFileURL(invokedFile).href) await main();
