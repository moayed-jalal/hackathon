/**
 * Centralized structured logger. Never pass API keys, webhook secrets,
 * Authorization headers, or other credentials into `meta` — audit.ts and
 * auth.ts are responsible for redacting before anything reaches here.
 */
type LogMeta = Record<string, unknown>;

const REDACTED_KEYS = new Set([
  "authorization",
  "apiKey",
  "api_key",
  "hashedKey",
  "signature",
  "secret",
  "password",
]);

function sanitize(meta: LogMeta): LogMeta {
  const clean: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    clean[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return clean;
}

function write(level: "info" | "warn" | "error", message: string, meta: LogMeta = {}) {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...sanitize(meta),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, meta?: LogMeta) => write("info", message, meta),
  warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
  error: (message: string, meta?: LogMeta) => write("error", message, meta),
};
