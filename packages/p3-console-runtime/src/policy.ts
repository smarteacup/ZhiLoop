import type { InjectionPolicy, RetrievalPolicy } from "@zhiloop/config";
import {
  fingerprintConsoleRetrievalPolicy,
  type ResolvedRetrievalPolicy,
  type RetrievalPolicyReference,
  type RetrievalPolicyResolver,
} from "@zhiloop/retrieval-query-service";

export type P3Consumer = "RETRIEVAL" | "CODEX_QUERY";
export type P3ConsumerState = "READY" | "DISABLED" | "NOT_CONFIGURED" | "NOT_VERIFIED" | "DEGRADED";

export interface ExplicitConsumerCapability {
  readonly state: P3ConsumerState;
  readonly reasonCode: string;
  readonly evidenceRefs: readonly string[];
}

export interface ExplicitP3PolicyRevision {
  readonly reference: RetrievalPolicyReference;
  readonly retrieval: RetrievalPolicy;
  readonly injection: InjectionPolicy;
  readonly consumers: Readonly<Record<P3Consumer, ExplicitConsumerCapability>>;
}

const REASON = /^[A-Z][A-Z0-9_]{0,99}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,499}$/u;

function key(reference: RetrievalPolicyReference): string {
  return `${reference.policyId}\0${reference.revision}\0${reference.fingerprint}\0${reference.source}`;
}

function validateCapability(value: ExplicitConsumerCapability): ExplicitConsumerCapability {
  if (!["READY", "DISABLED", "NOT_CONFIGURED", "NOT_VERIFIED", "DEGRADED"].includes(value.state)
    || !REASON.test(value.reasonCode) || value.evidenceRefs.length > 100
    || value.evidenceRefs.some((item) => !SAFE.test(item))) {
    throw new Error("P3 consumer capability evidence is invalid");
  }
  return Object.freeze({ ...value, evidenceRefs: Object.freeze([...value.evidenceRefs]) });
}

export class P3PolicyConsumerUnavailableError extends Error {
  override readonly name = "P3PolicyConsumerUnavailableError";
  constructor(
    readonly consumer: P3Consumer,
    readonly state: Exclude<P3ConsumerState, "READY">,
    readonly reasonCode: string,
  ) {
    super(`${consumer} consumer is ${state}: ${reasonCode}`);
  }
}

export class ExplicitP3PolicyResolver implements RetrievalPolicyResolver {
  readonly #revisions = new Map<string, ExplicitP3PolicyRevision>();

  constructor(revisions: readonly ExplicitP3PolicyRevision[]) {
    if (revisions.length < 1 || revisions.length > 10_000) throw new Error("explicit P3 policy revisions are required");
    for (const input of revisions) {
      if (fingerprintConsoleRetrievalPolicy(input.retrieval, input.injection) !== input.reference.fingerprint) {
        throw new Error("explicit P3 policy fingerprint does not match its retrieval and injection configuration");
      }
      const revision: ExplicitP3PolicyRevision = Object.freeze({
        reference: Object.freeze({ ...input.reference }),
        retrieval: structuredClone(input.retrieval),
        injection: structuredClone(input.injection),
        consumers: Object.freeze({
          RETRIEVAL: validateCapability(input.consumers.RETRIEVAL),
          CODEX_QUERY: validateCapability(input.consumers.CODEX_QUERY),
        }),
      });
      const identity = key(revision.reference);
      if (this.#revisions.has(identity)) throw new Error("duplicate explicit P3 policy revision");
      this.#revisions.set(identity, revision);
    }
  }

  resolve(reference: RetrievalPolicyReference): ResolvedRetrievalPolicy {
    this.requireReady(reference, "RETRIEVAL");
    const revision = this.#revisions.get(key(reference)) as ExplicitP3PolicyRevision;
    return {
      reference: structuredClone(revision.reference),
      retrieval: structuredClone(revision.retrieval),
      injection: structuredClone(revision.injection),
    };
  }

  capability(reference: RetrievalPolicyReference, consumer: P3Consumer): ExplicitConsumerCapability {
    const revision = this.#revisions.get(key(reference));
    if (revision === undefined) throw new Error("explicit P3 policy revision is unavailable");
    return structuredClone(revision.consumers[consumer]);
  }

  requireReady(reference: RetrievalPolicyReference, consumer: P3Consumer): ExplicitConsumerCapability {
    const capability = this.capability(reference, consumer);
    if (capability.state !== "READY") {
      throw new P3PolicyConsumerUnavailableError(consumer, capability.state, capability.reasonCode);
    }
    return capability;
  }
}
