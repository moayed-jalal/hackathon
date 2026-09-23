/**
 * FinBridge sandbox smoke test — a real HTTP client hitting a running
 * instance of the API (never internal function calls). Run with:
 *
 *   pnpm smoke-test              (server must already be running, e.g. `pnpm dev`)
 *
 * Reports a presentation-friendly PASS/FAIL summary and, on success, POSTs
 * the result to the API so the dashboard's Smoke Tests panel picks it up.
 */
import "dotenv/config";

const BASE_URL = process.env.SMOKE_TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "admin_sandbox_secret_change_me";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET_SIM_PROVIDER_B ?? "whsec_sandbox_sim_provider_b_test_key";

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  const icon = passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${icon} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function jsonRequest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function signHmac(rawBody: string, timestamp: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`));
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  console.log("\nFINBRIDGE SANDBOX SMOKE TEST");
  console.log(`Target: ${BASE_URL}\n`);

  let apiKey = "";

  await check("Sandbox API is reachable", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert(res.ok, `expected /health to be reachable, got ${res.status}`);
  });

  await check("Bootstrap a sandbox merchant + API key", async () => {
    const res = await jsonRequest("/api/v1/merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN_SECRET },
      body: JSON.stringify({ name: "Smoke Test Merchant", email: `smoke-${Date.now()}@finbridge.sandbox` }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    apiKey = (res.body as { data: { api_key: string } }).data.api_key;
    assert(apiKey.startsWith("fb_test_"), "API key must use the sandbox fb_test_ prefix");
  });

  const authHeaders = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` });

  await check("Unauthenticated request is rejected (401)", async () => {
    const res = await jsonRequest("/api/v1/payment-intents");
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("Invalid API key is rejected (401)", async () => {
    const res = await jsonRequest("/api/v1/payment-intents", {
      headers: { Authorization: "Bearer fb_test_not_a_real_key_00000000000000" },
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("Invalid input is rejected (negative amount, bad currency)", async () => {
    const res = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: -100, currency: "XXX", provider: "sim_provider_a" }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert((res.body as { error: { code: string } }).error.code === "VALIDATION_ERROR", "expected VALIDATION_ERROR code");
  });

  await check("Create payment: SimProviderA success (synchronous)", async () => {
    const res = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success" }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    assert((res.body as { data: { status: string } }).data.status === "succeeded", "expected status succeeded");
  });

  await check("Create payment: SimProviderA declined (synchronous)", async () => {
    const res = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 500, currency: "USD", provider: "sim_provider_a", scenario: "declined" }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    assert((res.body as { data: { status: string } }).data.status === "failed", "expected status failed");
  });

  await check("Idempotency: repeated key returns the same payment, no duplicate", async () => {
    const key = `smoke-idem-${Date.now()}`;
    const payload = { amount: 2000, currency: "USD", provider: "sim_provider_a", scenario: "success" };
    const first = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": key },
      body: JSON.stringify(payload),
    });
    const second = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": key },
      body: JSON.stringify(payload),
    });
    const idA = (first.body as { data: { id: string } }).data.id;
    const idB = (second.body as { data: { id: string } }).data.id;
    assert(idA === idB, `expected same payment id, got ${idA} vs ${idB}`);
  });

  await check("Idempotency: same key + different payload is rejected (409)", async () => {
    const key = `smoke-idem-conflict-${Date.now()}`;
    await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": key },
      body: JSON.stringify({ amount: 100, currency: "USD", provider: "sim_provider_a" }),
    });
    const conflict = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": key },
      body: JSON.stringify({ amount: 200, currency: "USD", provider: "sim_provider_a" }),
    });
    assert(conflict.status === 409, `expected 409, got ${conflict.status}`);
  });

  let asyncPaymentId = "";
  await check("Create payment: SimProviderB is asynchronous (processing)", async () => {
    const res = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 98000, currency: "LYD", provider: "sim_provider_b" }),
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    const data = (res.body as { data: { id: string; status: string } }).data;
    assert(data.status === "processing", `expected status processing, got ${data.status}`);
    asyncPaymentId = data.id;
  });

  await check("SimProviderB settles via a verified, signed webhook", async () => {
    const res = await jsonRequest(`/api/v1/sandbox/payment-intents/${asyncPaymentId}/simulate-webhook`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ outcome: "succeeded" }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const after = await jsonRequest(`/api/v1/payment-intents/${asyncPaymentId}`, { headers: authHeaders() });
    assert(
      (after.body as { data: { status: string } }).data.status === "succeeded",
      "expected payment to be succeeded after webhook",
    );
  });

  await check("Webhook signature verification: invalid signature is rejected (401)", async () => {
    const rawBody = JSON.stringify({
      event_id: `evt_smoke_bad_sig_${Date.now()}`,
      type: "payment.settled",
      provider: "sim_provider_b",
      data: { payment_intent_id: asyncPaymentId, provider_reference: "spb_smoke", status: "settled" },
      created_at: new Date().toISOString(),
    });
    const res = await fetch(`${BASE_URL}/api/v1/webhooks/sim-provider-b`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FinBridge-Signature": "0".repeat(64),
        "X-FinBridge-Timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: rawBody,
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("Replay protection: duplicate event_id is rejected (409)", async () => {
    // Fresh payment intent still "processing" — the earlier async check
    // already settled `asyncPaymentId`, so reusing it here would fail the
    // *first* delivery on a state-transition conflict, not prove replay.
    const created = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 4200, currency: "EUR", provider: "sim_provider_b" }),
    });
    const replayTargetId = (created.body as { data: { id: string } }).data.id;

    const eventId = `evt_smoke_replay_${Date.now()}`;
    const rawBody = JSON.stringify({
      event_id: eventId,
      type: "payment.settled",
      provider: "sim_provider_b",
      data: { payment_intent_id: replayTargetId, provider_reference: "spb_smoke", status: "settled" },
      created_at: new Date().toISOString(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signHmac(rawBody, timestamp, WEBHOOK_SECRET);
    const headers = {
      "Content-Type": "application/json",
      "X-FinBridge-Signature": signature,
      "X-FinBridge-Timestamp": timestamp,
    };
    const first = await fetch(`${BASE_URL}/api/v1/webhooks/sim-provider-b`, { method: "POST", headers, body: rawBody });
    assert(first.status === 200, `expected first delivery to be 200, got ${first.status}`);
    const replay = await fetch(`${BASE_URL}/api/v1/webhooks/sim-provider-b`, { method: "POST", headers, body: rawBody });
    assert(replay.status === 409, `expected replay to be 409, got ${replay.status}`);
  });

  await check("State machine: cannot cancel an already-succeeded payment (409)", async () => {
    const create = await jsonRequest("/api/v1/payment-intents", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount: 100, currency: "USD", provider: "sim_provider_a", scenario: "success" }),
    });
    const id = (create.body as { data: { id: string } }).data.id;
    const cancel = await jsonRequest(`/api/v1/payment-intents/${id}/cancel`, { method: "POST", headers: authHeaders() });
    assert(cancel.status === 409, `expected 409, got ${cancel.status}`);
  });

  await check("Rate limiting: exceeding the request budget returns 429", async () => {
    const rateLimitMerchant = await jsonRequest("/api/v1/merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN_SECRET },
      body: JSON.stringify({ name: "Smoke Test Rate Limit Merchant", email: `smoke-rl-${Date.now()}@finbridge.sandbox` }),
    });
    const rlKey = (rateLimitMerchant.body as { data: { api_key: string } }).data.api_key;
    let sawRateLimit = false;
    for (let i = 0; i < 30; i += 1) {
      const res = await fetch(`${BASE_URL}/api/v1/payment-intents`, { headers: { Authorization: `Bearer ${rlKey}` } });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    assert(sawRateLimit, "expected at least one 429 within 30 requests");
  });

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;

  console.log(`\n${passed} / ${total} PASSED\n`);

  try {
    await jsonRequest("/api/v1/sandbox/smoke-test-results", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ total, passed, results }),
    });
  } catch {
    // Non-fatal — the dashboard just won't show this run.
  }

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
