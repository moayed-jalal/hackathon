import { showToast } from "./toast";

/**
 * The backend processes a webhook (verify -> dedupe -> transition) inside one
 * synchronous call, so polling can never observe a distinct "received but not
 * yet applied" moment — by the time a poll sees the status change, it has
 * already been fully processed. We show the "webhook received" and
 * "succeeded" toasts as an immediate pair so the demo narrates both real,
 * already-true facts in the order they logically occurred, without polling
 * fast enough to catch a gap that doesn't exist server-side.
 */
const RECEIVED_TO_SUCCEEDED_GAP_MS = 600;

// Keyed by `${paymentIntentId}:${status}` so a transition is only narrated
// once, no matter how many polling components (list + detail) observe it, or
// how many times an effect re-fires (e.g. React StrictMode's double-invoke).
const notifiedTransitions = new Set<string>();

export function notifyPaymentCreated(status: string) {
  if (status === "processing") {
    showToast("Payment is processing. Waiting for provider confirmation…", "info");
  }
}

export function notifyPaymentStatusChange(paymentIntentId: string, status: string, previousStatus: string | undefined) {
  if (!previousStatus || previousStatus === status) return;
  if (previousStatus !== "processing") return;

  const key = `${paymentIntentId}:${status}`;
  if (notifiedTransitions.has(key)) return;
  notifiedTransitions.add(key);

  if (status === "succeeded") {
    showToast("Provider webhook received. Processing payment confirmation…", "info", 3000);
    setTimeout(() => {
      showToast("Payment succeeded — confirmation received from SimProviderB.", "success");
    }, RECEIVED_TO_SUCCEEDED_GAP_MS);
  } else if (status === "failed") {
    showToast("Provider webhook received. Processing payment confirmation…", "info", 3000);
    setTimeout(() => {
      showToast("Payment failed — provider reported a rejection.", "error");
    }, RECEIVED_TO_SUCCEEDED_GAP_MS);
  }
}
