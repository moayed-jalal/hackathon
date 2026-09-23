import { Google } from "arctic";
import { encodeBase64url, encodeHexLowerCase, decodeHex } from "@oslojs/encoding";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { users, workspaces, merchants, sessions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { ids } from "../../lib/ids.js";
import { createMerchantWithApiKey } from "../merchants/service.js";
import { recordAuditEvent } from "../audit/service.js";

const google = new Google(
  config.google.clientId ?? "dev_google_client_id",
  config.google.clientSecret ?? "dev_google_client_secret",
  config.google.redirectUri ?? "http://localhost:4000/auth/google/callback"
);

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

export async function getGoogleAuthUrl(state: string, codeVerifier: string): Promise<string> {
  // arctic's Google.createAuthorizationURL takes the raw PKCE verifier and
  // hashes it (S256) internally to produce code_challenge — do not pre-hash it here.
  const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
  return url.toString();
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string) {
  return google.validateAuthorizationCode(code, codeVerifier);
}

export async function getGoogleUserInfo(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error("Failed to fetch Google user info");
  }
  return response.json() as Promise<{
    sub: string;
    email: string;
    name: string;
    picture: string;
    email_verified: boolean;
  }>;
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

export async function findOrCreateUser(googleUser: { sub: string; email: string; name: string; picture: string }): Promise<typeof users.$inferSelect> {
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