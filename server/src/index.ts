import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { resumePendingSimProviderBSettlements } from "./modules/payment-intents/service.js";

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("FinBridge sandbox API listening", { port: info.port, env: config.nodeEnv });
  logger.info("SANDBOX ONLY — NO REAL MONEY");
  resumePendingSimProviderBSettlements().catch((err) => {
    logger.error("Failed to resume pending SimProviderB settlements", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
});
