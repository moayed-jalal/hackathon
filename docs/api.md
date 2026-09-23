# FinBridge API

Base URL (local): `http://localhost:4000`
Interactive reference: `GET /docs` (renders `GET /openapi.json`)

**SANDBOX ONLY — NO REAL MONEY.** Every payment intent carries `"sandbox": true`. Providers are
named `sim_provider_a` / `sim_provider_b` — there is no "real" provider, by design.

## Authentication

```
Authorization: Bearer fb_test_<your sandbox api key>
```

Obtain a key with:

```bash
curl -X POST http://localhost:4000/api/v1/merchants \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Test Merchant", "email": "me@example.com"}'
```

The response's `data.api_key` is shown **exactly once** — store it. `data.api_key_prefix` is safe
to log or display afterward. Once you hold that first key, `POST /api/v1/api-keys` mints additional
ones yourself — `X-Admin-Secret` is a one-time platform-bootstrap step, not something you need
again. See "API key management" below.

Every other endpoint below requires the `Authorization` header unless stated otherwise.

### Scopes

Each key carries scopes, checked per-endpoint:

| Scope | Grants |
|---|---|
| `payments:read` | List/retrieve payment intents and their timeline |
| `payments:write` | Create/cancel payment intents |
| `sandbox:simulate` | The sandbox simulate/replay/tamper-webhook helpers |
| `apikeys:write` | Create/list/revoke your own API keys |
| `webhooks:read` | Read your webhook configuration and delivery history |
| `webhooks:write` | Configure, disable, rotate, or test your webhook |

A key created via `POST /api/v1/merchants` or `POST /api/v1/api-keys` gets all six by default.

## Response envelope

Success:

```json
{ "data": { "...": "..." }, "request_id": "req_test_..." }
```

