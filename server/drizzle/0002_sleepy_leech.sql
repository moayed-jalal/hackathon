CREATE TABLE IF NOT EXISTS "merchant_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"payment_intent_id" text,
	"event_type" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "webhook_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_webhook_deliveries" ADD CONSTRAINT "merchant_webhook_deliveries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_webhook_deliveries" ADD CONSTRAINT "merchant_webhook_deliveries_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_webhook_deliveries_merchant_id_idx" ON "merchant_webhook_deliveries" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_webhook_deliveries_status_idx" ON "merchant_webhook_deliveries" USING btree ("status");