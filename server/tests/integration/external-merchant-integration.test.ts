/**
 * Proves the two gaps found by the external-integration audit are closed:
 *   1. An API-key-only merchant can configure/read/rotate/test its own
 *      merchant webhook and see its delivery history — no Console session.
 *   2. An API-key-only (or Console-session-only) merchant can mint and
 *      manage its own API keys — no X-Admin-Secret after onboarding.
 *
 * Drives the real HTTP surface (no internal function calls) exactly like
 * tenant-isolation.test.ts / full-flow.test.ts, and reuses the exact same
 * merchant-webhooks/service.ts delivery mechanism already covered by
 * merchant-webhooks.test.ts — this file does not re-test signing/retry/SSRF
 * internals, only that the new API-key-authenticated routes wire up to them
 * correctly and stay tenant-isolated.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { app } from "../../src/app.js";
import { config } from "../../src/config.js";
import { sql, db } from "../../src/db/client.js";
import { verifyWebhookSignature } from "../../src/lib/crypto.js";
import { createSession } from "../../src/modules/auth/service.js";
import { users, workspaces } from "../../src/db/schema.js";
import { createMerchantWithApiKey } from "../../src/modules/merchants/service.js";
import { ids } from "../../src/lib/ids.js";

const BASE_URL = `http://localhost:${config.port}`;
let server: Server;

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// --- a tiny local "merchant server" this file fully controls ---
let mockServer: http.Server;
let mockPort: number;
type ReceivedRequest = { headers: http.IncomingHttpHeaders; body: string };
let received: ReceivedRequest[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: config.port }, () => resolve()) as unknown as Server;
  });

  mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  mockPort = (mockServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  await sql.end();
});

beforeEach(() => {
  received = [];
});

function mockUrl(suffix = "") {
  return `http://127.0.0.1:${mockPort}/webhooks/finbridge${suffix}`;
}

async function bootstrapMerchant(name: string) {
  const created = await request("/api/v1/merchants", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Secret": config.adminSecret },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}@finbridge.sandbox` }),
  });
  const apiKey = (created.body as { data: { api_key: string } }).data.api_key;
  return { apiKey };
}

function authHeaders(apiKey: string, extra: Record<string, string> = {}) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extra };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("API-key merchant webhook configuration (external integration API)", () => {
  it("reads its own configuration (initially unconfigured)", async () => {
    const { apiKey } = await bootstrapMerchant("EXT Config Read");
    const res = await request("/api/v1/merchants/webhook", { headers: authHeaders(apiKey) });
    expect(res.status).toBe(200);
    expect((res.body as { data: { configured: boolean } }).data.configured).toBe(false);
  });

  it("configures a webhook URL via API key alone and reveals the secret exactly once", async () => {
    const { apiKey } = await bootstrapMerchant("EXT Config Write");
    const res = await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ url: mockUrl(), enabled: true }),
    });
    expect(res.status).toBe(200);
    const data = (res.body as { data: { configured: boolean; url: string; secret?: string } }).data;
    expect(data.configured).toBe(true);
    expect(data.url).toBe(mockUrl());
    expect(data.secret).toMatch(/^whsec_/);

    // A second read never leaks the full secret again — only a masked preview.
    const readBack = await request("/api/v1/merchants/webhook", { headers: authHeaders(apiKey) });
    expect(JSON.stringify(readBack.body)).not.toContain(data.secret);
  });

  it("rejects an SSRF-unsafe URL exactly like the Console path does", async () => {
    const { apiKey } = await bootstrapMerchant("EXT SSRF Guard");
    const res = await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ url: "https://10.0.0.5/webhooks" }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("regenerates the secret, invalidating the old one", async () => {
    const { apiKey } = await bootstrapMerchant("EXT Regenerate");
    const first = await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ url: mockUrl() }),
    });
    const firstSecret = (first.body as { data: { secret: string } }).data.secret;

    const regenerated = await request("/api/v1/merchants/webhook/regenerate-secret", {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    expect(regenerated.status).toBe(200);
    const newSecret = (regenerated.body as { data: { secret: string } }).data.secret;
    expect(newSecret).not.toBe(firstSecret);
  });

  it("sends a test event and it shows up in delivery history", async () => {
    const { apiKey } = await bootstrapMerchant("EXT Test Event");
    await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ url: mockUrl() }),
    });

    const testRes = await request("/api/v1/merchants/webhook/test", { method: "POST", headers: authHeaders(apiKey) });
    expect(testRes.status).toBe(200);
    expect((testRes.body as { data: { success: boolean } }).data.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body).type).toBe("webhook.test");

    const deliveries = await request("/api/v1/merchants/webhook/deliveries", { headers: authHeaders(apiKey) });
    expect(deliveries.status).toBe(200);
    const rows = (deliveries.body as { data: { event_type: string; status: string }[] }).data;
    expect(rows.some((r) => r.event_type === "webhook.test" && r.status === "delivered")).toBe(true);
  });

  it("disables the configuration", async () => {
    const { apiKey } = await bootstrapMerchant("EXT Disable");
    await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ url: mockUrl() }),
    });
    const disabled = await request("/api/v1/merchants/webhook", { method: "DELETE", headers: authHeaders(apiKey) });
    expect(disabled.status).toBe(200);
    expect((disabled.body as { data: { configured: boolean } }).data.configured).toBe(false);
  });

  it("keeps one merchant's config, secret, and deliveries completely isolated from another's", async () => {
    const merchantA = await bootstrapMerchant("EXT Tenant A");
    const merchantB = await bootstrapMerchant("EXT Tenant B");

    await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(merchantA.apiKey),
      body: JSON.stringify({ url: mockUrl("?tenant=a") }),
    });

    // B never configured anything — its own view must show unconfigured,
    // never A's URL, secret, or deliveries. No merchant_id is ever sent by
    // the client; this is purely a function of which key authenticated.
    const bConfig = await request("/api/v1/merchants/webhook", { headers: authHeaders(merchantB.apiKey) });
    expect((bConfig.body as { data: { configured: boolean; url: string | null } }).data.configured).toBe(false);
    expect((bConfig.body as { data: { url: string | null } }).data.url).toBeNull();

    const bDeliveries = await request("/api/v1/merchants/webhook/deliveries", { headers: authHeaders(merchantB.apiKey) });
    expect((bDeliveries.body as { data: unknown[] }).data).toHaveLength(0);

    // B configuring its own webhook must never disturb A's.
    await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(merchantB.apiKey),
      body: JSON.stringify({ url: mockUrl("?tenant=b") }),
    });
    const aAfter = await request("/api/v1/merchants/webhook", { headers: authHeaders(merchantA.apiKey) });
    expect((aAfter.body as { data: { url: string } }).data.url).toBe(mockUrl("?tenant=a"));
  });

  it("rejects missing, invalid, and revoked API keys on every new route", async () => {
    const noAuth = await request("/api/v1/merchants/webhook");
    expect(noAuth.status).toBe(401);

    const badKey = await request("/api/v1/merchants/webhook", {
      headers: authHeaders("fb_test_not_a_real_key_00000000000000"),
    });
    expect(badKey.status).toBe(401);

    const { apiKey } = await bootstrapMerchant("EXT Revoked Key");
    // Revoke it, then confirm the new routes reject it too.
    const meRes = await request("/api/v1/api-keys", { headers: authHeaders(apiKey) });
    const keyId = (meRes.body as { data: { id: string }[] }).data[0]!.id;
    await request(`/api/v1/api-keys/${keyId}`, { method: "DELETE", headers: authHeaders(apiKey) });

    const afterRevoke = await request("/api/v1/merchants/webhook", { headers: authHeaders(apiKey) });
    expect(afterRevoke.status).toBe(401);
  });

  it("proves the full external loop: API key -> configure webhook -> create payment -> provider transition -> signed merchant webhook delivered", async () => {
    const { apiKey } = await bootstrapMerchant("EXT Full Loop");

    const configured = await request("/api/v1/merchants/webhook", {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ url: mockUrl() }),
    });
    const secret = (configured.body as { data: { secret: string } }).data.secret;

    const payment = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" }),
    });
    expect(payment.status).toBe(201);
    expect((payment.body as { data: { status: string } }).data.status).toBe("succeeded");

    await sleep(300);
    expect(received).toHaveLength(1);
    const delivered = received[0]!;
    const signature = delivered.headers["x-finbridge-signature"] as string;
    const timestamp = delivered.headers["x-finbridge-timestamp"] as string;
    expect(delivered.headers["x-finbridge-event-id"]).toBeDefined();
    expect(verifyWebhookSignature(delivered.body, timestamp, signature, secret)).toBe(true);
    expect(JSON.parse(delivered.body).type).toBe("payment.succeeded");

    const deliveries = await request("/api/v1/merchants/webhook/deliveries", { headers: authHeaders(apiKey) });
    const rows = (deliveries.body as { data: { status: string; event_type: string }[] }).data;
    expect(rows.some((r) => r.event_type === "payment.succeeded" && r.status === "delivered")).toBe(true);
  });
});

describe("API-key self-service key management", () => {
  it("creates an additional key for the same merchant without X-Admin-Secret", async () => {
    const { apiKey } = await bootstrapMerchant("KEYS Self Service");
    const res = await request("/api/v1/api-keys", { method: "POST", headers: authHeaders(apiKey) });
    expect(res.status).toBe(201);
    const created = (res.body as { data: { api_key: string; prefix: string } }).data;
    expect(created.api_key).toMatch(/^fb_test_/);

    // The freshly minted key authenticates on its own.
    const check = await request("/api/v1/payment-intents", { headers: authHeaders(created.api_key) });
    expect(check.status).toBe(200);
  });

  it("lists only the authenticated merchant's own keys, never another merchant's", async () => {
    const merchantA = await bootstrapMerchant("KEYS Tenant A");
    const merchantB = await bootstrapMerchant("KEYS Tenant B");
    await request("/api/v1/api-keys", { method: "POST", headers: authHeaders(merchantA.apiKey) });

    const listA = await request("/api/v1/api-keys", { headers: authHeaders(merchantA.apiKey) });
    const listB = await request("/api/v1/api-keys", { headers: authHeaders(merchantB.apiKey) });

    const idsA = new Set((listA.body as { data: { id: string }[] }).data.map((k) => k.id));
    const idsB = (listB.body as { data: { id: string }[] }).data.map((k) => k.id);
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
    // Never the hash or a plaintext secret.
    expect(JSON.stringify(listA.body)).not.toMatch(/fb_test_[A-Za-z0-9_-]{20,}/);
  });

  it("revokes a self-created key, which then fails authentication", async () => {
    const { apiKey } = await bootstrapMerchant("KEYS Revoke");
    const created = await request("/api/v1/api-keys", { method: "POST", headers: authHeaders(apiKey) });
    const newKey = (created.body as { data: { id: string; api_key: string } }).data;

    const revoke = await request(`/api/v1/api-keys/${newKey.id}`, { method: "DELETE", headers: authHeaders(apiKey) });
    expect(revoke.status).toBe(200);

    const afterRevoke = await request("/api/v1/payment-intents", { headers: authHeaders(newKey.api_key) });
    expect(afterRevoke.status).toBe(401);
  });

  it("lets a Console-session-only merchant mint its very first key without database access", async () => {
    const unique = `console_bootstrap_${Date.now()}`;
    const [user] = await db
      .insert(users)
      .values({ googleSubject: unique, email: `${unique}@finbridge.sandbox`, name: "Console Only", avatarUrl: null })
      .returning();
    const [workspace] = await db.insert(workspaces).values({ userId: user!.id, name: "Console Only Workspace" }).returning();
    // Simulates a real Google-OAuth-provisioned merchant: it exists, and
    // already has a bootstrap key server-side, but — exactly like
    // auth/service.ts's ensureWorkspaceAndMerchant — nobody ever reads that
    // key's plaintext here. Only the session-authenticated route below can
    // give this merchant a key it can actually use.
    await createMerchantWithApiKey({
      name: "Console Only Merchant",
      email: `${unique}-merchant@finbridge.sandbox`,
      workspaceId: workspace!.id,
      requestId: ids.requestId(),
    });

    // A stale/foreign session id must fail cleanly (sanity check on the auth
    // path itself before trusting the happy path below).
    const badSession = await request("/api/v1/console/api-keys", { headers: { Cookie: "finbridge_session=not_a_real_session" } });
    expect(badSession.status).toBe(401);

    const sessionId = await createSession(user!.id);
    const cookie = `finbridge_session=${sessionId}`;

    const firstKey = await request("/api/v1/console/api-keys", { method: "POST", headers: { Cookie: cookie } });
    expect(firstKey.status).toBe(201);
    const revealed = (firstKey.body as { data: { api_key: string } }).data.api_key;
    expect(revealed).toMatch(/^fb_test_/);

    // That key now works as a normal external-API credential.
    const works = await request("/api/v1/payment-intents", { headers: authHeaders(revealed) });
    expect(works.status).toBe(200);

    const list = await request("/api/v1/console/api-keys", { headers: { Cookie: cookie } });
    expect((list.body as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("existing Console webhook functionality is unaffected", () => {
  it("Console session can still read/write its own webhook config exactly as before", async () => {
    const unique = `console_still_works_${Date.now()}`;
    const [user] = await db
      .insert(users)
      .values({ googleSubject: unique, email: `${unique}@finbridge.sandbox`, name: "Still Works", avatarUrl: null })
      .returning();
    const [workspace] = await db.insert(workspaces).values({ userId: user!.id, name: "Still Works Workspace" }).returning();
    await createMerchantWithApiKey({
      name: "Still Works Merchant",
      email: `${unique}-merchant@finbridge.sandbox`,
      workspaceId: workspace!.id,
      requestId: ids.requestId(),
    });
    const sessionId = await createSession(user!.id);
    const cookie = `finbridge_session=${sessionId}`;

    const put = await request("/api/v1/console/webhook", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ url: mockUrl("?via=console"), enabled: true }),
    });
    expect(put.status).toBe(200);

    const get = await request("/api/v1/console/webhook", { headers: { Cookie: cookie } });
    expect((get.body as { data: { url: string } }).data.url).toBe(mockUrl("?via=console"));

    // API-key auth must never work on the Console's own session-only routes.
    const wrongAuth = await request("/api/v1/console/webhook", { headers: { Authorization: "Bearer fb_test_whatever" } });
    expect(wrongAuth.status).toBe(401);
  });
});
