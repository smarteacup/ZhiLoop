import { createHash } from "node:crypto";
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
    const transport = parseHookTransportResult(result);
    if (transport.hookOutput.length > 0) await writeAccepted(output, transport.hookOutput);
    if (transport.delivery !== undefined && !transport.delivery.alreadyAcknowledged && transport.hookOutput.length > 0) {
      const deliveredAt = new Date().toISOString();
      const deliveryEvidenceRef = `hook-client:${createHash("sha256").update(transport.hookOutput, "utf8").digest("hex")}`;
      await requestSidecar(config.socketPath, {
        type: "injection-delivery.ack",
        attemptId: transport.delivery.attemptId,
        expectedRevision: transport.delivery.expectedRevision,
        deliveryEvidenceRef,
        deliveredAt,
      }, Math.min(250, config.hookTimeoutMs));
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "SIDECAR_UNAVAILABLE";
    await log.write({ component: "hook-client", code }).catch(() => undefined);
  }
  return 0;
}

interface HookTransportResult {
  readonly hookOutput: string;
  readonly delivery?: {
    readonly attemptId: string;
    readonly expectedRevision: 1;
    readonly alreadyAcknowledged: boolean;
  };
}

function parseHookTransportResult(value: unknown): HookTransportResult {
  if (typeof value === "string") return { hookOutput: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid Hook transport result");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "schemaVersion" && key !== "hookOutput" && key !== "delivery")
    || record["schemaVersion"] !== 1 || typeof record["hookOutput"] !== "string"
    || record["hookOutput"].length > 1_048_576 || record["hookOutput"].includes("\0")) {
    throw new Error("invalid Hook transport result");
  }
  const delivery = record["delivery"];
  if (delivery === undefined) return { hookOutput: record["hookOutput"] };
  if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery)) throw new Error("invalid Hook delivery metadata");
  const metadata = delivery as Record<string, unknown>;
  if (Object.keys(metadata).some((key) => !["attemptId", "expectedRevision", "alreadyAcknowledged"].includes(key))
    || typeof metadata["attemptId"] !== "string" || metadata["expectedRevision"] !== 1
    || typeof metadata["alreadyAcknowledged"] !== "boolean") throw new Error("invalid Hook delivery metadata");
  return {
    hookOutput: record["hookOutput"],
    delivery: {
      attemptId: metadata["attemptId"],
      expectedRevision: 1,
      alreadyAcknowledged: metadata["alreadyAcknowledged"],
    },
  };
}

async function writeAccepted(output: Writable, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(value, (error) => error === null || error === undefined ? resolve() : reject(error));
  });
}
