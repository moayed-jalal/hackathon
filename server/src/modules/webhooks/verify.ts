import { verifyWebhookSignature } from "../../lib/crypto.js";

export type WebhookVerificationFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "invalid_signature";

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: WebhookVerificationFailure;
}

/**
 * Pure signature + freshness check — no I/O, so it's directly unit-testable.
 * Duplicate-event (replay) detection happens separately in service.ts, since
 * that requires a database round trip.
 */
export function verifyWebhookRequest(params: {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  toleranceSeconds: number;
  now?: number;
}): WebhookVerificationResult {
  if (!params.timestampHeader) return { valid: false, reason: "missing_timestamp" };

  const timestamp = Number(params.timestampHeader);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "invalid_timestamp" };

  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > params.toleranceSeconds) {
    return { valid: false, reason: "stale_timestamp" };
  }

  if (!params.signatureHeader) return { valid: false, reason: "missing_signature" };

  const valid = verifyWebhookSignature(
    params.rawBody,
    params.timestampHeader,
    params.signatureHeader,
    params.secret,
  );
  if (!valid) return { valid: false, reason: "invalid_signature" };

  return { valid: true };
}
