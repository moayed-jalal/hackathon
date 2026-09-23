import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { recordAuditEvent } from "../modules/audit/service.js";

/**
 * Fixed-window in-memory rate limiter, keyed by authenticated API key (falls
 * back to client IP for unauthenticated requests). Sandbox-scoped: this
 * process holds the only state, which is intentional — see docs/security.md.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const requestId = c.get("requestId") as string;
  const auth = c.get("auth") as { apiKeyId: string; merchantId: string } | undefined;
  const key = auth?.apiKeyId ?? c.req.header("x-forwarded-for") ?? "anonymous";

  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + config.rateLimit.windowMs });
    await next();
    return;
  }

  existing.count += 1;
  if (existing.count > config.rateLimit.maxRequests) {
    const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);
    c.header("Retry-After", String(retryAfterSeconds));
    await recordAuditEvent({
      type: "RATE_LIMIT_TRIGGERED",
      requestId,
      merchantId: auth?.merchantId,
      metadata: { key, limit: config.rateLimit.maxRequests, windowMs: config.rateLimit.windowMs },
    });
    throw new ApiError("RATE_LIMITED", "Too many requests. Please slow down.", {
      limit: config.rateLimit.maxRequests,
      windowMs: config.rateLimit.windowMs,
      retryAfterSeconds,
    });
  }

  await next();
};

export function _resetRateLimitState() {
  windows.clear();
}
