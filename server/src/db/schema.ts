import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    googleSubject: text("google_subject").notNull().unique(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_google_subject_idx").on(table.googleSubject)],
);

export const usersRelations = relations(users, ({ many }) => ({
  workspaces: many(workspaces),
}));

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("workspaces_user_id_idx").on(table.userId)],
);

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  user: one(users, { fields: [workspaces.userId], references: [users.id] }),
  merchants: many(merchants),
}));

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  /**
   * Merchant-configured endpoint FinBridge delivers unified payment events
   * to. `webhookSecret` signs those deliveries (HMAC, same scheme as
   * `webhookEvents` but a per-merchant secret — never the internal
   * SimProviderB secret). Stored in plaintext: unlike an API key, it must be
   * reproducible server-side to sign every future delivery, not just
   * verified once — see modules/merchant-webhooks/service.ts. Never returned
   * by the API except at creation/regeneration time.
   */
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  webhookEnabled: boolean("webhook_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchantsRelations = relations(merchants, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [merchants.workspaceId], references: [workspaces.id] }),
  apiKeys: many(apiKeys),
  paymentIntents: many(paymentIntents),
}));

/**
 * API keys are never stored in plaintext. `hashedKey` is a scrypt hash of the
 * full secret; `prefix` (e.g. fb_test_ab12cd34) is safe to display and index
 * for fast lookup without revealing the secret.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    hashedKey: text("hashed_key").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("api_keys_prefix_idx").on(table.prefix),
    index("api_keys_merchant_id_idx").on(table.merchantId),
  ],
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  merchant: one(merchants, { fields: [apiKeys.merchantId], references: [merchants.id] }),
}));

export const PAYMENT_STATUSES = [
  "created",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const PROVIDERS = ["sim_provider_a", "sim_provider_b"] as const;

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: text("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("created"),
    provider: text("provider").notNull(),
    scenario: text("scenario"),
    providerReference: text("provider_reference"),
    failureReason: text("failure_reason"),
    reference: text("reference"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    sandbox: boolean("sandbox").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("payment_intents_merchant_id_idx").on(table.merchantId)],
);

export const paymentIntentsRelations = relations(paymentIntents, ({ one, many }) => ({
  merchant: one(merchants, { fields: [paymentIntents.merchantId], references: [merchants.id] }),
  events: many(paymentIntentEvents),
}));

/** Append-only timeline used to render the transaction detail lifecycle in the dashboard. */
export const paymentIntentEvents = pgTable(
  "payment_intent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentIntentId: text("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("payment_intent_events_payment_intent_id_idx").on(table.paymentIntentId)],
);

/**
 * One row per (merchant, idempotency key). The DB unique constraint is the
 * real guard against concurrent duplicate requests racing the application.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    paymentIntentId: text("payment_intent_id").references(() => paymentIntents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idempotency_merchant_key_idx").on(table.merchantId, table.idempotencyKey)],
);

/**
 * Primary key IS the provider event id — inserting a duplicate id triggers a
 * unique-violation, which is exactly the DB-enforced replay guard (see
 * modules/webhooks/service.ts).
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    paymentIntentId: text("payment_intent_id").references(() => paymentIntents.id),
    payload: jsonb("payload").$type<unknown>().notNull(),
    rawBody: text("raw_body").notNull(),
    signature: text("signature").notNull(),
    timestampHeader: text("timestamp_header").notNull(),
    verified: boolean("verified").notNull(),
    rejectionReason: text("rejection_reason"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhook_events_payment_intent_id_idx").on(table.paymentIntentId)],
);

export const AUDIT_EVENT_TYPES = [
  "API_KEY_CREATED",
  "API_KEY_REVOKED",
  "MERCHANT_CREATED",
  "USER_LOGIN",
  "PAYMENT_CREATED",
  "PAYMENT_PROCESSING",
  "PAYMENT_SUCCEEDED",
  "PAYMENT_FAILED",
  "PAYMENT_CANCELLED",
  "WEBHOOK_RECEIVED",
  "WEBHOOK_VERIFIED",
  "WEBHOOK_REJECTED",
  "WEBHOOK_REPLAY_REJECTED",
  "IDEMPOTENCY_REPLAY",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMIT_TRIGGERED",
  "AUTH_FAILURE",
  "VALIDATION_FAILURE",
] as const;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    requestId: text("request_id").notNull(),
    merchantId: uuid("merchant_id").references(() => merchants.id),
    paymentIntentId: text("payment_intent_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_merchant_id_idx").on(table.merchantId),
  ],
);

export const providerConfigurations = pgTable("provider_configurations", {
  name: text("name").primaryKey(),
  displayName: text("display_name").notNull(),
  mode: text("mode").notNull(),
  description: text("description").notNull(),
  enabled: boolean("enabled").notNull().default(true),
});

/** Public, merchant-facing event vocabulary — deliberately distinct from AUDIT_EVENT_TYPES (see modules/merchant-webhooks/service.ts). */
export const MERCHANT_WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
  "webhook.test",
] as const;

export const MERCHANT_WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;

/**
 * Outbox pattern: a row is inserted (status "pending") in the same
 * transaction-adjacent step as the payment's state transition, before any
 * network call is attempted — the payment stays correct even if the
 * merchant's endpoint never responds. `id` IS the event id merchants see and
 * is never regenerated across retries, so `attempt_count` can grow on the
 * same row without ever duplicating the event.
 */
export const merchantWebhookDeliveries = pgTable(
  "merchant_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    paymentIntentId: text("payment_intent_id").references(() => paymentIntents.id),
    eventType: text("event_type").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    status: text("status").notNull().default("pending"),
    httpStatus: integer("http_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (table) => [
    index("merchant_webhook_deliveries_merchant_id_idx").on(table.merchantId),
    index("merchant_webhook_deliveries_status_idx").on(table.status),
  ],
);

export const smokeTestResults = pgTable("smoke_test_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  total: integer("total").notNull(),
  passed: integer("passed").notNull(),
  results: jsonb("results").$type<{ name: string; passed: boolean; detail?: string }[]>().notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
});