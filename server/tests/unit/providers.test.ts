import { describe, expect, it } from "vitest";
import { simProviderA } from "../../src/modules/providers/simProviderA.js";
import {
  simProviderB,
  buildSimProviderBWebhookPayload,
  simProviderBSettlementOutcome,
} from "../../src/modules/providers/simProviderB.js";
import { getProvider, listProviders } from "../../src/modules/providers/registry.js";
import { ApiError } from "../../src/lib/errors.js";

describe("SimProviderA (synchronous)", () => {
  it("normalizes its own 'success' vocabulary to canonical 'succeeded'", async () => {
    const result = await simProviderA.createPayment({ paymentIntentId: "pi_1", amount: 100, currency: "USD" });
    expect(result.providerStatus).toBe("success");
    expect(result.canonicalStatus).toBe("succeeded");
  });

  it("normalizes its own 'declined' vocabulary to canonical 'failed'", async () => {
    const result = await simProviderA.createPayment({
      paymentIntentId: "pi_1",
      amount: 100,
      currency: "USD",
      scenario: "declined",
    });
    expect(result.providerStatus).toBe("declined");
    expect(result.canonicalStatus).toBe("failed");
  });
});

describe("SimProviderB (asynchronous)", () => {
  it("always returns canonical 'processing' immediately, regardless of scenario", async () => {
    const result = await simProviderB.createPayment({
      paymentIntentId: "pi_2",
      amount: 100,
      currency: "USD",
      scenario: "succeeded",
    });
    expect(result.providerStatus).toBe("pending");
    expect(result.canonicalStatus).toBe("processing");
  });

  it("builds a 'settled' webhook payload for a succeeded outcome", () => {
    const { body } = buildSimProviderBWebhookPayload({
      paymentIntentId: "pi_2",
      providerReference: "spb_abc",
      outcome: "succeeded",
    });
    expect(body.data.status).toBe("settled");
    expect(body.type).toBe("payment.settled");
  });

  it("builds a 'rejected' webhook payload for a failed outcome", () => {
    const { body } = buildSimProviderBWebhookPayload({
      paymentIntentId: "pi_2",
      providerReference: "spb_abc",
      outcome: "failed",
    });
    expect(body.data.status).toBe("rejected");
    expect(body.type).toBe("payment.rejected");
  });

  it("settles as succeeded by default and failed for failure scenarios", () => {
    expect(simProviderBSettlementOutcome(undefined)).toBe("succeeded");
    expect(simProviderBSettlementOutcome(null)).toBe("succeeded");
    expect(simProviderBSettlementOutcome("succeeded")).toBe("succeeded");
    expect(simProviderBSettlementOutcome("failed")).toBe("failed");
    expect(simProviderBSettlementOutcome("declined")).toBe("failed");
    expect(simProviderBSettlementOutcome("rejected")).toBe("failed");
  });

  it("never settles on its own for the 'manual' scenario", () => {
    expect(simProviderBSettlementOutcome("manual")).toBeNull();
  });
});

describe("provider registry", () => {
  it("resolves both simulated providers by name", () => {
    expect(getProvider("sim_provider_a").name).toBe("sim_provider_a");
    expect(getProvider("sim_provider_b").name).toBe("sim_provider_b");
  });

  it("lists exactly the registered providers", () => {
    expect(listProviders().map((p) => p.name).sort()).toEqual(["sim_provider_a", "sim_provider_b"]);
  });

  it("throws a typed ApiError for an unknown provider", () => {
    expect(() => getProvider("real_bank_of_somewhere")).toThrow(ApiError);
  });
});
