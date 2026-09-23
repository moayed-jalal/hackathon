import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { ApiError } from "../../lib/errors.js";
import { ok, okList } from "../../lib/response.js";
import { putMerchantWebhookSchema } from "./schemas.js";
import {
  disableMerchantWebhookConfig,
  getMerchantWebhookConfig,
  listMerchantWebhookDeliveries,
  regenerateMerchantWebhookSecret,
  sendTestWebhook,
  serializeDelivery,
  serializeMerchantWebhookConfig,
  upsertMerchantWebhookUrl,
} from "./service.js";

/**
 * API-key authenticated merchant webhook configuration — the external-API
 * counterpart to the Console's session-authed /api/v1/console/webhook
 * routes. Every handler here is a thin wrapper: all outbox, signing, retry,
 * SSRF, and replay logic lives untouched in ./service.js. Ownership is
 * always `auth.merchantId` from the verified API key — never a client-
 * supplied merchant_id/workspace_id.
 */
export const merchantWebhookRoutes = new Hono();

merchantWebhookRoutes.get("/", requireAuth("webhooks:read"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const merchant = await getMerchantWebhookConfig(auth.merchantId);
  return ok(c, serializeMerchantWebhookConfig(merchant));
});

merchantWebhookRoutes.put("/", requireAuth("webhooks:write"), rateLimit, async (c) => {
  const auth = c.get("auth");

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON");
  }

  const parsed = putMerchantWebhookSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Request failed validation", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  const { merchant, secretRevealed } = await upsertMerchantWebhookUrl(
    auth.merchantId,
    parsed.data.url,
    parsed.data.enabled,
  );

  return ok(c, {
    ...serializeMerchantWebhookConfig(merchant),
    ...(secretRevealed ? { secret: secretRevealed } : {}),
  });
});

merchantWebhookRoutes.delete("/", requireAuth("webhooks:write"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const merchant = await disableMerchantWebhookConfig(auth.merchantId);
  return ok(c, serializeMerchantWebhookConfig(merchant));
});

merchantWebhookRoutes.post("/regenerate-secret", requireAuth("webhooks:write"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const { merchant, secret } = await regenerateMerchantWebhookSecret(auth.merchantId);
  return ok(c, { ...serializeMerchantWebhookConfig(merchant), secret });
});

merchantWebhookRoutes.post("/test", requireAuth("webhooks:write"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const result = await sendTestWebhook(auth.merchantId, c.get("requestId") as string);
  return ok(c, result);
});

merchantWebhookRoutes.get("/deliveries", requireAuth("webhooks:read"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const deliveries = await listMerchantWebhookDeliveries(auth.merchantId);
  return okList(c, deliveries.map(serializeDelivery));
});
