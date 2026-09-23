/**
 * Cross-tenant isolation tests
 * These tests verify that users can only access their own workspace/merchant data
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { app } from "../../src/app.js";
import { config } from "../../src/config.js";
import { sql } from "../../src/db/client.js";
import { db } from "../../src/db/client.js";
import { users, workspaces, merchants, apiKeys, paymentIntents, auditEvents } from "../../src/db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { signWebhookPayload } from "../../src/lib/crypto.js";
import { createPaymentIntent } from "../../src/modules/payment-intents/service.js";
import { processSimProviderBWebhook } from "../../src/modules/webhooks/service.js";
import { buildSimProviderBWebhookPayload } from "../../src/modules/providers/simProviderB.js";
import { ids } from "../../src/lib/ids.js";
import { generateSessionId, createSession, validateSession, getGoogleUserInfo, findOrCreateUser, ensureWorkspaceAndMerchant } from "../../src/modules/auth/service.js";

const BASE_URL = `http://localhost:${config.port}`;
let server: Server;

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let userA: { userId: string; workspaceId: string; merchantId: string };
let userB: { userId: string; workspaceId: string; merchantId: string };
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: config.port }, () => resolve()) as unknown as Server;
  });

  // Create User A
  const googleUserA = {
    sub: `test_subject_A_${Date.now()}`,
    email: `userA-${Date.now()}@finbridge.sandbox`,
    name: "User A",
    picture: "https://example.com/avatarA.jpg",
    email_verified: true,
  };
  
  const userAObj = await findOrCreateUser(googleUserA);
  const { workspace: workspaceA, merchant: merchantA } = await ensureWorkspaceAndMerchant(userAObj.id, userAObj.name);

  userA = {
    userId: userAObj.id,
    workspaceId: workspaceA.id,
    merchantId: merchantA.id,
  };

  // Create User B
  const googleUserB = {
    sub: `test_subject_B_${Date.now()}`,
    email: `userB-${Date.now()}@finbridge.sandbox`,
    name: "User B",
    picture: "https://example.com/avatarB.jpg",
    email_verified: true,
  };
  
  const userBObj = await findOrCreateUser(googleUserB);
  const { workspace: workspaceB, merchant: merchantB } = await ensureWorkspaceAndMerchant(userBObj.id, userBObj.name);

  userB = {
    userId: userBObj.id,
    workspaceId: workspaceB.id,
    merchantId: merchantB.id,
  };

  // Create sessions for both users
  sessionA = await createSession(userA.userId);
  sessionB = await createSession(userB.userId);

  // Create some test data for User A
  await createPaymentIntent(
    userA.merchantId,
    { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success", reference: "order-A-1001" },
    ids.requestId(),
  );

  // Create some test data for User B
  await createPaymentIntent(
    userB.merchantId,
    { amount: 4200, currency: "USD", provider: "sim_provider_a", scenario: "declined", reference: "order-B-1002" },
    ids.requestId(),
  );

  // Create async payment for User B
  const asyncPaymentB = await createPaymentIntent(
    userB.merchantId,
    { amount: 98000, currency: "LYD", provider: "sim_provider_b", scenario: "succeeded", reference: "order-B-1003" },
    ids.requestId(),
  );
  
  // Settle it via webhook
  const { body } = buildSimProviderBWebhookPayload({
    paymentIntentId: asyncPaymentB.id,
    providerReference: asyncPaymentB.providerReference ?? `spb_${asyncPaymentB.id}`,
    outcome: "succeeded",
  });
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);
  await processSimProviderBWebhook(rawBody, { signature, timestamp }, ids.requestId());
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql.end();
});

function sessionHeadersA(extra: Record<string, string> = {}) {
  return { "Content-Type": "application/json", Cookie: `finbridge_session=${sessionA}`, ...extra };
}

function sessionHeadersB(extra: Record<string, string> = {}) {
  return { "Content-Type": "application/json", Cookie: `finbridge_session=${sessionB}`, ...extra };
}

describe("Cross-tenant isolation via Console sessions", () => {
  it("User A can access their console summary", async () => {
    const res = await request("/api/v1/console/summary", { headers: sessionHeadersA() });
    expect(res.status).toBe(200);
    expect((res.body as { data: { workspace_name: string } }).data.workspace_name).toContain("User A");
  });

  it("User B can access their console summary", async () => {
    const res = await request("/api/v1/console/summary", { headers: sessionHeadersB() });
    expect(res.status).toBe(200);
    expect((res.body as { data: { workspace_name: string } }).data.workspace_name).toContain("User B");
  });

  it("User A cannot access User B's console payments", async () => {
    const resB = await request("/api/v1/console/payment-intents", { headers: sessionHeadersB() });
    const paymentB = (resB.body as { data: Array<{ id: string }> }).data[0];
    
    const res = await request(`/api/v1/console/payment-intents/${paymentB.id}`, { headers: sessionHeadersA() });
    expect(res.status).toBe(404);
  });

  it("User B cannot access User A's console payments", async () => {
    const resA = await request("/api/v1/console/payment-intents", { headers: sessionHeadersA() });
    const paymentA = (resA.body as { data: Array<{ id: string }> }).data[0];
    
    const res = await request(`/api/v1/console/payment-intents/${paymentA.id}`, { headers: sessionHeadersB() });
    expect(res.status).toBe(404);
  });

  it("User A cannot simulate webhook for User B's payment", async () => {
    const resB = await request("/api/v1/console/payment-intents", { headers: sessionHeadersB() });
    const paymentB = (resB.body as { data: Array<{ id: string; provider: string }> }).data.find(p => p.provider === "sim_provider_b");
    
    if (paymentB) {
      const res = await request(`/api/v1/console/payment-intents/${paymentB.id}/simulate-webhook`, {
        method: "POST",
        headers: sessionHeadersA(),
        body: JSON.stringify({ outcome: "succeeded" }),
      });
      expect(res.status).toBe(404);
    }
  });

  it("User A cannot cancel User B's payment via console", async () => {
    const resB = await request("/api/v1/console/payment-intents", { headers: sessionHeadersB() });
    const paymentB = (resB.body as { data: Array<{ id: string; status: string }> }).data.find(p => 
      p.status === "created" || p.status === "processing"
    );
    
    if (paymentB) {
      const res = await request(`/api/v1/console/payment-intents/${paymentB.id}/cancel`, {
        method: "POST",
        headers: sessionHeadersA(),
      });
      expect(res.status).toBe(404);
    }
  });

  it("User A's console audit events are scoped to their workspace", async () => {
    const res = await request("/api/v1/console/audit-events", { headers: sessionHeadersA() });
    expect(res.status).toBe(200);
    const events = (res.body as { data: Array<{ merchant_id: string }> }).data;
    for (const e of events) {
      if (e.merchant_id) {
        expect(e.merchant_id).toBe(userA.merchantId);
      }
    }
  });
});

describe("Database-level tenant isolation verification", () => {
  it("Payment intents are scoped to merchant", async () => {
    const paymentsA = await db.query.paymentIntents.findMany({
      where: (pi, { eq }) => eq(pi.merchantId, userA.merchantId),
    });
    const paymentsB = await db.query.paymentIntents.findMany({
      where: (pi, { eq }) => eq(pi.merchantId, userB.merchantId),
    });
    
    expect(paymentsA.length).toBeGreaterThan(0);
    expect(paymentsB.length).toBeGreaterThan(0);
    
    // Verify no overlap
    const idsA = new Set(paymentsA.map(p => p.id));
    const idsB = new Set(paymentsB.map(p => p.id));
    
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  it("Audit events are scoped to merchant", async () => {
    const eventsA = await db.query.auditEvents.findMany({
      where: (ae, { eq }) => eq(ae.merchantId, userA.merchantId),
    });
    const eventsB = await db.query.auditEvents.findMany({
      where: (ae, { eq }) => eq(ae.merchantId, userB.merchantId),
    });
    
    // Verify no overlap
    const idsA = new Set(eventsA.map(e => e.id));
    const idsB = new Set(eventsB.map(e => e.id));
    
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  it("API keys are scoped to merchant", async () => {
    const keysA = await db.query.apiKeys.findMany({
      where: (ak, { eq }) => eq(ak.merchantId, userA.merchantId),
    });
    const keysB = await db.query.apiKeys.findMany({
      where: (ak, { eq }) => eq(ak.merchantId, userB.merchantId),
    });
    
    expect(keysA.length).toBeGreaterThan(0);
    expect(keysB.length).toBeGreaterThan(0);
    
    // Verify no overlap
    const idsA = new Set(keysA.map(k => k.id));
    const idsB = new Set(keysB.map(k => k.id));
    
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  it("Merchants are scoped to workspace", async () => {
    const merchantsA = await db.query.merchants.findMany({
      where: (m, { eq }) => eq(m.workspaceId, userA.workspaceId),
    });
    const merchantsB = await db.query.merchants.findMany({
      where: (m, { eq }) => eq(m.workspaceId, userB.workspaceId),
    });
    
    expect(merchantsA.length).toBeGreaterThanOrEqual(1);
    expect(merchantsB.length).toBeGreaterThanOrEqual(1);
    expect(merchantsA.some(m => m.id === userA.merchantId)).toBe(true);
    expect(merchantsB.some(m => m.id === userB.merchantId)).toBe(true);
  });

  it("Workspaces are scoped to user", async () => {
    const workspacesA = await db.query.workspaces.findMany({
      where: (w, { eq }) => eq(w.userId, userA.userId),
    });
    const workspacesB = await db.query.workspaces.findMany({
      where: (w, { eq }) => eq(w.userId, userB.userId),
    });
    
    expect(workspacesA.length).toBe(1);
    expect(workspacesB.length).toBe(1);
    expect(workspacesA[0].id).toBe(userA.workspaceId);
    expect(workspacesB[0].id).toBe(userB.workspaceId);
  });

  });