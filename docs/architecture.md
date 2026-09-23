# FinBridge Architecture

FinBridge is a **modular monolith**: one deployable Node.js service, organized into clearly
separated modules, backed by a single PostgreSQL database. There are no microservices, no
message queues, and no distributed transactions — deliberately, because the thing worth
demonstrating in a hackathon sandbox is clean module boundaries and a real interoperability
abstraction, not deployment topology.

## System diagram

```
                              Developer / Merchant
                                       |
                                       v
                    +---------------------------------------+
                    |            FinBridge API               |
                    |  (Hono, TypeScript, single process)    |
                    |                                         |
                    |  Request ID  --> Authentication         |
                    |               --> Rate Limiting         |
                    |               --> Zod Validation        |
                    |               --> Idempotency           |
                    |               --> Payment State Machine |
                    +-------------------+---------------------+
                                        |
                                        v
                          +--------------------------+
                          |  Provider Adapter Layer  |
                          |  (PaymentProvider iface) |
                          +------------+-------------+
                                       |
                     +-----------------+-----------------+
                     |                                   |
                     v                                   v
           +-------------------+               +-------------------+
           |   SimProviderA    |               |   SimProviderB    |
           |   synchronous     |               |   asynchronous    |
           +-------------------+               +---------+---------+
                                                          |
                                                          v
                                              +------------------------+
                                              |  Webhook Verification  |
                                              |  (HMAC, timestamp,     |
                                              |   replay protection)   |
                                              +-----------+------------+
                                                          |
                                                          v
                                              +------------------------+
                                              |  Audit / Security      |
                                              |  Events (Postgres)     |
                                              +------------------------+
                                                          |
                                                          v
                                              +------------------------+
                                              |   Developer Dashboard   |
                                              |   (React, Vite)         |
                                              +------------------------+
```

## The core abstraction

```
   Merchant
      |
      v
FinBridge Canonical API      <-- one contract, regardless of provider
      |
      v
Provider Adapter Interface   <-- PaymentProvider: createPayment()
      |
      +---- SimProviderA   (sync:  success | declined)
      |
      +---- SimProviderB   (async: accepted -> pending -> settled | rejected, via webhook)
      |
      +---- FutureProvider...  (add an adapter, register it — nothing else changes)
```

A merchant never sees `accepted`, `pending`, `settled`, or `declined`. They only ever see the
canonical state machine: `created`, `processing`, `succeeded`, `failed`, `cancelled`. That
normalization — hiding two genuinely different provider protocols behind one contract — is the
whole interoperability story, and it is enforced in exactly one place: each adapter's
`createPayment()` return value carries both `providerStatus` (the provider's own vocabulary, kept
for observability) and `canonicalStatus` (what the rest of the system uses).

See [`server/src/modules/providers/types.ts`](../server/src/modules/providers/types.ts),
[`simProviderA.ts`](../server/src/modules/providers/simProviderA.ts), and
[`simProviderB.ts`](../server/src/modules/providers/simProviderB.ts).

## Modules

| Module | Path | Responsibility |
|---|---|---|
| API layer | `src/app.ts` | Route wiring, CORS, error boundary, OpenAPI/docs serving |
| Authentication | `src/middleware/auth.ts` | Bearer API key verification, scope checks |
| Merchants | `src/modules/merchants/` | Merchant + API key lifecycle (create, hash, verify, revoke) |
| Payment Intents | `src/modules/payment-intents/` | Canonical API, schemas, service layer |
| Payment State Machine | `src/modules/payment-intents/state-machine.ts` | The one place transitions are defined and enforced |
| Idempotency | `src/modules/idempotency/` | Idempotency-Key handling, DB-enforced dedup |
| Provider Abstraction | `src/modules/providers/` | `PaymentProvider` interface + registry |
| SimProviderA | `src/modules/providers/simProviderA.ts` | Synchronous simulated provider |
| SimProviderB | `src/modules/providers/simProviderB.ts` | Asynchronous simulated provider |
| Webhooks | `src/modules/webhooks/` | Signature verification, replay protection, event processing |
| Security Events / Audit | `src/modules/audit/` | Append-only audit trail |
| Rate Limiting | `src/middleware/rateLimit.ts` | Fixed-window limiter per API key |
| Sandbox controls | `src/modules/sandbox/` | Simulate/replay/tamper webhook triggers, smoke-test result storage |
| Dashboard API | `src/modules/dashboard/` | Read-only summary/audit/provider endpoints for the frontend |
| Smoke Tests | `server/smoke-test/` | Real-HTTP conformance suite |
| Dashboard (UI) | `web/` | React + Vite developer dashboard |

New providers plug into the registry
([`src/modules/providers/registry.ts`](../server/src/modules/providers/registry.ts)) without
touching the public API, the state machine, routes, or the dashboard.

## Payment lifecycle

```
created
   |
   +--(SimProviderA)--> succeeded | failed        (synchronous, single request)
   |
   +--(SimProviderB)--> processing --(webhook)--> succeeded | failed   (asynchronous)
   |
   +--> cancelled   (from created, or from processing while awaiting a webhook)
```

The state machine (`state-machine.ts`) is a pure, dependency-free module: a transition table plus
`assertTransition()`. It is unit-tested in isolation and is the *only* code path allowed to change
a payment's status — `applyTransition()` in `payment-intents/service.ts` wraps every write in a
conditional `UPDATE ... WHERE status = $from`, so a transition silently racing another request
fails closed instead of corrupting state (see docs/security.md, "Concurrency").

## Data model

```
merchants ──< api_keys
merchants ──< payment_intents ──< payment_intent_events   (timeline)
merchants ──< idempotency_keys
merchants ──< audit_events
payment_intents ──< webhook_events   (event_id is the primary key — replay protection)
provider_configurations               (static metadata for the dashboard)
smoke_test_results                    (latest CLI run, for the dashboard)
```

Full schema: [`server/src/db/schema.ts`](../server/src/db/schema.ts).

## Why a modular monolith

- One process to run, one database to reason about — appropriate for a sandbox whose job is to
  *demonstrate* interoperability and security, not to prove a distributed-systems thesis.
- Module boundaries (folders + explicit interfaces) give the same "swap an adapter without
  touching the core" property microservices are usually reached for, at a fraction of the
  operational cost.
- Every acceptance-criteria flow (auth, idempotency, webhook security, rate limiting, the state
  machine) is easier to test and to demo live when it's one process with one log stream.
