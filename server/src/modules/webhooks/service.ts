import { db } from "../../db/client.js";
import { webhookEvents } from "../../db/schema.js";
import { ApiError } from "../../lib/errors.js";
import { config } from "../../config.js";
import { recordAuditEvent } from "../audit/service.js";
import { applyTransition, getPaymentIntentById } from "../payment-intents/service.js";
import { simProviderBWebhookBodySchema } from "./schemas.js";
import { verifyWebhookRequest } from "./verify.js";

export interface IncomingWebhookHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
}

/**
 * Best-effort extraction of payment_intent_id from a webhook body that may
 * have failed signature/schema verification — used only to attribute a
 * rejected-webhook audit event to the right merchant on the dashboard, never
 * to trust the payload for an actual state change.
 */
function tryExtractPaymentIntentId(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as { data?: { payment_intent_id?: unknown } };
    const id = parsed?.data?.payment_intent_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

async function resolveMerchantId(paymentIntentId: string | undefined): Promise<string | undefined> {
  if (!paymentIntentId) return undefined;
  try {
    const paymentIntent = await getPaymentIntentById(paymentIntentId);
    return paymentIntent.merchantId;
  } catch {
    return undefined;
  }
}

/**
 * Handles an inbound SimProviderB webhook end to end: signature + freshness
 * verification, replay detection, schema validation, and the resulting
 * payment state transition. Every rejection path is audited so the
 * dashboard's Security page can show exactly what was blocked and why.
 */
export async function processSimProviderBWebhook(
  rawBody: string,
  headers: IncomingWebhookHeaders,
  requestId: string,
) {
  const bestEffortPaymentIntentId = tryExtractPaymentIntentId(rawBody);
  const bestEffortMerchantId = await resolveMerchantId(bestEffortPaymentIntentId);

  await recordAuditEvent({
    type: "WEBHOOK_RECEIVED",
    requestId,
    merchantId: bestEffortMerchantId,
    paymentIntentId: bestEffortPaymentIntentId,
    metadata: { provider: "sim_provider_b" },
  });

  const verification = verifyWebhookRequest({
    rawBody,
    signatureHeader: headers.signature,
    timestampHeader: headers.timestamp,
    secret: config.webhookSecrets.sim_provider_b,
    toleranceSeconds: config.webhookTimestampToleranceSeconds,
  });

  if (!verification.valid) {
    await recordAuditEvent({
      type: "WEBHOOK_REJECTED",
      requestId,
      merchantId: bestEffortMerchantId,
      paymentIntentId: bestEffortPaymentIntentId,
      metadata: { provider: "sim_provider_b", reason: verification.reason },
    });
    const isSignatureIssue = verification.reason === "missing_signature" || verification.reason === "invalid_signature";
    throw new ApiError(
      isSignatureIssue ? "INVALID_SIGNATURE" : "STALE_TIMESTAMP",
      `Webhook rejected: ${verification.reason}`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    await recordAuditEvent({
      type: "WEBHOOK_REJECTED",
      requestId,
      merchantId: bestEffortMerchantId,
      paymentIntentId: bestEffortPaymentIntentId,
      metadata: { provider: "sim_provider_b", reason: "malformed_json" },
    });
    throw new ApiError("INVALID_REQUEST", "Webhook body is not valid JSON");
  }

  const parsed = simProviderBWebhookBodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    await recordAuditEvent({
      type: "WEBHOOK_REJECTED",
      requestId,
      merchantId: bestEffortMerchantId,
      paymentIntentId: bestEffortPaymentIntentId,
      metadata: { provider: "sim_provider_b", reason: "validation_error" },
    });
    throw new ApiError("VALIDATION_ERROR", "Webhook payload failed validation", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  const body = parsed.data;

  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      id: body.event_id,
      provider: "sim_provider_b",
      paymentIntentId: body.data.payment_intent_id,
      payload: body,
      rawBody,
      signature: headers.signature!,
      timestampHeader: headers.timestamp!,
      verified: true,
    })
    .onConflictDoNothing({ target: webhookEvents.id })
    .returning();

  if (!inserted) {
    await recordAuditEvent({
      type: "WEBHOOK_REPLAY_REJECTED",
      requestId,
      merchantId: bestEffortMerchantId,
      paymentIntentId: body.data.payment_intent_id,
      metadata: { provider: "sim_provider_b", eventId: body.event_id },
    });
    throw new ApiError("DUPLICATE_EVENT", `Webhook event already processed: ${body.event_id}`);
  }

  await recordAuditEvent({
    type: "WEBHOOK_VERIFIED",
    requestId,
    merchantId: bestEffortMerchantId,
    paymentIntentId: body.data.payment_intent_id,
    metadata: { provider: "sim_provider_b", eventId: body.event_id },
  });

  const paymentIntent = await getPaymentIntentById(body.data.payment_intent_id);
  const canonicalStatus = body.data.status === "settled" ? "succeeded" : "failed";

  const updated = await applyTransition(
    paymentIntent.id,
    "processing",
    canonicalStatus,
    requestId,
    {
      providerReference: body.data.provider_reference,
      failureReason: canonicalStatus === "failed" ? "sandbox_simulated_provider_rejection" : null,
    },
  );

  return { paymentIntent: updated, eventId: body.event_id };
}
