import type {
  InjectionActivationEvidence,
  InjectionRolloutMode,
  InjectionRolloutSnapshot,
} from "./types.js";

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    && !/[\0\r\n]/u.test(value);
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function validEvidence(value: InjectionActivationEvidence | undefined): value is InjectionActivationEvidence {
  return value !== undefined && validText(value.datasetId, 500)
    && Number.isSafeInteger(value.datasetVersion) && value.datasetVersion > 0
    && /^sha256:[a-f0-9]{64}$/u.test(value.configFingerprint) && value.defaultInjectionAllowed === true;
}

export class InjectionRolloutController {
  private current: InjectionRolloutSnapshot = freeze({ revision: 0, mode: "OFF" });

  get snapshot(): InjectionRolloutSnapshot {
    return this.current;
  }

  activate(revision: number, mode: InjectionRolloutMode, evidence?: InjectionActivationEvidence): InjectionRolloutSnapshot {
    if (!Number.isSafeInteger(revision) || revision <= this.current.revision) {
      throw new Error("rollout revision must increase monotonically");
    }
    if (!(["OFF", "SHADOW", "ACTIVE"] as const).includes(mode)) throw new Error("rollout mode is invalid");
    if (mode === "ACTIVE" && !validEvidence(evidence)) {
      throw new Error("ACTIVE rollout requires passing Golden Dataset evidence");
    }
    this.current = freeze(structuredClone({
      revision, mode,
      ...(mode === "ACTIVE" ? { evidence: evidence as InjectionActivationEvidence } : {}),
    }));
    return this.current;
  }

  rollback(revision: number): InjectionRolloutSnapshot {
    return this.activate(revision, "OFF");
  }
}
