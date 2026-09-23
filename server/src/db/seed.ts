import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, sql } from "./client.js";
import { merchants, providerConfigurations, users, workspaces } from "./schema.js";
import { createMerchantWithApiKey } from "../modules/merchants/service.js";
import { createPaymentIntent } from "../modules/payment-intents/service.js";
import { processSimProviderBWebhook } from "../modules/webhooks/service.js";
import { buildSimProviderBWebhookPayload } from "../modules/providers/simProviderB.js";
import { signWebhookPayload } from "../lib/crypto.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ids } from "../lib/ids.js";

const SYSTEM_USER_EMAIL = "system@finbridge.sandbox";
const SYSTEM_USER_SUB = "system_user_subject";

async function seedProviderConfigurations() {
  await db
    .insert(providerConfigurations)
    .values([
      {
        name: "sim_provider_a",
        displayName: "SimProviderA",
        mode: "sync",
        description:
          "Synchronous simulated provider. Returns an immediate success or decline based on the requested scenario.",
        enabled: true,
      },
      {
        name: "sim_provider_b",
        displayName: "SimProviderB",
        mode: "async",
        description:
          "Asynchronous simulated provider. Returns processing immediately, then settles via a signed webhook.",
        enabled: true,
      },
    ])
    .onConflictDoNothing({ target: providerConfigurations.name });
}

async function seedDemoTransactions(merchantId: string, requestId: string) {
  await createPaymentIntent(
    merchantId,
    { amount: 15000, currency: "LYD", provider: "sim_provider_a", scenario: "success", reference: "order-1001" },
    requestId,
  );
  await createPaymentIntent(
    merchantId,
    { amount: 4200, currency: "USD", provider: "sim_provider_a", scenario: "declined", reference: "order-1002" },
    requestId,
  );

  const asyncSuccess = await createPaymentIntent(
    merchantId,
    { amount: 98000, currency: "LYD", provider: "sim_provider_b", scenario: "succeeded", reference: "order-1003" },
    requestId,
  );
  const { body } = buildSimProviderBWebhookPayload({
    paymentIntentId: asyncSuccess.id,
    providerReference: asyncSuccess.providerReference ?? `spb_${asyncSuccess.id}`,
    outcome: "succeeded",
  });
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(rawBody, timestamp, config.webhookSecrets.sim_provider_b);
  await processSimProviderBWebhook(rawBody, { signature, timestamp }, requestId);

  // Left in "processing" on purpose — a natural demo target for the live "simulate webhook" step.
  await createPaymentIntent(
    merchantId,
    { amount: 25000, currency: "EUR", provider: "sim_provider_b", scenario: "succeeded", reference: "order-1004" },
    requestId,
  );
}

async function ensureSystemWorkspace(): Promise<{ userId: string; workspaceId: string; merchantId: string; apiKey: string }> {
  const user = await db.query.users.findFirst({ where: eq(users.googleSubject, SYSTEM_USER_SUB) });
  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({
        googleSubject: SYSTEM_USER_SUB,
        email: SYSTEM_USER_EMAIL,
        name: "System User",
        avatarUrl: null,
      })
      .returning();
    return ensureSystemWorkspace();
  }

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.userId, user.id) });
  if (!workspace) {
    const [newWorkspace] = await db
      .insert(workspaces)
      .values({ userId: user.id, name: "FinBridge Demo Workspace" })
      .returning();
    return ensureSystemWorkspace();
  }

  const merchant = await db.query.merchants.findFirst({ where: eq(merchants.workspaceId, workspace.id) });
  if (!merchant) {
    const { merchant: newMerchant, apiKey } = await createMerchantWithApiKey({
      name: "FinBridge Demo Merchant",
      email: "demo@finbridge.sandbox",
      workspaceId: workspace.id,
      requestId: ids.requestId(),
    });
    return { userId: user.id, workspaceId: workspace.id, merchantId: newMerchant.id, apiKey: apiKey.fullKey };
  }

  // The full secret is never persisted (only its scrypt hash — see apiKeys
  // schema comment), so an already-existing key's plaintext can't be
  // recovered here. Leave `apiKey` empty; `main()` treats that as "keep
  // whatever's already in web/.env.local" instead of overwriting it with a
  // fabricated, unusable value.
  return { userId: user.id, workspaceId: workspace.id, merchantId: merchant.id, apiKey: "" };
}

async function main() {
  const requestId = ids.requestId();
  logger.info("Seeding FinBridge sandbox data");

  await seedProviderConfigurations();

  const { merchantId, apiKey } = await ensureSystemWorkspace();

  await seedDemoTransactions(merchantId, requestId);

  const summary = {
    merchant_id: merchantId,
    merchant_name: "FinBridge Demo Merchant",
    api_key: apiKey,
    note: "SANDBOX ONLY — synthetic demo credential. Shown once; re-run `docker compose down -v && db:migrate && db:seed` for a fresh one.",
  };

  console.log("\n=== FinBridge Sandbox Seed Complete ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("========================================\n");

  const webEnvPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../web/.env.local",
  );
  if (!apiKey) {
    logger.info("Demo merchant already exists — its API key secret can't be recovered, leaving web/.env.local untouched");
  } else if (existsSync(path.dirname(webEnvPath))) {
    writeFileSync(
      webEnvPath,
      // No VITE_API_BASE_URL here: vite.config.ts proxies /api and /auth to
      // localhost:${config.port} in dev, so the dashboard calls same-origin
      // paths and never needs CORS locally. Set VITE_API_BASE_URL only for
      // a production build talking to a separately-hosted API.
      `VITE_DEMO_API_KEY=${apiKey}\n`,
    );
    logger.info("Wrote demo API key to web/.env.local for the dashboard to pick up automatically");
  } else {
    logger.info("No web/ workspace here — set VITE_DEMO_API_KEY manually on Vercel", {
      api_key: apiKey,
    });
  }

  await sql.end();
}

main().catch((error) => {
  logger.error("Seed failed", { error: String(error) });
  process.exit(1);
});