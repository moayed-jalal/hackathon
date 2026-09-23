# FinBridge — Secure FinTech Interoperability Sandbox

**SANDBOX ONLY — NO REAL MONEY.** FinBridge is a synthetic developer platform for testing FinTech
integrations. It never connects to a real bank, card network, wallet, or payment processor, and it
never handles real financial data. Every transaction, provider, and credential in this repository
is simulated.

> Integrate once. Test against multiple simulated financial providers through one secure,
> standardized API.

Built for the **US-Libya Global Innovation Bridge Hackathon 2026** — Entrepreneurship track,
Sandbox FinTech / APIs.

## What this is

One canonical payment API in front of two intentionally-different simulated providers:

- **SimProviderA** — synchronous, resolves `success` / `declined` immediately.
- **SimProviderB** — asynchronous, returns `processing` immediately and settles later via a
  signed, verified webhook.

FinBridge normalizes both into the same `created / processing / succeeded / failed / cancelled`
state machine, so a merchant integrates against one contract regardless of which simulated
provider is behind it. See [`docs/architecture.md`](docs/architecture.md) for the full picture.

Security is not an afterthought here — hashed API keys, HMAC-signed webhooks, database-enforced
idempotency and replay protection, rate limiting, and strict input validation are all first-class,
demonstrable, and tested. See [`docs/security.md`](docs/security.md).

## Quick start (fresh clone)

Requires Node.js 20+, [pnpm](https://pnpm.io), and Docker.

```bash
docker compose up -d          # PostgreSQL on localhost:5544
pnpm install
pnpm db:migrate
pnpm db:seed                  # prints a sandbox API key, writes web/.env.local
pnpm dev                      # API on http://localhost:4000
```

In a second terminal:

```bash
pnpm dev:web                  # site on http://localhost:5180
```

Open `http://localhost:5180` for the marketing site, or go straight to
`http://localhost:5180/console` for the dashboard — it picks up the seeded API key automatically.
Open `http://localhost:4000/docs` for the interactive API reference.

Run the tests and the smoke suite:

```bash
pnpm test          # unit + integration + e2e (server must NOT already be running on :4000)
pnpm smoke-test     # real HTTP conformance run against the live API (server must be running)
```

> `pnpm test`'s end-to-end suite starts its own server instance on the configured port, so stop
> `pnpm dev` before running it (or run `pnpm test` first, then `pnpm dev` + `pnpm smoke-test`).

## Live demo

See [`docs/demo.md`](docs/demo.md) for the full, copy-pasteable 7-step script (idempotency,
async webhook settlement, tampered/replayed webhook rejection, rate limiting) — runnable via curl
or entirely by clicking through the dashboard.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Module layout, provider abstraction, data model |
| [`docs/security.md`](docs/security.md) | Threat model, what's protected, what's explicitly not |
| [`docs/api.md`](docs/api.md) | Full endpoint reference, error codes, examples |
| [`docs/demo.md`](docs/demo.md) | Step-by-step live demo script |
| [`docs/hackathon-pitch.md`](docs/hackathon-pitch.md) | Problem, solution, innovation, business case |

## Production deployment

Target topology: the marketing site + dashboard on **Vercel**, the API + interactive docs on a **VPS via Docker + Caddy**.

| Host | Where it lives |
|---|---|
| `hackathon.com.ly` + `www` | Vercel (frontend build) |
| `api.hackathon.com.ly` | VPS — Caddy → `server` container (has its own `/docs` too) |
| `docs.hackathon.com.ly` | VPS — Caddy → `server` container `/docs` |

### 1. DNS (at your registrar)

| Record | Type | Value |
|---|---|---|
| `@` | CNAME | `cname.vercel-dns.com` |
| `www` | CNAME | `cname.vercel-dns.com` |
| `api` | A | VPS public IP |
| `docs` | A | VPS public IP |

### 2. VPS (Ubuntu 22.04+, Docker + Compose installed)

```bash
cp deploy/.env.production.example deploy/.env.production
# fill in POSTGRES_PASSWORD, ADMIN_SECRET, WEBHOOK_SECRET_SIM_PROVIDER_B
# (openssl rand -hex 32), set ACME_EMAIL, keep CADDY_INGRESS_DOMAIN=hackathon.com.ly

docker compose -f docker-compose.prod.yml --env-file deploy/.env.production up -d --build

# one-time database setup (inside the server image, no tsx/pnpm needed in prod)
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production run --rm server node dist/db/migrate.js
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production run --rm server node dist/db/seed.js
# seed prints a sandbox API key — save it for step 3
```

Caddy (`deploy/Caddyfile`) auto-provisions Let's Encrypt certificates for both subdomains.
Verify: `curl https://api.hackathon.com.ly/health`.

### 3. Frontend (Vercel)

1. Push the repo to GitHub and import it in Vercel (root directory = repo root).
2. `vercel.json` is already checked in (Vite + `pnpm --filter @finbridge/web build`).
3. Add env vars:
   - `VITE_API_BASE_URL=https://api.hackathon.com.ly`
   - `VITE_DEMO_API_KEY=<api key printed by the seed step>`
4. Add `hackathon.com.ly` and `www.hackathon.com.ly` as custom domains.

Screens to sanity-check: `https://hackathon.com.ly/console`, `https://api.hackathon.com.ly/docs`,
`https://docs.hackathon.com.ly`, `https://docs.hackathon.com.ly/openapi.json`.

## Repository layout

```
server/                    Hono + TypeScript + Drizzle ORM + PostgreSQL
  src/modules/              merchants, payment-intents, providers, webhooks,
                             idempotency, audit, sandbox, dashboard
  src/middleware/            auth, rate limiting, request id, error handling
  src/db/                    Drizzle schema, migrations, migrate/seed scripts
  smoke-test/                real-HTTP conformance CLI (pnpm smoke-test)
  tests/                     unit / integration / e2e (Vitest)
web/                        React + Vite + TypeScript + Tailwind dashboard
docs/                       architecture, security, api, demo, pitch
docker-compose.yml          PostgreSQL for local development
```

## Stack

Backend: TypeScript, Node.js, [Hono](https://hono.dev), [Zod](https://zod.dev), PostgreSQL,
[Drizzle ORM](https://orm.drizzle.team), hand-written OpenAPI 3.0.
Frontend: React, Vite, TypeScript, Tailwind CSS.
Testing: [Vitest](https://vitest.dev) (unit, integration, e2e) + a standalone smoke-test CLI.
Infra: Docker Compose for PostgreSQL locally (`docker-compose.yml`); production ships behind
Caddy via `docker-compose.prod.yml` (PostgreSQL + API + Caddy, auto-HTTPS).

## Known limitations

Sandbox-only by design — see [`docs/security.md`](docs/security.md#what-is-not-protected-explicit-limitations)
for the explicit list (in-memory rate limiting, no TLS termination configured, coarse API key
scopes, single shared admin secret). None of these are gaps in the demonstrated security
patterns; they're scope boundaries appropriate to a sandbox, called out rather than hidden.
