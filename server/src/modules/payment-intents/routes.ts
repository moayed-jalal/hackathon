import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { ApiError } from "../../lib/errors.js";
import { ok, okList } from "../../lib/response.js";
import { withIdempotency } from "../idempotency/service.js";
import {
  createPaymentIntentSchema,
  listPaymentIntentsQuerySchema,
} from "./schemas.js";
import {
  cancelPaymentIntent,
  createPaymentIntent,
  getPaymentIntent,
  getPaymentIntentTimeline,
  listPaymentIntents,
  serializePaymentIntent,
} from "./service.js";

export const paymentIntentRoutes = new Hono();

paymentIntentRoutes.post("/", requireAuth("payments:write"), rateLimit, async (c) => {
  const requestId = c.get("requestId") as string;
  const auth = c.get("auth");

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON");
  }

  const parsed = createPaymentIntentSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Request failed validation", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  const idempotencyKey = c.req.header("Idempotency-Key");

  const respond = async () => {
    const created = await createPaymentIntent(auth.merchantId, parsed.data, requestId);
    return { status: 201 as const, body: { data: serializePaymentIntent(created), request_id: requestId }, paymentIntentId: created.id };
  };

  if (!idempotencyKey) {
    const result = await respond();
    return c.json(result.body, result.status);
  }

  const { status, body } = await withIdempotency({
    merchantId: auth.merchantId,
    idempotencyKey,
    requestBody: parsed.data,
    requestId,
    handler: respond,
  });
  return c.json(body, status as 201);
});

paymentIntentRoutes.get("/", requireAuth("payments:read"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const parsed = listPaymentIntentsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Invalid query parameters", { issues: parsed.error.issues });
  }
  const rows = await listPaymentIntents(auth.merchantId, parsed.data);
  return okList(c, rows.map(serializePaymentIntent));
});

paymentIntentRoutes.get("/:id", requireAuth("payments:read"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const row = await getPaymentIntent(auth.merchantId, c.req.param("id"));
  return ok(c, serializePaymentIntent(row));
});

paymentIntentRoutes.get("/:id/timeline", requireAuth("payments:read"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const events = await getPaymentIntentTimeline(auth.merchantId, c.req.param("id"));
  return okList(
    c,
    events.map((event) => ({
      id: event.id,
      type: event.type,
      data: event.data,
      created_at: event.createdAt.toISOString(),
    })),
  );
});

paymentIntentRoutes.post("/:id/cancel", requireAuth("payments:write"), rateLimit, async (c) => {
  const requestId = c.get("requestId") as string;
  const auth = c.get("auth");
  const updated = await cancelPaymentIntent(auth.merchantId, c.req.param("id"), requestId);
  return ok(c, serializePaymentIntent(updated));
});
