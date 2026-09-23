import { describe, expect, it } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  isWellFormedApiKey,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../../src/lib/crypto.js";

describe("API key hashing", () => {
  it("generates a recognizably-prefixed key", () => {
    const { fullKey, prefix } = generateApiKey();
    expect(fullKey.startsWith("fb_test_")).toBe(true);
    expect(fullKey.startsWith(prefix)).toBe(true);
    expect(isWellFormedApiKey(fullKey)).toBe(true);
  });

  it("verifies a hash against its own key and rejects the wrong key", () => {
    const { fullKey } = generateApiKey();
    const other = generateApiKey().fullKey;
    const hashed = hashApiKey(fullKey);

    expect(verifyApiKey(fullKey, hashed)).toBe(true);
    expect(verifyApiKey(other, hashed)).toBe(false);
  });

  it("never stores the plaintext key in the hash", () => {
    const { fullKey } = generateApiKey();
    const hashed = hashApiKey(fullKey);
    expect(hashed).not.toContain(fullKey);
  });

  it("rejects malformed keys", () => {
    expect(isWellFormedApiKey("not-a-key")).toBe(false);
    expect(isWellFormedApiKey("")).toBe(false);
  });
});

describe("webhook HMAC signing", () => {
  const secret = "whsec_test_secret";

  it("verifies a correctly signed payload", () => {
    const body = JSON.stringify({ hello: "world" });
    const timestamp = "1700000000";
    const signature = signWebhookPayload(body, timestamp, secret);
    expect(verifyWebhookSignature(body, timestamp, signature, secret)).toBe(true);
  });

  it("rejects a payload that was tampered with after signing", () => {
    const body = JSON.stringify({ amount: 100 });
    const timestamp = "1700000000";
    const signature = signWebhookPayload(body, timestamp, secret);
    const tamperedBody = JSON.stringify({ amount: 999999 });
    expect(verifyWebhookSignature(tamperedBody, timestamp, signature, secret)).toBe(false);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const body = JSON.stringify({ hello: "world" });
    const timestamp = "1700000000";
    const signature = signWebhookPayload(body, timestamp, "wrong_secret");
    expect(verifyWebhookSignature(body, timestamp, signature, secret)).toBe(false);
  });

  it("rejects a malformed (non-hex, wrong-length) signature without throwing", () => {
    const body = JSON.stringify({ hello: "world" });
    const timestamp = "1700000000";
    expect(() => verifyWebhookSignature(body, timestamp, "not-hex-garbage", secret)).not.toThrow();
    expect(verifyWebhookSignature(body, timestamp, "not-hex-garbage", secret)).toBe(false);
  });
});
