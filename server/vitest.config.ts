import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
    env: {
      // Higher than the dev/demo default (20/10s) so incidental setup
      // traffic across unrelated e2e tests sharing a key doesn't trip the
      // limiter — the dedicated "rate limiting" test still proves the 429
      // behavior against this same (raised) ceiling.
      RATE_LIMIT_MAX_REQUESTS: "50",
      // Fast, deterministic merchant-webhook delivery tests instead of real
      // multi-second waits — see modules/merchant-webhooks/service.ts.
      MERCHANT_WEBHOOK_TIMEOUT_MS: "300",
      MERCHANT_WEBHOOK_RETRY_BACKOFF_MS: "50,50",
    },
  },
});
