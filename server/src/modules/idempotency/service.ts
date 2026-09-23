import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { idempotencyKeys } from "../../db/schema.js";
import { ApiError } from "../../lib/errors.js";
import { hashRequestBody } from "../../lib/stableHash.js";
import { recordAuditEvent } from "../audit/service.js";

const POLL_INTERVAL_MS = 100;
const POLL_ATTEMPTS = 20; // ~2s ceiling while a concurrent owner finishes

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WithIdempotencyParams<T> {
  merchantId: string;
  idempotencyKey: string;
  requestBody: unknown;
  requestId: string;
  handler: () => Promise<{ status: number; body: T; paymentIntentId?: string }>;
}

interface WithIdempotencyResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Guarantees that concurrent requests sharing the same (merchant, key) only
 * ever run `handler` once. The database's unique constraint on
 * (merchant_id, idempotency_key) — not application logic — is what makes
 * this safe under real concurrency: see docs/security.md "Concurrency".
 */
export async function withIdempotency<T>(params: WithIdempotencyParams<T>): Promise<WithIdempotencyResult<T>> {
  const requestHash = hashRequestBody(params.requestBody);

  const [reserved] = await db
    .insert(idempotencyKeys)
    .values({
      merchantId: params.merchantId,
      idempotencyKey: params.idempotencyKey,
      requestHash,
    })
    .onConflictDoNothing({ target: [idempotencyKeys.merchantId, idempotencyKeys.idempotencyKey] })
    .returning();

  if (reserved) {
    let result: { status: number; body: T; paymentIntentId?: string };
    try {
      result = await params.handler();
    } catch (err) {
      // The reservation must not outlive a failed handler, or every retry
      // with this (merchant, key) pair would poll forever and never see a
      // recorded response — see POLL_ATTEMPTS below.
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, reserved.id));
      throw err;
    }
    await db
      .update(idempotencyKeys)
      .set({
        responseStatus: result.status,
        responseBody: result.body as unknown,
        paymentIntentId: result.paymentIntentId,
      })
      .where(eq(idempotencyKeys.id, reserved.id));
    return { status: result.status, body: result.body, replayed: false };
  }

  // Another request already owns this key — inspect it.
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const existing = await db.query.idempotencyKeys.findFirst({
      where: and(
        eq(idempotencyKeys.merchantId, params.merchantId),
        eq(idempotencyKeys.idempotencyKey, params.idempotencyKey),
      ),
    });

    if (!existing) break; // extremely unlikely race; fall through to conflict error

    if (existing.requestHash !== requestHash) {
      await recordAuditEvent({
        type: "IDEMPOTENCY_CONFLICT",
        requestId: params.requestId,
        merchantId: params.merchantId,
        metadata: { idempotencyKey: params.idempotencyKey },
      });
      throw new ApiError(
        "IDEMPOTENCY_KEY_CONFLICT",
        "This idempotency key was already used with a different request payload",
      );
    }

    if (existing.responseBody !== null && existing.responseStatus !== null) {
      await recordAuditEvent({
        type: "IDEMPOTENCY_REPLAY",
        requestId: params.requestId,
        merchantId: params.merchantId,
        metadata: { idempotencyKey: params.idempotencyKey, paymentIntentId: existing.paymentIntentId },
      });
      return {
        status: existing.responseStatus,
        body: existing.responseBody as T,
        replayed: true,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new ApiError(
    "IDEMPOTENCY_KEY_CONFLICT",
    "The original request for this idempotency key is still being processed",
  );
}
