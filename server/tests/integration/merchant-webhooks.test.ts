import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { sql, db } from "../../src/db/client.js";
import { users, workspaces, merchantWebhookDeliveries } from "../../src/db/schema.js";
import { createMerchantWithApiKey } from "../../src/modules/merchants/service.js";
import { createPaymentIntent } from "../../src/modules/payment-intents/service.js";
import { buildSimProviderBWebhookPayload } from "../../src/modules/providers/simProviderB.js";
import { processSimProviderBWebhook } from "../../src/modules/webhooks/service.js";
import { signWebhookPayload, verifyWebhookSignature } from "../../src/lib/crypto.js";
import { config } from "../../src/config.js";
import { ids } from "../../src/lib/ids.js";
import { ApiError } from "../../src/lib/errors.js";
import {
  attemptDelivery,
  disableMerchantWebhookConfig,
  enqueueMerchantWebhookEvent,
  getMerchantWebhookConfig,
  listMerchantWebhookDeliveries,
  regenerateMerchantWebhookSecret,
  sendTestWebhook,
  serializeMerchantWebhookConfig,
  upsertMerchantWebhookUrl,
} from "../../src/modules/merchant-webhooks/service.js";

// --- a tiny local "merchant server" the tests fully control ---
let server: http.Server;
let serverPort: number;
type ReceivedRequest = { headers: http.IncomingHttpHeaders; body: string };
let received: ReceivedRequest[] = [];
type Mode = "success" | "fail" | "hang" | "flaky" | "redirect";
let mode: Mode = "success";
let flakyFailuresRemaining = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (mode === "hang") return; // never respond — exercises the delivery timeout
      if (mode === "redirect") {
        res.writeHead(302, { Location: "http://10.0.0.5/internal" });
        res.end();
        return;
      }
      if (mode === "fail") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (mode === "flaky" && flakyFailuresRemaining > 0) {
        flakyFailuresRemaining -= 1;
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql.end();
});

beforeEach(() => {
  received = [];
  mode = "success";
  flakyFailuresRemaining = 0;
});

function mockUrl(): string {
  return `http://127.0.0.1:${serverPort}/webhooks/finbridge`;
}

