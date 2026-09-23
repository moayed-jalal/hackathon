/**
 * Hand-written OpenAPI 3.0 document served at GET /openapi.json and rendered
 * interactively at GET /docs. Kept as a plain object (no codegen) so it's
 * easy to read end to end — see docs/api.md for prose-form documentation.
 */
export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "FinBridge Sandbox API",
    version: "1.0.0",
    description:
      "A secure, interoperable sandbox API for simulated FinTech payment flows. " +
      "SANDBOX ONLY — NO REAL MONEY. Every payment_intent carries `sandbox: true` " +
      "and is created against a simulated provider (sim_provider_a or sim_provider_b). " +
      "See docs/api.md, docs/security.md, and docs/architecture.md in the repository for full context.",
  },
  servers: [{ url: "/", description: "This sandbox instance" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "Sandbox API key, e.g. `fb_test_...`. Obtain your first one via POST /api/v1/merchants (platform " +
          "bootstrap) or the Console; create additional keys yourself via POST /api/v1/api-keys once you hold " +
          "one. Keys carry scopes (`payments:read`, `payments:write`, `sandbox:simulate`, `apikeys:write`, " +
          "`webhooks:read`, `webhooks:write`) checked per-endpoint.",
      },
    },
    schemas: {
      PaymentIntent: {
        type: "object",
        properties: {
          id: { type: "string", example: "pi_test_ab12cd34ef56" },
          status: { type: "string", enum: ["created", "processing", "succeeded", "failed", "cancelled"] },
          amount: { type: "integer", example: 15000, description: "Minor units, e.g. 15000 = 150.00" },
          currency: { type: "string", enum: ["USD", "EUR", "LYD"] },
          provider: { type: "string", enum: ["sim_provider_a", "sim_provider_b"] },
          scenario: { type: "string", nullable: true },
          reference: { type: "string", nullable: true },
          metadata: { type: "object" },
          failure_reason: { type: "string", nullable: true },
          provider_reference: { type: "string", nullable: true },
          sandbox: { type: "boolean", example: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string", example: "VALIDATION_ERROR" },
              message: { type: "string" },
              details: { type: "object" },
            },
          },
          request_id: { type: "string", example: "req_test_a1b2c3d4" },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: "Missing, malformed, invalid, or revoked API key",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Validation: {
        description: "Input failed schema validation",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      RateLimited: {
        description: "Too many requests in the current window",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      NotFound: {
        description: "Resource not found or not owned by this merchant",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
  paths: {
    "/api/v1/payment-intents": {
      post: {
        summary: "Create a payment intent",
        description:
          "Provider-neutral creation endpoint. Supports an `Idempotency-Key` header — repeating the " +
          "same key with an equivalent payload returns the original payment_intent instead of creating a duplicate.",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string" },
            example: "demo-order-1001",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount", "currency", "provider"],
                properties: {
                  amount: { type: "integer", example: 15000 },
                  currency: { type: "string", enum: ["USD", "EUR", "LYD"] },
                  provider: { type: "string", enum: ["sim_provider_a", "sim_provider_b"] },
                  scenario: { type: "string", example: "success" },
                  reference: { type: "string" },
                  metadata: { type: "object" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Payment intent created (or replayed from an idempotency key)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/PaymentIntent" }, request_id: { type: "string" } },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Validation" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "409": { description: "Idempotency key reused with a different payload" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
      get: {
        summary: "List payment intents",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100, default: 20 } },
          { name: "status", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "A page of payment intents" } },
      },
    },
    "/api/v1/payment-intents/{id}": {
      get: {
        summary: "Retrieve a payment intent",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "The payment intent" }, "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/api/v1/payment-intents/{id}/timeline": {
      get: {
        summary: "Retrieve the full lifecycle timeline for a payment intent",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Ordered list of lifecycle events" } },
      },
    },
    "/api/v1/payment-intents/{id}/cancel": {
      post: {
        summary: "Cancel a payment intent",
        description: "Only valid from status `created`. Any other status returns 409 INVALID_STATE_TRANSITION.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Cancelled payment intent" }, "409": { description: "Invalid state transition" } },
      },
    },
    "/api/v1/webhooks/sim-provider-b": {
      post: {
        summary: "SimProviderB webhook receiver",
        description:
          "Receives signed asynchronous settlement events from SimProviderB. Requires " +
          "X-FinBridge-Signature and X-FinBridge-Timestamp headers (HMAC-SHA256 of `${timestamp}.${rawBody}`). " +
          "Duplicate event_id values are rejected with 409 (replay protection).",
        security: [],
        parameters: [
          { name: "X-FinBridge-Signature", in: "header", required: true, schema: { type: "string" } },
          { name: "X-FinBridge-Timestamp", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Webhook verified and processed" },
          "401": { description: "Missing/invalid signature or stale timestamp" },
          "409": { description: "Duplicate event_id (replay rejected)" },
        },
      },
    },
    "/api/v1/sandbox/payment-intents/{id}/simulate-webhook": {
      post: {
        summary: "[Sandbox] Trigger SimProviderB's async settlement webhook",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { outcome: { type: "string", enum: ["succeeded", "failed"] } } },
            },
          },
        },
        responses: { "200": { description: "Webhook delivered and payment intent updated" } },
      },
    },
    "/api/v1/sandbox/payment-intents/{id}/replay-webhook": {
      post: {
        summary: "[Sandbox] Resend the last webhook byte-for-byte",
        description: "Demonstrates replay protection. Expected result: 409 duplicate event.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "409": { description: "Replay rejected" } },
      },
    },
    "/api/v1/sandbox/payment-intents/{id}/tamper-webhook": {
      post: {
        summary: "[Sandbox] Resend the last webhook with a mutated body",
        description: "Demonstrates signature verification. Expected result: 401 invalid signature.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "401": { description: "Invalid signature rejected" } },
      },
    },
    "/api/v1/merchants": {
      post: {
        summary: "Create a sandbox merchant + API key",
        description: "Platform-operator action, protected by X-Admin-Secret (not a merchant API key).",
        security: [],
        parameters: [{ name: "X-Admin-Secret", in: "header", required: true, schema: { type: "string" } }],
        responses: { "201": { description: "Merchant created; API key shown once" } },
      },
    },
    "/api/v1/api-keys": {
      post: {
        summary: "Create an additional API key for the authenticated merchant",
        description:
          "Self-service key creation — no X-Admin-Secret required. Requires the `apikeys:write` scope. " +
          "The full secret is returned exactly once, in this response.",
        responses: {
          "201": { description: "Key created; full secret shown once" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { description: "API key lacks the apikeys:write scope" },
        },
      },
      get: {
        summary: "List the authenticated merchant's own API keys",
        description: "Metadata only (id, prefix, scopes, timestamps) — never the hash or a plaintext secret.",
        responses: { "200": { description: "A list of the merchant's own keys" } },
      },
    },
    "/api/v1/api-keys/{id}": {
      delete: {
        summary: "Revoke an API key",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Key revoked" }, "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/api/v1/merchants/webhook": {
      get: {
        summary: "Get the authenticated merchant's webhook configuration",
        description: "Requires the `webhooks:read` scope. Never returns the full secret — only a masked preview.",
        responses: { "200": { description: "Current webhook configuration" } },
      },
      put: {
        summary: "Create or update the authenticated merchant's webhook URL",
        description:
          "Requires the `webhooks:write` scope. Validates the URL (HTTPS required outside localhost, private/" +
          "loopback/link-local/reserved destinations rejected — SSRF protection). The signing secret is " +
          "generated once, the first time a URL is configured, and stays stable across later URL edits — the " +
          "response includes `secret` only on the call that just (re)created it.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string", example: "https://merchant.example.com/webhooks/finbridge" },
                  enabled: { type: "boolean", default: true },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated configuration (plus `secret` if one was just created)" },
          "400": { $ref: "#/components/responses/Validation" },
        },
      },
      delete: {
        summary: "Disable and clear the authenticated merchant's webhook configuration",
        description: "Requires the `webhooks:write` scope. FinBridge stops sending events to this endpoint.",
        responses: { "200": { description: "Configuration cleared" } },
      },
    },
    "/api/v1/merchants/webhook/regenerate-secret": {
      post: {
        summary: "Rotate the authenticated merchant's webhook signing secret",
        description:
          "Requires the `webhooks:write` scope. The previous secret is invalidated immediately — any endpoint " +
          "still verifying with it will start rejecting deliveries until updated. The new secret is returned " +
          "exactly once, in this response.",
        responses: { "200": { description: "New secret shown once" } },
      },
    },
    "/api/v1/merchants/webhook/test": {
      post: {
        summary: "Send a one-off test event to the configured webhook URL",
        description:
          "Requires the `webhooks:write` scope. Sends a `webhook.test` event synchronously (no background " +
          "retry) and returns the delivery outcome directly. Fails with 400 if no webhook URL is configured.",
        responses: { "200": { description: "Delivery outcome (success/httpStatus/error)" } },
      },
    },
    "/api/v1/merchants/webhook/deliveries": {
      get: {
        summary: "List recent webhook delivery attempts for the authenticated merchant",
        description: "Requires the `webhooks:read` scope.",
        responses: { "200": { description: "Recent deliveries, newest first" } },
      },
    },
    "/api/v1/dashboard/summary": {
      get: { summary: "Dashboard overview counts", responses: { "200": { description: "Summary" } } },
    },
    "/api/v1/dashboard/audit-events": {
      get: { summary: "Security / audit event feed", responses: { "200": { description: "Recent audit events" } } },
    },
    "/api/v1/dashboard/providers": {
      get: { summary: "List configured simulated providers", responses: { "200": { description: "Providers" } } },
    },
    "/api/v1/sandbox/smoke-test-results/latest": {
      get: { summary: "Latest smoke test run", responses: { "200": { description: "Latest result, or null" } } },
    },
  },
} as const;
