import { db } from "../../db/client.js";
import { auditEvents, type AUDIT_EVENT_TYPES } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { publishConsoleEvent } from "../console/events.js";
import { ids } from "../../lib/ids.js";

type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

interface RecordAuditEventInput {
  type: AuditEventType;
  requestId: string;
  merchantId?: string;
  paymentIntentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records a security/lifecycle audit event. Never pass API keys, webhook
 * secrets, or Authorization header values in `metadata` — this is the
 * permanent, queryable trail shown on the dashboard's Security page.
 */
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  await db.insert(auditEvents).values({
    type: input.type,
    requestId: input.requestId,
    merchantId: input.merchantId,
    paymentIntentId: input.paymentIntentId,
    metadata: input.metadata ?? {},
  });
  logger.info(`audit:${input.type}`, {
    requestId: input.requestId,
    merchantId: input.merchantId,
    paymentIntentId: input.paymentIntentId,
  });

  if (input.merchantId) {
    publishConsoleEvent({
      id: ids.consoleEventId(),
      type: "audit.event_created",
      merchant_id: input.merchantId,
      audit_event_type: input.type,
      created_at: new Date().toISOString(),
    });
  }
}

export async function listAuditEvents(merchantId: string, limit = 100) {
  return db.query.auditEvents.findMany({
    where: (events, { eq }) => eq(events.merchantId, merchantId),
    orderBy: (events, { desc }) => desc(events.createdAt),
    limit,
  });
}
