import { spawn } from "node:child_process";

export interface CodeGraphProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface CodeGraphProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

export interface CodeGraphProcessPort {
  run(request: CodeGraphProcessRequest): Promise<CodeGraphProcessResult>;
}

export class NodeCodeGraphProcess implements CodeGraphProcessPort {
  run(request: CodeGraphProcessRequest): Promise<CodeGraphProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env["PATH"] ?? "" },
      });
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let timedOut = false;
      let outputExceeded = false;
      const append = (current: Buffer, chunk: Buffer): Buffer => {
        const combined = Buffer.concat([current, chunk]);
        if (combined.byteLength <= request.maxOutputBytes) return combined;
        outputExceeded = true;
        child.kill("SIGKILL");
        return combined.subarray(0, request.maxOutputBytes);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut, outputExceeded });
      });
    });
  }
}
