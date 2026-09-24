import { eq } from "drizzle-orm";
import { Agent, fetch as undiciFetch } from "undici";
import { isIP } from "node:net";
import { db } from "../../db/client.js";
import { merchants, merchantWebhookDeliveries } from "../../db/schema.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { ids } from "../../lib/ids.js";
import { ApiError } from "../../lib/errors.js";
import { generateWebhookSecret, signWebhookPayload } from "../../lib/crypto.js";
import { assertPublicWebhookUrl, UnsafeWebhookUrlError } from "../../lib/webhookUrlSafety.js";
import { publishConsoleEvent } from "../console/events.js";
import type { paymentIntents, PAYMENT_STATUSES } from "../../db/schema.js";

type PaymentIntentRow = typeof paymentIntents.$inferSelect;
type MerchantRow = typeof merchants.$inferSelect;
type DeliveryRow = typeof merchantWebhookDeliveries.$inferSelect;
type TerminalStatus = Extract<(typeof PAYMENT_STATUSES)[number], "succeeded" | "failed" | "cancelled">;

const MAX_ATTEMPTS = 3;
/**
 * Delay before retry #2 and retry #3, respectively — short and bounded,
 * appropriate for a live demo. Overridable via env (same convention as
 * middleware/rateLimit.ts's RATE_LIMIT_* vars) so tests can exercise
 * backoff/timeout behavior without real multi-second waits.
 */
const RETRY_BACKOFF_MS = (process.env.MERCHANT_WEBHOOK_RETRY_BACKOFF_MS ?? "2000,5000")
  .split(",")
  .map(Number);
const DELIVERY_TIMEOUT_MS = Number(process.env.MERCHANT_WEBHOOK_TIMEOUT_MS ?? 8000);

/** Public, merchant-facing vocabulary — never the internal AUDIT_EVENT_TYPES strings (see docs/architecture.md). */
const EVENT_TYPE_BY_TRANSITION: Record<TerminalStatus, "payment.succeeded" | "payment.failed" | "payment.cancelled"> = {
  succeeded: "payment.succeeded",
  failed: "payment.failed",
  cancelled: "payment.cancelled",
};

function allowLocalhostHttp(): boolean {
  return config.nodeEnv !== "production";
}

/** Realtime Console notification for the Webhooks page's delivery list — see modules/console/events.ts. */
function publishDeliveryEvent(delivery: {
  id: string;
  merchantId: string;
  paymentIntentId: string | null;
  status: string;
}) {
  publishConsoleEvent({
    id: ids.consoleEventId(),
    type: "webhook.delivery_recorded",
    delivery_id: delivery.id,
    merchant_id: delivery.merchantId,
    payment_intent_id: delivery.paymentIntentId,
    status: delivery.status,
    created_at: new Date().toISOString(),
  });
}

function maskSecret(secret: string): string {
  return `whsec_${"•".repeat(8)}${secret.slice(-4)}`;
}

export function serializeMerchantWebhookConfig(merchant: MerchantRow) {
  return {
    url: merchant.webhookUrl,
    enabled: merchant.webhookEnabled,
    configured: Boolean(merchant.webhookUrl && merchant.webhookSecret),
    secret_preview: merchant.webhookSecret ? maskSecret(merchant.webhookSecret) : null,
    events: Object.values(EVENT_TYPE_BY_TRANSITION),
  };
}

export function serializeDelivery(row: DeliveryRow) {
  return {
    id: row.id,
    payment_intent_id: row.paymentIntentId,
    event_type: row.eventType,
    endpoint_url: row.endpointUrl,
    attempt_count: row.attemptCount,
    status: row.status,
    http_status: row.httpStatus,
    last_error: row.lastError,
    created_at: row.createdAt.toISOString(),
    last_attempt_at: row.lastAttemptAt?.toISOString() ?? null,
    next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
  };
}