Error:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} }, "request_id": "req_test_..." }
```

`request_id` also comes back as the `X-Request-Id` response header, and is threaded through every
log line and audit event touched by that request.

## Money

All amounts are **integers in minor units**. `15000` on a `LYD` payment means `150.00 LYD`. There
is no floating-point arithmetic anywhere in the payment path.

## Canonical Payment API

### `POST /api/v1/payment-intents`

Creates a payment intent and synchronously drives it to its first canonical status.

Headers:
- `Idempotency-Key` (optional, strongly recommended): repeating the same key with an equivalent
  body returns the original result. Reusing the key with a **different** body returns 409.

Body:

```json
{
  "amount": 15000,
  "currency": "LYD",
  "provider": "sim_provider_a",
  "scenario": "success",
  "reference": "order-1001",
  "metadata": { "order_id": "1001" }
}
```

| Field | Type | Notes |
|---|---|---|
| `amount` | integer, required | Positive, minor units |
| `currency` | enum, required | `USD`, `EUR`, `LYD` |
| `provider` | enum, required | `sim_provider_a`, `sim_provider_b` |
| `scenario` | string, optional | See "Provider scenarios" below |
| `reference` | string, optional | Free-form merchant reference |
| `metadata` | object, optional | String values only |

`sim_provider_a` resolves synchronously — the response already reflects `succeeded` or `failed`.
`sim_provider_b` always returns `processing`; its final status arrives later via a webhook (or via
the sandbox `simulate-webhook` helper below).

Response: `201` with the created (or idempotently-replayed) payment intent.

### `GET /api/v1/payment-intents/:id`

Returns the payment intent, scoped to the authenticated merchant. Unknown or another merchant's
id → `404`.

### `GET /api/v1/payment-intents?limit=20&status=processing`

Lists the authenticated merchant's payment intents, newest first. `limit` max 100. `status` is
optional.

### `GET /api/v1/payment-intents/:id/timeline`

Returns the ordered lifecycle events for a payment intent — this is what the dashboard's
transaction detail page renders.

### `POST /api/v1/payment-intents/:id/cancel`

Valid only from `created` or `processing` (i.e. before a `sim_provider_b` payment's webhook has
settled it). Any other status → `409 INVALID_STATE_TRANSITION`.

## Provider scenarios

| Provider | `scenario` | Result |
|---|---|---|
| `sim_provider_a` | `success` (default) | Immediately `succeeded` |
| `sim_provider_a` | `declined` | Immediately `failed` |
| `sim_provider_b` | any | Always `processing` immediately; final outcome decided when its webhook fires |

## Provider state machine

```
created -> processing -> succeeded
created -> processing -> failed
created -> processing -> cancelled   (sim_provider_b, before its webhook arrives)
created -> succeeded                 (sim_provider_a, success)
created -> failed                    (sim_provider_a, declined)
created -> cancelled
```

`succeeded`, `failed`, and `cancelled` are terminal. See
[`server/src/modules/payment-intents/state-machine.ts`](../server/src/modules/payment-intents/state-machine.ts).

## Webhooks (SimProviderB)

### `POST /api/v1/webhooks/sim-provider-b`

Not merchant-authenticated (no `Authorization` header) — authenticated instead by HMAC signature,
the same way a real payment provider authenticates itself to your webhook receiver.

Headers:

```
X-FinBridge-Signature: <hex HMAC-SHA256 of "${timestamp}.${rawBody}">
X-FinBridge-Timestamp: <unix seconds>
```

Body:

```json
{
  "event_id": "evt_test_...",
  "type": "payment.settled",
  "provider": "sim_provider_b",
  "data": {
    "payment_intent_id": "pi_test_...",
    "provider_reference": "spb_...",
    "status": "settled"
  },
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

Signing secret: `WEBHOOK_SECRET_SIM_PROVIDER_B` (see `.env.example`).

Responses: `200` (verified + processed), `401` (missing/invalid signature or stale timestamp),
`409` (duplicate `event_id` — replay rejected), `400` (malformed JSON or schema validation
failure).

## Sandbox control endpoints

These are explicitly **sandbox extensions**, not part of the "real provider" contract — they let
you drive SimProviderB's async behavior and exercise its security paths on demand instead of
waiting on a timer.

### `POST /api/v1/sandbox/payment-intents/:id/simulate-webhook`

Body: `{ "outcome": "succeeded" | "failed" }`. Only valid while the payment is `processing` on
`sim_provider_b`. Internally builds a correctly-signed webhook and delivers it to the real webhook
receiver over HTTP — the same code path a genuine webhook would take.

### `POST /api/v1/sandbox/payment-intents/:id/replay-webhook`

Resends the last webhook delivered for this payment intent, byte-for-byte, including its original
signature and timestamp. **Expected result: `409`** — this proves replay protection.

### `POST /api/v1/sandbox/payment-intents/:id/tamper-webhook`

Resends the last webhook with its body mutated but its original signature intact. **Expected
result: `401`** — this proves signature verification.

### `GET /api/v1/sandbox/smoke-test-results/latest`

Returns the most recent `pnpm smoke-test` run, for the dashboard's Smoke Tests panel.

## Dashboard read endpoints

- `GET /api/v1/dashboard/summary` — transaction counts by status, security event count, latest
  smoke test.
- `GET /api/v1/dashboard/audit-events` — recent audit/security events for the merchant.
- `GET /api/v1/dashboard/providers` — configured simulated providers.

## API key management

Self-service — no `X-Admin-Secret` required for any of these, only a valid API key with the
`apikeys:write` scope:

- `POST /api/v1/api-keys` — creates an additional key for **your own** merchant (never another
  merchant's). Same generation/hashing path as the initial bootstrap key. The full secret is
  returned exactly once, in this response — store it immediately.
- `GET /api/v1/api-keys` — lists your own keys: `id`, `prefix`, `scopes`, `created_at`,
  `last_used_at`, `revoked_at`. Never the hash or a plaintext secret.
- `DELETE /api/v1/api-keys/:id` — revokes a key (requires `apikeys:write` scope). A revoked key
  fails authentication on its very next use.

Signed in through the Console instead (no API key yet at all)? `POST /api/v1/console/api-keys` and
`GET /api/v1/console/api-keys` do the same thing, authenticated by your Console session cookie —
this is how a Console-only merchant gets their very first key without database access.

## Merchant webhooks (FinBridge → you)

This is the other half of the integration: how FinBridge tells **your** backend a payment finished.
Distinct from "Webhooks (SimProviderB)" above — that section is the *provider → FinBridge* leg;
this section is the *FinBridge → merchant* leg, using a completely different secret (yours, not
SimProviderB's).

All endpoints below require your API key with the scope noted, and always act on **your own**
merchant — there is no way to read or modify another merchant's configuration, and no
`merchant_id`/`workspace_id` field is ever accepted from the client; ownership comes entirely from
the API key.

### `GET /api/v1/merchants/webhook` — scope `webhooks:read`

Returns your current configuration:

```json
{
  "url": "https://merchant.example.com/webhooks/finbridge",
  "enabled": true,
  "configured": true,
  "secret_preview": "whsec_••••••••ab12",
  "events": ["payment.succeeded", "payment.failed", "payment.cancelled"]
}
```

The full secret is never included here — only a masked preview.

### `PUT /api/v1/merchants/webhook` — scope `webhooks:write`

Body: `{ "url": "https://...", "enabled": true }` (`enabled` optional, defaults `true`).

The URL is validated before it's stored: HTTPS required (plain `http://` is only accepted for
`localhost`/`127.0.0.1`, and only outside production), and the hostname is resolved and rejected if
it points at a private, loopback, link-local, or reserved address (SSRF protection — same guard
used for every subsequent delivery attempt, re-checked fresh each time to close the DNS-rebinding
window). Invalid URLs return `400 VALIDATION_ERROR`.

A signing secret is generated the **first** time you configure a URL, and stays stable across
later URL edits — rotating it on every save would silently break your existing signature
verification. The response includes `secret` (the full value) only on the call that actually
(re)created it:

```json
{ "url": "...", "enabled": true, "configured": true, "secret_preview": "whsec_••••••••ab12",
  "events": [...], "secret": "whsec_<full value — copy it now>" }
```

### `DELETE /api/v1/merchants/webhook` — scope `webhooks:write`

Clears the URL and secret. FinBridge stops sending events to you until reconfigured.

### `POST /api/v1/merchants/webhook/regenerate-secret` — scope `webhooks:write`

Rotates your signing secret. The old one stops verifying immediately — update your receiver with
the new value returned in this response before or right after calling this.

### `POST /api/v1/merchants/webhook/test` — scope `webhooks:write`

Sends a single `webhook.test` event synchronously (no background retry) and returns the outcome
directly: `{ "event_id": "...", "success": true, "httpStatus": 200 }`. `400` if no webhook URL is
configured yet.

### `GET /api/v1/merchants/webhook/deliveries` — scope `webhooks:read`

Your recent delivery attempts, newest first:

```json
[{
  "id": "evt_test_...",
  "payment_intent_id": "pi_test_...",
  "event_type": "payment.succeeded",
  "endpoint_url": "https://merchant.example.com/webhooks/finbridge",
  "attempt_count": 1,
  "status": "delivered",
  "http_status": 200,
  "last_error": null,
  "created_at": "...",
  "last_attempt_at": "...",
  "next_attempt_at": null
}]
```

`id` **is** the event id — stable across every retry of the same event, never regenerated. Use it
to de-duplicate on your side the same way `Idempotency-Key` lets FinBridge de-duplicate yours.

### What gets delivered, and when

Every terminal state transition (`succeeded`, `failed`, `cancelled`) enqueues one event, regardless
of which provider produced it — this is the same normalization story as payment creation: you write
one webhook receiver, not one per provider.

```json
{
  "id": "evt_test_...",
  "type": "payment.succeeded",
  "created_at": "2026-01-01T00:00:00.000Z",
  "data": {
    "payment_intent_id": "pi_test_...",
    "status": "succeeded",
    "amount": 15000,
    "currency": "LYD",
    "provider": "sim_provider_a",
    "reference": "order-1001",
    "provider_reference": "spa_...",
    "failure_reason": null
  }
}
```

### Verifying a delivery

Every request FinBridge sends to your endpoint carries:

```
X-FinBridge-Signature: <hex HMAC-SHA256 of "${timestamp}.${rawBody}", using YOUR webhook secret>
X-FinBridge-Timestamp: <unix seconds>
X-FinBridge-Event-Id: <same as body.id — stable across retries>
```

```python
expected = hmac_sha256(your_webhook_secret, f"{timestamp}.{raw_body}")
if not constant_time_equals(expected, headers["X-FinBridge-Signature"]):
    reject()
```

Use the **raw, unparsed** request body — not a re-serialized version of the parsed JSON — the
signature is over the exact bytes sent.

### Retries and duplicates

A non-2xx response, a timeout (8s), or a connection failure is retried up to 2 more times
(3 attempts total) with backoff, then marked `failed` — visible via `GET .../deliveries`. Because
`id` never changes across those retries, respond `2xx` idempotently: if you've already processed
this `id`, acknowledge it again with `2xx` rather than reprocessing your own side effects. FinBridge
does not currently re-deliver a delivery already marked `delivered`.

## Idempotency

```bash
curl -X POST http://localhost:4000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-order-1001" \
  -d '{"amount": 15000, "currency": "LYD", "provider": "sim_provider_a", "scenario": "success"}'
```

Run the exact same request again with the same key: you get back the **same** `payment_intent.id`.
Change the body but keep the key: you get `409 IDEMPOTENCY_KEY_CONFLICT`.

## Rate limiting

Default: 20 requests / 10 seconds per API key (configurable via `RATE_LIMIT_MAX_REQUESTS` /
`RATE_LIMIT_WINDOW_MS`). Exceeding it returns:

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests. Please slow down." } }
```

with a `Retry-After` header (seconds).

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` / `INVALID_REQUEST` | 400 | Input failed schema validation or body wasn't valid JSON |
| `INVALID_API_KEY` | 401 | Missing, malformed, unknown, or revoked API key |
| `INVALID_SIGNATURE` | 401 | Webhook signature missing or incorrect |
| `STALE_TIMESTAMP` | 401 | Webhook timestamp missing or outside tolerance |
| `FORBIDDEN` | 403 | Missing/invalid admin secret on merchant creation |
| `INSUFFICIENT_SCOPE` | 403 | API key lacks the required scope |
| `NOT_FOUND` | 404 | Resource doesn't exist, or belongs to another merchant |
| `INVALID_STATE_TRANSITION` | 409 | Payment isn't in a status this action allows |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Same key, different payload (or original request still in flight) |
| `DUPLICATE_EVENT` | 409 | Webhook `event_id` already processed |
| `RATE_LIMITED` | 429 | Too many requests in the current window |
| `INTERNAL_ERROR` | 500 | Unexpected server error (never leaks internals) |

## Sandbox limitations

See docs/security.md for the full list. In short: this is a single-process sandbox — rate
limiting is in-memory, there is no multi-provider real-money path, and the admin bootstrap
endpoint uses a shared secret appropriate for a sandbox operator, not a production control plane.
