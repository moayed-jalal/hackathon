import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { webhookEvents } from "../../db/schema.js";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { signWebhookPayload } from "../../lib/crypto.js";
import { getPaymentIntent } from "../payment-intents/service.js";
import { buildSimProviderBWebhookPayload } from "../providers/simProviderB.js";

interface WebhookCallResult {
  status: number;
  body: unknown;
}

async function postToWebhookEndpoint(
  rawBody: string,
  signature: string,
  timestamp: string,
): Promise<WebhookCallResult> {
  const response = await fetch(`http://localhost:${config.port}/api/v1/webhooks/sim-provider-b`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-FinBridge-Signature": signature,
      "X-FinBridge-Timestamp": timestamp,
    },
    body: rawBody,
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

/**
 * Sandbox-only control plane: lets a merchant (or the demo script) drive
 * SimProviderB's async settlement and exercise webhook security paths on
 * demand, deterministically — see docs/demo.md.
 */
export async function simulateSimProviderBWebhook(
  merchantId: string,
  paymentIntentId: string,
  outcome: "succeeded" | "failed",
): Promise<WebhookCallResult> {
  const paymentIntent = await getPaymentIntent(merchantId, paymentIntentId);
  if (paymentIntent.provider !== "sim_provider_b") {
    throw new ApiError("INVALID_REQUEST", "Webhook simulation only applies to sim_provider_b payments");
  }
  if (paymentIntent.status !== "processing") {
    throw new ApiError(
      "INVALID_STATE_TRANSITION",
      `Payment intent is "${paymentIntent.status}", not awaiting a webhook`,
    );
  }

  const { body } = buildSimProviderBWebhookPayload({
    paymentIntentId,
    providerReference: paymentIntent.providerReference ?? `spb_${paymentIntentId}`,
    outcome,
  });
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);

  return postToWebhookEndpoint(rawBody, signature, timestamp);
}

async function getLastWebhookEvent(merchantId: string, paymentIntentId: string) {
  await getPaymentIntent(merchantId, paymentIntentId); // ownership check
  const event = await db.query.webhookEvents.findFirst({
    where: eq(webhookEvents.paymentIntentId, paymentIntentId),
    orderBy: desc(webhookEvents.receivedAt),
  });
  if (!event) {
    throw new ApiError("NOT_FOUND", "No webhook has been delivered for this payment intent yet");
  }
  return event;
}

/** Resends the exact last webhook byte-for-byte. Expected outcome: 409 duplicate event. */
export async function replayLastWebhook(
  merchantId: string,
  paymentIntentId: string,
): Promise<WebhookCallResult> {
  const event = await getLastWebhookEvent(merchantId, paymentIntentId);
  return postToWebhookEndpoint(event.rawBody, event.signature, event.timestampHeader);
}

/** Mutates the last webhook's body but keeps its original signature. Expected outcome: 401 invalid signature. */
export async function sendTamperedWebhook(
  merchantId: string,
  paymentIntentId: string,
): Promise<WebhookCallResult> {
  const event = await getLastWebhookEvent(merchantId, paymentIntentId);
  const original = JSON.parse(event.rawBody) as { data: { status: string } };
  const tampered = {
    ...original,
    data: { ...original.data, status: original.data.status === "settled" ? "rejected" : "settled" },
  };
  const tamperedRawBody = JSON.stringify(tampered);
  return postToWebhookEndpoint(tamperedRawBody, event.signature, event.timestampHeader);
}
