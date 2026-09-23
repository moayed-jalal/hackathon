import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { ok, okList } from "../../lib/response.js";
import { db } from "../../db/client.js";
import { auditEvents, paymentIntents, providerConfigurations } from "../../db/schema.js";
import { listAuditEvents } from "../audit/service.js";

export const dashboardRoutes = new Hono();

dashboardRoutes.get("/summary", requireAuth("payments:read"), rateLimit, async (c) => {
  const auth = c.get("auth");

  const statusCounts = await db
    .select({ status: paymentIntents.status, count: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(eq(paymentIntents.merchantId, auth.merchantId))
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
    .where(and(eq(auditEvents.merchantId, auth.merchantId), inArray(auditEvents.type, securityEventTypes)));

  const counts = { created: 0, processing: 0, succeeded: 0, failed: 0, cancelled: 0 } as Record<string, number>;
  for (const row of statusCounts) counts[row.status] = row.count;

  const latestSmokeTest = await db.query.smokeTestResults.findFirst({
    orderBy: (t, { desc }) => desc(t.ranAt),
  });

  return ok(c, {
    sandbox: true,
    merchant_name: auth.merchantName,
    transaction_counts: counts,
    total_transactions: Object.values(counts).reduce((a, b) => a + b, 0),
    security_event_count: securityEventCount[0]?.count ?? 0,
    latest_smoke_test: latestSmokeTest ?? null,
  });
});

dashboardRoutes.get("/audit-events", requireAuth("payments:read"), rateLimit, async (c) => {
  const events = await listAuditEvents(c.get("auth").merchantId, 200);
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

dashboardRoutes.get("/providers", requireAuth("payments:read"), rateLimit, async (c) => {
  const providers = await db.select().from(providerConfigurations);
  return okList(c, providers);
});
