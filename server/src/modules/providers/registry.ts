import { ApiError } from "../../lib/errors.js";
import { simProviderA } from "./simProviderA.js";
import { simProviderB } from "./simProviderB.js";
import type { PaymentProvider } from "./types.js";

/**
 * The only place that knows which providers exist. Adding a third provider
 * means writing an adapter that satisfies PaymentProvider and registering it
 * here — the public API, state machine, and dashboard never change.
 */
const providers: Record<string, PaymentProvider> = {
  sim_provider_a: simProviderA,
  sim_provider_b: simProviderB,
};

export function getProvider(name: string): PaymentProvider {
  const provider = providers[name];
  if (!provider) {
    throw new ApiError("INVALID_REQUEST", `Unknown provider: ${name}`, {
      allowed: Object.keys(providers),
    });
  }
  return provider;
}

export function listProviders(): PaymentProvider[] {
  return Object.values(providers);
}
