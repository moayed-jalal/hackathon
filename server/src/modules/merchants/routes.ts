import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { config } from "../../config.js";
import { ApiError } from "../../lib/errors.js";
import { ok, okList } from "../../lib/response.js";
import { createApiKeyForMerchant, createMerchantWithApiKey, listApiKeysForMerchant, revokeApiKey } from "./service.js";

export const merchantRoutes = new Hono();
export const apiKeyRoutes = new Hono();

const createMerchantSchema = z
  .object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    workspaceId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Bootstraps a new sandbox merchant + its one-and-only-time-visible API key.
 * Protected by a shared admin secret rather than a merchant API key, since
 * no merchant exists yet to authenticate as. Not part of the canonical
 * payments API — a platform-operator action.
 */
merchantRoutes.post("/", async (c) => {
  const requestId = c.get("requestId") as string;
  const adminHeader = c.req.header("X-Admin-Secret");
  if (!adminHeader || adminHeader !== config.adminSecret) {
    throw new ApiError("FORBIDDEN", "A valid X-Admin-Secret header is required to create merchants");
  }

  const parsed = createMerchantSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Invalid merchant payload", { issues: parsed.error.issues });
  }

  const { merchant, apiKey } = await createMerchantWithApiKey({ ...parsed.data, requestId });

  return ok(
    c,
    {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      workspace_id: merchant.workspaceId,
      api_key: apiKey.fullKey,
      api_key_prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      warning: "This is the only time the full API key is shown. Store it now.",
    },
    201,
  );
});

/**
 * Self-service key management for a merchant that already holds a working
 * key — mint additional keys or rotate away from an old one without ever
 * touching X-Admin-Secret again. Scoped strictly to the authenticated
 * merchant; no merchant_id/workspace_id is ever accepted from the client.
 */
apiKeyRoutes.post("/", requireAuth("apikeys:write"), rateLimit, async (c) => {
  const requestId = c.get("requestId") as string;
  const auth = c.get("auth");
  const apiKey = await createApiKeyForMerchant(auth.merchantId, requestId);
  return ok(
    c,
    {
      id: apiKey.id,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      api_key: apiKey.fullKey,
      created_at: apiKey.createdAt.toISOString(),
      warning: "This is the only time the full API key is shown. Store it now.",
    },
    201,
  );
});

/** Metadata only (id, prefix, scopes, timestamps) — never the hash or a plaintext secret. */
apiKeyRoutes.get("/", requireAuth("apikeys:write"), rateLimit, async (c) => {
  const auth = c.get("auth");
  const keys = await listApiKeysForMerchant(auth.merchantId);
  return okList(
    c,
    keys.map((key) => ({
      id: key.id,
      prefix: key.prefix,
      scopes: key.scopes,
      created_at: key.createdAt.toISOString(),
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      revoked_at: key.revokedAt?.toISOString() ?? null,
    })),
  );
});

apiKeyRoutes.delete("/:id", requireAuth("apikeys:write"), rateLimit, async (c) => {
  const requestId = c.get("requestId") as string;
  const auth = c.get("auth");
  const revoked = await revokeApiKey(c.req.param("id"), auth.merchantId, requestId);
  if (!revoked) {
    throw new ApiError("NOT_FOUND", "API key not found or already revoked");
  }
  return ok(c, { id: revoked.id, revoked_at: revoked.revokedAt?.toISOString() });
});