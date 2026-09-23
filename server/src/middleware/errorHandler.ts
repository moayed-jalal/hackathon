import type { Context } from "hono";
import { ApiError } from "../lib/errors.js";
import { errorBody } from "../lib/response.js";
import { logger } from "../logger.js";

/**
 * Central error boundary. Only ApiError messages are ever sent to clients —
 * anything else (DB errors, programming errors) is logged internally and
 * reported as a generic INTERNAL_ERROR so stack traces and SQL details never
 * leak to the API surface.
 */
export function onError(err: unknown, c: Context) {
  const requestId = (c.get("requestId") as string) ?? "unknown";

  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logger.error(err.message, { requestId, code: err.code });
    }
    return c.json(errorBody(requestId, err.code, err.message, err.details), err.status as 400);
  }

  logger.error("Unhandled error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  return c.json(errorBody(requestId, "INTERNAL_ERROR", "An unexpected error occurred"), 500);
}
