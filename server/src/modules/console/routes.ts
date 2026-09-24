import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireSession } from "../../middleware/sessionAuth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { ApiError } from "../../lib/errors.js";
import { ok, okList } from "../../lib/response.js";
import { db } from "../../db/client.js";
import { auditEvents, paymentIntents, paymentIntentEvents, providerConfigurations, merchants, webhookEvents } from "../../db/schema.js";
import { listAuditEvents } from "../audit/service.js";
import { processSimProviderBWebhook } from "../webhooks/service.js";
import { buildSimProviderBWebhookPayload } from "../providers/simProviderB.js";
import { signWebhookPayload } from "../../lib/crypto.js";
import { config } from "../../config.js";
import { withIdempotency } from "../idempotency/service.js";
import { createPaymentIntentSchema, simulateWebhookSchema } from "../payment-intents/schemas.js";
import { applyTransition, createPaymentIntent, serializePaymentIntent } from "../payment-intents/service.js";
import type { PaymentStatus } from "../payment-intents/state-machine.js";
import { createApiKeyForMerchant, listApiKeysForMerchant, revokeApiKey } from "../merchants/service.js";
import { putMerchantWebhookSchema } from "../merchant-webhooks/schemas.js";
import {
  disableMerchantWebhookConfig,
  getMerchantWebhookConfig,
  listMerchantWebhookDeliveries,
  regenerateMerchantWebhookSecret,
  sendTestWebhook,
  serializeDelivery,
  serializeMerchantWebhookConfig,
  upsertMerchantWebhookUrl,
} from "../merchant-webhooks/service.js";
import { subscribeConsoleEvents, subscribeGlobalConsoleEvents, type ConsoleEvent, type GlobalConsoleEvent } from "./events.js";

export const consoleRoutes = new Hono();

const SSE_HEARTBEAT_MS = 20000;

/**
 * Realtime push for the Console — scoped strictly to the authenticated
 * session's own merchant (never a client-supplied id), so one connection
 * can only ever see its own tenant's events. REST remains authoritative:
 * the frontend loads current state via the normal GET endpoints first and
 * treats this stream purely as a "something changed, go check" signal.
 */
consoleRoutes.get("/events", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");

  return streamSSE(c, async (stream) => {
    let closed = false;
    let unsubscribe = () => {};
    let unsubscribeGlobal = () => {};

    // A connection can receive a merchant-scoped event and a global event
    // (or two merchant-scoped events) back to back, un-awaited, from two
    // different listeners. writeSSE isn't safe to call concurrently on the
    // same stream — overlapping calls can interleave and corrupt frames —
    // so every write is chained onto this single queue instead of firing
    // independently.
    let writeQueue: Promise<unknown> = Promise.resolve();
    function enqueueWrite(frame: { id?: string; event?: string; data: string }) {
      writeQueue = writeQueue.then(() => (closed ? undefined : stream.writeSSE(frame)));
    }

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      unsubscribeGlobal();
    });

    unsubscribe = subscribeConsoleEvents(sessionUser.merchantId, (event: ConsoleEvent) => {
      if (closed) return;
      enqueueWrite({ id: event.id, event: event.type, data: JSON.stringify(event) });
    });

    unsubscribeGlobal = subscribeGlobalConsoleEvents((event: GlobalConsoleEvent) => {
      if (closed) return;
      enqueueWrite({ id: event.id, event: event.type, data: JSON.stringify(event) });
    });

    // Explicit application-level ack — sent only once both subscriptions
    // above are live, so the client knows it will not miss an event
    // published right after this. Distinct from the browser's own "open"
    // (TCP/HTTP handshake only); this confirms the server side is ready.
    enqueueWrite({
      event: "connected",
      data: JSON.stringify({ merchant_id: sessionUser.merchantId, connected_at: new Date().toISOString() }),
    });

    while (!closed) {
      await stream.sleep(SSE_HEARTBEAT_MS);
      if (closed) break;
      enqueueWrite({ event: "heartbeat", data: "" });
      await writeQueue;
    }
  });
});

function serializeEvents(events: (typeof paymentIntentEvents.$inferSelect)[]) {
  return events.map((event) => ({
    id: event.id,
    payment_intent_id: event.paymentIntentId,
    type: event.type,
    data: event.data,
    created_at: event.createdAt.toISOString(),
  }));
}

