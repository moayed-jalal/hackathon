import { useCallback, useEffect, useRef, useState } from "react";
import { useConsoleEvents } from "./useConsoleEvents";
import type { ConsoleEvent, ConsoleEventType } from "./consoleEvents";

interface ResourceState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Fetches `fetcher` once, then re-fetches only when a relevant event arrives
 * on the shared Console SSE connection (see lib/consoleEvents.ts) — no
 * interval, no background polling. `eventTypes` picks which event types this
 * resource cares about; `shouldRefetch` narrows further (e.g. only the event
 * for this one payment intent's id).
 */
export function useConsoleResource<T>(
  fetcher: () => Promise<T>,
  eventTypes: ConsoleEventType[],
  deps: unknown[] = [],
  shouldRefetch: (event: ConsoleEvent) => boolean = () => true,
): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const shouldRefetchRef = useRef(shouldRefetch);
  shouldRefetchRef.current = shouldRefetch;

  const load = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  const { lastEvent } = useConsoleEvents();
  const lastHandledId = useRef<string | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent.id === lastHandledId.current) return;
    if (!eventTypes.includes(lastEvent.type)) return;
    if (!shouldRefetchRef.current(lastEvent)) return;
    lastHandledId.current = lastEvent.id;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent, load]);

  return { data, error, loading, refetch: load };
}
