import { useMemo, useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldQuestion, Info, ShieldX } from "lucide-react";
import { consoleApi } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { PageHeader } from "../components/PageHeader";
import { SkeletonRows } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { CopyButton } from "../components/CopyButton";
import { formatDateTime } from "../lib/format";

type Severity = "info" | "warn" | "danger";

interface AuditEvent {
  id: string;
  type: string;
  request_id: string;
  merchant_id: string | null;
  payment_intent_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const SEVERITY: Record<string, Severity> = {
  AUTH_FAILURE: "danger",
  WEBHOOK_REJECTED: "danger",
  WEBHOOK_REPLAY_REJECTED: "danger",
  RATE_LIMIT_TRIGGERED: "warn",
  IDEMPOTENCY_REPLAY: "warn",
  IDEMPOTENCY_CONFLICT: "warn",
  API_KEY_REVOKED: "warn",
};

const SEVERITY_META: Record<Severity, { styles: string; icon: typeof ShieldX; label: string }> = {
  danger: { styles: "bg-rose-100 text-rose-800", icon: ShieldX, label: "Critical" },
  warn: { styles: "bg-amber-100 text-amber-800", icon: ShieldAlert, label: "Warning" },
  info: { styles: "bg-slate-100 text-slate-600", icon: Info, label: "Info" },
};

const FILTERS: { label: string; value: Severity | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Critical", value: "danger" },
  { label: "Warning", value: "warn" },
  { label: "Info", value: "info" },
];

export function Security() {
  const [filter, setFilter] = useState<Severity | "all">("all");
  const { data, loading } = useConsoleResource<{ data: AuditEvent[] }>(
    () => consoleApi.get("/api/v1/console/audit-events"),
    ["audit.event_created"],
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.data;
    return data.data.filter((event) => (SEVERITY[event.type] ?? "info") === filter);
  }, [data, filter]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShieldCheck}
        title="Security & Events"
        subtitle="Every authentication failure, webhook rejection, replay attempt, idempotency conflict, and rate-limit trigger is recorded here with a request id for correlation."
      />

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              filter === f.value
                ? "bg-ink text-white"
                : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && !data && <SkeletonRows count={8} />}

      {data && filtered.length === 0 && (
        <div className="fb-card">
          <EmptyState
            icon={ShieldQuestion}
            title={filter === "all" ? "No events yet" : `No ${filter} events`}
            body="Security events appear here the moment something worth watching happens — a rejected webhook, a replay attempt, a rate limit trigger."
          />
        </div>
      )}

      {data && filtered.length > 0 && (
        <>
          <div className="space-y-3 sm:hidden">
            {filtered.map((event) => {
              const severity = SEVERITY[event.type] ?? "info";
              const meta = SEVERITY_META[severity];
              return (
                <div key={event.id} className="fb-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`fb-badge ${meta.styles}`}>{event.type}</span>
                    <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${meta.styles}`}>
                      <meta.icon className="h-3.5 w-3.5" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-0.5 font-mono text-[11px] text-slate-400">
                    <span className="min-w-0 truncate">{event.request_id}</span>
                    <CopyButton value={event.request_id} label="request id" />
                  </div>
                  {Object.keys(event.metadata).length > 0 && (
                    <pre className="mt-1.5 overflow-x-auto text-[11px] text-slate-500">
                      {JSON.stringify(event.metadata)}
                    </pre>
                  )}
                  <div className="mt-2 text-xs text-slate-400">{formatDateTime(event.created_at)}</div>
                </div>
              );
            })}
          </div>

          <div className="hidden fb-card divide-y divide-slate-100 sm:block">
            {filtered.map((event) => {
              const severity = SEVERITY[event.type] ?? "info";
              const meta = SEVERITY_META[severity];
              return (
                <div key={event.id} className="flex items-start justify-between gap-4 px-5 py-3.5">
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${meta.styles}`}>
                      <meta.icon className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`fb-badge ${meta.styles}`}>{event.type}</span>
                        <span className="flex items-center gap-0.5 font-mono text-[11px] text-slate-400">
                          {event.request_id}
                          <CopyButton value={event.request_id} label="request id" />
                        </span>
                      </div>
                      {Object.keys(event.metadata).length > 0 && (
                        <pre className="mt-1.5 max-w-xl overflow-x-auto text-[11px] text-slate-500">
                          {JSON.stringify(event.metadata)}
                        </pre>
                      )}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-xs text-slate-400">{formatDateTime(event.created_at)}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}