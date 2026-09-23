import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://finbridge:finbridge_sandbox@localhost:5544/finbridge",
  ),
  adminSecret: required("ADMIN_SECRET", "admin_sandbox_secret_change_me"),
  corsOrigins: optional(
    "CORS_ORIGINS",
    "http://localhost:5180,https://hackathon.com.ly,https://www.hackathon.com.ly",
  )!.split(",").map((origin) => origin.trim()),
  frontendUrl: optional("FRONTEND_URL", "http://localhost:5180")!,
  webhookSecrets: {
    sim_provider_b: required(
      "WEBHOOK_SECRET_SIM_PROVIDER_B",
      "whsec_sandbox_sim_provider_b_test_key",
    ),
  },
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000),
    maxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 20),
  },
  webhookTimestampToleranceSeconds: Number(
    process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS ?? 300,
  ),
  google: {
    clientId: optional("GOOGLE_CLIENT_ID", "dev_google_client_id"),
    clientSecret: optional("GOOGLE_CLIENT_SECRET", "dev_google_client_secret"),
    redirectUri: optional("GOOGLE_REDIRECT_URI", "http://localhost:4000/auth/google/callback"),
  },
  session: {
    secret: required("SESSION_SECRET", "dev_session_secret_change_in_production_min_32_chars"),
    cookieName: "finbridge_session",
    maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
  },
} as const;