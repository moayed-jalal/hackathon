# FinBridge Security

FinBridge is a sandbox. Nothing here processes real money, touches a real bank, or connects to a
real payment processor. The security controls below exist because the *pattern* — authenticating
API clients, verifying signed webhooks, rejecting replays, enforcing idempotency, rate limiting,
and validating input — is exactly what a real integration needs, and this sandbox is where a
developer should be able to test and break that pattern safely before going anywhere near
production financial infrastructure.

No claims of "military-grade" anything below. Just what is implemented, and its actual limits.

## Threat model

| Threat | Impact | Mitigation |
|---|---|---|
| Leaked API key | Attacker can create/read/cancel payments as the merchant | Keys are never stored in plaintext (scrypt-hashed, salted); only a recognizable prefix (`fb_test_...`) is retrievable; keys are revocable via `DELETE /api/v1/api-keys/:id`; every auth failure is audited |
| Forged webhook | Attacker fabricates a "payment succeeded" event to trick a merchant's system | Every SimProviderB webhook must carry a valid HMAC-SHA256 signature (`X-FinBridge-Signature`) over `${timestamp}.${rawBody}`, verified with `crypto.timingSafeEqual`; invalid signatures are rejected with 401 and audited (`WEBHOOK_REJECTED`) |
| Replay attack (webhook) | Attacker (or a flaky provider) resends a valid, previously-processed webhook to double-apply a state change | `webhook_events.id` (the provider's `event_id`) is the primary key; a duplicate insert is rejected by the database itself, not just application logic, and returns 409 (`WEBHOOK_REPLAY_REJECTED`) |
| Stale webhook replay | Attacker replays an old, still-validly-signed webhook long after the fact | Timestamp freshness check (`X-FinBridge-Timestamp`) rejects requests outside a configurable tolerance window (default 300s), independent of the replay-by-event-id check |
| Duplicate payment request | A network retry, double-click, or buggy client submits the same payment twice | `Idempotency-Key` + request-body hash, enforced by a database unique constraint on `(merchant_id, idempotency_key)`; a second request with the same key and equivalent payload returns the original result instead of creating a new payment |
| Malformed / malicious input | Invalid amounts, unsupported currencies, oversized payloads, wrong types crash the API or corrupt data | Every externally-controlled input is validated with Zod before it reaches business logic; malformed JSON is rejected with 400 before parsing proceeds further |
| Brute-force / credential stuffing | Attacker tries many API keys to find a valid one | Rate limiting applies per API key (falls back to client IP when unauthenticated), independent of whether individual requests succeed or fail auth; `AUTH_FAILURE` events are audited with a request id for correlation |
| Rate/API abuse | A client (malicious or buggy) floods the API | Fixed-window rate limiter (20 requests / 10s by default, configurable via `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS`); exceeding it returns 429 with `Retry-After` |
| Unauthorized provider access | A merchant tries to act on another merchant's payment intent | Every payment-intent lookup is scoped by `merchant_id` in the query itself (`WHERE id = $1 AND merchant_id = $2`); a mismatch returns 404, not 403, to avoid confirming the resource's existence |
| Log/secret leakage | API keys, webhook secrets, or Authorization headers end up in logs or audit metadata | `src/logger.ts` redacts known-sensitive keys before writing; audit event metadata is built explicitly per event type and never includes raw headers, keys, or secrets |
| Invalid state transition | A client tries to cancel an already-succeeded payment, or otherwise skip the state machine | All transitions go through `assertTransition()` against a fixed table, backed by a conditional `UPDATE ... WHERE status = $from` at the database layer; invalid transitions return 409 |
| Race condition (concurrent requests) | Two concurrent requests with the same idempotency key, or a webhook racing a cancel, corrupt state or create duplicates | See "Concurrency" below |

## What is **not** protected (explicit limitations)

- **Rate limiting is in-process, in-memory.** It resets on restart and does not share state across
  multiple instances. That's an intentional sandbox simplification — see
  `src/middleware/rateLimit.ts` — not a production rate limiter.
- **The webhook receiver has no per-IP throttle.** It's protected by signature verification, not
  by request volume limits. A flood of *invalid* signature attempts would still cost CPU/DB time
  to reject.
- **No TLS termination is configured** in this repository. In any real deployment, HTTPS is
  assumed to be handled by the hosting environment.
- **API key scopes are coarse** (e.g. `payments:read`, `payments:write`, `sandbox:simulate`,
  `apikeys:write`), not fine-grained per-resource permissions.
- **The admin merchant-bootstrap endpoint** (`POST /api/v1/merchants`) is protected by a single
  shared secret (`X-Admin-Secret`), appropriate for a sandbox operator, not a multi-tenant
  production control plane.

## Authentication

- `Authorization: Bearer fb_test_...` is required on every merchant-facing endpoint.
- API keys are generated as `fb_test_<random>`, hashed with salted `scrypt` before storage
  (`src/lib/crypto.ts`), and only the first 16 characters (the prefix) are retained in plaintext
  for lookup. The full key is shown exactly once, at creation time.
- A revoked key (`revoked_at IS NOT NULL`) fails authentication immediately.
- Missing, malformed, unknown, revoked, and insufficiently-scoped keys all return 401/403 with a
  consistent error envelope — no distinction is leaked about *why* a key is invalid beyond the
  error code.

## Webhook security

Every SimProviderB webhook must include:

```
X-FinBridge-Signature: <hex HMAC-SHA256>
X-FinBridge-Timestamp: <unix seconds>
```

Verification (`src/modules/webhooks/verify.ts`, pure and unit-tested):

1. Timestamp is present, numeric, and within `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` (default 300s)
   of the receiver's clock.
2. Signature is present and equals `HMAC_SHA256(secret, "${timestamp}.${rawBody}")`, compared with
   `crypto.timingSafeEqual` (not `===`, to avoid timing side-channels).
3. The event body parses as JSON and matches the expected schema (Zod).
4. The event's `event_id` has not been processed before (database-enforced, see below).

Any failure at steps 1–3 returns 401 (`INVALID_SIGNATURE` or `STALE_TIMESTAMP`). Failure at step 4
returns 409 (`DUPLICATE_EVENT`). Every step is audited regardless of outcome.

## Replay protection

`webhook_events.id` (the event's own `event_id`) is the table's **primary key**. Processing a
webhook is: verify → `INSERT ... ON CONFLICT DO NOTHING RETURNING *`. If no row comes back, the
event was already processed — this is a database constraint, not an application-level `if`
statement, so it holds even under concurrent delivery of the same event.

## Idempotency

Backed by a unique constraint on `(merchant_id, idempotency_key)`:

1. Reserve the slot: `INSERT ... ON CONFLICT DO NOTHING RETURNING *`.
2. If the insert wins, run the handler, then fill in the stored response.
3. If the insert loses (another request already holds the key), compare request-body hashes:
   - Different payload → 409 (`IDEMPOTENCY_KEY_CONFLICT`).
   - Same payload, response not yet recorded → poll briefly (the original request is still in
     flight) and return its result once available.
   - Same payload, response recorded → return the original result verbatim (`IDEMPOTENCY_REPLAY`).

See `src/modules/idempotency/service.ts`.

## Concurrency

Three specific races are handled, all at the database layer rather than in application logic:

- **Duplicate payment creation** (same idempotency key, concurrent requests): the unique
  constraint on `idempotency_keys(merchant_id, idempotency_key)` guarantees only one request
  "wins" the reservation; see `tests/integration/persistence.test.ts` for a test that fires three
  concurrent requests and asserts the handler ran exactly once.
- **Duplicate webhook delivery**: the primary key on `webhook_events.id` guarantees only one
  insert succeeds, regardless of how many identical deliveries arrive concurrently.
- **Concurrent state transitions**: `applyTransition()` issues
  `UPDATE payment_intents SET status = $to WHERE id = $id AND status = $from`. If two requests
  race to transition the same payment, only the one whose `WHERE` clause still matches succeeds;
  the other gets zero affected rows and a 409, never a corrupted intermediate state.

## Input validation

Every externally-controlled input is validated with [Zod](https://zod.dev) before touching
business logic (`src/modules/payment-intents/schemas.ts`,
`src/modules/webhooks/schemas.ts`). This includes: amount must be a positive integer (minor
units — no floating-point money math anywhere in the codebase), currency must be a supported
enum value, provider must be a known simulated provider, string fields have length limits, unknown
extra fields are rejected (`.strict()`), and malformed JSON is caught before schema validation
even runs.

## Error model

Every error response has the same shape:

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "...", "details": { } },
  "request_id": "req_test_..."
}
```

`src/middleware/errorHandler.ts` is the single place responses are constructed from thrown errors.
Anything that isn't a recognized `ApiError` is logged internally (with stack trace) and reported
to the client as a generic `INTERNAL_ERROR` — no stack traces, SQL error text, or internal
implementation details ever reach the API surface.

## Audit trail

`audit_events` is an append-only table recording (at minimum): timestamp, event type, request id,
merchant id, payment intent id (when applicable), and safe metadata. It is never written to with
API keys, webhook secrets, Authorization headers, or other credentials — see
`src/modules/audit/service.ts` and the redaction list in `src/logger.ts`. This is what powers the
dashboard's Security page.
