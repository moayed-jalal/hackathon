import { z } from "zod";

export const putMerchantWebhookSchema = z
  .object({
    url: z.string().min(1).max(2048),
    enabled: z.boolean().optional(),
  })
  .strict();

export type PutMerchantWebhookInput = z.infer<typeof putMerchantWebhookSchema>;