async function makeMerchant(label: string) {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const [user] = await db
    .insert(users)
    .values({ googleSubject: `mw_test_${unique}`, email: `mw-${unique}@finbridge.sandbox`, name: label, avatarUrl: null })
    .returning();
  const [workspace] = await db.insert(workspaces).values({ userId: user.id, name: `${label} workspace` }).returning();
  const { merchant } = await createMerchantWithApiKey({
    name: label,
    email: `${unique}@example.com`,
    workspaceId: workspace.id,
    requestId: ids.requestId(),
  });
  return merchant;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("merchant webhook configuration", () => {
  it("creates a configuration and reveals the secret exactly once", async () => {
    const merchant = await makeMerchant("Config Create");
    const { merchant: updated, secretRevealed } = await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    expect(updated.webhookUrl).toBe(mockUrl());
    expect(updated.webhookEnabled).toBe(true);
    expect(secretRevealed).toMatch(/^whsec_/);
    expect(updated.webhookSecret).toBe(secretRevealed);
  });

  it("updates the URL without rotating the existing secret", async () => {
    const merchant = await makeMerchant("Config Update");
    const first = await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const second = await upsertMerchantWebhookUrl(merchant.id, `${mockUrl()}?v=2`, undefined);

    expect(second.secretRevealed).toBeNull();
    expect(second.merchant.webhookSecret).toBe(first.merchant.webhookSecret);
    expect(second.merchant.webhookUrl).toBe(`${mockUrl()}?v=2`);
  });

  it("retrieves the current configuration", async () => {
    const merchant = await makeMerchant("Config Get");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    const merchantConfig = await getMerchantWebhookConfig(merchant.id);
    const serialized = serializeMerchantWebhookConfig(merchantConfig);

    expect(serialized.url).toBe(mockUrl());
    expect(serialized.configured).toBe(true);
    expect(serialized.events).toEqual(["payment.succeeded", "payment.failed", "payment.cancelled"]);
    // The full secret is never present in the serialized view — only a masked preview.
    expect(JSON.stringify(serialized)).not.toContain(merchantConfig.webhookSecret);
  });

  it("disables (clears) the configuration", async () => {
    const merchant = await makeMerchant("Config Delete");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    const cleared = await disableMerchantWebhookConfig(merchant.id);

    expect(cleared.webhookUrl).toBeNull();
    expect(cleared.webhookSecret).toBeNull();
    expect(cleared.webhookEnabled).toBe(false);
  });

  it("keeps each merchant's configuration and secret isolated from the other", async () => {
    const merchantA = await makeMerchant("Tenant A");
    const merchantB = await makeMerchant("Tenant B");

    const a = await upsertMerchantWebhookUrl(merchantA.id, mockUrl(), undefined);
    const b = await upsertMerchantWebhookUrl(merchantB.id, `${mockUrl()}?tenant=b`, undefined);

    expect(a.secretRevealed).not.toBe(b.secretRevealed);

    await regenerateMerchantWebhookSecret(merchantA.id);
    const bAfter = await getMerchantWebhookConfig(merchantB.id);

    // Regenerating A's secret must not touch B's stored URL or secret.
    expect(bAfter.webhookUrl).toBe(`${mockUrl()}?tenant=b`);
    expect(bAfter.webhookSecret).toBe(b.merchant.webhookSecret);
  });
});

describe("merchant webhook URL safety (SSRF)", () => {
  it("rejects a malformed URL", async () => {
    const merchant = await makeMerchant("Bad URL");
    await expect(upsertMerchantWebhookUrl(merchant.id, "not-a-url", undefined)).rejects.toThrow(ApiError);
  });

  it("rejects a URL resolving to a private IP even outside production", async () => {
    const merchant = await makeMerchant("Private IP");
    await expect(upsertMerchantWebhookUrl(merchant.id, "https://10.0.0.5/webhooks", undefined)).rejects.toThrow(
      ApiError,
    );
  });

  it("allows the localhost mock server in development/test", async () => {
    const merchant = await makeMerchant("Localhost OK");
    const { merchant: updated } = await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    expect(updated.webhookUrl).toBe(mockUrl());
  });

  it("does not follow a redirect to a private address", async () => {
    mode = "redirect";
    const merchant = await makeMerchant("Redirect Guard");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const fresh = await getMerchantWebhookConfig(merchant.id);

    const eventId = ids.webhookEventId();
    await db.insert(merchantWebhookDeliveries).values({
      id: eventId,
      merchantId: merchant.id,
      paymentIntentId: null,
      eventType: "webhook.test",
      endpointUrl: fresh.webhookUrl!,
      payload: { id: eventId, type: "webhook.test", created_at: new Date().toISOString(), data: {} },
      status: "pending",
    });

    const result = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });

    expect(result.success).toBe(false);
    // The mock server itself received exactly one request (the redirect was
    // never chased to http://10.0.0.5/internal — nothing would be there to
    // receive it, and delivery must not attempt to).
    expect(received).toHaveLength(1);
  });
});

