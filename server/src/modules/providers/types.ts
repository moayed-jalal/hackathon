import type { PaymentStatus } from "../payment-intents/state-machine.js";

export interface ProviderCreateInput {
  paymentIntentId: string;
  amount: number;
  currency: string;
  scenario?: string;
}

/**
 * The normalized result every adapter must return. `providerStatus` keeps
 * the provider's own vocabulary (e.g. "settled", "accepted") for
 * observability; `canonicalStatus` is what FinBridge's public API and state
 * machine actually use. This mapping IS the interoperability story — see
 * docs/architecture.md.
 */
export interface ProviderResult {
  provider: string;
  providerStatus: string;
  canonicalStatus: Extract<PaymentStatus, "processing" | "succeeded" | "failed">;
  providerReference: string;
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: "sync" | "async";
  createPayment(input: ProviderCreateInput): Promise<ProviderResult>;
}
