import { ids } from "../../lib/ids.js";
import type { PaymentProvider, ProviderCreateInput, ProviderResult } from "./types.js";

/**
 * SimProviderA — mostly synchronous. Returns an immediate, deterministic
 * result based on `scenario`. Its own vocabulary is "success" / "declined",
 * which we normalize to the canonical succeeded / failed statuses.
 */
export const simProviderA: PaymentProvider = {
  name: "sim_provider_a",
  mode: "sync",

  async createPayment(input: ProviderCreateInput): Promise<ProviderResult> {
    const scenario = input.scenario ?? "success";
    const providerReference = `spa_${ids.webhookEventId().slice(-16)}`;

    if (scenario === "declined") {
      return {
        provider: "sim_provider_a",
        providerStatus: "declined",
        canonicalStatus: "failed",
        providerReference,
        raw: { status: "declined", reason: "sandbox_simulated_decline" },
      };
    }

    return {
      provider: "sim_provider_a",
      providerStatus: "success",
      canonicalStatus: "succeeded",
      providerReference,
      raw: { status: "success" },
    };
  },
};
