import { logger } from "../../logger.js";

/**
 * Minimal in-process pub/sub for pushing Console-relevant changes to any
 * open SSE connections. Deliberately tiny: one process, one Map, no
 * external broker — swap this module out for a distributed bus later
 * without touching callers (`publishConsoleEvent`/`subscribeConsoleEvents`
 * is the entire contract). Never touches the database and never throws
 * into its caller — a subscriber failing to receive an event must never
 * affect the payment transition that produced it (see
 * payment-intents/service.ts `applyTransition`).
 */
export type ConsoleEvent =
  | {
      id: string;
      type: "payment.status_changed";
      payment_intent_id: string;
      merchant_id: string;
      status: string;
      previous_status: string;
      created_at: string;
    }
  | {
      id: string;
      type: "webhook.delivery_recorded";
      delivery_id: string;
      merchant_id: string;
      payment_intent_id: string | null;
      status: string;
      created_at: string;
    }
  | {
      id: string;
      type: "audit.event_created";
      merchant_id: string;
      audit_event_type: string;
      created_at: string;
    };

/** Not scoped to a merchant — every connected Console session receives these (e.g. the shared smoke-test suite result). */
export type GlobalConsoleEvent = {
  id: string;
  type: "smoke_test.completed";
  passed: number;
  total: number;
  created_at: string;
};

type Listener = (event: ConsoleEvent) => void;
type GlobalListener = (event: GlobalConsoleEvent) => void;

const subscribersByMerchant = new Map<string, Set<Listener>>();
const globalSubscribers = new Set<GlobalListener>();

/** Scoped to one merchant — a connection only ever subscribes to its own session's merchant. */
export function subscribeConsoleEvents(merchantId: string, listener: Listener): () => void {
  let set = subscribersByMerchant.get(merchantId);
  if (!set) {
    set = new Set();
    subscribersByMerchant.set(merchantId, set);
  }
  set.add(listener);

  return () => {
    const current = subscribersByMerchant.get(merchantId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) subscribersByMerchant.delete(merchantId);
  };
}

/** Every Console connection, regardless of merchant — for events with no single-tenant owner. */
export function subscribeGlobalConsoleEvents(listener: GlobalListener): () => void {
  globalSubscribers.add(listener);
  return () => {
    globalSubscribers.delete(listener);
  };
}

/**
 * Fire-and-forget: delivery to subscribers happens on the next microtask,
 * each wrapped so one bad listener can't affect another, and none of it can
 * ever propagate back to the caller (the just-committed DB transition).
 */
export function publishConsoleEvent(event: ConsoleEvent): void {
  const set = subscribersByMerchant.get(event.merchant_id);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    queueMicrotask(() => {
      try {
        listener(event);
      } catch (err) {
        logger.error("Console event listener failed", {
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}

/** Same delivery guarantees as `publishConsoleEvent`, broadcast to every connected session. */
export function publishGlobalConsoleEvent(event: GlobalConsoleEvent): void {
  for (const listener of globalSubscribers) {
    queueMicrotask(() => {
      try {
        listener(event);
      } catch (err) {
        logger.error("Global console event listener failed", {
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}

/** Test-only: current subscriber count for a merchant, to assert cleanup happened. */
export function _subscriberCount(merchantId: string): number {
  return subscribersByMerchant.get(merchantId)?.size ?? 0;
}
