import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { validateSession, getUserWorkspaceMerchant } from "../modules/auth/service.js";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    auth: AuthenticatedKey;
    sessionUser: SessionUser;
  }
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  workspaceId: string;
  workspaceName: string;
  merchantId: string;
  merchantName: string;
}

export interface AuthenticatedKey {
  merchantId: string;
  merchantName: string;
  workspaceId: string;
  apiKeyId: string;
  scopes: string[];
}

/** Requires a valid server-side session cookie. Used for Console (human) authentication. */
export function requireSession(): MiddlewareHandler {
  return async (c, next) => {
    const sessionId = getCookie(c, config.session.cookieName);
    if (!sessionId) {
      throw new ApiError("UNAUTHORIZED", "A valid console session is required");
    }

    const result = await validateSession(sessionId);
    if (!result) {
      throw new ApiError("UNAUTHORIZED", "Console session is invalid or expired");
    }

    const userWorkspaceMerchant = await getUserWorkspaceMerchant(result.user.id);
    if (!userWorkspaceMerchant || !userWorkspaceMerchant.workspace || !userWorkspaceMerchant.merchant) {
      throw new ApiError("UNAUTHORIZED", "Console session is invalid or expired");
    }

    const { workspace, merchant } = userWorkspaceMerchant;

    const sessionUser: SessionUser = {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      avatarUrl: result.user.avatarUrl,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      merchantId: merchant.id,
      merchantName: merchant.name,
    };

    const auth: AuthenticatedKey = {
      merchantId: merchant.id,
      merchantName: merchant.name,
      workspaceId: workspace.id,
      apiKeyId: "",
      scopes: ["payments:read", "payments:write", "sandbox:simulate", "apikeys:write", "webhooks:read", "webhooks:write"],
    };

    c.set("sessionUser", sessionUser);
    c.set("auth", auth);
    await next();
  };
}