describe("merchant webhook delivery", () => {
  async function insertPendingDelivery(merchantId: string, url: string) {
    const eventId = ids.webhookEventId();
    await db.insert(merchantWebhookDeliveries).values({
      id: eventId,
      merchantId,
      paymentIntentId: null,
      eventType: "payment.succeeded",
      endpointUrl: url,
      payload: { id: eventId, type: "payment.succeeded", created_at: new Date().toISOString(), data: { amount: 1000 } },
      status: "pending",
    });
    return eventId;
  }

  it("delivers successfully and signs the exact bytes sent", async () => {
    const merchant = await makeMerchant("Delivery Success");
    const { merchant: withSecret } = await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const eventId = await insertPendingDelivery(merchant.id, mockUrl());

    const result = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });

    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(received).toHaveLength(1);

    const req = received[0]!;
    const signature = req.headers["x-finbridge-signature"] as string;
    const timestamp = req.headers["x-finbridge-timestamp"] as string;
    expect(req.headers["x-finbridge-event-id"]).toBe(eventId);
    expect(verifyWebhookSignature(req.body, timestamp, signature, withSecret.webhookSecret!)).toBe(true);

    const row = await db.query.merchantWebhookDeliveries.findFirst({ where: eq(merchantWebhookDeliveries.id, eventId) });
    expect(row?.status).toBe("delivered");
    expect(row?.attemptCount).toBe(1);
  });

  it("records a non-2xx response as a failed attempt, not a delivery", async () => {
    mode = "fail";
    const merchant = await makeMerchant("Delivery 500");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const eventId = await insertPendingDelivery(merchant.id, mockUrl());

    const result = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(500);
    const row = await db.query.merchantWebhookDeliveries.findFirst({ where: eq(merchantWebhookDeliveries.id, eventId) });
    expect(row?.status).toBe("pending"); // one attempt used, not yet final
    expect(row?.attemptCount).toBe(1);
  });

  it("treats a hanging endpoint as a clean timeout failure", async () => {
    mode = "hang";
    const merchant = await makeMerchant("Delivery Timeout");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const eventId = await insertPendingDelivery(merchant.id, mockUrl());

    const start = Date.now();
    const result = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    // MERCHANT_WEBHOOK_TIMEOUT_MS is overridden to 300ms for tests (vitest.config.ts).
    expect(elapsed).toBeLessThan(3000);
  });

  it("treats a connection failure (nothing listening) as a clean delivery failure", async () => {
    const merchant = await makeMerchant("Delivery Network Failure");
    // Port 1 is a reserved, always-refused port — nothing ever listens there.
    await upsertMerchantWebhookUrl(merchant.id, "http://127.0.0.1:1/webhooks", undefined);
    const eventId = await insertPendingDelivery(merchant.id, "http://127.0.0.1:1/webhooks");

    const result = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });
    expect(result.success).toBe(false);
  });

  it("retries up to the bounded maximum, reusing the same event id, then gives up", async () => {
    mode = "fail";
    const merchant = await makeMerchant("Delivery Final Failure");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const eventId = await insertPendingDelivery(merchant.id, mockUrl());

    await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });
    await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });
    const third = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });

    expect(third.success).toBe(false);
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.headers["x-finbridge-event-id"])).size).toBe(1);

    const row = await db.query.merchantWebhookDeliveries.findFirst({ where: eq(merchantWebhookDeliveries.id, eventId) });
    expect(row?.status).toBe("failed");
    expect(row?.attemptCount).toBe(3);
  });

  it("succeeds on a retry after an initial failure, still with the same event id", async () => {
    mode = "flaky";
    flakyFailuresRemaining = 1;
    const merchant = await makeMerchant("Delivery Flaky");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const eventId = await insertPendingDelivery(merchant.id, mockUrl());

    const first = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });
    expect(first.success).toBe(false);
    const second = await attemptDelivery(eventId, ids.requestId(), { chainRetries: false });
    expect(second.success).toBe(true);

    expect(received).toHaveLength(2);
    expect(received[0]!.headers["x-finbridge-event-id"]).toBe(eventId);
    expect(received[1]!.headers["x-finbridge-event-id"]).toBe(eventId);

    const row = await db.query.merchantWebhookDeliveries.findFirst({ where: eq(merchantWebhookDeliveries.id, eventId) });
    expect(row?.status).toBe("delivered");
    expect(row?.attemptCount).toBe(2);
  });

  it("the automatic background retry chain (real timers) also recovers and delivers", async () => {
    mode = "flaky";
    flakyFailuresRemaining = 1;
    const merchant = await makeMerchant("Delivery Auto Chain");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);
    const eventId = await insertPendingDelivery(merchant.id, mockUrl());

    // No `chainRetries: false` here — let the real setTimeout-based scheduler
    // (MERCHANT_WEBHOOK_RETRY_BACKOFF_MS=50,50 in tests) drive the retry.
    await attemptDelivery(eventId, ids.requestId());
    await sleep(500);

    const row = await db.query.merchantWebhookDeliveries.findFirst({ where: eq(merchantWebhookDeliveries.id, eventId) });
    expect(row?.status).toBe("delivered");
    expect(row?.attemptCount).toBe(2);
  });

  it("sends a test event synchronously with no auto-retry, without leaking the secret", async () => {
    const merchant = await makeMerchant("Test Webhook");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    const result = await sendTestWebhook(merchant.id, ids.requestId());

    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(JSON.stringify(result)).not.toMatch(/whsec_/);
    expect(received).toHaveLength(1);
    const sentPayload = JSON.parse(received[0]!.body);
    expect(sentPayload.type).toBe("webhook.test");
  });

  it("refuses a test event when no webhook is configured", async () => {
    const merchant = await makeMerchant("Test Webhook Unconfigured");
    await expect(sendTestWebhook(merchant.id, ids.requestId())).rejects.toThrow(ApiError);
  });
});

