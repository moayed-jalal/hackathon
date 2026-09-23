import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftRight, PlusCircle, Inbox } from "lucide-react";
import { consoleApi } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { StatusBadge } from "../components/StatusBadge";
import { ProviderBadge } from "../components/ProviderBadge";
import { CopyButton } from "../components/CopyButton";
import { PageHeader } from "../components/PageHeader";
import { Select } from "../components/Select";
import { SkeletonRows } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { formatAmount, timeAgo } from "../lib/format";
import { notifyPaymentCreated } from "../lib/paymentNotifications";
import { useConsoleConfirm } from "../lib/useConsoleConfirm";

const CURRENCIES = ["USD", "EUR"];
const STATUS_FILTERS: { label: string; value: string }[] = [
  { label: "All", value: "all" },
  { label: "Created", value: "created" },
  { label: "Processing", value: "processing" },
  { label: "Succeeded", value: "succeeded" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
];

interface PaymentIntent {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  scenario: string | null;
  provider_reference: string | null;
  failure_reason: string | null;
  reference: string | null;
  metadata: Record<string, unknown>;
  sandbox: boolean;
  created_at: string;
  updated_at: string;
}

function CreatePaymentIntentForm({ onCreated }: { onCreated: () => void }) {
  const [amount, setAmount] = useState("15000");
  const [currency, setCurrency] = useState("USD");
  const [provider, setProvider] = useState<"sim_provider_a" | "sim_provider_b">("sim_provider_a");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const { confirmAndRun } = useConsoleConfirm();

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const headers = { "Idempotency-Key": crypto.randomUUID() };
      const res = await consoleApi.post<{ data: PaymentIntent }>(
        "/api/v1/console/payment-intents",
        { amount: Number(amount), currency, provider },
        headers,
      );
      setResult(`Created ${res.data.id} → ${res.data.status}`);
      notifyPaymentCreated(res.data.status);
      onCreated();
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fb-card p-5">
      <div className="flex items-center gap-2">
        <PlusCircle className="h-4 w-4 text-brand-600" />
        <h2 className="text-sm font-bold text-slate-900">Create a sandbox payment intent</h2>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]">
        <label className="min-w-0 text-xs font-semibold text-slate-500">
          Amount (minor units)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
          />
        </label>
        <label className="min-w-0 text-xs font-semibold text-slate-500">
          Currency
          <Select value={currency} onChange={setCurrency} options={CURRENCIES} className="mt-1" />
        </label>
        <label className="min-w-0 text-xs font-semibold text-slate-500">
          Provider
          <Select
            value={provider}
            onChange={setProvider}
            options={[
              { value: "sim_provider_a", label: "SimProviderA (sync)" },
              { value: "sim_provider_b", label: "SimProviderB (async)" },
            ]}
            className="mt-1"
          />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          className="fb-btn-primary"
          disabled={busy}
          onClick={() =>
            confirmAndRun(
              {
                asking: "Create this sandbox payment intent?",
                target: "payment-intents",
                running: "POST /api/v1/console/payment-intents",
              },
              submit,
            )
          }
        >
          {busy ? "Creating…" : "Create payment intent"}
        </button>
        {result && <span className="text-xs font-mono text-slate-600">{result}</span>}
      </div>
    </div>
  );
}

export function Transactions() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // Fetched once, then re-fetched only when the shared SSE connection
  // reports a payment status change — no interval polling.
  const { data, error, loading, refetch } = useConsoleResource<{ data: PaymentIntent[] }>(
    () => consoleApi.get("/api/v1/console/payment-intents"),
    ["payment.status_changed"],
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    return statusFilter === "all" ? data.data : data.data.filter((pi) => pi.status === statusFilter);
  }, [data, statusFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ArrowLeftRight}
        title="Transactions"
        subtitle="Simulated payment intents created through the canonical API."
      />

      <CreatePaymentIntentForm onCreated={refetch} />

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              statusFilter === f.value
                ? "bg-ink text-white"
                : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && !data && <SkeletonRows />}

      {data && filtered.length === 0 && (
        <div className="fb-card">
          <EmptyState
            icon={Inbox}
            title={statusFilter === "all" ? "No transactions yet" : `No ${statusFilter} transactions`}
            body="Create one above to see the canonical API and lifecycle timeline in action."
          />
        </div>
      )}

      {data && filtered.length > 0 && (
        <>
          <div className="space-y-3 sm:hidden">
            {filtered.map((pi) => (
              <Link key={pi.id} to={`/console/transactions/${pi.id}`} className="fb-card block p-4 active:bg-slate-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-xs font-semibold text-brand-600">{pi.id}</span>
                  <StatusBadge status={pi.status as "created" | "processing" | "succeeded" | "failed" | "cancelled"} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <ProviderBadge provider={pi.provider} />
                  <span className="font-medium text-slate-800">{formatAmount(pi.amount, pi.currency)}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-400">
                  <span className="min-w-0 truncate">{pi.reference ?? "—"}</span>
                  <span className="shrink-0">{timeAgo(pi.created_at)}</span>
                </div>
              </Link>
            ))}
          </div>

          <div className="fb-card hidden overflow-hidden sm:block">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">ID</th>
                    <th className="px-4 py-3 font-semibold">Provider</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((pi) => (
                    <tr key={pi.id} className="group hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Link
                            to={`/console/transactions/${pi.id}`}
                            className="font-mono text-xs font-semibold text-brand-600 hover:underline"
                          >
                            {pi.id}
                          </Link>
                          <span className="opacity-0 transition group-hover:opacity-100">
                            <CopyButton value={pi.id} label="payment intent id" />
                          </span>
                        </div>
                        {pi.reference && <div className="text-[11px] text-slate-400">{pi.reference}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <ProviderBadge provider={pi.provider} />
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-800">{formatAmount(pi.amount, pi.currency)}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={pi.status as "created" | "processing" | "succeeded" | "failed" | "cancelled"} />
                      </td>
                      <td className="px-4 py-3 text-slate-500">{timeAgo(pi.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}