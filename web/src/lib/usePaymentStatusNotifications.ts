import { useEffect, useRef } from "react";
import { useConsoleEvents } from "./useConsoleEvents";
import { notifyPaymentStatusChange } from "./paymentNotifications";

/**
 * Mounted once for the whole Console shell (ConsoleLayout) so an async
 * provider's confirmation (e.g. SimProviderB) is narrated via toast no
 * matter which page the user is currently on — reacts to the SSE event's
 * own status fields directly, so it needs no page's payment-intents fetch
 * to be mounted.
 */
export function usePaymentStatusNotifications() {
  const { lastEvent } = useConsoleEvents();
  const lastHandledId = useRef<string | null>(null);

  useEffect(() => {
    if (!lastEvent || lastEvent.id === lastHandledId.current) return;
    if (lastEvent.type !== "payment.status_changed") return;

    const paymentIntentId = lastEvent.payment_intent_id;
    const status = lastEvent.status;
    const previousStatus = lastEvent.previous_status;
    if (typeof paymentIntentId !== "string" || typeof status !== "string") return;

    lastHandledId.current = lastEvent.id;
    notifyPaymentStatusChange(paymentIntentId, status, typeof previousStatus === "string" ? previousStatus : undefined);
  }, [lastEvent]);
}