describe("merchant webhooks triggered from real payment transitions", () => {
  it("SimProviderA success delivers a payment.succeeded merchant webhook", async () => {
    const merchant = await makeMerchant("Payment A Success");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    await createPaymentIntent(
      merchant.id,
      { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" },
      ids.requestId(),
    );
    await sleep(300);

    const deliveries = await listMerchantWebhookDeliveries(merchant.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("payment.succeeded");
    expect(deliveries[0]!.status).toBe("delivered");
  });

  it("SimProviderB's provider webhook (processing -> succeeded) delivers a merchant webhook", async () => {
    const merchant = await makeMerchant("Payment B Success");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    const created = await createPaymentIntent(
      merchant.id,
      { amount: 98000, currency: "LYD", provider: "sim_provider_b", scenario: "succeeded" },
      ids.requestId(),
    );
    expect(created.status).toBe("processing");
    // Automatic SimProviderB settlement is off under test, so it never
    // interferes with this test — settle it explicitly instead.
    expect(config.simProviderB.autoSettle).toBe(false);

    const { body } = buildSimProviderBWebhookPayload({
      paymentIntentId: created.id,
      providerReference: created.providerReference ?? `spb_${created.id}`,
      outcome: "succeeded",
    });
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);
    await processSimProviderBWebhook(rawBody, { signature, timestamp }, ids.requestId());
    await sleep(300);

    const deliveries = await listMerchantWebhookDeliveries(merchant.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("payment.succeeded");
    expect(deliveries[0]!.status).toBe("delivered");
  });

  it("a duplicate provider webhook (already-processed event) does not create a duplicate merchant event", async () => {
    const merchant = await makeMerchant("Payment B Duplicate");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    const created = await createPaymentIntent(
      merchant.id,
      { amount: 50000, currency: "LYD", provider: "sim_provider_b", scenario: "succeeded" },
      ids.requestId(),
    );

    const { body } = buildSimProviderBWebhookPayload({
      paymentIntentId: created.id,
      providerReference: created.providerReference ?? `spb_${created.id}`,
      outcome: "succeeded",
    });
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);

    await processSimProviderBWebhook(rawBody, { signature, timestamp }, ids.requestId());
    await expect(processSimProviderBWebhook(rawBody, { signature, timestamp }, ids.requestId())).rejects.toThrow(
      "already processed",
    );
    await sleep(300);

    const deliveries = await listMerchantWebhookDeliveries(merchant.id);
    expect(deliveries).toHaveLength(1);
  });

  it("does not enqueue a merchant event for an internal 'processing' transition", async () => {
    const merchant = await makeMerchant("Payment B Processing Only");
    await upsertMerchantWebhookUrl(merchant.id, mockUrl(), undefined);

    await createPaymentIntent(
      merchant.id,
      { amount: 25000, currency: "LYD", provider: "sim_provider_b", scenario: "succeeded" },
      ids.requestId(),
    );
    await sleep(200);

    const deliveries = await listMerchantWebhookDeliveries(merchant.id);
    expect(deliveries).toHaveLength(0);
  });

  it("never delivers to a merchant with no webhook configured", async () => {
    const merchant = await makeMerchant("No Webhook Configured");

    await createPaymentIntent(
      merchant.id,
      { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" },
      ids.requestId(),
    );
    await sleep(200);

    const deliveries = await listMerchantWebhookDeliveries(merchant.id);
    expect(deliveries).toHaveLength(0);
    expect(received).toHaveLength(0);
  });
});