async function getMerchantOrThrow(merchantId: string): Promise<MerchantRow> {
  const merchant = await db.query.merchants.findFirst({ where: eq(merchants.id, merchantId) });
  if (!merchant) throw new ApiError("NOT_FOUND", `Merchant not found: ${merchantId}`);
  return merchant;
}

export async function getMerchantWebhookConfig(merchantId: string) {
  return getMerchantOrThrow(merchantId);
}

/**
 * Creates or updates the merchant's webhook URL. A signing secret is
 * generated once, the first time a merchant configures a URL, and then kept
 * stable across future URL edits — rotating it silently on every save would
 * break a merchant's existing signature verification. `secretRevealed` is
 * only set when a secret was just (re)created, so the route can show it
 * exactly once.
 */
export async function upsertMerchantWebhookUrl(
  merchantId: string,
  url: string,
  enabled: boolean | undefined,
): Promise<{ merchant: MerchantRow; secretRevealed: string | null }> {
  try {
    await assertPublicWebhookUrl(url, { allowLocalhostHttp: allowLocalhostHttp() });
  } catch (err) {
    if (err instanceof UnsafeWebhookUrlError) {
      throw new ApiError("VALIDATION_ERROR", err.message);
    }
    throw err;
  }

  const existing = await getMerchantOrThrow(merchantId);
  const secretRevealed = existing.webhookSecret ? null : generateWebhookSecret();

  const [updated] = await db
    .update(merchants)
    .set({
      webhookUrl: url,
      webhookEnabled: enabled ?? true,
      webhookSecret: existing.webhookSecret ?? secretRevealed,
    })
    .where(eq(merchants.id, merchantId))
    .returning();
  if (!updated) throw new Error("Failed to update merchant webhook configuration");

  return { merchant: updated, secretRevealed };
}

export async function regenerateMerchantWebhookSecret(merchantId: string): Promise<{ merchant: MerchantRow; secret: string }> {
  await getMerchantOrThrow(merchantId);
  const secret = generateWebhookSecret();
  const [updated] = await db
    .update(merchants)
    .set({ webhookSecret: secret })
    .where(eq(merchants.id, merchantId))
    .returning();
  if (!updated) throw new Error("Failed to regenerate merchant webhook secret");
  return { merchant: updated, secret };
}

export async function disableMerchantWebhookConfig(merchantId: string): Promise<MerchantRow> {
  await getMerchantOrThrow(merchantId);
  const [updated] = await db
    .update(merchants)
    .set({ webhookUrl: null, webhookSecret: null, webhookEnabled: false })
    .where(eq(merchants.id, merchantId))
    .returning();
  if (!updated) throw new Error("Failed to clear merchant webhook configuration");
  return updated;
}

export async function listMerchantWebhookDeliveries(merchantId: string, limit = 50) {
  return db.query.merchantWebhookDeliveries.findMany({
    where: eq(merchantWebhookDeliveries.merchantId, merchantId),
    orderBy: (d, { desc }) => desc(d.createdAt),
    limit,
  });
}

function buildEventPayload(eventId: string, eventType: string, data: Record<string, unknown>) {
  return {
    id: eventId,
    type: eventType,
    created_at: new Date().toISOString(),
    data,
  };
}

function paymentIntentEventData(pi: PaymentIntentRow) {
  return {
    payment_intent_id: pi.id,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    provider: pi.provider,
    reference: pi.reference,
    provider_reference: pi.providerReference,
    failure_reason: pi.failureReason,
  };
}

/**
 * Outbox step: persists a "pending" delivery row (fast, local, always
 * succeeds if the merchant has webhooks enabled) and only then kicks off the
 * network attempt in the background — the caller (payment-intents/service.ts
 * `applyTransition`, the single choke point for every status change) never
 * waits on the merchant's server. A no-op when the merchant hasn't
 * configured (or has disabled) a webhook.
 */
