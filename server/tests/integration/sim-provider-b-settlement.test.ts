import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { app } from "../../src/app.js";
import { config } from "../../src/config.js";
import { sql } from "../../src/db/client.js";
import { createSession, ensureWorkspaceAndMerchant, findOrCreateUser } from "../../src/modules/auth/service.js";
import {
  createPaymentIntent,
  getPaymentIntentById,
  resumePendingSimProviderBSettlements,
} from "../../src/modules/payment-intents/service.js";
import { ids } from "../../src/lib/ids.js";

const BASE_URL = `http://localhost:${config.port}`;
let server: Server;
const settlementConfig = config.simProviderB as { autoSettle: boolean };

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: config.port }, () => resolve()) as unknown as Server;
  });
});

afterEach(() => {
  settlementConfig.autoSettle = false;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql.end();
});

async function makeSessionMerchant(label: string) {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const user = await findOrCreateUser({
    sub: `spb_settle_${unique}`,
    email: `${unique}@finbridge.sandbox`,
    name: label,
    picture: null,
    email_verified: true,
  });
  const { merchant } = await ensureWorkspaceAndMerchant(user.id, user.name);
  const sessionId = await createSession(user.id);
  return { merchantId: merchant.id, cookie: { Cookie: `finbridge_session=${sessionId}` } };
}

async function waitForStatus(id: string, expected: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    status = (await getPaymentIntentById(id)).status;
    if (status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return status;
}

function consolePost(path: string, cookie: Record<string, string>, body?: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("SimProviderB automatic settlement", () => {
  it("settles processing -> succeeded on its own via a verified webhook", async () => {
    settlementConfig.autoSettle = true;
    const { merchantId } = await makeSessionMerchant("Auto settle success");
    const created = await createPaymentIntent(
      merchantId,
      { amount: 1000, currency: "USD", provider: "sim_provider_b" },
      ids.requestId(),
    );
    expect(created.status).toBe("processing");
    expect(await waitForStatus(created.id, "succeeded")).toBe("succeeded");
  });

  it("settles processing -> failed for a failure scenario", async () => {
    settlementConfig.autoSettle = true;
    const { merchantId } = await makeSessionMerchant("Auto settle failure");
    const created = await createPaymentIntent(
      merchantId,
      { amount: 1000, currency: "USD", provider: "sim_provider_b", scenario: "failed" },
      ids.requestId(),
    );
    expect(await waitForStatus(created.id, "failed")).toBe("failed");
    expect((await getPaymentIntentById(created.id)).failureReason).toBe("sandbox_simulated_provider_rejection");
  });

  it("re-arms settlement for payments left processing by a restart, skipping 'manual' ones", async () => {
    const { merchantId } = await makeSessionMerchant("Resume after restart");
    // Created while auto-settlement is off — the equivalent of a timer lost to a restart.
    const stranded = await createPaymentIntent(
      merchantId,
      { amount: 1000, currency: "USD", provider: "sim_provider_b" },
      ids.requestId(),
    );
    const manual = await createPaymentIntent(
      merchantId,
      { amount: 1000, currency: "USD", provider: "sim_provider_b", scenario: "manual" },
      ids.requestId(),
    );

    settlementConfig.autoSettle = true;
    await resumePendingSimProviderBSettlements();

    expect(await waitForStatus(stranded.id, "succeeded")).toBe("succeeded");
    expect((await getPaymentIntentById(manual.id)).status).toBe("processing");
  });
});

describe("Console sandbox webhook actions", () => {
  it("replay resends the stored webhook byte-for-byte and is rejected as a duplicate", async () => {
    const { merchantId, cookie } = await makeSessionMerchant("Console replay");
    const created = await createPaymentIntent(
      merchantId,
      { amount: 1000, currency: "USD", provider: "sim_provider_b", scenario: "manual" },
      ids.requestId(),
    );

    const settle = await consolePost(`/api/v1/console/payment-intents/${created.id}/simulate-webhook`, cookie, {
      outcome: "succeeded",
    });
    expect(settle.status).toBe(200);

    const replay = await consolePost(`/api/v1/console/payment-intents/${created.id}/replay-webhook`, cookie);
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE_EVENT");

    const tamper = await consolePost(`/api/v1/console/payment-intents/${created.id}/tamper-webhook`, cookie);
    expect(tamper.status).toBe(401);
    expect(((await tamper.json()) as { error: { code: string } }).error.code).toBe("INVALID_SIGNATURE");

    expect((await getPaymentIntentById(created.id)).status).toBe("succeeded");
  });

  it("replay before any webhook exists does not settle the payment", async () => {
    const { merchantId, cookie } = await makeSessionMerchant("Console replay early");
    const created = await createPaymentIntent(
      merchantId,
      { amount: 1000, currency: "USD", provider: "sim_provider_b", scenario: "manual" },
      ids.requestId(),
    );

    const replay = await consolePost(`/api/v1/console/payment-intents/${created.id}/replay-webhook`, cookie);
    expect(replay.status).toBe(404);
    expect((await getPaymentIntentById(created.id)).status).toBe("processing");
  });

  it("simulate-webhook rejects an invalid outcome and a non-processing payment", async () => {
    const { merchantId, cookie } = await makeSessionMerchant("Console simulate validation");
    const created = await createPaymentIntent(
      merchantId,
      { amount: 1000, currency: "USD", provider: "sim_provider_b", scenario: "manual" },
      ids.requestId(),
    );

    const invalid = await consolePost(`/api/v1/console/payment-intents/${created.id}/simulate-webhook`, cookie, {
      outcome: "maybe",
    });
    expect(invalid.status).toBe(400);

    await consolePost(`/api/v1/console/payment-intents/${created.id}/simulate-webhook`, cookie, { outcome: "failed" });
    expect((await getPaymentIntentById(created.id)).status).toBe("failed");

    const again = await consolePost(`/api/v1/console/payment-intents/${created.id}/simulate-webhook`, cookie, {
      outcome: "succeeded",
    });
    expect(again.status).toBe(409);
    expect((await getPaymentIntentById(created.id)).status).toBe("failed");
  });
});
