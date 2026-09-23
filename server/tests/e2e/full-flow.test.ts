/**
 * End-to-end tests drive the real HTTP surface (no internal function calls),
 * exactly like the smoke-test CLI. This file starts its own server on
 * config.port — nothing else (including the dev server) should be bound to
 * that port while `pnpm test` runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { app } from "../../src/app.js";
import { config } from "../../src/config.js";
import { sql } from "../../src/db/client.js";
import { signWebhookPayload } from "../../src/lib/crypto.js";
import { db } from "../../src/db/client.js";
import { users, workspaces } from "../../src/db/schema.js";

const BASE_URL = `http://localhost:${config.port}`;
let server: Server;

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let apiKey: string;
let workspaceId: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: config.port }, () => resolve()) as unknown as Server;
  });

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

  const created = await request("/api/v1/merchants", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Secret": config.adminSecret },
    body: JSON.stringify({ name: "E2E Test Merchant", email: `e2e-${Date.now()}@finbridge.sandbox`, workspaceId }),
  });
  
  if (created.body && (created.body as { data: { api_key: string } }).data) {
    apiKey = (created.body as { data: { api_key: string } }).data.api_key;
  } else {
    console.error("Failed to create merchant:", created.body);
    throw new Error("Failed to create test merchant");
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql.end();
});

function authHeaders(extra: Record<string, string> = {}) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extra };
}

describe("authentication", () => {
  it("rejects requests with no API key", async () => {
    const res = await request("/api/v1/payment-intents");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid API key", async () => {
    const res = await request("/api/v1/payment-intents", {
      headers: { Authorization: "Bearer fb_test_not_a_real_key_at_all_00000000" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects merchant creation without the admin secret", async () => {
    const res = await request("/api/v1/merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope", email: "nope@finbridge.sandbox", workspaceId }),
    });
    expect(res.status).toBe(403);
  });

  it("bootstraps a merchant without workspaceId by auto-provisioning a workspace", async () => {
    const res = await request("/api/v1/merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Secret": config.adminSecret },
      body: JSON.stringify({ name: "Auto Workspace Merchant", email: "auto-ws@finbridge.sandbox" }),
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: { api_key: string; workspace_id: string } };
    expect(body.data.api_key.startsWith("fb_test_")).toBe(true);
    expect(body.data.workspace_id).toBeTruthy();
  });
});

describe("input validation", () => {
  it("rejects a negative amount", async () => {
    const res = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: -100, currency: "USD", provider: "sim_provider_a" }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unsupported currency", async () => {
    const res = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 100, currency: "GBP", provider: "sim_provider_a" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payment-intents`, {
      method: "POST",
      headers: authHeaders(),
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });
});

describe("canonical payment API", () => {
  it("creates a successful SimProviderA payment synchronously", async () => {
    const res = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" }),
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: { status: string; sandbox: boolean } };
    expect(body.data.status).toBe("succeeded");
    expect(body.data.sandbox).toBe(true);
  });

  it("declines a SimProviderA payment", async () => {
    const res = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 100, currency: "USD", provider: "sim_provider_a", scenario: "declined" }),
    });
    const body = res.body as { data: { status: string } };
    expect(body.data.status).toBe("failed");
  });

  it("retrieves a payment intent by id", async () => {
    const create = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 100, currency: "USD", provider: "sim_provider_a" }),
    });
    const id = (create.body as { data: { id: string } }).data.id;
    const get = await request(`/api/v1/payment-intents/${id}`, { headers: authHeaders() });
    expect(get.status).toBe(200);
    expect((get.body as { data: { id: string } }).data.id).toBe(id);
  });

  it("returns 404 for an unknown payment intent", async () => {
    const res = await request("/api/v1/payment-intents/pi_test_does_not_exist", { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("enforces the state machine: cannot cancel an already-succeeded payment", async () => {
    const create = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 100, currency: "USD", provider: "sim_provider_a", scenario: "success" }),
    });
    const id = (create.body as { data: { id: string } }).data.id;
    const cancel = await request(`/api/v1/payment-intents/${id}/cancel`, { method: "POST", headers: authHeaders() });
    expect(cancel.status).toBe(409);
  });
});

describe("idempotency", () => {
  it("returns the same payment intent for a repeated Idempotency-Key", async () => {
    const key = `e2e-idem-${Date.now()}`;
    const payload = { amount: 2500, currency: "USD", provider: "sim_provider_a", scenario: "success" };

    const first = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders({ "Idempotency-Key": key }),
      body: JSON.stringify(payload),
    });
    const second = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders({ "Idempotency-Key": key }),
      body: JSON.stringify(payload),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((first.body as { data: { id: string } }).data.id).toBe((second.body as { data: { id: string } }).data.id);
  });

  it("rejects the same key reused with a different payload", async () => {
    const key = `e2e-idem-conflict-${Date.now()}`;
    await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders({ "Idempotency-Key": key }),
      body: JSON.stringify({ amount: 100, currency: "USD", provider: "sim_provider_a" }),
    });
    const conflict = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders({ "Idempotency-Key": key }),
      body: JSON.stringify({ amount: 999, currency: "USD", provider: "sim_provider_a" }),
    });
    expect(conflict.status).toBe(409);
  });
});

describe("provider interoperability: SimProviderB async + webhook", () => {
  it("creates a processing payment, then settles it via a signed webhook", async () => {
    const create = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 8000, currency: "EUR", provider: "sim_provider_b" }),
    });
    expect((create.body as { data: { status: string } }).data.status).toBe("processing");
    const id = (create.body as { data: { id: string } }).data.id;

    const simulate = await request(`/api/v1/sandbox/payment-intents/${id}/simulate-webhook`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ outcome: "succeeded" }),
    });
    expect(simulate.status).toBe(200);

    const after = await request(`/api/v1/payment-intents/${id}`, { headers: authHeaders() });
    expect((after.body as { data: { status: string } }).data.status).toBe("succeeded");
  });

  it("rejects a webhook with an invalid signature", async () => {
    const rawBody = JSON.stringify({
      event_id: "evt_e2e_bad_sig",
      type: "payment.settled",
      provider: "sim_provider_b",
      data: { payment_intent_id: "pi_test_x", provider_reference: "spb_x", status: "settled" },
      created_at: new Date().toISOString(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${BASE_URL}/api/v1/webhooks/sim-provider-b`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FinBridge-Signature": "0".repeat(64),
        "X-FinBridge-Timestamp": timestamp,
      },
      body: rawBody,
    });
    expect(res.status).toBe(401);
  });

  it("rejects a replayed (duplicate event_id) webhook", async () => {
    const create = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 1000, currency: "USD", provider: "sim_provider_b" }),
    });
    const id = (create.body as { data: { id: string } }).data.id;

    const eventId = `evt_e2e_replay_${Date.now()}`;
    const rawBody = JSON.stringify({
      event_id: eventId,
      type: "payment.settled",
      provider: "sim_provider_b",
      data: { payment_intent_id: id, provider_reference: "spb_e2e", status: "settled" },
      created_at: new Date().toISOString(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);
    const headers = {
      "Content-Type": "application/json",
      "X-FinBridge-Signature": signature,
      "X-FinBridge-Timestamp": timestamp,
    };

    const first = await fetch(`${BASE_URL}/api/v1/webhooks/sim-provider-b`, { method: "POST", headers, body: rawBody });
    expect(first.status).toBe(200);

    const replay = await fetch(`${BASE_URL}/api/v1/webhooks/sim-provider-b`, { method: "POST", headers, body: rawBody });
    expect(replay.status).toBe(409);
  });

  it("[sandbox helper] tamper-webhook produces an invalid-signature rejection", async () => {
    const create = await request("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 1000, currency: "USD", provider: "sim_provider_b" }),
    });
    const id = (create.body as { data: { id: string } }).data.id;
    await request(`/api/v1/sandbox/payment-intents/${id}/simulate-webhook`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ outcome: "succeeded" }),
    });

    const tamper = await request(`/api/v1/sandbox/payment-intents/${id}/tamper-webhook`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(tamper.status).toBe(401);

    const replay = await request(`/api/v1/sandbox/payment-intents/${id}/replay-webhook`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(replay.status).toBe(409);
  });
});

describe("rate limiting", () => {
  it("returns 429 after exceeding the configured request budget in a window", async () => {
    // Fresh key so this test's bucket isn't polluted by requests earlier tests already made.
    const created = await request("/api/v1/merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Secret": config.adminSecret },
      body: JSON.stringify({ name: "Rate Limit Test Merchant", email: `ratelimit-${Date.now()}@finbridge.sandbox`, workspaceId }),
    });
    const rateLimitKey = (created.body as { data: { api_key: string } }).data.api_key;

    const statuses: number[] = [];
    for (let i = 0; i < config.rateLimit.maxRequests + 5; i += 1) {
      const res = await fetch(`${BASE_URL}/api/v1/payment-intents`, {
        headers: { Authorization: `Bearer ${rateLimitKey}` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});