export async function enqueueMerchantWebhookEvent(
  paymentIntent: PaymentIntentRow,
  transitionTo: TerminalStatus,
  requestId: string,
): Promise<void> {
  const merchant = await db.query.merchants.findFirst({ where: eq(merchants.id, paymentIntent.merchantId) });
  if (!merchant?.webhookEnabled || !merchant.webhookUrl || !merchant.webhookSecret) return;

  const eventId = ids.webhookEventId();
  const eventType = EVENT_TYPE_BY_TRANSITION[transitionTo];
  const payload = buildEventPayload(eventId, eventType, paymentIntentEventData(paymentIntent));

  await db.insert(merchantWebhookDeliveries).values({
    id: eventId,
    merchantId: merchant.id,
    paymentIntentId: paymentIntent.id,
    eventType,
    endpointUrl: merchant.webhookUrl,
    payload,
    status: "pending",
  });
  publishDeliveryEvent({ id: eventId, merchantId: merchant.id, paymentIntentId: paymentIntent.id, status: "pending" });

  scheduleDeliveryAttempt(eventId, 0, requestId);
}

export function scheduleDeliveryAttempt(deliveryId: string, delayMs: number, requestId: string) {
  setTimeout(() => {
    void attemptDelivery(deliveryId, requestId).catch((err) => {
      logger.error("Merchant webhook delivery attempt threw unexpectedly", {
        deliveryId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, delayMs);
}

/**
 * A single delivery attempt. Re-validates the target URL fresh (closing the
 * DNS-rebinding window between config-save and this exact request) and pins
 * the outbound connection to that validated IP, so undici can't be tricked
 * into re-resolving to a different, unvalidated address at connect time.
 * Never follows redirects — a redirect target would need this same
 * validation before it could be trusted, and chasing it blindly is exactly
 * the SSRF footgun this function exists to avoid.
 *
 * `chainRetries` (default true) schedules the next backoff attempt on
 * failure — tests pass `false` to observe one attempt's outcome in
 * isolation without waiting on real timers.
 */
export async function attemptDelivery(
  deliveryId: string,
  requestId: string,
  options: { chainRetries?: boolean } = {},
): Promise<{ success: boolean; httpStatus?: number; error?: string }> {
  const chainRetries = options.chainRetries ?? true;

  const delivery = await db.query.merchantWebhookDeliveries.findFirst({
    where: eq(merchantWebhookDeliveries.id, deliveryId),
  });
  if (!delivery || delivery.status === "delivered") {
    return { success: delivery?.status === "delivered" };
  }

  const merchant = await db.query.merchants.findFirst({ where: eq(merchants.id, delivery.merchantId) });
  if (!merchant?.webhookEnabled || !merchant.webhookUrl || !merchant.webhookSecret) {
    await db
      .update(merchantWebhookDeliveries)
      .set({ status: "failed", lastError: "Webhook was disabled before this event could be delivered", lastAttemptAt: new Date() })
      .where(eq(merchantWebhookDeliveries.id, deliveryId));
    return { success: false, error: "webhook_disabled" };
  }

  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(rawBody, timestamp, merchant.webhookSecret);

  const attemptCount = delivery.attemptCount + 1;
  const result = await deliverOnce(merchant.webhookUrl, rawBody, timestamp, signature, delivery.id, requestId);

  const success = result.success;
  const isFinal = success || attemptCount >= MAX_ATTEMPTS;
  const nextStatus = success ? "delivered" : isFinal ? "failed" : "pending";

  await db
    .update(merchantWebhookDeliveries)
    .set({
      attemptCount,
      httpStatus: result.httpStatus ?? null,
      lastError: success ? null : result.error ?? "Unknown delivery error",
      status: nextStatus,
      lastAttemptAt: new Date(),
      nextAttemptAt: !success && !isFinal ? new Date(Date.now() + RETRY_BACKOFF_MS[attemptCount - 1]!) : null,
    })
    .where(eq(merchantWebhookDeliveries.id, deliveryId));
  publishDeliveryEvent({
    id: delivery.id,
    merchantId: delivery.merchantId,
    paymentIntentId: delivery.paymentIntentId,
    status: nextStatus,
  });

  if (!success && !isFinal && chainRetries) {
    scheduleDeliveryAttempt(deliveryId, RETRY_BACKOFF_MS[attemptCount - 1]!, requestId);
  }

  return result;
}

async function deliverOnce(
  urlString: string,
  rawBody: string,
  timestamp: string,
  signature: string,
  eventId: string,
  requestId: string,
): Promise<{ success: boolean; httpStatus?: number; error?: string }> {
  let validatedIp: string;
  let url: URL;
  try {
    const validated = await assertPublicWebhookUrl(urlString, { allowLocalhostHttp: allowLocalhostHttp() });
    url = validated.url;
    validatedIp = validated.validatedIp;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Webhook URL is no longer safe to deliver to" };
  }

  const family = isIP(validatedIp) === 6 ? 6 : 4;
  // Pin the connection to the exact IP we just validated instead of letting
  // undici re-resolve DNS itself — this is what actually closes the
  // DNS-rebinding gap (see lib/webhookUrlSafety.ts's module doc comment).
  // Node's net.connect calls lookup with `{ all: true }` whenever
  // autoSelectFamily (Happy Eyeballs) is on — the default since Node 20 — and
  // then expects an array of `{ address, family }`. Answering that call with a
  // bare string fails every hostname-based delivery with
  // ERR_INVALID_IP_ADDRESS ("Invalid IP address: undefined") before any
  // packet is sent, so both callback shapes must be honoured.
  const pinnedLookup = (
    _hostname: string,
    opts: { all?: boolean } | undefined,
    callback: (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    if (opts?.all) callback(null, [{ address: validatedIp, family }]);
    else callback(null, validatedIp, family);
  };

  const dispatcher = new Agent({
    connect: { timeout: DELIVERY_TIMEOUT_MS, lookup: pinnedLookup } as never,
  });

  try {
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FinBridge-Signature": signature,
        "X-FinBridge-Timestamp": timestamp,
        "X-FinBridge-Event-Id": eventId,
      },
      body: rawBody,
      redirect: "manual",
      dispatcher,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (res.status >= 200 && res.status < 300) {
      return { success: true, httpStatus: res.status };
    }
    return { success: false, httpStatus: res.status, error: `Merchant endpoint responded with HTTP ${res.status}` };
  } catch (err) {
    // undici wraps every network failure as a bare "fetch failed" TypeError;
    // the actionable reason (ECONNREFUSED, ETIMEDOUT, TLS errors, ...) lives
    // on the cause chain, so surface it in both the log and the stored error.
    const message = describeFetchError(err);
    logger.warn("Merchant webhook delivery attempt failed", { requestId, eventId, error: message });
    return { success: false, error: message };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

/** Flattens an error and its `cause` chain into one line, e.g. "fetch failed: connect ECONNREFUSED 1.2.3.4:443". */
function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(typeof code === "string" && !current.message.includes(code) ? `${current.message} (${code})` : current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(": ");
}

/**
 * A safe, one-shot "does my webhook actually work" check — sends a
 * `webhook.test` event with no real payment data, makes exactly one
 * attempt (no background retry chain), and returns the outcome directly so
 * the Console can show it immediately.
 */
export async function sendTestWebhook(merchantId: string, requestId: string) {
  const merchant = await getMerchantOrThrow(merchantId);
  if (!merchant.webhookEnabled || !merchant.webhookUrl || !merchant.webhookSecret) {
    throw new ApiError("VALIDATION_ERROR", "Configure and enable a webhook URL before sending a test event");
  }

  const eventId = ids.webhookEventId();
  const payload = buildEventPayload(eventId, "webhook.test", {
    message: "This is a test event from FinBridge — no real payment is associated with it.",
  });

  await db.insert(merchantWebhookDeliveries).values({
    id: eventId,
    merchantId: merchant.id,
    paymentIntentId: null,
    eventType: "webhook.test",
    endpointUrl: merchant.webhookUrl,
    payload,
    status: "pending",
  });

  const result = await attemptDelivery(eventId, requestId, { chainRetries: false });
  return { event_id: eventId, ...result };
}
