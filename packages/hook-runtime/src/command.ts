import type { Readable } from "node:stream";

import type { CodexHookHandler } from "./handler.js";
import type { HookCommandOptions, HookCommandResult } from "./types.js";

const DEFAULT_MAX_INPUT_BYTES = 5 * 1024 * 1024;

export async function runCodexHookCommand(
  input: Readable,
  handler: CodexHookHandler,
  options: HookCommandOptions = {},
): Promise<HookCommandResult> {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) {
    throw new Error("maxInputBytes must be a positive safe integer");
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      byteLength += buffer.byteLength;
      if (byteLength > maxInputBytes) return { exitCode: 0, capture: await handler.handle(undefined) };
      chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return { exitCode: 0, capture: await handler.handle(parsed) };
  } catch {
    return { exitCode: 0, capture: await handler.handle(undefined) };
  }
}
