import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { ApiError } from "../../lib/errors.js";
import { ok } from "../../lib/response.js";
import { db } from "../../db/client.js";
import { smokeTestResults } from "../../db/schema.js";
import { simulateWebhookSchema } from "../payment-intents/schemas.js";
import { publishGlobalConsoleEvent } from "../console/events.js";
import { ids } from "../../lib/ids.js";
import {
  replayLastWebhook,
  sendTamperedWebhook,
  simulateSimProviderBWebhook,
} from "./service.js";

export const sandboxRoutes = new Hono();

/**
 * These three endpoints proxy the exact HTTP response the real webhook
 * receiver produced (status code included) rather than wrapping it in the
 * usual envelope — the point is to show the raw security outcome (200 / 401
 * / 409) during a live demo.
 */
sandboxRoutes.post(
  "/payment-intents/:id/simulate-webhook",
  requireAuth("sandbox:simulate"),
  rateLimit,
  async (c) => {
    const auth = c.get("auth");
    const parsed = simulateWebhookSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new ApiError("VALIDATION_ERROR", "Invalid simulate-webhook request", {
        issues: parsed.error.issues,
      });
    }
    const result = await simulateSimProviderBWebhook(auth.merchantId, c.req.param("id"), parsed.data.outcome);
    return c.json(result.body, result.status as 200);
  },
);

sandboxRoutes.post(
  "/payment-intents/:id/replay-webhook",
  requireAuth("sandbox:simulate"),
  rateLimit,
  async (c) => {
    const auth = c.get("auth");
    const result = await replayLastWebhook(auth.merchantId, c.req.param("id"));
    return c.json(result.body, result.status as 200);
  },
);

sandboxRoutes.post(
  "/payment-intents/:id/tamper-webhook",
  requireAuth("sandbox:simulate"),
  rateLimit,
  async (c) => {
    const auth = c.get("auth");
    const result = await sendTamperedWebhook(auth.merchantId, c.req.param("id"));
    return c.json(result.body, result.status as 200);
  },
);

const smokeTestResultSchema = z.object({
  total: z.number().int().positive(),
  passed: z.number().int().nonnegative(),
  results: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
});

/** The smoke-test CLI reports its own results here so the dashboard can show "N / N PASSED". */
sandboxRoutes.post("/smoke-test-results", requireAuth("sandbox:simulate"), rateLimit, async (c) => {
  const parsed = smokeTestResultSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Invalid smoke test result payload", { issues: parsed.error.issues });
  }
  const [row] = await db.insert(smokeTestResults).values(parsed.data).returning();
  publishGlobalConsoleEvent({
    id: ids.consoleEventId(),
    type: "smoke_test.completed",
    passed: row!.passed,
    total: row!.total,
    created_at: new Date().toISOString(),
  });
  return ok(c, row, 201);
});

sandboxRoutes.get("/smoke-test-results/latest", requireAuth("payments:read"), rateLimit, async (c) => {
  const row = await db.query.smokeTestResults.findFirst({
    orderBy: (t, { desc }) => desc(t.ranAt),
  });
  return ok(c, row ?? null);
});
