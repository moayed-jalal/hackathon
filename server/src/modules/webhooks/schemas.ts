import { z } from "zod";

export const simProviderBWebhookBodySchema = z
  .object({
    event_id: z.string().min(1),
    type: z.enum(["payment.settled", "payment.rejected"]),
    provider: z.literal("sim_provider_b"),
    data: z.object({
      payment_intent_id: z.string().min(1),
      provider_reference: z.string().min(1),
      status: z.enum(["settled", "rejected"]),
    }),
    created_at: z.string(),
  })
  .strict();

export type SimProviderBWebhookBody = z.infer<typeof simProviderBWebhookBodySchema>;
