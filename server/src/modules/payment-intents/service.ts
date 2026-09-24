import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { paymentIntentEvents, paymentIntents } from "../../db/schema.js";
import { ApiError } from "../../lib/errors.js";
import { ids } from "../../lib/ids.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { getProvider } from "../providers/registry.js";
import { recordAuditEvent } from "../audit/service.js";
import { buildSimProviderBWebhookPayload, simProviderBSettlementOutcome } from "../providers/simProviderB.js";
import { signWebhookPayload } from "../../lib/crypto.js";
import { enqueueMerchantWebhookEvent } from "../merchant-webhooks/service.js";
import { publishConsoleEvent } from "../console/events.js";
import { assertTransition, InvalidTransitionError, type PaymentStatus } from "./state-machine.js";
import type { CreatePaymentIntentInput } from "./schemas.js";

const AUTO_WEBHOOK_MIN_DELAY_MS = 2000;
const AUTO_WEBHOOK_MAX_DELAY_MS = 5000;

/**
 * SimProviderB's own asynchronous settlement. The provider is simulated in
 * every environment, so "the provider's webhook" has to come from here: after
 * a short, human-visible delay it sends the signed settlement webhook, and the
 * console shows created -> processing -> (webhook) -> succeeded/failed live.
 * Goes through the exact same `processSimProviderBWebhook` path a real inbound
 * webhook takes — verification, replay-dedup, and the transition itself are
 * untouched. Outcome comes from the payment's `scenario` (see
 * `simProviderBSettlementOutcome`); scenario "manual" opts out so a demo can
 * drive the webhook by hand. Disabled under test via config.simProviderB.
 */
