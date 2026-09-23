import { describe, expect, it } from "vitest";
import { createPaymentIntentSchema } from "../../src/modules/payment-intents/schemas.js";
import { hashRequestBody } from "../../src/lib/stableHash.js";

describe("createPaymentIntentSchema", () => {
  it("accepts a valid payload", () => {
    const result = createPaymentIntentSchema.safeParse({
      amount: 15000,
      currency: "LYD",
      provider: "sim_provider_a",
      scenario: "success",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive amount", () => {
    const result = createPaymentIntentSchema.safeParse({ amount: 0, currency: "USD", provider: "sim_provider_a" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative amount", () => {
    const result = createPaymentIntentSchema.safeParse({ amount: -100, currency: "USD", provider: "sim_provider_a" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer amount", () => {
    const result = createPaymentIntentSchema.safeParse({ amount: 15.5, currency: "USD", provider: "sim_provider_a" });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported currency", () => {
    const result = createPaymentIntentSchema.safeParse({ amount: 100, currency: "XXX", provider: "sim_provider_a" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown provider", () => {
    const result = createPaymentIntentSchema.safeParse({ amount: 100, currency: "USD", provider: "real_bank" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const result = createPaymentIntentSchema.safeParse({
      amount: 100,
      currency: "USD",
      provider: "sim_provider_a",
      bank_account_number: "1234567890",
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed JSON shapes gracefully (missing required fields)", () => {
    const result = createPaymentIntentSchema.safeParse({ amount: 100 });
    expect(result.success).toBe(false);
  });
});

describe("hashRequestBody", () => {
  it("produces the same hash regardless of key order", () => {
    const a = hashRequestBody({ amount: 100, currency: "USD" });
    const b = hashRequestBody({ currency: "USD", amount: 100 });
    expect(a).toBe(b);
  });

  it("produces a different hash for different content", () => {
    const a = hashRequestBody({ amount: 100, currency: "USD" });
    const b = hashRequestBody({ amount: 200, currency: "USD" });
    expect(a).not.toBe(b);
  });
});
