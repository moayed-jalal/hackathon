import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { apiKeys, merchants, users, workspaces } from "../../db/schema.js";
import { generateApiKey, hashApiKey, verifyApiKey, extractKeyPrefix } from "../../lib/crypto.js";
import { recordAuditEvent } from "../audit/service.js";

export const DEFAULT_SCOPES = [
  "payments:read",
  "payments:write",
  "sandbox:simulate",
  "apikeys:write",
  "webhooks:read",
  "webhooks:write",
];

const ADMIN_BOOTSTRAP_USER_SUB = "admin_bootstrap_subject";
const ADMIN_BOOTSTRAP_USER_EMAIL = "admin-bootstrap@finbridge.sandbox";

export interface CreateMerchantInput {
  name: string;
  email: string;
  workspaceId?: string;
  requestId: string;
  scopes?: string[];
}

/**
 * The admin bootstrap route (POST /api/v1/merchants) is documented and used
 * without a workspaceId — it's how a brand-new sandbox tenant gets its first
 * merchant, before any workspace exists for it to reference. This creates
 * that workspace under a shared system-owned user, one workspace per call.
 */
async function createBootstrapWorkspace(): Promise<string> {
  let user = await db.query.users.findFirst({ where: eq(users.googleSubject, ADMIN_BOOTSTRAP_USER_SUB) });
  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({
        googleSubject: ADMIN_BOOTSTRAP_USER_SUB,
        email: ADMIN_BOOTSTRAP_USER_EMAIL,
        name: "Admin Bootstrap",
        avatarUrl: null,
      })
      .onConflictDoNothing({ target: users.googleSubject })
      .returning();
    user = newUser ?? (await db.query.users.findFirst({ where: eq(users.googleSubject, ADMIN_BOOTSTRAP_USER_SUB) }));
  }
  if (!user) throw new Error("Failed to create admin bootstrap user");

  const [workspace] = await db
    .insert(workspaces)
    .values({ userId: user.id, name: "Sandbox Workspace" })
    .returning();
  if (!workspace) throw new Error("Failed to create bootstrap workspace");

  return workspace.id;
}

export async function createMerchantWithApiKey(input: CreateMerchantInput) {
  const workspaceId = input.workspaceId ?? (await createBootstrapWorkspace());

  const [merchant] = await db
    .insert(merchants)
    .values({ name: input.name, email: input.email, workspaceId })
    .returning();
  if (!merchant) throw new Error("Failed to create merchant");

  const { fullKey, prefix } = generateApiKey();
  const hashedKey = hashApiKey(fullKey);
  const scopes = input.scopes ?? DEFAULT_SCOPES;

  const [apiKey] = await db
    .insert(apiKeys)
    .values({ merchantId: merchant.id, prefix, hashedKey, scopes })
    .returning();
  if (!apiKey) throw new Error("Failed to create API key");

  await recordAuditEvent({
    type: "MERCHANT_CREATED",
    requestId: input.requestId,
    merchantId: merchant.id,
    metadata: { name: merchant.name },
  });
  await recordAuditEvent({
    type: "API_KEY_CREATED",
    requestId: input.requestId,
    merchantId: merchant.id,
    metadata: { apiKeyId: apiKey.id, prefix, scopes },
  });

  return { merchant, apiKey: { ...apiKey, fullKey } };
}

export interface AuthenticatedKey {
  merchantId: string;
  merchantName: string;
  workspaceId: string;
  apiKeyId: string;
  scopes: string[];
}

/** Returns null for any failure mode (unknown prefix, wrong secret, revoked). */
export async function authenticateApiKey(fullKey: string): Promise<AuthenticatedKey | null> {
  const prefix = extractKeyPrefix(fullKey);
  const candidate = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.prefix, prefix),
    with: { merchant: true },
  });
  if (!candidate) return null;
  if (candidate.revokedAt) return null;
  if (!verifyApiKey(fullKey, candidate.hashedKey)) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, candidate.id));

  return {
    merchantId: candidate.merchantId,
    merchantName: candidate.merchant.name,
    workspaceId: candidate.merchant.workspaceId,
    apiKeyId: candidate.id,
    scopes: (candidate.scopes as string[]) ?? [],
  };
}

export interface ApiKeySummary {
  id: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Self-service key creation for a merchant that already has *some* way to
 * authenticate as itself (an existing API key, or a Console session) —
 * never requires the admin bootstrap secret. Same generation/hashing path
 * as `createMerchantWithApiKey`; only the full secret is ever returned, and
 * only here, at creation time.
 */
export async function createApiKeyForMerchant(merchantId: string, requestId: string) {
  const { fullKey, prefix } = generateApiKey();
  const hashedKey = hashApiKey(fullKey);

  const [apiKey] = await db
    .insert(apiKeys)
    .values({ merchantId, prefix, hashedKey, scopes: DEFAULT_SCOPES })
    .returning();
  if (!apiKey) throw new Error("Failed to create API key");

  await recordAuditEvent({
    type: "API_KEY_CREATED",
    requestId,
    merchantId,
    metadata: { apiKeyId: apiKey.id, prefix, scopes: DEFAULT_SCOPES },
  });

  return { ...apiKey, fullKey };
}

/** Metadata only — never the hash or the plaintext secret. Scoped to one merchant. */
export async function listApiKeysForMerchant(merchantId: string): Promise<ApiKeySummary[]> {
  const rows = await db.query.apiKeys.findMany({
    where: eq(apiKeys.merchantId, merchantId),
    orderBy: (keys, { desc }) => desc(keys.createdAt),
  });
  return rows.map((row) => ({
    id: row.id,
    prefix: row.prefix,
    scopes: (row.scopes as string[]) ?? [],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }));
}

export async function revokeApiKey(apiKeyId: string, merchantId: string, requestId: string) {
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.merchantId, merchantId), isNull(apiKeys.revokedAt)))
    .returning();
  if (revoked) {
    await recordAuditEvent({
      type: "API_KEY_REVOKED",
      requestId,
      merchantId: revoked.merchantId,
      metadata: { apiKeyId },
    });
  }
  return revoked ?? null;
}