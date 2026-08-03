import type {
  InjectionDeliveryAcknowledgement,
  InjectionDeliveryAcknowledgementPort,
  RuntimeAuditStorePort,
} from "./types.js";

/**
 * Narrow post-transport boundary. Generating additionalContext never calls this;
 * only the Hook client that accepted the response may provide delivery evidence.
 */
export class InjectionDeliveryAcknowledger implements InjectionDeliveryAcknowledgementPort {
  constructor(private readonly audits: Pick<RuntimeAuditStorePort, "acknowledgeInjectionDelivery">) {}

  acknowledge(request: InjectionDeliveryAcknowledgement) {
    return this.audits.acknowledgeInjectionDelivery(
      request.attemptId,
      request.expectedRevision,
      request.deliveryEvidenceRef,
      request.deliveredAt,
    );
  }
}
