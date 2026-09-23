import { ids } from "../../lib/ids.js";
import type { PaymentProvider, ProviderCreateInput, ProviderResult } from "./types.js";

/**
 * SimProviderB — asynchronous. `createPayment` only ever returns "pending"
 * (canonical: processing); the final success/failure outcome always arrives
 * later via a signed webhook (see modules/webhooks and modules/sandbox).
 * Internally this provider speaks "accepted" -> "pending" -> "settled" /
 * "rejected" — a different vocabulary than SimProviderA on purpose, to prove
 * the canonical API hides provider-specific behavior from merchants.
 */
export const simProviderB: PaymentProvider = {
  name: "sim_provider_b",
  mode: "async",

  async createPayment(input: ProviderCreateInput): Promise<ProviderResult> {
    const providerReference = `spb_${ids.webhookEventId().slice(-16)}`;
    return {
      provider: "sim_provider_b",
      providerStatus: "pending",
      canonicalStatus: "processing",
      providerReference,
      raw: { status: "accepted", nextStatus: "pending" },
    };
  },
};

/** Builds the webhook body SimProviderB "sends" once its async settlement completes. */
export function buildSimProviderBWebhookPayload(params: {
  paymentIntentId: string;
  providerReference: string;
  outcome: "succeeded" | "failed";
}) {
  const eventId = ids.webhookEventId();
  const providerStatus = params.outcome === "succeeded" ? "settled" : "rejected";
  return {
    eventId,
    body: {
      event_id: eventId,
      type: params.outcome === "succeeded" ? "payment.settled" : "payment.rejected",
      provider: "sim_provider_b",
      data: {
        payment_intent_id: params.paymentIntentId,
        provider_reference: params.providerReference,
        status: providerStatus,
      },
      created_at: new Date().toISOString(),
    },
  };
}
