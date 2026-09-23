import { useEffect, useSyncExternalStore } from "react";
import {
  acquireConsoleEventsConnection,
  getConsoleEventsSnapshot,
  subscribeConsoleEventsStore,
  type ConnectionStatus,
  type ConsoleEvent,
} from "./consoleEvents";

/**
 * Subscribes this component to the one shared Console SSE connection.
 * Multiple components/pages calling this simultaneously still share a
 * single underlying EventSource (ref-counted) — it's only closed once
 * every subscriber has unmounted.
 */
export function useConsoleEvents(): { status: ConnectionStatus; lastEvent: ConsoleEvent | null } {
  useEffect(() => acquireConsoleEventsConnection(), []);
  return useSyncExternalStore(subscribeConsoleEventsStore, getConsoleEventsSnapshot, getConsoleEventsSnapshot);
}