function scheduleAutoSimProviderBWebhook(
  paymentIntentId: string,
  providerReference: string,
  scenario: string | null,
  requestId: string,
  delayMs = AUTO_WEBHOOK_MIN_DELAY_MS + Math.random() * (AUTO_WEBHOOK_MAX_DELAY_MS - AUTO_WEBHOOK_MIN_DELAY_MS),
) {
  if (!config.simProviderB.autoSettle) return;
  const outcome = simProviderBSettlementOutcome(scenario);
  if (!outcome) return;

  setTimeout(() => {
    void (async () => {
      try {
        const { processSimProviderBWebhook } = await import("../webhooks/service.js");
        const { body } = buildSimProviderBWebhookPayload({ paymentIntentId, providerReference, outcome });
        const rawBody = JSON.stringify(body);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);
        await processSimProviderBWebhook(rawBody, { signature, timestamp }, requestId);
        logger.info("SimProviderB settled payment", { paymentIntentId, outcome });
      } catch (err) {
        // A manual "Simulate webhook" click, a cancellation, or a replay may
        // have already resolved this payment before the timer fired —
        // processSimProviderBWebhook's own CAS/dedup guards turn that into a
        // clean ApiError (already audited there).
        if (err instanceof ApiError) {
          logger.info("Automatic SimProviderB webhook skipped", { paymentIntentId, code: err.code });
        } else {
          logger.error("Automatic SimProviderB webhook failed", {
            paymentIntentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
  }, delayMs);
}

/**
 * Settlement timers live in process memory, so a restart/redeploy would
 * otherwise strand every SimProviderB payment that was still awaiting its
 * webhook in "processing" forever. Called once at startup to re-arm them.
 */
export async function resumePendingSimProviderBSettlements() {
  if (!config.simProviderB.autoSettle) return 0;
  const pending = await db.query.paymentIntents.findMany({
    where: and(eq(paymentIntents.provider, "sim_provider_b"), eq(paymentIntents.status, "processing")),
  });
  let resumed = 0;
  for (const row of pending) {
    if (!simProviderBSettlementOutcome(row.scenario)) continue;
    scheduleAutoSimProviderBWebhook(
      row.id,
      row.providerReference ?? `spb_${row.id}`,
      row.scenario,
      ids.requestId(),
      AUTO_WEBHOOK_MIN_DELAY_MS + resumed * 250,
    );
    resumed += 1;
  }
  if (resumed > 0) logger.info("Resumed pending SimProviderB settlements", { count: resumed });
  return resumed;
}

type PaymentIntentRow = typeof paymentIntents.$inferSelect;

export function serializePaymentIntent(row: PaymentIntentRow) {
  return {
    id: row.id,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    provider: row.provider,
    scenario: row.scenario,
    reference: row.reference,
    metadata: row.metadata,
    failure_reason: row.failureReason,
    provider_reference: row.providerReference,
    sandbox: row.sandbox,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function addEvent(paymentIntentId: string, type: string, data: Record<string, unknown> = {}) {
  await db.insert(paymentIntentEvents).values({ paymentIntentId, type, data });
}

const AUDIT_BY_STATUS = {
  processing: "PAYMENT_PROCESSING",
  succeeded: "PAYMENT_SUCCEEDED",
  failed: "PAYMENT_FAILED",
  cancelled: "PAYMENT_CANCELLED",
} as const;

async function findOwnedOrThrow(merchantId: string, id: string): Promise<PaymentIntentRow> {
  const row = await db.query.paymentIntents.findFirst({
    where: and(eq(paymentIntents.id, id), eq(paymentIntents.merchantId, merchantId)),
  });
  if (!row) throw new ApiError("NOT_FOUND", `Payment intent not found: ${id}`);
  return row;
}

export async function createPaymentIntent(
  merchantId: string,
  input: CreatePaymentIntentInput,
  requestId: string,
) {
  const id = ids.paymentIntentId();
  const provider = getProvider(input.provider);

  const [created] = await db
    .insert(paymentIntents)
    .values({
      id,
      merchantId,
      amount: input.amount,
      currency: input.currency,
      status: "created",
      provider: input.provider,
      scenario: input.scenario,
      reference: input.reference,
      metadata: input.metadata ?? {},
    })
    .returning();
  if (!created) throw new Error("Failed to create payment intent");

  await addEvent(id, "payment_created", { amount: input.amount, currency: input.currency });
  await recordAuditEvent({
    type: "PAYMENT_CREATED",
    requestId,
    merchantId,
    paymentIntentId: id,
    metadata: { provider: input.provider, amount: input.amount, currency: input.currency },
  });

  await addEvent(id, "provider_selected", { provider: provider.name, mode: provider.mode });
  const result = await provider.createPayment({
    paymentIntentId: id,
    amount: input.amount,
    currency: input.currency,
    scenario: input.scenario,
  });
  await addEvent(id, "provider_responded", {
    providerStatus: result.providerStatus,
    providerReference: result.providerReference,
    raw: result.raw,
  });

  const updated = await applyTransition(id, "created", result.canonicalStatus, requestId, {
    providerReference: result.providerReference,
    failureReason: result.canonicalStatus === "failed" ? String(result.raw.reason ?? "declined") : null,
  });

  if (updated.provider === "sim_provider_b" && updated.status === "processing") {
    scheduleAutoSimProviderBWebhook(
      updated.id,
      updated.providerReference ?? `spb_${updated.id}`,
      updated.scenario,
      requestId,
    );
  }

  return updated;
}

/**
 * The single choke point for every payment status change. Enforces the
 * state machine, appends a timeline event, records an audit event, and
 * persists atomically — see docs/architecture.md "Payment State Machine".
 */
export async function applyTransition(
  paymentIntentId: string,
  from: PaymentStatus,
  to: PaymentStatus,
  requestId: string,
  extra: { providerReference?: string; failureReason?: string | null } = {},
) {
  try {
    assertTransition(from, to);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      throw new ApiError("INVALID_STATE_TRANSITION", err.message);
    }
    throw err;
  }

  const [updated] = await db
    .update(paymentIntents)
    .set({
      status: to,
      providerReference: extra.providerReference,
      failureReason: extra.failureReason ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(paymentIntents.id, paymentIntentId), eq(paymentIntents.status, from)))
    .returning();

  if (!updated) {
    throw new ApiError(
      "INVALID_STATE_TRANSITION",
      `Payment intent ${paymentIntentId} is no longer in status "${from}"`,
    );
  }

  await addEvent(paymentIntentId, `status_${to}`, { from, to });
  await recordAuditEvent({
    type: AUDIT_BY_STATUS[to as keyof typeof AUDIT_BY_STATUS],
    requestId,
    merchantId: updated.merchantId,
    paymentIntentId,
    metadata: { from, to },
  });

  if (to === "succeeded" || to === "failed" || to === "cancelled") {
    await enqueueMerchantWebhookEvent(updated, to, requestId);
  }

  // Realtime Console notification — fired only after the transition above
  // has actually committed, never a requirement for it (see
  // modules/console/events.ts). A disconnected/absent Console browser has
  // no effect on this function.
  publishConsoleEvent({
    id: ids.consoleEventId(),
    type: "payment.status_changed",
    payment_intent_id: paymentIntentId,
    merchant_id: updated.merchantId,
    status: to,
    previous_status: from,
    created_at: new Date().toISOString(),
  });

  return updated;
}

export async function getPaymentIntent(merchantId: string, id: string) {
  return findOwnedOrThrow(merchantId, id);
}

/** Unscoped lookup for internal use (e.g. webhook processing, which only knows the id). */
export async function getPaymentIntentById(id: string) {
  const row = await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, id) });
  if (!row) throw new ApiError("NOT_FOUND", `Payment intent not found: ${id}`);
  return row;
}

export async function listPaymentIntents(
  merchantId: string,
  options: { limit: number; status?: PaymentStatus },
) {
  return db.query.paymentIntents.findMany({
    where: options.status
      ? and(eq(paymentIntents.merchantId, merchantId), eq(paymentIntents.status, options.status))
      : eq(paymentIntents.merchantId, merchantId),
    orderBy: desc(paymentIntents.createdAt),
    limit: options.limit,
  });
}

export async function getPaymentIntentTimeline(merchantId: string, id: string) {
  await findOwnedOrThrow(merchantId, id);
  return db.query.paymentIntentEvents.findMany({
    where: eq(paymentIntentEvents.paymentIntentId, id),
    orderBy: paymentIntentEvents.createdAt,
  });
}

export async function cancelPaymentIntent(merchantId: string, id: string, requestId: string) {
  const current = await findOwnedOrThrow(merchantId, id);
  return applyTransition(id, current.status as PaymentStatus, "cancelled", requestId);
}
