import { randomUUID } from "node:crypto";
import { lstat, mkdir, readlink, rename, rm, symlink, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  assertRegularOrAbsent,
  assertSnapshotUnchanged,
  atomicWriteFile,
  pathExists,
  restoreFile,
  snapshotFile,
} from "./secure-files.js";
import type { DeploymentStep } from "./types.js";

export async function replaceFileStep(id: string, path: string, content: string | Buffer, mode = 0o600): Promise<DeploymentStep> {
  const snapshot = await snapshotFile(path);
  return Object.freeze({
    id,
    apply: async () => {
      await assertSnapshotUnchanged(path, snapshot);
      await atomicWriteFile(path, content, mode);
      return async () => restoreFile(path, snapshot);
    },
  });
}

interface LinkSnapshot {
  readonly existed: boolean;
  readonly target?: string;
}

async function snapshotLink(path: string): Promise<LinkSnapshot> {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) throw new Error(`${path} must be an installer-managed symbolic link or absent`);
    return { existed: true, target: await readlink(path) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { existed: false };
    throw error;
  }
}

async function assertLinkUnchanged(path: string, expected: LinkSnapshot): Promise<void> {
  const current = await snapshotLink(path);
  if (current.existed !== expected.existed || current.target !== expected.target) {
    throw new Error(`${path} changed after deployment planning`);
  }
}

async function replaceLink(path: string, target: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await symlink(relative(dirname(path), resolve(target)), temporary);
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function replaceSymlinkStep(id: string, path: string, target: string): Promise<DeploymentStep> {
  const snapshot = await snapshotLink(path);
  return Object.freeze({
    id,
    apply: async () => {
      await assertLinkUnchanged(path, snapshot);
      await replaceLink(path, target);
      return async () => {
        const current = await snapshotLink(path);
        if (!current.existed) return;
        if (snapshot.existed && snapshot.target !== undefined) await replaceLink(path, resolve(dirname(path), snapshot.target));
        else await unlink(path);
      };
    },
  });
}

export async function removeSymlinkStep(id: string, path: string): Promise<DeploymentStep> {
  const snapshot = await snapshotLink(path);
  return Object.freeze({
    id,
    apply: async () => {
      await assertLinkUnchanged(path, snapshot);
      if (snapshot.existed) await unlink(path);
      return async () => {
        if (snapshot.existed && snapshot.target !== undefined) await replaceLink(path, resolve(dirname(path), snapshot.target));
      };
    },
  });
}

export interface DirectoryRemovalStep {
  readonly step: DeploymentStep;
  cleanup(): Promise<void>;
}

export async function quarantineDirectoryStep(id: string, path: string, token: string): Promise<DirectoryRemovalStep> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(token)) throw new Error("directory removal token must be safe");
  let existed = false;
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} must be a real directory or absent`);
    existed = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const quarantine = `${path}.removed-${token}`;
  if (await pathExists(quarantine)) throw new Error("directory removal quarantine already exists");
  return Object.freeze({
    step: Object.freeze({
      id,
      apply: async () => {
        if (existed) {
          const current = await lstat(path);
          if (!current.isDirectory() || current.isSymbolicLink()) throw new Error(`${path} changed before directory removal`);
          await rename(path, quarantine);
        }
        return async () => {
          if (existed && await pathExists(quarantine)) await rename(quarantine, path);
        };
      },
    }),
    cleanup: async () => {
      if (existed) await rm(quarantine, { recursive: true, force: true });
    },
  });
}

export async function removeRegularFileStep(id: string, path: string): Promise<DeploymentStep> {
  const snapshot = await snapshotFile(path);
  return Object.freeze({
    id,
    apply: async () => {
      await assertSnapshotUnchanged(path, snapshot);
      if (snapshot.existed) await unlink(path);
      return async () => restoreFile(path, snapshot);
    },
  });
}

export async function ownedRegularFile(path: string): Promise<boolean> {
  await assertRegularOrAbsent(path);
  return pathExists(path);
}
