import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors.js";
import { isWellFormedApiKey, extractKeyPrefix } from "../lib/crypto.js";
import { authenticateApiKey, type AuthenticatedKey } from "../modules/merchants/service.js";
import { recordAuditEvent } from "../modules/audit/service.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    auth: AuthenticatedKey;
  }
}

/** Requires a valid, non-revoked sandbox API key. Optionally enforces a scope. */
export function requireAuth(scope?: string): MiddlewareHandler {
  return async (c, next) => {
    const requestId = c.get("requestId") as string;
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;

    if (!token || !isWellFormedApiKey(token)) {
      await recordAuditEvent({
        type: "AUTH_FAILURE",
        requestId,
        metadata: { reason: "missing_or_malformed_key", prefix: token ? extractKeyPrefix(token) : null },
      });
      throw new ApiError("INVALID_API_KEY", "A valid sandbox API key is required");
    }

    const authenticated = await authenticateApiKey(token);
    if (!authenticated) {
      await recordAuditEvent({
        type: "AUTH_FAILURE",
        requestId,
        metadata: { reason: "invalid_or_revoked_key", prefix: extractKeyPrefix(token) },
      });
      throw new ApiError("INVALID_API_KEY", "Invalid, revoked, or unknown API key");
    }

    if (scope && !authenticated.scopes.includes(scope)) {
      await recordAuditEvent({
        type: "AUTH_FAILURE",
        requestId,
        merchantId: authenticated.merchantId,
        metadata: { reason: "insufficient_scope", requiredScope: scope },
      });
      throw new ApiError("INSUFFICIENT_SCOPE", `API key is missing required scope: ${scope}`);
    }

    c.set("auth", authenticated);
    await next();
  };
}
