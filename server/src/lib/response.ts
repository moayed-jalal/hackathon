import type { Context } from "hono";
import type { ErrorCode } from "./errors.js";

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  const requestId = c.get("requestId") as string;
  return c.json({ data, request_id: requestId }, status);
}

export function okList<T>(c: Context, data: T[], extra: Record<string, unknown> = {}) {
  const requestId = c.get("requestId") as string;
  return c.json({ data, ...extra, request_id: requestId }, 200);
}

export function errorBody(
  requestId: string,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return {
    error: { code, message, ...(details ? { details } : {}) },
    request_id: requestId,
  };
}
