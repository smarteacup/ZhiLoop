import { spawn } from "node:child_process";

import type { CodexExecProcessPort, CodexExecProcessRequest, CodexExecProcessResult } from "./types.js";

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 128 * 1024;

function validateRequest(request: CodexExecProcessRequest): void {
  if (request.executable.trim().length === 0 || request.executable.includes("\0")) {
    throw new Error("Codex executable must be non-empty");
  }
  if (request.args.length > MAX_ARGUMENTS || request.args.some((argument) => argument.includes("\0"))) {
    throw new Error("Codex arguments are invalid");
  }
  if (Buffer.byteLength(request.args.join("\0"), "utf8") > MAX_ARGUMENT_BYTES) {
    throw new Error("Codex arguments exceed the safe size limit");
  }
  if (request.cwd.trim().length === 0 || request.cwd.includes("\0")) throw new Error("Codex cwd is invalid");
  for (const value of [request.maxStdoutBytes, request.maxStderrBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Codex output limit is invalid");
  }
}

export class NodeCodexExecProcess implements CodexExecProcessPort {
  async run(request: CodexExecProcessRequest): Promise<CodexExecProcessResult> {
    validateRequest(request);
    if (request.signal.aborted) return Promise.reject(request.signal.reason ?? new Error("Codex execution aborted"));

    return await new Promise<CodexExecProcessResult>((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        signal: request.signal,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        operation();
      };
      const capture = (target: Buffer[], currentBytes: number, limit: number, source: Buffer | string): number => {
        if (settled) return currentBytes;
        const chunk = Buffer.isBuffer(source) ? source : Buffer.from(source);
        target.push(chunk);
        const nextBytes = currentBytes + chunk.byteLength;
        if (nextBytes > limit) {
          child.kill("SIGKILL");
          finish(() => reject(new Error("Codex process output exceeded the configured limit")));
        }
        return nextBytes;
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBytes = capture(stdout, stdoutBytes, request.maxStdoutBytes, chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBytes = capture(stderr, stderrBytes, request.maxStderrBytes, chunk);
      });
      child.stdin.on("error", () => {
        // A process that exits before consuming stdin is classified from its exit status.
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (exitCode, signal) => finish(() => resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })));
      child.stdin.end(request.stdin, "utf8");
    });
  }
}
