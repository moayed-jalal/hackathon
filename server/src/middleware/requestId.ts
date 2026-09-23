import type { MiddlewareHandler } from "hono";
import { ids } from "../lib/ids.js";

export const requestId: MiddlewareHandler = async (c, next) => {
  const requestId = ids.requestId();
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-Id", requestId);
};
