import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../../src/db/client.js";
import { createMerchantWithApiKey, authenticateApiKey, revokeApiKey } from "../../src/modules/merchants/service.js";
import { withIdempotency } from "../../src/modules/idempotency/service.js";
import { createPaymentIntent, applyTransition } from "../../src/modules/payment-intents/service.js";
import { ApiError } from "../../src/lib/errors.js";
import { ids } from "../../src/lib/ids.js";
import { db } from "../../src/db/client.js";
import { webhookEvents, users, workspaces } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

let merchantId: string;
let apiKeyFull: string;
let workspaceId: string;

beforeAll(async () => {
  // Create test user
  const [user] = await db
    .insert(users)
    .values({
      googleSubject: `test_subject_${Date.now()}`,
      email: `test-${Date.now()}@finbridge.sandbox`,
      name: "Test User",
      avatarUrl: null,
    })
    .returning();

  // Create test workspace
  const [workspace] = await db
    .insert(workspaces)
    .values({
      userId: user.id,
      name: "Test Workspace",
    })
    .returning();

  workspaceId = workspace.id;

  const { merchant, apiKey } = await createMerchantWithApiKey({
    name: "Integration Test Merchant",
    email: `integration-${Date.now()}@finbridge.sandbox`,
    workspaceId,
    requestId: ids.requestId(),
  });
  merchantId = merchant.id;
  apiKeyFull = apiKey.fullKey;
});

afterAll(async () => {
  await sql.end();
});

describe("API key authentication (persisted)", () => {
  it("authenticates a freshly created key", async () => {
    const result = await authenticateApiKey(apiKeyFull);
    expect(result?.merchantId).toBe(merchantId);
    expect(result?.workspaceId).toBe(workspaceId);
  });

  it("rejects an unknown key", async () => {
    const result = await authenticateApiKey("fb_test_totally_unknown_key_00000000");
    expect(result).toBeNull();
  });

  it("rejects a revoked key", async () => {
    const authBefore = await authenticateApiKey(apiKeyFull);
    expect(authBefore).not.toBeNull();

    await revokeApiKey(authBefore!.apiKeyId, authBefore!.merchantId, ids.requestId());

    const authAfter = await authenticateApiKey(apiKeyFull);
    expect(authAfter).toBeNull();
  });
});

describe("idempotency (database-enforced)", () => {
  it("runs the handler exactly once for concurrent requests sharing a key", async () => {
    const { apiKey } = await createMerchantWithApiKey({
      name: "Idempotency Test Merchant",
      email: `idem-${Date.now()}@finbridge.sandbox`,
      workspaceId,
      requestId: ids.requestId(),
    });

    let handlerCalls = 0;
    const idempotencyKey = `race-${Date.now()}`;
    const requestBody = { amount: 1000, currency: "USD" };

    const run = () =>
      withIdempotency({
        merchantId: apiKey.merchantId,
        idempotencyKey,
        requestBody,
        requestId: ids.requestId(),
        handler: async () => {
          handlerCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: 201, body: { id: `pi_test_${handlerCalls}` } };
        },
      });

    const [first, second, third] = await Promise.all([run(), run(), run()]);

    expect(handlerCalls).toBe(1);
    expect(first.body).toEqual(second.body);
    expect(second.body).toEqual(third.body);
  });

  it("rejects reuse of the same key with a different payload", async () => {
    const { apiKey } = await createMerchantWithApiKey({
      name: "Idempotency Conflict Merchant",
      email: `idem-conflict-${Date.now()}@finbridge.sandbox`,
      workspaceId,
      requestId: ids.requestId(),
    });
    const idempotencyKey = "conflict-key";

    await withIdempotency({
      merchantId: apiKey.merchantId,
      idempotencyKey,
      requestBody: { amount: 100 },
      requestId: ids.requestId(),
      handler: async () => ({ status: 201, body: { ok: true } }),
    });

    await expect(
      withIdempotency({
        merchantId: apiKey.merchantId,
        idempotencyKey,
        requestBody: { amount: 999 },
        requestId: ids.requestId(),
        handler: async () => ({ status: 201, body: { ok: true } }),
      }),
    ).rejects.toThrow(ApiError);
  });
});

describe("webhook replay protection (database-enforced)", () => {
  it("rejects a second insert of the same event id", async () => {
    const eventId = `evt_test_${Date.now()}`;
    const [first] = await db
      .insert(webhookEvents)
      .values({
        id: eventId,
        provider: "sim_provider_b",
        payload: { hello: "world" },
        rawBody: "{}",
        signature: "deadbeef",
        timestampHeader: "1700000000",
        verified: true,
      })
      .onConflictDoNothing({ target: webhookEvents.id })
      .returning();
    expect(first).toBeDefined();

    const [second] = await db
      .insert(webhookEvents)
      .values({
        id: eventId,
        provider: "sim_provider_b",
        payload: { hello: "tampered" },
        rawBody: "{}",
        signature: "deadbeef",
        timestampHeader: "1700000000",
        verified: true,
      })
      .onConflictDoNothing({ target: webhookEvents.id })
      .returning();
    expect(second).toBeUndefined();
  });
});

describe("payment lifecycle (persisted)", () => {
  it("creates a sim_provider_a success payment fully synchronously", async () => {
    const requestId = ids.requestId();
    const pi = await createPaymentIntent(
      merchantId,
      { amount: 5000, currency: "USD", provider: "sim_provider_a", scenario: "success" },
      requestId,
    );
    expect(pi.status).toBe("succeeded");
    expect(pi.providerReference).toMatch(/^spa_/);
  });

  it("creates a sim_provider_a declined payment as failed", async () => {
    const pi = await createPaymentIntent(
      merchantId,
      { amount: 5000, currency: "USD", provider: "sim_provider_a", scenario: "declined" },
      ids.requestId(),
    );
    expect(pi.status).toBe("failed");
  });

  it("leaves a sim_provider_b payment in processing until a webhook arrives", async () => {
    const pi = await createPaymentIntent(
      merchantId,
      { amount: 5000, currency: "USD", provider: "sim_provider_b" },
      ids.requestId(),
    );
    expect(pi.status).toBe("processing");
  });

  it("rejects an invalid state transition at the database layer", async () => {
    const pi = await createPaymentIntent(
      merchantId,
      { amount: 5000, currency: "USD", provider: "sim_provider_a", scenario: "success" },
      ids.requestId(),
    );
    expect(pi.status).toBe("succeeded");

    await expect(applyTransition(pi.id, "succeeded", "cancelled", ids.requestId())).rejects.toThrow(ApiError);
  });
});