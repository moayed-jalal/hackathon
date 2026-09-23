import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

const API_KEY_PREFIX = "fb_test_";
const WEBHOOK_SECRET_PREFIX = "whsec_";
const SCRYPT_KEYLEN = 64;

/**
 * Generates a new sandbox API key. The full secret is returned exactly once
 * to the caller — only `prefix` and a salted scrypt hash of the secret are
 * ever persisted (see modules/merchants/service.ts).
 */
export function generateApiKey(): { fullKey: string; prefix: string } {
  const secret = randomBytes(24).toString("base64url");
  const fullKey = `${API_KEY_PREFIX}${secret}`;
  const prefix = fullKey.slice(0, 16);
  return { fullKey, prefix };
}

export function hashApiKey(fullKey: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(fullKey, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyApiKey(fullKey: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(fullKey, salt, SCRYPT_KEYLEN);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function extractKeyPrefix(fullKey: string): string {
  return fullKey.slice(0, 16);
}

export function isWellFormedApiKey(fullKey: string): boolean {
  return fullKey.startsWith(API_KEY_PREFIX) && fullKey.length > API_KEY_PREFIX.length + 8;
}

/**
 * Generates a merchant's webhook signing secret — distinct per merchant, and
 * always distinct from any internal provider secret (config.webhookSecrets).
 * Stored server-side in plaintext (see db/schema.ts merchants.webhookSecret)
 * since, unlike an API key, it must be reproduced to sign every delivery.
 */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
}

/** Signs `${timestamp}.${rawBody}` — the same string a receiver reconstructs to verify. */
export function signWebhookPayload(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyWebhookSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  const expected = signWebhookPayload(rawBody, timestamp, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
