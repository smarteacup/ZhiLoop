import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeRepositoryReadPort } from "./repository.js";

const cleanup: string[] = [];

function temporary(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("NodeRepositoryReadPort", () => {
  it("reads bounded regular UTF-8 files and returns only a hash plus content", async () => {
    const root = temporary("zhiloop-repository-");
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await expect(new NodeRepositoryReadPort(root).read("src/a.ts")).resolves.toMatchObject({
      path: "src/a.ts", byteLength: 20, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects traversal, absolute paths, excessive depth, and directories", async () => {
    const root = temporary("zhiloop-repository-");
    mkdirSync(path.join(root, "folder"));
    const repository = new NodeRepositoryReadPort(root, { maxPathDepth: 2 });
    await expect(repository.read("../secret")).rejects.toMatchObject({ code: "REPOSITORY_PATH_INVALID" });
    await expect(repository.read("/etc/passwd")).rejects.toMatchObject({ code: "REPOSITORY_PATH_INVALID" });
    await expect(repository.read("a/b/c")).rejects.toMatchObject({ code: "REPOSITORY_PATH_INVALID" });
    await expect(repository.read("folder")).rejects.toMatchObject({ code: "REPOSITORY_FILE_NOT_REGULAR" });
  });

  it("rejects a symlink escaping the canonical repository root", async () => {
    const root = temporary("zhiloop-repository-");
    const external = temporary("zhiloop-external-");
    writeFileSync(path.join(external, "secret.txt"), "never read this");
    symlinkSync(path.join(external, "secret.txt"), path.join(root, "escape.txt"));
    await expect(new NodeRepositoryReadPort(root).read("escape.txt")).rejects.toMatchObject({ code: "REPOSITORY_PATH_ESCAPE" });
  });

  it("rejects oversized and binary input before returning content", async () => {
    const root = temporary("zhiloop-repository-");
    writeFileSync(path.join(root, "large.txt"), "12345");
    writeFileSync(path.join(root, "binary.bin"), Buffer.from([65, 0, 66]));
    const repository = new NodeRepositoryReadPort(root, { maxBytes: 4 });
    await expect(repository.read("large.txt")).rejects.toMatchObject({ code: "REPOSITORY_FILE_TOO_LARGE" });
    await expect(new NodeRepositoryReadPort(root).read("binary.bin")).rejects.toMatchObject({ code: "REPOSITORY_FILE_BINARY" });
  });
});
