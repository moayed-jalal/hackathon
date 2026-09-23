import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { requestId } from "./middleware/requestId.js";
import { onError } from "./middleware/errorHandler.js";
import { errorBody } from "./lib/response.js";
import { paymentIntentRoutes } from "./modules/payment-intents/routes.js";
import { webhookRoutes } from "./modules/webhooks/routes.js";
import { sandboxRoutes } from "./modules/sandbox/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { merchantRoutes, apiKeyRoutes } from "./modules/merchants/routes.js";
import { merchantWebhookRoutes } from "./modules/merchant-webhooks/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { consoleRoutes } from "./modules/console/routes.js";
import { openApiDocument } from "./openapi.js";

export const app = new Hono();

app.use("*", requestId);
app.use(
  "*",
  cors({
    origin: config.corsOrigins,
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Admin-Secret"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);
app.onError(onError);

app.get("/", (c) => c.redirect("/health"));

app.get("/health", (c) =>
  c.json({ status: "ok", sandbox: true, service: "finbridge", note: "SANDBOX ONLY — NO REAL MONEY" }),
);

app.get("/openapi.json", (c) => c.json(openApiDocument));

app.get("/docs", (c) =>
  c.html(`<!doctype html>
<html>
  <head>
    <title>FinBridge API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0">
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`),
);

// Public auth routes
app.route("/auth", authRoutes);

// API key authenticated routes (for developer API access)
app.route("/api/v1/payment-intents", paymentIntentRoutes);
app.route("/api/v1/webhooks", webhookRoutes);
app.route("/api/v1/sandbox", sandboxRoutes);
app.route("/api/v1/dashboard", dashboardRoutes);
app.route("/api/v1/merchants", merchantRoutes);
app.route("/api/v1/merchants/webhook", merchantWebhookRoutes);
app.route("/api/v1/api-keys", apiKeyRoutes);

// Session authenticated routes (for human Console access)
app.route("/api/v1/console", consoleRoutes);

app.notFound((c) => {
  const requestIdValue = c.get("requestId") as string;
  return c.json(errorBody(requestIdValue, "NOT_FOUND", `No route: ${c.req.method} ${c.req.path}`), 404);
});