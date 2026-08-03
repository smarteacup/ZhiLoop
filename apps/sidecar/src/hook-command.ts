import type { Readable, Writable } from "node:stream";

import type { SidecarConfig } from "./config.js";
import { SafeDiagnosticLog } from "./diagnostic-log.js";
import { requestSidecar } from "./transport.js";

async function readHookInput(input: Readable, maximum: number): Promise<{ readonly ok: boolean; readonly value?: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maximum) return { ok: false };
      chunks.push(buffer);
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function runHookCommand(inputStream: Readable, output: Writable, config: SidecarConfig): Promise<0> {
  const log = new SafeDiagnosticLog(config.logPath, config.logMaxBytes, config.logRetainFiles);
  const input = await readHookInput(inputStream, config.hookMaxInputBytes);
  if (!input.ok) {
    await log.write({ component: "hook-client", code: "INVALID_OR_OVERSIZED_INPUT" }).catch(() => undefined);
    return 0;
  }
  try {
    const result = await requestSidecar(config.socketPath, { type: "hook", input: input.value }, config.hookTimeoutMs);
    if (typeof result === "string" && result.length > 0) output.write(result);
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "SIDECAR_UNAVAILABLE";
    await log.write({ component: "hook-client", code }).catch(() => undefined);
  }
  return 0;
}
