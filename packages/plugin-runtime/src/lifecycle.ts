import { evaluateSidecarCompatibility } from "./compatibility.js";
import type {
  SidecarCompatibilityPolicy,
  SidecarControlPort,
  SidecarReadiness,
} from "./types.js";

export class SidecarLifecycleService {
  readonly #control: SidecarControlPort;
  readonly #policy: SidecarCompatibilityPolicy;
  #starting: Promise<SidecarReadiness> | undefined;

  constructor(control: SidecarControlPort, policy: SidecarCompatibilityPolicy) {
    this.#control = control;
    this.#policy = Object.freeze({ ...policy });
  }

  async ensureReady(signal: AbortSignal = new AbortController().signal): Promise<SidecarReadiness> {
    if (signal.aborted) throw signal.reason;
    const existing = await this.#control.health(signal);
    const currentReport = evaluateSidecarCompatibility(existing, this.#policy);
    if (existing !== undefined && currentReport.compatible) {
      return Object.freeze({ started: false, health: existing, compatibility: currentReport });
    }
    if (existing !== undefined) {
      return Object.freeze({ started: false, health: existing, compatibility: currentReport });
    }
    this.#starting ??= this.#start(signal).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(signal: AbortSignal): Promise<SidecarReadiness> {
    await this.#control.start(signal);
    if (signal.aborted) throw signal.reason;
    const health = await this.#control.health(signal);
    const compatibility = evaluateSidecarCompatibility(health, this.#policy);
    return Object.freeze({ started: true, ...(health === undefined ? {} : { health }), compatibility });
  }
}
