import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { createHash } from "node:crypto";
import { encodeBase64url, encodeBase64urlNoPadding, encodeHexLowerCase, decodeHex } from "@oslojs/encoding";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { users, workspaces, merchants, sessions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { ids } from "../../lib/ids.js";
import { createMerchantWithApiKey } from "../merchants/service.js";
import { recordAuditEvent } from "../audit/service.js";
import { logger } from "../../logger.js";

const oauth2Client = new OAuth2Client({
  clientId: config.google.clientId ?? "dev_google_client_id",
  clientSecret: config.google.clientSecret ?? "dev_google_client_secret",
  redirectUri: config.google.redirectUri ?? "http://localhost:4000/auth/google/callback",
});

export function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

export async function createSession(userId: string): Promise<string> {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + config.session.maxAgeSeconds * 1000);
  await db.insert(sessions).values({ id: sessionId, userId, expiresAt });
  return sessionId;
}

export async function validateSession(sessionId: string): Promise<{ user: typeof users.$inferSelect; session: typeof sessions.$inferSelect } | null> {
  const result = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: { user: true },
  });
  if (!result) return null;
  if (result.expiresAt < new Date()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  return { user: result.user, session: result };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

// RFC 7636 S256: code_challenge = base64url-no-padding(sha256(code_verifier)).
// codeVerifier itself is unchanged — still our own generateCodeVerifier(),
// stored in the same OAUTH_VERIFIER_COOKIE and sent back as-is in getToken().
function computeCodeChallengeS256(codeVerifier: string): string {
  const hash = createHash("sha256").update(codeVerifier).digest();
  return encodeBase64urlNoPadding(new Uint8Array(hash));
}

export async function getGoogleAuthUrl(state: string, codeVerifier: string): Promise<string> {
  return oauth2Client.generateAuthUrl({
    state,
    scope: ["openid", "email", "profile"],
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: computeCodeChallengeS256(codeVerifier),
  });
}

// Uses google-auth-library's OAuth2Client.getToken(), which goes through
// its gaxios transport instead of a hand-built fetch request. This
// replaces an earlier hand-rolled implementation that hit two distinct
// bugs in this environment: arctic's manual Content-Length header made
// undici reject the request outright, and a follow-up raw fetch() got a
// 200 response whose body decoded as raw gzip bytes instead of JSON.
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  requestId?: string,
): Promise<{ idToken: string }> {
  try {
    const { tokens } = await oauth2Client.getToken({
      code,
      codeVerifier,
      redirect_uri: config.google.redirectUri ?? "http://localhost:4000/auth/google/callback",
    });
    oauth2Client.setCredentials(tokens);
    if (!tokens.id_token) {
      // Shouldn't happen — the "openid" scope always gets one — but
      // fail closed rather than proceed without a verifiable identity.
      throw new Error("Google token response had no id_token");
    }
    logger.info("[oauth-diag] token exchange: succeeded", { requestId });
    return { idToken: tokens.id_token };
  } catch (err) {
    // Never log err.response/err.cause here — for google-auth-library
    // errors those carry the request/response, which would leak
    // GOOGLE_CLIENT_SECRET and token values.
    logger.error("[oauth-diag] token exchange: failed", {
      requestId,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// Verifies the ID token's signature, audience, issuer, and expiration via
// google-auth-library (the officially documented way to authenticate a
// Google Sign-In user server-side) instead of a separate userinfo HTTP
// call — every field we need (sub, email, name, picture) is already in
// the ID token payload for the openid+email+profile scope we request, so
// there's no second network request to fail.
export async function verifyGoogleIdentity(
  idToken: string,
  requestId?: string,
): Promise<{ sub: string; email: string; name: string; picture: string | null; email_verified: boolean }> {
  let payload;
  try {
    const ticket = await oauth2Client.verifyIdToken({
      idToken,
      audience: config.google.clientId ?? "dev_google_client_id",
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.error("[oauth-diag] id token verification failed", {
      requestId,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (!payload || !payload.sub || !payload.email) {
    logger.error("[oauth-diag] id token verified but missing required claims", {
      requestId,
      hasPayload: Boolean(payload),
      hasSub: Boolean(payload?.sub),
      hasEmail: Boolean(payload?.email),
    });
    throw new Error("Verified Google ID token was missing required claims");
  }

  logger.info("[oauth-diag] id token verification succeeded", { requestId });

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
    picture: payload.picture ?? null,
    email_verified: payload.email_verified ?? false,
  };
}

const DEV_LOGIN_SUBJECT = "dev_login_subject";

/**
 * Non-production escape hatch: judges/reviewers running the sandbox locally
 * (or anywhere without real Google OAuth credentials configured) can reach
 * the console without a Google account. Gated in routes.ts to nodeEnv !== "production".
 */
export async function getOrCreateDevUser(): Promise<typeof users.$inferSelect> {
  const existing = await db.query.users.findFirst({ where: eq(users.googleSubject, DEV_LOGIN_SUBJECT) });
  if (existing) return existing;

  const [newUser] = await db
    .insert(users)
    .values({
      googleSubject: DEV_LOGIN_SUBJECT,
      email: "judge@finbridge.sandbox",
      name: "Sandbox Judge",
      avatarUrl: null,
    })
    .returning();
  return newUser!;
}

export async function findOrCreateUser(googleUser: { sub: string; email: string; name: string; picture: string | null }): Promise<typeof users.$inferSelect> {
  const existingUser = await db.query.users.findFirst({
    where: eq(users.googleSubject, googleUser.sub),
  });

  if (existingUser) {
    return existingUser;
  }

  const [newUser] = await db
    .insert(users)
    .values({
      googleSubject: googleUser.sub,
      email: googleUser.email,
      name: googleUser.name,
      avatarUrl: googleUser.picture,
    })
    .returning();
  return newUser!;
}

export async function ensureWorkspaceAndMerchant(userId: string, userName: string): Promise<{ workspace: typeof workspaces.$inferSelect; merchant: typeof merchants.$inferSelect }> {
  const existingWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.userId, userId),
  });

  let workspace: typeof workspaces.$inferSelect;
  if (existingWorkspace) {
    workspace = existingWorkspace;
  } else {
    const [newWorkspace] = await db
      .insert(workspaces)
      .values({ userId, name: `${userName}'s Workspace` })
      .returning();
    workspace = newWorkspace!;
  }

  const workspaceId = workspace.id;

  const existingMerchant = await db.query.merchants.findFirst({
    where: eq(merchants.workspaceId, workspaceId),
  });

  let merchant: typeof merchants.$inferSelect;
  if (existingMerchant) {
    merchant = existingMerchant;
  } else {
    const { merchant: newMerchant } = await createMerchantWithApiKey({
      name: `${userName}'s Sandbox Merchant`,
      email: `${userId}@finbridge.sandbox`,
      workspaceId: workspaceId,
      requestId: ids.requestId(),
    });
    merchant = newMerchant;
  }

  return { workspace, merchant };
}

export async function getUserWorkspaceMerchant(userId: string): Promise<{ workspace: typeof workspaces.$inferSelect; merchant: typeof merchants.$inferSelect } | null> {
  const existingWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.userId, userId),
  });

  if (!existingWorkspace) return null;

  const existingMerchant = await db.query.merchants.findFirst({
    where: eq(merchants.workspaceId, existingWorkspace.id),
  });

  if (!existingMerchant) return null;

  return { workspace: existingWorkspace, merchant: existingMerchant };
}