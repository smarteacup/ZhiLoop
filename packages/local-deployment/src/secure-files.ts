import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const MAX_OWNERSHIP_FILE_BYTES = 4 * 1024 * 1024;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function assertRegularOrAbsent(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("managed path must be absolute");
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a regular file or absent`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_OWNERSHIP_FILE_BYTES) throw new Error(`${path} is not a bounded regular ownership file`);
    return createHash("sha256").update(await handle.readFile()).digest("hex");
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
  await assertRegularOrAbsent(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, mode);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export interface FileSnapshot {
  readonly existed: boolean;
  readonly content?: Buffer;
  readonly mode?: number;
  readonly hash?: string;
}

export async function snapshotFile(path: string): Promise<FileSnapshot> {
  await assertRegularOrAbsent(path);
  if (!(await pathExists(path))) return Object.freeze({ existed: false });
  const stat = await lstat(path);
  if (stat.size > MAX_OWNERSHIP_FILE_BYTES) throw new Error(`${path} exceeds the snapshot size limit`);
  const content = await readFile(path);
  return Object.freeze({
    existed: true,
    content,
    mode: stat.mode & 0o777,
    hash: createHash("sha256").update(content).digest("hex"),
  });
}

export async function assertSnapshotUnchanged(path: string, snapshot: FileSnapshot): Promise<void> {
  const current = await snapshotFile(path);
  if (current.existed !== snapshot.existed || current.hash !== snapshot.hash) {
    throw new Error(`${path} changed after deployment planning`);
  }
}

export async function restoreFile(path: string, snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await assertRegularOrAbsent(path);
    await unlink(path).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    return;
  }
  if (snapshot.content === undefined || snapshot.mode === undefined) throw new Error("file snapshot is incomplete");
  await atomicWriteFile(path, snapshot.content, snapshot.mode);
}