consoleRoutes.post("/payment-intents", requireSession(), rateLimit, async (c) => {
  const requestId = c.get("requestId") as string;
  const sessionUser = c.get("sessionUser");

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
    const created = await createPaymentIntent(sessionUser.merchantId, parsed.data, requestId);
    return { status: 201 as const, body: { data: serializePaymentIntent(created), request_id: requestId }, paymentIntentId: created.id };
  };

  if (!idempotencyKey) {
    const result = await respond();
    return c.json(result.body, result.status);
  }

  const { status, body } = await withIdempotency({
    merchantId: sessionUser.merchantId,
    idempotencyKey,
    requestBody: parsed.data,
    requestId,
    handler: respond,
  });
  return c.json(body, status as 201);
});

consoleRoutes.get("/summary", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const auth = c.get("auth");

  const merchantIds = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.workspaceId, sessionUser.workspaceId));

  const merchantIdList = merchantIds.map((m) => m.id);

  const statusCounts = await db
    .select({ status: paymentIntents.status, count: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(inArray(paymentIntents.merchantId, merchantIdList))
    .groupBy(paymentIntents.status);

  const securityEventTypes = [
    "WEBHOOK_REJECTED",
    "WEBHOOK_REPLAY_REJECTED",
    "AUTH_FAILURE",
    "IDEMPOTENCY_REPLAY",
    "IDEMPOTENCY_CONFLICT",
    "RATE_LIMIT_TRIGGERED",
  ];
  const securityEventCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(and(inArray(auditEvents.merchantId, merchantIdList), inArray(auditEvents.type, securityEventTypes)));

  const counts = { created: 0, processing: 0, succeeded: 0, failed: 0, cancelled: 0 } as Record<string, number>;
  for (const row of statusCounts) counts[row.status] = row.count;

  const latestSmokeTest = await db.query.smokeTestResults.findFirst({
    orderBy: (t, { desc }) => desc(t.ranAt),
  });

  return ok(c, {
    sandbox: true,
    workspace_name: sessionUser.workspaceName,
    merchant_name: sessionUser.merchantName,
    transaction_counts: counts,
    total_transactions: Object.values(counts).reduce((a, b) => a + b, 0),
    security_event_count: securityEventCount[0]?.count ?? 0,
    latest_smoke_test: latestSmokeTest ?? null,
  });
});

consoleRoutes.get("/audit-events", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");

  const merchantIds = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.workspaceId, sessionUser.workspaceId));

  const merchantIdList = merchantIds.map((m) => m.id);

  const events = await db.query.auditEvents.findMany({
    where: (events, { inArray }) => inArray(events.merchantId, merchantIdList),
    orderBy: (events, { desc }) => desc(events.createdAt),
    limit: 200,
  });
  return okList(
    c,
    events.map((event) => ({
      id: event.id,
      type: event.type,
      request_id: event.requestId,
      merchant_id: event.merchantId,
      payment_intent_id: event.paymentIntentId,
      metadata: event.metadata,
      created_at: event.createdAt.toISOString(),
    })),
  );
});

consoleRoutes.get("/providers", requireSession(), rateLimit, async (c) => {
  const providers = await db.select().from(providerConfigurations);
  return okList(c, providers);
});

consoleRoutes.get("/merchants", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");

  const merchantList = await db.query.merchants.findMany({
    where: eq(merchants.workspaceId, sessionUser.workspaceId),
  });
  return okList(c, merchantList);
});

consoleRoutes.get("/payment-intents", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");

  const merchantIds = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.workspaceId, sessionUser.workspaceId));

  const merchantIdList = merchantIds.map((m) => m.id);

  const paymentList = await db.query.paymentIntents.findMany({
    where: (pi, { inArray }) => inArray(pi.merchantId, merchantIdList),
    orderBy: (pi, { desc }) => desc(pi.createdAt),
    limit: 50,
  });
  
  // Fetch events separately for each payment
  const paymentIds = paymentList.map(p => p.id);
  let eventsMap = new Map<string, typeof paymentIntentEvents.$inferSelect[]>();
  if (paymentIds.length > 0) {
    const events = await db.query.paymentIntentEvents.findMany({
      where: (e, { inArray }) => inArray(e.paymentIntentId, paymentIds),
      orderBy: (e, { asc }) => asc(e.createdAt),
    });
    for (const event of events) {
      if (!eventsMap.has(event.paymentIntentId)) {
        eventsMap.set(event.paymentIntentId, []);
      }
      eventsMap.get(event.paymentIntentId)!.push(event);
    }
  }
  
  const paymentListWithEvents = paymentList.map(p => ({
    ...serializePaymentIntent(p),
    events: serializeEvents(eventsMap.get(p.id) ?? []),
  }));

  return okList(c, paymentListWithEvents);
});

