import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertRegularOrAbsent,
  assertSnapshotUnchanged,
  atomicWriteFile,
  pathExists,
  restoreFile,
  sha256File,
  snapshotFile,
} from "./secure-files.js";
import {
  ownedRegularFile,
  quarantineDirectoryStep,
  removeRegularFileStep,
  removeSymlinkStep,
  replaceFileStep,
  replaceSymlinkStep,
} from "./steps.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zhiloop-secure-steps-")); roots.push(root); return root;
}

describe("secure deployment file primitives", () => {
  it("distinguishes missing, regular, directory and symbolic-link paths", async () => {
    const root = await temporary(); const file = join(root, "file"); const directory = join(root, "directory"); const link = join(root, "link");
    expect(await pathExists(file)).toBe(false);
    await expect(assertRegularOrAbsent("relative")).rejects.toThrow("absolute");
    await expect(assertRegularOrAbsent(file)).resolves.toBeUndefined();
    await writeFile(file, "safe"); await mkdir(directory); await symlink(file, link);
    expect(await pathExists(file)).toBe(true);
    await expect(assertRegularOrAbsent(file)).resolves.toBeUndefined();
    await expect(assertRegularOrAbsent(directory)).rejects.toThrow("regular file");
    await expect(assertRegularOrAbsent(link)).rejects.toThrow("regular file");
    expect(await ownedRegularFile(file)).toBe(true);
  });

  it("atomically writes, hashes, snapshots, detects races and restores both present and absent files", async () => {
    const root = await temporary(); const file = join(root, "nested", "file");
    const absent = await snapshotFile(file); expect(absent).toEqual({ existed: false });
    await atomicWriteFile(file, "one", 0o640);
    expect(await sha256File(file)).toMatch(/^[a-f0-9]{64}$/u);
    const present = await snapshotFile(file); expect(present).toMatchObject({ existed: true, mode: 0o640, content: Buffer.from("one") });
    await assertSnapshotUnchanged(file, present);
    await writeFile(file, "two");
    await expect(assertSnapshotUnchanged(file, present)).rejects.toThrow("changed after deployment planning");
    await restoreFile(file, present); expect(await readFile(file, "utf8")).toBe("one");
    await restoreFile(file, absent); expect(await pathExists(file)).toBe(false);
    await restoreFile(file, absent);
    await expect(restoreFile(file, { existed: true })).rejects.toThrow("incomplete");
  });

  it("rejects oversized ownership and snapshot files", async () => {
    const root = await temporary(); const file = join(root, "large");
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(sha256File(file)).rejects.toThrow("bounded regular ownership file");
    await expect(snapshotFile(file)).rejects.toThrow("snapshot size limit");
  });
});

describe("transactional deployment steps", () => {
  it("replaces and rolls back regular files and refuses a planning race", async () => {
    const root = await temporary(); const file = join(root, "file"); await writeFile(file, "old");
    const step = await replaceFileStep("replace", file, "new", 0o600); const rollback = await step.apply();
    expect(await readFile(file, "utf8")).toBe("new"); await rollback(); expect(await readFile(file, "utf8")).toBe("old");
    const raced = await replaceFileStep("raced", file, "never"); await writeFile(file, "changed");
    await expect(raced.apply()).rejects.toThrow("changed after deployment planning");
    const remove = await removeRegularFileStep("remove", file); const restore = await remove.apply();
    expect(await pathExists(file)).toBe(false); await restore(); expect(await readFile(file, "utf8")).toBe("changed");
    const absent = await removeRegularFileStep("absent", join(root, "absent")); const restoreAbsent = await absent.apply(); await restoreAbsent();
  });

  it("replaces, removes and restores installer-owned symbolic links", async () => {
    const root = await temporary(); const first = join(root, "first"); const second = join(root, "second"); const link = join(root, "bin", "tool");
    await writeFile(first, "first"); await writeFile(second, "second");
    const create = await replaceSymlinkStep("create", link, first); const removeCreated = await create.apply(); expect(await readlink(link)).toContain("first"); await removeCreated(); expect(await pathExists(link)).toBe(false);
    await mkdir(join(root, "bin"), { recursive: true }); await symlink("../first", link);
    const replace = await replaceSymlinkStep("replace", link, second); const restore = await replace.apply(); expect(await readlink(link)).toContain("second"); await restore(); expect(await readlink(link)).toBe("../first");
    const remove = await removeSymlinkStep("remove", link); const undo = await remove.apply(); expect(await pathExists(link)).toBe(false); await undo(); expect(await readlink(link)).toBe("../first");
    await unlink(link); await writeFile(link, "not-link");
    await expect(replaceSymlinkStep("invalid", link, first)).rejects.toThrow("symbolic link");
  });

  it("detects link races and safely quarantines existing and absent directories", async () => {
    const root = await temporary(); const target = join(root, "target"); const other = join(root, "other"); const link = join(root, "link");
    await writeFile(target, "one"); await writeFile(other, "two"); await symlink(target, link);
    const raced = await replaceSymlinkStep("raced", link, other); await unlink(link); await symlink(other, link);
    await expect(raced.apply()).rejects.toThrow("changed after deployment planning");
    await expect(quarantineDirectoryStep("bad", join(root, "data"), "bad token")).rejects.toThrow("token");
    await writeFile(join(root, "file"), "x"); await expect(quarantineDirectoryStep("file", join(root, "file"), "safe")).rejects.toThrow("real directory");
    const data = join(root, "data"); await mkdir(data); await writeFile(join(data, "item"), "value");
    const quarantine = await quarantineDirectoryStep("quarantine", data, "safe"); const undo = await quarantine.step.apply(); expect(await pathExists(data)).toBe(false); await undo(); expect(await readFile(join(data, "item"), "utf8")).toBe("value");
    const remove = await quarantineDirectoryStep("remove", data, "cleanup"); await remove.step.apply(); await remove.cleanup(); expect(await pathExists(`${data}.removed-cleanup`)).toBe(false);
    const absent = await quarantineDirectoryStep("absent", join(root, "absent"), "absent"); const undoAbsent = await absent.step.apply(); await undoAbsent(); await absent.cleanup();
  });

  it("refuses an occupied quarantine and a directory type change after planning", async () => {
    const root = await temporary(); const data = join(root, "data"); await mkdir(data); await mkdir(`${data}.removed-token`);
    await expect(quarantineDirectoryStep("occupied", data, "token")).rejects.toThrow("already exists");
    await rm(`${data}.removed-token`, { recursive: true });
    const planned = await quarantineDirectoryStep("planned", data, "token"); await rm(data, { recursive: true }); await writeFile(data, "changed");
    await expect(planned.step.apply()).rejects.toThrow("changed before directory removal");
    await chmod(data, 0o600); expect((await lstat(data)).isFile()).toBe(true);
  });
});
