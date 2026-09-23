import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { app } from "../../src/app.js";
import { config } from "../../src/config.js";
import { sql, db } from "../../src/db/client.js";
import { users, workspaces } from "../../src/db/schema.js";
import { createSession, ensureWorkspaceAndMerchant, findOrCreateUser } from "../../src/modules/auth/service.js";
import { applyTransition, createPaymentIntent } from "../../src/modules/payment-intents/service.js";
import { _subscriberCount } from "../../src/modules/console/events.js";
import { ids } from "../../src/lib/ids.js";

const BASE_URL = `http://localhost:${config.port}`;
let server: Server;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: config.port }, () => resolve()) as unknown as Server;
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql.end();
});

async function makeSessionUser(label: string) {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const googleUser = {
    sub: `sse_test_${unique}`,
    email: `${unique}@finbridge.sandbox`,
    name: label,
    picture: null,
    email_verified: true,
  };
  const user = await findOrCreateUser(googleUser);
  const { workspace, merchant } = await ensureWorkspaceAndMerchant(user.id, user.name);
  const sessionId = await createSession(user.id);
  return { userId: user.id, workspaceId: workspace.id, merchantId: merchant.id, sessionId };
}

function sessionCookieHeader(sessionId: string) {
  return { Cookie: `finbridge_session=${sessionId}` };
}

/** Reads SSE frames off a fetch Response body until `until` returns true, a specific event type/count is seen, or the timeout elapses. */
async function readSSEEvents(
  response: Response,
  opts: { timeoutMs?: number; minEvents?: number } = {},
): Promise<Array<{ event?: string; id?: string; data: string }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event?: string; id?: string; data: string }> = [];
  let buffer = "";
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(remaining, 0))),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const parsed: { event?: string; id?: string; data: string } = { data: "" };
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event: ")) parsed.event = line.slice("event: ".length);
        else if (line.startsWith("id: ")) parsed.id = line.slice("id: ".length);
        else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
      }
      parsed.data = dataLines.join("\n");
      events.push(parsed);
    }

    // The stream now also carries audit.event_created (and other) frames
    // alongside payment.status_changed — count only the type this suite
    // actually asserts on, so an audit event for the same transition
    // doesn't end the read before the status-change frame arrives.
    if (opts.minEvents && events.filter((e) => e.event === "payment.status_changed").length >= opts.minEvents) break;
  }

  await reader.cancel().catch(() => {});
  return events;
}

describe("GET /api/v1/console/events (SSE)", () => {
  it("requires authentication", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/console/events`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  });

  it("streams text/event-stream with the expected headers once authenticated", async () => {
    const userA = await makeSessionUser("SSE Headers User");
    const res = await fetch(`${BASE_URL}/api/v1/console/events`, { headers: sessionCookieHeader(userA.sessionId) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    await res.body?.cancel();
  });

  it("delivers an event after a successful payment transition, with a stable event id matching the payload", async () => {
    const merchant = await makeSessionUser("SSE Delivery User");
    const streamPromise = fetch(`${BASE_URL}/api/v1/console/events`, { headers: sessionCookieHeader(merchant.sessionId) });
    const stream = await streamPromise;

    const created = await createPaymentIntent(
      merchant.merchantId,
      { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" },
      ids.requestId(),
    );

    const events = await readSSEEvents(stream, { minEvents: 1, timeoutMs: 2000 });
    const statusEvents = events.filter((e) => e.event === "payment.status_changed");

    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    const last = statusEvents[statusEvents.length - 1]!;
    const payload = JSON.parse(last.data);
    expect(payload.payment_intent_id).toBe(created.id);
    expect(payload.status).toBe("succeeded");
    expect(payload.merchant_id).toBe(merchant.merchantId);
    expect(last.id).toBe(payload.id);
  });

  it("does not deliver an event for a failed (rejected) transition attempt", async () => {
    const merchant = await makeSessionUser("SSE No Event On Failure User");
    const stream = await fetch(`${BASE_URL}/api/v1/console/events`, { headers: sessionCookieHeader(merchant.sessionId) });

    const created = await createPaymentIntent(
      merchant.merchantId,
      { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" },
      ids.requestId(),
    );
    // Already "succeeded" — attempting created->succeeded again must be rejected by the state machine and must not emit.
    await expect(applyTransition(created.id, "created", "succeeded", ids.requestId())).rejects.toThrow();

    const events = await readSSEEvents(stream, { timeoutMs: 1200 });
    const statusEvents = events.filter((e) => e.event === "payment.status_changed");
    // Only the original real "succeeded" transition from createPaymentIntent should appear — never a second one from the rejected attempt.
    expect(statusEvents.length).toBe(1);
  });

  it("never delivers merchant A's events to merchant B's connection (tenant isolation)", async () => {
    const merchantA = await makeSessionUser("SSE Tenant A");
    const merchantB = await makeSessionUser("SSE Tenant B");

    const streamB = await fetch(`${BASE_URL}/api/v1/console/events`, { headers: sessionCookieHeader(merchantB.sessionId) });

    await createPaymentIntent(
      merchantA.merchantId,
      { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" },
      ids.requestId(),
    );

    const eventsOnB = await readSSEEvents(streamB, { timeoutMs: 1200 });
    const statusEventsOnB = eventsOnB.filter((e) => e.event === "payment.status_changed");
    expect(statusEventsOnB).toHaveLength(0);
  });

  it("delivers to multiple simultaneous connections for the same merchant", async () => {
    const merchant = await makeSessionUser("SSE Multi Connection");
    const [streamX, streamY] = await Promise.all([
      fetch(`${BASE_URL}/api/v1/console/events`, { headers: sessionCookieHeader(merchant.sessionId) }),
      fetch(`${BASE_URL}/api/v1/console/events`, { headers: sessionCookieHeader(merchant.sessionId) }),
    ]);

    await createPaymentIntent(
      merchant.merchantId,
      { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" },
      ids.requestId(),
    );

    const [eventsX, eventsY] = await Promise.all([
      readSSEEvents(streamX, { minEvents: 1, timeoutMs: 2000 }),
      readSSEEvents(streamY, { minEvents: 1, timeoutMs: 2000 }),
    ]);

    expect(eventsX.filter((e) => e.event === "payment.status_changed").length).toBeGreaterThanOrEqual(1);
    expect(eventsY.filter((e) => e.event === "payment.status_changed").length).toBeGreaterThanOrEqual(1);
  });

  it("cleans up the subscriber when the connection is closed", async () => {
    const merchant = await makeSessionUser("SSE Cleanup");
    const controller = new AbortController();
    const stream = await fetch(`${BASE_URL}/api/v1/console/events`, {
      headers: sessionCookieHeader(merchant.sessionId),
      signal: controller.signal,
    });
    // Read one chunk (or timeout) so the connection is fully established server-side.
    await Promise.race([stream.body!.getReader().read(), new Promise((r) => setTimeout(r, 200))]);
    expect(_subscriberCount(merchant.merchantId)).toBeGreaterThanOrEqual(1);

    controller.abort();
    await new Promise((r) => setTimeout(r, 300));

    expect(_subscriberCount(merchant.merchantId)).toBe(0);
  });
});