consoleRoutes.get("/payment-intents/:id", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const id = c.req.param("id");

  const merchantIds = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.workspaceId, sessionUser.workspaceId));

  const merchantIdList = merchantIds.map((m) => m.id);

  const payment = await db.query.paymentIntents.findFirst({
    where: (pi, { and, eq, inArray }) => and(eq(pi.id, id), inArray(pi.merchantId, merchantIdList)),
  });

  if (!payment) {
    return c.json({ error: { code: "NOT_FOUND", message: "Payment not found" } }, 404);
  }

  const events = await db.query.paymentIntentEvents.findMany({
    where: (e, { eq }) => eq(e.paymentIntentId, id),
    orderBy: (e, { asc }) => asc(e.createdAt),
  });

  return ok(c, { ...serializePaymentIntent(payment), events: serializeEvents(events) });
});

async function findWorkspacePaymentIntent(workspaceId: string, id: string) {
  const merchantIds = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.workspaceId, workspaceId));
  const merchantIdList = merchantIds.map((m) => m.id);
  return db.query.paymentIntents.findFirst({
    where: (pi, { and, eq, inArray }) => and(eq(pi.id, id), inArray(pi.merchantId, merchantIdList)),
  });
}

async function findLastWebhookEvent(paymentIntentId: string) {
  const event = await db.query.webhookEvents.findFirst({
    where: eq(webhookEvents.paymentIntentId, paymentIntentId),
    orderBy: desc(webhookEvents.receivedAt),
  });
  if (!event) {
    throw new ApiError("NOT_FOUND", "No webhook has been delivered for this payment intent yet");
  }
  return event;
}

consoleRoutes.post("/payment-intents/:id/simulate-webhook", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const id = c.req.param("id");

  const parsed = simulateWebhookSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Invalid simulate-webhook request", { issues: parsed.error.issues });
  }

  const payment = await findWorkspacePaymentIntent(sessionUser.workspaceId, id);
  if (!payment) {
    return c.json({ error: { code: "NOT_FOUND", message: "Payment not found" } }, 404);
  }

  if (payment.provider !== "sim_provider_b") {
    return c.json({ error: { code: "INVALID_OPERATION", message: "Only SimProviderB payments can simulate webhooks" } }, 400);
  }
  if (payment.status !== "processing") {
    throw new ApiError("INVALID_STATE_TRANSITION", `Payment intent is "${payment.status}", not awaiting a webhook`);
  }

  const { body: webhookBody } = buildSimProviderBWebhookPayload({
    paymentIntentId: payment.id,
    providerReference: payment.providerReference ?? `spb_${payment.id}`,
    outcome: parsed.data.outcome,
  });
  const rawBody = JSON.stringify(webhookBody);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);

  await processSimProviderBWebhook(rawBody, { signature, timestamp }, c.get("requestId") as string);

  return ok(c, { success: true });
});

/** Resends the exact last stored webhook byte-for-byte (same event_id, body, signature, timestamp). Expected: 409 DUPLICATE_EVENT. */
consoleRoutes.post("/payment-intents/:id/replay-webhook", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const id = c.req.param("id");

  const payment = await findWorkspacePaymentIntent(sessionUser.workspaceId, id);
  if (!payment) {
    return c.json({ error: { code: "NOT_FOUND", message: "Payment not found" } }, 404);
  }

  const event = await findLastWebhookEvent(payment.id);
  await processSimProviderBWebhook(
    event.rawBody,
    { signature: event.signature, timestamp: event.timestampHeader },
    c.get("requestId") as string,
  );

  return ok(c, { success: true });
});

/** Flips the last stored webhook's settlement status but keeps its original signature. Expected: 401 INVALID_SIGNATURE. */
consoleRoutes.post("/payment-intents/:id/tamper-webhook", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const id = c.req.param("id");

  const payment = await findWorkspacePaymentIntent(sessionUser.workspaceId, id);
  if (!payment) {
    return c.json({ error: { code: "NOT_FOUND", message: "Payment not found" } }, 404);
  }

  const event = await findLastWebhookEvent(payment.id);
  const original = JSON.parse(event.rawBody) as { data: { status: string } };
  const tamperedRawBody = JSON.stringify({
    ...original,
    data: { ...original.data, status: original.data.status === "settled" ? "rejected" : "settled" },
  });

  await processSimProviderBWebhook(
    tamperedRawBody,
    { signature: event.signature, timestamp: Math.floor(Date.now() / 1000).toString() },
    c.get("requestId") as string,
  );

  return ok(c, { success: true });
});

