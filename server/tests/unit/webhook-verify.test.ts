import { describe, expect, it } from "vitest";
import { verifyWebhookRequest } from "../../src/modules/webhooks/verify.js";
import { signWebhookPayload } from "../../src/lib/crypto.js";

const secret = "whsec_test";
const rawBody = JSON.stringify({ event_id: "evt_1" });

describe("verifyWebhookRequest", () => {
  it("accepts a fresh, correctly signed request", () => {
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const signature = signWebhookPayload(rawBody, timestamp, secret);

    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: signature,
      timestampHeader: timestamp,
      secret,
      toleranceSeconds: 300,
      now,
    });

    expect(result.valid).toBe(true);
  });

  it("rejects a missing signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: undefined,
      timestampHeader: timestamp,
      secret,
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("rejects a missing timestamp", () => {
    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: "deadbeef",
      timestampHeader: undefined,
      secret,
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ valid: false, reason: "missing_timestamp" });
  });

  it("rejects a stale timestamp outside tolerance", () => {
    const now = 1_700_000_000_000;
    const staleTimestamp = String(Math.floor(now / 1000) - 3600); // 1 hour old
    const signature = signWebhookPayload(rawBody, staleTimestamp, secret);

    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: signature,
      timestampHeader: staleTimestamp,
      secret,
      toleranceSeconds: 300,
      now,
    });
    expect(result).toEqual({ valid: false, reason: "stale_timestamp" });
  });

  it("rejects an invalid signature even with a fresh timestamp", () => {
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const result = verifyWebhookRequest({
      rawBody,
      signatureHeader: "0".repeat(64),
      timestampHeader: timestamp,
      secret,
      toleranceSeconds: 300,
      now,
    });
    expect(result).toEqual({ valid: false, reason: "invalid_signature" });
  });
});
