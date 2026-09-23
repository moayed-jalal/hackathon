import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { ok } from "../../lib/response.js";
import { logger } from "../../logger.js";
import { recordAuditEvent } from "../audit/service.js";
import {
  generateState,
  generateCodeVerifier,
  createSession,
  validateSession,
  deleteSession,
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  getGoogleUserInfo,
  findOrCreateUser,
  ensureWorkspaceAndMerchant,
  getUserWorkspaceMerchant,
  getOrCreateDevUser,
} from "./service.js";

export const authRoutes = new Hono();

const OAUTH_STATE_COOKIE = "finbridge_oauth_state";
const OAUTH_VERIFIER_COOKIE = "finbridge_oauth_verifier";
const SESSION_COOKIE = config.session.cookieName;

function setSecureCookie(c: any, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

function deleteSecureCookie(c: any, name: string) {
  deleteCookie(c, name, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "Lax",
    path: "/",
  });
}

authRoutes.get("/google", async (c) => {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  setSecureCookie(c, OAUTH_STATE_COOKIE, state, 60 * 10);
  setSecureCookie(c, OAUTH_VERIFIER_COOKIE, codeVerifier, 60 * 10);

  const authUrl = await getGoogleAuthUrl(state, codeVerifier);
  // TEMP DIAGNOSTIC — remove once the stuck-on-Google issue is confirmed fixed.
  logger.info("[oauth-diag] /auth/google -> redirecting to Google", {
    requestId: c.get("requestId"),
    authUrl,
  });
  return c.redirect(authUrl);
});

authRoutes.get("/google/callback", async (c) => {
  const requestId = c.get("requestId") as string;
  const storedState = getCookie(c, OAUTH_STATE_COOKIE);
  const storedVerifier = getCookie(c, OAUTH_VERIFIER_COOKIE);
  const returnedState = c.req.query("state");
  const code = c.req.query("code");
  const error = c.req.query("error");

  // TEMP DIAGNOSTIC — remove once the stuck-on-Google issue is confirmed fixed.
  logger.info("[oauth-diag] /auth/google/callback HIT", {
    requestId,
    hasCode: Boolean(code),
    hasState: Boolean(returnedState),
    hasStoredState: Boolean(storedState),
    hasStoredVerifier: Boolean(storedVerifier),
    error: error ?? null,
  });

  deleteSecureCookie(c, OAUTH_STATE_COOKIE);
  deleteSecureCookie(c, OAUTH_VERIFIER_COOKIE);

  // This route is only ever reached via a full-page browser redirect from
  // Google, never via fetch/XHR — a thrown ApiError would bubble to the
  // generic JSON error handler and strand the user on a raw JSON response
  // instead of back in the app, so every failure path redirects instead.
  const failLogin = (reason: string) => c.redirect(`${config.frontendUrl}/login?error=${reason}`);

  if (error) {
    return failLogin("google_denied");
  }

  if (!storedState || !storedVerifier || !returnedState || !code) {
    return failLogin("missing_params");
  }

  if (storedState !== returnedState) {
    await recordAuditEvent({
      type: "AUTH_FAILURE",
      requestId,
      metadata: { reason: "invalid_oauth_state" },
    });
    return failLogin("invalid_state");
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, storedVerifier);
  } catch (err) {
    const cause = err instanceof Error ? (err.cause as unknown) : undefined;
    logger.error("Google OAuth token exchange failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      causeName: cause instanceof Error ? cause.name : undefined,
      causeMessage: cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined,
      causeCode: cause && typeof cause === "object" ? (cause as { code?: string }).code : undefined,
    });
    await recordAuditEvent({
      type: "AUTH_FAILURE",
      requestId,
      metadata: { reason: "token_exchange_failed" },
    });
    return failLogin("token_exchange_failed");
  }

  let googleUser;
  try {
    googleUser = await getGoogleUserInfo(tokens.accessToken());
  } catch (err) {
    logger.error("Google userinfo fetch failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    await recordAuditEvent({
      type: "AUTH_FAILURE",
      requestId,
      metadata: { reason: "userinfo_fetch_failed" },
    });
    return failLogin("userinfo_fetch_failed");
  }

  if (!googleUser.email_verified) {
    return failLogin("email_not_verified");
  }

  const user = await findOrCreateUser(googleUser);
  const { workspace, merchant } = await ensureWorkspaceAndMerchant(user.id, user.name);

  const sessionId = await createSession(user.id);
  setSecureCookie(c, SESSION_COOKIE, sessionId, config.session.maxAgeSeconds);

  await recordAuditEvent({
    type: "USER_LOGIN",
    requestId,
    merchantId: merchant.id,
    metadata: { action: "user_login", userId: user.id, workspaceId: workspace.id },
  });

  return c.redirect(`${config.frontendUrl}/console`);
});

authRoutes.post("/dev-login", async (c) => {
  if (config.nodeEnv === "production") {
    throw new ApiError("FORBIDDEN", "Dev login is disabled in production");
  }

  const user = await getOrCreateDevUser();
  await ensureWorkspaceAndMerchant(user.id, user.name);

  const sessionId = await createSession(user.id);
  setSecureCookie(c, SESSION_COOKIE, sessionId, config.session.maxAgeSeconds);

  return ok(c, { success: true });
});

authRoutes.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    await deleteSession(sessionId);
  }
  deleteSecureCookie(c, SESSION_COOKIE);
  return ok(c, { success: true });
});

authRoutes.get("/me", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) {
    return ok(c, { authenticated: false });
  }

  const result = await validateSession(sessionId);
  if (!result) {
    deleteSecureCookie(c, SESSION_COOKIE);
    return ok(c, { authenticated: false });
  }

  const userWorkspaceMerchant = await getUserWorkspaceMerchant(result.user.id);
  if (!userWorkspaceMerchant || !userWorkspaceMerchant.workspace || !userWorkspaceMerchant.merchant) {
    return ok(c, { authenticated: false });
  }

  const { workspace, merchant } = userWorkspaceMerchant;

  return ok(c, {
    authenticated: true,
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      avatarUrl: result.user.avatarUrl,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      merchantId: merchant.id,
      merchantName: merchant.name,
    },
  });
});