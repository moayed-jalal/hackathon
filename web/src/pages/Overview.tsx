import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  ArrowRight,
  AlertTriangle,
  ArrowLeftRight,
  ShieldCheck,
} from "lucide-react";
import { consoleApi } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { PageHeader } from "../components/PageHeader";
import { SkeletonCardGrid } from "../components/Skeleton";


const STATUS_META = {
  created: { label: "Created", icon: Clock, color: "text-slate-600" },
  processing: { label: "Processing", icon: Loader2, color: "text-amber-600" },
  succeeded: { label: "Succeeded", icon: CheckCircle2, color: "text-emerald-600" },
  failed: { label: "Failed", icon: XCircle, color: "text-rose-600" },
  cancelled: { label: "Cancelled", icon: Ban, color: "text-slate-500" },
} as const;

const STATUS_ORDER = Object.keys(STATUS_META) as (keyof typeof STATUS_META)[];

interface ConsoleSummary {
  sandbox: boolean;
  workspace_name: string;
  merchant_name: string;
  transaction_counts: Record<string, number>;
  total_transactions: number;
  security_event_count: number;
  latest_smoke_test: unknown;
}

export function Overview() {
  // Fetched once, then re-fetched only when the shared SSE connection
  // reports something that could change these counts — no interval polling.
  const { data: envelope, error, loading } = useConsoleResource<{ data: ConsoleSummary }>(
    () => consoleApi.get("/api/v1/console/summary"),
    ["payment.status_changed", "audit.event_created"],
  );
  const data = envelope?.data;

  return (
    <div className="space-y-8">
      <PageHeader
        icon={LayoutDashboard}
        title="Sandbox Overview"
        subtitle={
          data
            ? `Signed in as ${data.workspace_name} (${data.merchant_name}). All data below is synthetic sandbox activity — no real financial systems are involved.`
            : "Loading synthetic sandbox activity…"
        }
      />

      {error && <ApiKeyHint error={error} />}

      {loading && !data && !error && <SkeletonCardGrid />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {STATUS_ORDER.map((status) => {
              const meta = STATUS_META[status];
              return (
                <div key={status} className="fb-card p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{meta.label}</div>
                    <meta.icon className={`h-3.5 w-3.5 ${meta.color}`} />
                  </div>
                  <div className={`mt-2 text-3xl font-bold ${meta.color}`}>
                    {data.transaction_counts[status] ?? 0}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <StatCard
              icon={ArrowLeftRight}
              label="Total Transactions"
              value={data.total_transactions}
              to="/console/transactions"
              cta="View transactions"
            />
            <StatCard
              icon={ShieldCheck}
              label="Security Events"
              value={data.security_event_count}
              to="/console/security"
              cta="View security feed"
            />
          </div>

          <div className="fb-card p-5">
            <h2 className="text-sm font-bold text-slate-900">The interoperability story</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Every transaction above was created through the exact same canonical FinBridge API —{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">POST /api/v1/payment-intents</code>. Behind
              that one API, <strong>SimProviderA</strong> answers synchronously with its own "success / declined"
              vocabulary, while <strong>SimProviderB</strong> answers "processing" immediately and settles later
              through a signed, asynchronous webhook using its own "accepted / pending / settled / rejected"
              vocabulary. FinBridge normalizes both into the same canonical status field so merchants never write
              provider-specific code.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  to,
  cta,
}: {
  icon: typeof ArrowLeftRight;
  label: string;
  value: ReactNode;
  to: string;
  cta: string;
}) {
  return (
    <div className="fb-card p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Icon className="h-3.5 w-3.5" />
        </div>
      </div>
      <div className="mt-2 text-3xl font-bold text-slate-900">{value}</div>
      <Link to={to} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-600 hover:underline">
        {cta} <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

function ApiKeyHint({ error }: { error: string }) {
  return (
    <div className="fb-card border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
      <div className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4" />
        Couldn't load sandbox data.
      </div>
      <p className="mt-1">{error}</p>
      <p className="mt-2">
        Make sure you are signed in with Google and have a valid session.
      </p>
    </div>
  );
}