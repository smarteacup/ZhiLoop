import { spawn } from "node:child_process";
import process from "node:process";

import type { DeploymentPaths, ServiceController } from "./types.js";

const LAUNCH_AGENT_LABEL = "dev.zhiloop.sidecar";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderLaunchAgent(paths: DeploymentPaths): string {
  const argumentsList = [paths.sidecarLauncher, "serve", "--config", paths.configPath]
    .map((value) => `      <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsList}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(paths.serviceStdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(paths.serviceStderrPath)}</string>
  </dict>
</plist>
`;
}

interface CommandResult {
  readonly code: number;
  readonly stderr: string;
}

export interface MacOsLaunchctlDependencies {
  readonly run?: (argumentsList: readonly string[]) => Promise<CommandResult>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

async function runLaunchctl(argumentsList: readonly string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn("/bin/launchctl", [...argumentsList], {
      stdio: ["ignore", "ignore", "pipe"], env: {}, signal: AbortSignal.timeout(5_000),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr: stderr.replace(/[\0\r\n]/gu, " ").slice(0, 500) }));
  });
}

export class MacOsLaunchctlController implements ServiceController {
  readonly #domain: string;
  readonly #service: string;
  readonly #run: (argumentsList: readonly string[]) => Promise<CommandResult>;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(uid: number = process.getuid?.() ?? -1, dependencies: MacOsLaunchctlDependencies = {}) {
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("a valid user id is required for launchd");
    this.#domain = `gui/${uid}`;
    this.#service = `${this.#domain}/${LAUNCH_AGENT_LABEL}`;
    this.#run = dependencies.run ?? runLaunchctl;
    this.#sleep = dependencies.sleep ?? (async (milliseconds) => await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  }

  async bootstrap(plistPath: string): Promise<void> {
    let last: CommandResult | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await this.#run(["bootstrap", this.#domain, plistPath]);
      if (result.code === 0 || await this.status() === "RUNNING") return;
      last = result;
      if (result.code !== 5 && !/input.?output error/iu.test(result.stderr)) break;
      await this.#sleep(100 * (attempt + 1));
    }
    throw new Error(`launchctl bootstrap failed: ${last?.stderr || last?.code || "unknown"}`);
  }

  async kickstart(): Promise<void> {
    if (await this.status() === "RUNNING") return;
    let last: CommandResult | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await this.#run(["kickstart", "-k", this.#service]);
      if (result.code === 0 || await this.status() === "RUNNING") return;
      last = result;
      if (result.code !== 5 && result.code !== 37 && !/input.?output error|operation.*progress/iu.test(result.stderr)) break;
      await this.#sleep(100 * (attempt + 1));
    }
    throw new Error(`launchctl kickstart failed: ${last?.stderr || last?.code || "unknown"}`);
  }

  async bootout(): Promise<void> {
    const result = await this.#run(["bootout", this.#service]);
    if (result.code !== 0 && !/could not find service|no such process|not found/iu.test(result.stderr)) {
      throw new Error(`launchctl bootout failed: ${result.stderr || result.code}`);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await this.status() === "STOPPED") return;
      await this.#sleep(100 * (attempt + 1));
    }
    throw new Error("launchctl bootout did not reach STOPPED state");
  }

  async status(): Promise<"RUNNING" | "STOPPED" | "UNKNOWN"> {
    const result = await this.#run(["print", this.#service]);
    if (result.code === 0) return "RUNNING";
    return /could not find service|no such process|not found/iu.test(result.stderr) ? "STOPPED" : "UNKNOWN";
  }
}
