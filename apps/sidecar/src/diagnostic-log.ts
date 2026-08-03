import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface DiagnosticRecord {
  readonly component: "hook" | "hook-client" | "service" | "worker";
  readonly code: string;
  readonly durationMs?: number;
  readonly count?: number;
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 100);
}

export class SafeDiagnosticLog {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #retainFiles: number;
  readonly #clock: () => Date;
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string, maxBytes: number, retainFiles: number, clock: () => Date = () => new Date()) {
    this.#path = path;
    this.#maxBytes = maxBytes;
    this.#retainFiles = retainFiles;
    this.#clock = clock;
  }

  write(record: DiagnosticRecord): Promise<void> {
    const operation = this.#pending.then(() => this.#write(record));
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async #write(record: DiagnosticRecord): Promise<void> {
    const timestamp = this.#clock();
    if (Number.isNaN(timestamp.getTime())) return;
    const line = `${JSON.stringify({
      timestamp: timestamp.toISOString(),
      component: record.component,
      code: safeToken(record.code),
      ...(record.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(record.durationMs)) }),
      ...(record.count === undefined ? {} : { count: Math.max(0, Math.trunc(record.count)) }),
    })}\n`;
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      const stat = await lstat(this.#path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("diagnostic log must be a regular file");
      size = stat.size;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (size + Buffer.byteLength(line) > this.#maxBytes) await this.#rotate();
    const handle = await open(this.#path, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await chmod(this.#path, 0o600);
  }

  async #rotate(): Promise<void> {
    await unlink(`${this.#path}.${this.#retainFiles}`).catch(() => undefined);
    for (let index = this.#retainFiles - 1; index >= 1; index -= 1) {
      await rename(`${this.#path}.${index}`, `${this.#path}.${index + 1}`).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
    await rename(this.#path, `${this.#path}.1`).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
