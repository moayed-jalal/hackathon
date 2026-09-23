import { Hono } from "hono";
import { ok } from "../../lib/response.js";
import { processSimProviderBWebhook } from "./service.js";
import { serializePaymentIntent } from "../payment-intents/service.js";

export const webhookRoutes = new Hono();

/**
 * Provider -> platform direction: authenticated by HMAC signature, not a
 * merchant API key (a real payment provider doesn't hold your API key
 * either). See docs/security.md for the full verification contract.
 */
webhookRoutes.post("/sim-provider-b", async (c) => {
  const requestId = c.get("requestId") as string;
  const rawBody = await c.req.text();
  const signature = c.req.header("X-FinBridge-Signature");
  const timestamp = c.req.header("X-FinBridge-Timestamp");

  const result = await processSimProviderBWebhook(rawBody, { signature, timestamp }, requestId);

  return ok(c, {
    accepted: true,
    event_id: result.eventId,
    payment_intent: serializePaymentIntent(result.paymentIntent),
  });
});
