import { randomBytes } from "node:crypto";

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export const ids = {
  requestId: () => `req_test_${randomToken(8)}`,
  paymentIntentId: () => `pi_test_${randomToken(12)}`,
  webhookEventId: () => `evt_test_${randomToken(12)}`,
  idempotencyRecordId: () => `idem_test_${randomToken(8)}`,
  consoleEventId: () => `cevt_test_${randomToken(12)}`,
};
