# FinBridge Live Demo Script

Total time: ~5 minutes. Everything below runs entirely locally — no internet connectivity, no
external services, no real financial systems.

## Setup (once)

```bash
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` prints a sandbox API key and writes it to `web/.env.local`. Keep the terminal it
printed to open — that key is also what you'll use in the commands below.

```bash
pnpm dev        # terminal 1: API on http://localhost:4000
pnpm dev:web    # terminal 2: site on http://localhost:5180
```

Open `http://localhost:5180/console` for the dashboard — it picks up the seeded key automatically.
(`http://localhost:5180` on its own is the marketing landing page, useful for opening the pitch.)
Open `http://localhost:4000/docs` in another tab if you want the interactive API reference visible too.

Export the key for the curl commands below:

```bash
export KEY=fb_test_...   # from the db:seed output
```

## The 7-step story

### Step 1 — Canonical API, SimProviderA, synchronous success

```bash
curl -s -X POST http://localhost:4000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"amount": 15000, "currency": "LYD", "provider": "sim_provider_a", "scenario": "success"}' | jq
```

**Result:** `status: "succeeded"` — immediately, one request, one response. Watch it appear on the
dashboard's Transactions page in real time.

### Step 2 — Same API, SimProviderB, asynchronous

```bash
curl -s -X POST http://localhost:4000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"amount": 98000, "currency": "LYD", "provider": "sim_provider_b", "scenario": "manual"}' | jq
```

**Result:** `status: "processing"`. Same request shape, same endpoint, same response envelope —
this is the interoperability point: the merchant never wrote provider-specific code, but the
underlying behavior is genuinely different. (Without `"scenario": "manual"`, SimProviderB settles
on its own via a signed webhook 2–5 seconds later; `manual` keeps it waiting so Step 3 can drive
the webhook by hand.) Save the returned `id` as `PI`:

```bash
export PI=pi_test_...   # from the response above
```

### Step 3 — Simulate the provider's webhook (signed, verified, accepted)

```bash
curl -s -X POST http://localhost:4000/api/v1/sandbox/payment-intents/$PI/simulate-webhook \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"outcome": "succeeded"}' | jq
```

**Result:** the payment transitions `processing -> succeeded`. This isn't a shortcut — it's a real
signed HTTP request to `POST /api/v1/webhooks/sim-provider-b`, verified by HMAC, exactly like a
genuine provider callback. Refresh the transaction detail page to see the completed timeline:
Payment Created → Provider Selected → Provider Response → Processing → Payment Completed.

### Step 4 — Idempotency: repeat the exact request

```bash
curl -s -X POST http://localhost:4000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-order-1001" \
  -d '{"amount": 15000, "currency": "LYD", "provider": "sim_provider_a", "scenario": "success"}' | jq -r '.data.id'

# run it again, verbatim:
curl -s -X POST http://localhost:4000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-order-1001" \
  -d '{"amount": 15000, "currency": "LYD", "provider": "sim_provider_a", "scenario": "success"}' | jq -r '.data.id'
```

**Result:** the same `pi_test_...` id both times. No duplicate transaction — check the Transactions
page count didn't move.

### Step 5 — Tampered webhook rejected

```bash
curl -s -X POST http://localhost:4000/api/v1/sandbox/payment-intents/$PI/tamper-webhook \
  -H "Authorization: Bearer $KEY" | jq
```

**Result:** `401 INVALID_SIGNATURE`. The sandbox helper resent the last webhook with its body
altered but the original signature intact — the signature no longer matches, so it's rejected.
Same effect as `docs/api.md`'s manual curl against the raw webhook endpoint with a garbage
signature.

### Step 6 — Replay a valid webhook

```bash
curl -s -X POST http://localhost:4000/api/v1/sandbox/payment-intents/$PI/replay-webhook \
  -H "Authorization: Bearer $KEY" | jq
```

**Result:** `409 DUPLICATE_EVENT`. This is the *exact* original webhook, byte-for-byte, valid
signature and all — rejected purely because its `event_id` was already processed.

### Step 7 — Rate limiting

```bash
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:4000/api/v1/payment-intents -H "Authorization: Bearer $KEY"
done; echo
```

**Result:** a run of `200`s, then `429`s once the 20-requests-per-10-seconds budget (default,
`docs/security.md`) is exceeded.

## Everything above, automated

```bash
pnpm smoke-test
```

Runs the same flow (plus a few more checks — invalid input, unauthorized/invalid-key rejection,
declined payments) against the live API and reports:

```
FINBRIDGE SANDBOX SMOKE TEST
✓ Sandbox API is reachable
✓ Bootstrap a sandbox merchant + API key
✓ Unauthenticated request is rejected (401)
✓ Invalid API key is rejected (401)
✓ Invalid input is rejected (negative amount, bad currency)
✓ Create payment: SimProviderA success (synchronous)
✓ Create payment: SimProviderA declined (synchronous)
✓ Idempotency: repeated key returns the same payment, no duplicate
✓ Idempotency: same key + different payload is rejected (409)
✓ Create payment: SimProviderB is asynchronous (processing)
✓ SimProviderB settles via a verified, signed webhook
✓ Webhook signature verification: invalid signature is rejected (401)
✓ Replay protection: duplicate event_id is rejected (409)
✓ State machine: cannot cancel an already-succeeded payment (409)
✓ Rate limiting: exceeding the request budget returns 429

15 / 15 PASSED
```

The result is also POSTed back to the API, so it shows up on the dashboard's Smoke Tests panel
immediately after the run — a nice thing to leave open on a second screen during the pitch.

## Dashboard-only version of the same story

Everything above can also be driven entirely from the UI, for a click-through demo:

1. **Transactions** page → create form → pick `sim_provider_a` / `success` → Create.
2. Same form → pick `sim_provider_b` → Create → note it lands in `processing`, then settles to
   `succeeded` on its own a few seconds later (SimProviderB's signed webhook, pushed live over SSE).
3. Click into that transaction → **Replay last webhook** / **Send tampered webhook** to exercise
   the security paths. (**Simulate webhook** is available while a payment is still `processing`,
   e.g. one created via the API with `"scenario": "manual"`.)
4. On the same transaction → **Send tampered webhook** → see the `401` result inline.
5. Same transaction → **Replay last webhook** → see the `409` result inline.
6. **Security** page → see `WEBHOOK_REJECTED`, `WEBHOOK_REPLAY_REJECTED`, and every other event
   from this session, each with its own request id.
7. **Smoke Tests** page → shows the latest `pnpm smoke-test` result.
