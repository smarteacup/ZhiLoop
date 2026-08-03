import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

export interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export class StaticAssetStore {
  private constructor(private readonly root: string, private readonly maximumBytes: number) {}

  public static async create(root: string, maximumBytes = 2 * 1_048_576): Promise<StaticAssetStore> {
    if (!path.isAbsolute(root)) throw new Error("static asset root must be absolute");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16 * 1_048_576) {
      throw new Error("static asset byte limit is invalid");
    }
    const canonicalRoot = await realpath(root);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) throw new Error("static asset root must be a directory");
    return new StaticAssetStore(canonicalRoot, maximumBytes);
  }

  public async read(pathname: string): Promise<StaticAsset | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
    const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    if (relative.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) return undefined;
    const candidate = path.resolve(this.root, relative);
    if (!candidate.startsWith(`${this.root}${path.sep}`)) return undefined;
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      return undefined;
    }
    if (!canonical.startsWith(`${this.root}${path.sep}`)) return undefined;
    const metadata = await stat(canonical);
    if (!metadata.isFile() || metadata.size > this.maximumBytes) return undefined;
    const extension = path.extname(canonical).toLowerCase();
    const contentType = CONTENT_TYPES.get(extension);
    if (!contentType) return undefined;
    return { body: await readFile(canonical), contentType };
  }
}