consoleRoutes.post("/payment-intents/:id/cancel", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const id = c.req.param("id");

  const merchantIds = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.workspaceId, sessionUser.workspaceId));

  const merchantIdList = merchantIds.map((m) => m.id);

  const payment = await db.query.paymentIntents.findFirst({
    where: (pi, { and, eq, inArray }) => and(eq(pi.id, id), inArray(pi.merchantId, merchantIdList)),
  });

  if (!payment) {
    return c.json({ error: { code: "NOT_FOUND", message: "Payment not found" } }, 404);
  }

  if (!["created", "processing"].includes(payment.status)) {
    return c.json(
      { error: { code: "INVALID_STATE", message: `Cannot cancel payment in ${payment.status} state` } },
      409,
    );
  }

  await applyTransition(id, payment.status as PaymentStatus, "cancelled", c.get("requestId") as string);

  return ok(c, { success: true });
});

/**
 * Solves the first-key chicken-and-egg problem: a merchant that signed in
 * via Google OAuth (or dev-login) has a merchant record and an API key
 * already provisioned server-side (see auth/service.ts
 * `ensureWorkspaceAndMerchant`), but — before this route existed — no way to
 * ever see that key's plaintext, and no key of their own to call the
 * API-key-authenticated /api/v1/api-keys routes with. This lets a signed-in
 * merchant mint (and later revoke) their own keys without X-Admin-Secret or
 * database access, using the exact same generation/hashing path.
 */
consoleRoutes.get("/api-keys", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const keys = await listApiKeysForMerchant(sessionUser.merchantId);
  return okList(
    c,
    keys.map((key) => ({
      id: key.id,
      prefix: key.prefix,
      scopes: key.scopes,
      created_at: key.createdAt.toISOString(),
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      revoked_at: key.revokedAt?.toISOString() ?? null,
    })),
  );
});

consoleRoutes.post("/api-keys", requireSession(), rateLimit, async (c) => {
  const requestId = c.get("requestId") as string;
  const sessionUser = c.get("sessionUser");
  const apiKey = await createApiKeyForMerchant(sessionUser.merchantId, requestId);
  return ok(
    c,
    {
      id: apiKey.id,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      api_key: apiKey.fullKey,
      created_at: apiKey.createdAt.toISOString(),
      warning: "This is the only time the full API key is shown. Store it now.",
    },
    201,
  );
});

consoleRoutes.delete("/api-keys/:id", requireSession(), rateLimit, async (c) => {
  const requestId = c.get("requestId") as string;
  const sessionUser = c.get("sessionUser");
  const revoked = await revokeApiKey(c.req.param("id"), sessionUser.merchantId, requestId);
  if (!revoked) {
    throw new ApiError("NOT_FOUND", "API key not found or already revoked");
  }
  return ok(c, { id: revoked.id, revoked_at: revoked.revokedAt?.toISOString() });
});

consoleRoutes.get("/webhook", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const merchant = await getMerchantWebhookConfig(sessionUser.merchantId);
  return ok(c, serializeMerchantWebhookConfig(merchant));
});

consoleRoutes.put("/webhook", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");

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
    sessionUser.merchantId,
    parsed.data.url,
    parsed.data.enabled,
  );

  return ok(c, {
    ...serializeMerchantWebhookConfig(merchant),
    ...(secretRevealed ? { secret: secretRevealed } : {}),
  });
});

consoleRoutes.delete("/webhook", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const merchant = await disableMerchantWebhookConfig(sessionUser.merchantId);
  return ok(c, serializeMerchantWebhookConfig(merchant));
});

consoleRoutes.post("/webhook/regenerate-secret", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const { merchant, secret } = await regenerateMerchantWebhookSecret(sessionUser.merchantId);
  return ok(c, { ...serializeMerchantWebhookConfig(merchant), secret });
});

consoleRoutes.post("/webhook/test", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const result = await sendTestWebhook(sessionUser.merchantId, c.get("requestId") as string);
  return ok(c, result);
});

consoleRoutes.get("/webhook/deliveries", requireSession(), rateLimit, async (c) => {
  const sessionUser = c.get("sessionUser");
  const deliveries = await listMerchantWebhookDeliveries(sessionUser.merchantId);
  return okList(c, deliveries.map(serializeDelivery));
});