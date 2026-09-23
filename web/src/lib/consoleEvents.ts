import { BASE_URL } from "../api/client";

/**
 * One shared SSE connection for the whole Console session (ref-counted —
 * see acquireConsoleEventsConnection), instead of one per component/page.
 * Mirrors the same module-level external-store pattern as lib/toast.ts.
 * Established once when the Console shell mounts (ConsoleLayout) and kept
 * open for as long as any Console page is on screen — every page's data
 * refresh rides this single connection instead of its own poll.
 */
export type ConsoleEventType =
  | "payment.status_changed"
  | "webhook.delivery_recorded"
  | "audit.event_created"
  | "smoke_test.completed";

export interface ConsoleEvent {
  id: string;
  type: ConsoleEventType;
  created_at: string;
  [key: string]: unknown;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

interface Snapshot {
  status: ConnectionStatus;
  lastEvent: ConsoleEvent | null;
}

let es: EventSource | null = null;
let refCount = 0;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let snapshot: Snapshot = { status: "closed", lastEvent: null };
const listeners = new Set<() => void>();

const EVENT_TYPES: ConsoleEventType[] = [
  "payment.status_changed",
  "webhook.delivery_recorded",
  "audit.event_created",
  "smoke_test.completed",
];

function emit() {
  for (const listener of listeners) listener();
}

function setStatus(status: ConnectionStatus) {
  if (snapshot.status === status) return;
  snapshot = { ...snapshot, status };
  emit();
}

function setLastEvent(event: ConsoleEvent) {
  snapshot = { ...snapshot, lastEvent: event };
  emit();
}

function connect() {
  if (es) return;
  setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");

  const source = new EventSource(`${BASE_URL}/api/v1/console/events`, { withCredentials: true });
  es = source;

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (raw) => {
      const messageEvent = raw as MessageEvent<string>;
      try {
        setLastEvent(JSON.parse(messageEvent.data) as ConsoleEvent);
      } catch {
        // Malformed frame — ignore it rather than crash the connection.
      }
    });
  }

  // Server-sent ack, not the browser's own "open" (which only means the
  // HTTP handshake completed) — "connected" confirms the server has
  // actually subscribed this connection, so no event published from here
  // on can be missed.
  source.addEventListener("connected", () => {
    reconnectAttempt = 0;
    setStatus("open");
  });

  source.onopen = () => {
    reconnectAttempt = 0;
  };

  source.onerror = () => {
    source.close();
    if (es === source) es = null;
    setStatus("reconnecting");
    reconnectAttempt += 1;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (refCount > 0) connect();
    }, delay);
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  es?.close();
  es = null;
  reconnectAttempt = 0;
  setStatus("closed");
}

/** Call once per component that needs the connection kept open; call the returned cleanup on unmount. */
export function acquireConsoleEventsConnection(): () => void {
  refCount += 1;
  if (refCount === 1) connect();
  return () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) disconnect();
  };
}

export function subscribeConsoleEventsStore(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getConsoleEventsSnapshot(): Snapshot {
  return snapshot;
}
