import { z } from "zod";
import { PROVIDERS } from "../../db/schema.js";

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "LYD"] as const;

export const createPaymentIntentSchema = z
  .object({
    amount: z
      .number({ invalid_type_error: "amount must be an integer number of minor units" })
      .int("amount must be an integer (minor units, e.g. 15000 = 150.00)")
      .positive("amount must be a positive integer"),
    currency: z.enum(SUPPORTED_CURRENCIES, {
      errorMap: () => ({ message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}` }),
    }),
    provider: z.enum(PROVIDERS, {
      errorMap: () => ({ message: `provider must be one of: ${PROVIDERS.join(", ")}` }),
    }),
    scenario: z.string().max(40).optional(),
    reference: z.string().max(255).optional(),
    metadata: z.record(z.string().max(500)).optional(),
  })
  .strict();

export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;

export const listPaymentIntentsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.enum(["created", "processing", "succeeded", "failed", "cancelled"]).optional(),
});

export const simulateWebhookSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
  })
  .strict();
