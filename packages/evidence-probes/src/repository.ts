import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import type { RepositoryFile, RepositoryReadOptions, RepositoryReadPort } from "./types.js";
import { RepositoryReadError } from "./types.js";

const DEFAULT_MAX_BYTES = 1_048_576;
const MAX_MAX_BYTES = 16_777_216;
const DEFAULT_MAX_PATH_DEPTH = 32;

function validRelativePath(value: string, maxDepth: number): boolean {
  return value.length > 0 && value.length <= 4_096 && !/[\0\r\n]/u.test(value)
    && !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/u.test(value) && !value.includes("\\")
    && value.split("/").length <= maxDepth
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function beneath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class NodeRepositoryReadPort implements RepositoryReadPort {
  readonly #repositoryRoot: string;
  #root?: Promise<string>;
  readonly #maxBytes: number;
  readonly #maxPathDepth: number;

  constructor(repositoryRoot: string, options: RepositoryReadOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxPathDepth = options.maxPathDepth ?? DEFAULT_MAX_PATH_DEPTH;
    if (repositoryRoot.trim().length === 0 || repositoryRoot.length > 4_096 || /[\0\r\n]/u.test(repositoryRoot) || !path.isAbsolute(repositoryRoot)
      || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > MAX_MAX_BYTES
      || !Number.isSafeInteger(this.#maxPathDepth) || this.#maxPathDepth < 1 || this.#maxPathDepth > 128) {
      throw new RepositoryReadError("REPOSITORY_ROOT_INVALID");
    }
    this.#repositoryRoot = repositoryRoot;
  }

  async read(relativePath: string): Promise<RepositoryFile> {
    if (!validRelativePath(relativePath, this.#maxPathDepth)) {
      throw new RepositoryReadError("REPOSITORY_PATH_INVALID");
    }
    this.#root ??= realpath(this.#repositoryRoot).catch(() => { throw new RepositoryReadError("REPOSITORY_ROOT_INVALID"); });
    const root = await this.#root;
    const unresolved = path.resolve(root, relativePath);
    let resolved: string;
    try {
      resolved = await realpath(unresolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new RepositoryReadError(code === "ENOENT" ? "REPOSITORY_FILE_NOT_FOUND" : "REPOSITORY_READ_FAILED");
    }
    if (!beneath(root, resolved)) throw new RepositoryReadError("REPOSITORY_PATH_ESCAPE");
    let handle;
    try {
      handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new RepositoryReadError("REPOSITORY_FILE_NOT_REGULAR");
      if (stat.size > this.#maxBytes) throw new RepositoryReadError("REPOSITORY_FILE_TOO_LARGE");
      const buffer = Buffer.allocUnsafe(this.#maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      if (bytesRead > this.#maxBytes) throw new RepositoryReadError("REPOSITORY_FILE_TOO_LARGE");
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new RepositoryReadError("REPOSITORY_FILE_BINARY");
      const content = bytes.toString("utf8");
      if (Buffer.from(content, "utf8").byteLength !== bytes.byteLength) {
        throw new RepositoryReadError("REPOSITORY_FILE_BINARY");
      }
      return Object.freeze({
        path: relativePath,
        content,
        byteLength: bytes.byteLength,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      if (error instanceof RepositoryReadError) throw error;
      throw new RepositoryReadError("REPOSITORY_READ_FAILED");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
