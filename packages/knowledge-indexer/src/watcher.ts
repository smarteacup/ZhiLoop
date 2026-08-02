import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { DebouncedKnowledgeIndexer } from "./scheduler.js";
import type { NodeKnowledgeWatcherOptions } from "./types.js";

const SAFE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const VERSION_FILE = /^\d{8}\.md$/;
const MAX_STARTUP_ASSETS = 100_000;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function existingAssetIds(rootDirectory: string): readonly string[] {
  const assetsDirectory = path.join(rootDirectory, "assets");
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(assetsDirectory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("knowledge assets root must be a real directory");
  const assetIds: string[] = [];
  for (const entry of readdirSync(assetsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_ASSET_ID.test(entry.name)) continue;
    const currentPath = path.join(assetsDirectory, entry.name, "current.md");
    try {
      const current = lstatSync(currentPath);
      if (current.isFile() && !current.isSymbolicLink()) assetIds.push(entry.name);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (assetIds.length > MAX_STARTUP_ASSETS) throw new Error(`watch startup assets exceed ${MAX_STARTUP_ASSETS}`);
  }
  return assetIds.sort();
}

export function assetIdFromKnowledgePath(rootDirectory: string, changedPath: string): string | undefined {
  const root = path.resolve(rootDirectory);
  const absolute = path.resolve(changedPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const parts = relative.split(path.sep);
  if (parts[0] !== "assets" || parts[1] === undefined || !SAFE_ASSET_ID.test(parts[1])) return undefined;
  if (parts.length === 3 && parts[2] === "current.md") return parts[1];
  if (parts.length === 4 && parts[2] === "versions" && parts[3] !== undefined && VERSION_FILE.test(parts[3])) return parts[1];
  return undefined;
}

export class NodeMarkdownKnowledgeWatcher {
  readonly #rootDirectory: string;
  readonly #scheduler: DebouncedKnowledgeIndexer;
  readonly #onError: NodeKnowledgeWatcherOptions["onError"];
  #watcher: FSWatcher | undefined;
  #lastError: Error | undefined;

  constructor(
    rootDirectory: string,
    scheduler: DebouncedKnowledgeIndexer,
    options: NodeKnowledgeWatcherOptions = {},
  ) {
    if (rootDirectory.trim().length === 0) throw new Error("watch root must not be empty");
    this.#rootDirectory = path.resolve(rootDirectory);
    this.#scheduler = scheduler;
    this.#onError = options.onError;
  }

  get lastError(): Error | undefined {
    return this.#lastError;
  }

  start(): void {
    if (this.#watcher !== undefined) return;
    const metadata = lstatSync(this.#rootDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("watch root must be a real directory");
    this.#watcher = watch(this.#rootDirectory, { recursive: true }, (_eventType, fileName) => {
      if (fileName === null) return;
      const assetId = assetIdFromKnowledgePath(this.#rootDirectory, path.join(this.#rootDirectory, fileName.toString()));
      if (assetId !== undefined) this.#scheduler.notifyAsset(assetId);
    });
    this.#watcher.on("error", (error) => {
      this.#lastError = error;
      this.#onError?.(error);
    });
    try {
      // The watch is registered before the scan. Existing assets are then reconciled,
      // so a change during native watcher startup is either observed or read by this scan.
      for (const assetId of existingAssetIds(this.#rootDirectory)) this.#scheduler.notifyAsset(assetId);
    } catch (error) {
      this.#watcher.close();
      this.#watcher = undefined;
      throw error;
    }
  }

  close(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
  }
}
