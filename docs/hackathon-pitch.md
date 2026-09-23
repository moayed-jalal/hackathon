# FinBridge — Hackathon Pitch

**Track:** Entrepreneurship — Sandbox FinTech / APIs
**Event:** US-Libya Global Innovation Bridge Hackathon 2026

## Problem

Every financial provider — a bank, a mobile money operator, a card processor — exposes a
different API, a different authentication model, a different webhook format, and a different
transaction lifecycle. A developer integrating with two providers writes two integrations, tests
them two different ways, and has nowhere safe to rehearse the failure modes that matter most —
forged webhooks, replayed events, duplicate charges — before touching money that's real.

## Solution

FinBridge is a secure, sandboxed API that gives a developer **one canonical contract** —
authentication, payment intents, a fixed state machine, signed webhooks — in front of **multiple
simulated providers** that intentionally behave differently underneath. Integrate once against
FinBridge; the simulated providers stand in for the real, inconsistent world you'll eventually
connect to.

It is not a payment gateway. It never touches real money, a real bank, or a real processor —
every transaction is synthetic, every provider is named `sim_provider_*`, and the UI says so on
every page.

## Innovation

The interesting part isn't "an API that creates records." It's that:

1. **Two providers, deliberately incompatible internally, one contract externally.**
   `sim_provider_a` is synchronous and speaks `success` / `declined`. `sim_provider_b` is
   asynchronous and speaks `accepted -> pending -> settled` / `rejected` via a webhook FinBridge
   itself signs and verifies. Both normalize to the same `created / processing / succeeded /
   failed / cancelled` state machine. That normalization is implemented in exactly one place per
   provider (`ProviderResult.canonicalStatus`) — see `docs/architecture.md`.
2. **The security controls are load-bearing, not decorative.** Idempotency is enforced by a
   database unique constraint, not an in-memory cache. Webhook replay protection is a primary-key
   collision, not an `if (seen.has(id))`. Every one of these is provable live: tamper a webhook and
   watch it get rejected with the real cryptographic reason, not a canned response.
3. **A conformance suite that hits the real API.** `pnpm smoke-test` is an actual HTTP client, not
   a set of internal function calls — the same guarantee a real integration test suite for a real
   provider would need.

## Demo

See `docs/demo.md` for the full script. In under two minutes:

```
ONE API
   |
   +---- SimProviderA -> immediate result (success / declined)
   |
   +---- SimProviderB -> processing -> signed webhook -> settled / rejected
```

followed by, live, in front of the judges:

```
Idempotency ...................... same request twice -> same payment, no duplicate
Webhook signature verification ... tampered webhook -> 401, rejected
Replay protection ................ valid webhook resent -> 409, rejected
Rate limiting ..................... 21st request in 10s -> 429
Invalid request rejection ........ negative amount / bad currency -> 400
Smoke tests ....................... 15 / 15 PASSED, against the real running API
```

## Security

Authentication (hashed, revocable API keys) · HMAC-SHA256 webhook signing and verification ·
timestamp-based freshness checks · database-enforced replay protection · database-enforced
idempotency · Zod input validation on every external input · fixed-window rate limiting · a
consistent error envelope that never leaks internals · an append-only, redacted audit trail behind
the dashboard's Security page. Full threat model in `docs/security.md`.

## Business potential

FinBridge's actual product shape isn't a payment processor — it's **developer infrastructure for
testing financial integrations before they go anywhere near production**. Concretely, a next
version could:

- Add more simulated provider archetypes (different auth models, different webhook retry/backoff
  behavior, different failure taxonomies) so developers can rehearse against a realistic spread of
  what they'll actually encounter.
- Offer a hosted, multi-tenant sandbox with per-team API keys and dashboards — the same shape as
  this repo, running as a service instead of `docker compose up`.
- Provide a conformance-test-as-a-service offering: a merchant runs FinBridge's smoke-test suite
  against *their own* webhook receiver to prove it correctly rejects tampered and replayed events
  before they ever integrate with a real provider.

None of this requires, implies, or claims any existing partnership with a bank, processor, or
regulator. FinBridge does not have regulatory approval, does not process real payments, and makes
no claim to.
