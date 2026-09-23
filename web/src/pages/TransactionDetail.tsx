import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Receipt,
  Boxes,
  ArrowLeftRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  Circle,
} from "lucide-react";
import { consoleApi, ApiError } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { StatusBadge } from "../components/StatusBadge";
import { ProviderBadge } from "../components/ProviderBadge";
import { CopyButton } from "../components/CopyButton";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { formatAmount, formatDateTime } from "../lib/format";
import { showToast } from "../lib/toast";
import { notifyPaymentStatusChange } from "../lib/paymentNotifications";
import { useConsoleConfirm } from "../lib/useConsoleConfirm";

const TIMELINE_META: Record<string, { label: string; icon: typeof Receipt; classes: string }> = {
  payment_created: { label: "Payment Created", icon: Receipt, classes: "bg-slate-100 text-slate-600" },
  provider_selected: { label: "Provider Selected", icon: Boxes, classes: "bg-slate-100 text-slate-600" },
  provider_responded: { label: "Provider Response", icon: ArrowLeftRight, classes: "bg-slate-100 text-slate-600" },
  status_processing: { label: "Processing", icon: Loader2, classes: "bg-amber-100 text-amber-700" },
  status_succeeded: { label: "Payment Completed", icon: CheckCircle2, classes: "bg-emerald-100 text-emerald-700" },
  status_failed: { label: "Payment Failed", icon: XCircle, classes: "bg-rose-100 text-rose-700" },
  status_cancelled: { label: "Payment Cancelled", icon: Ban, classes: "bg-slate-200 text-slate-600" },
};

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
  events: Array<{
    id: string;
    payment_intent_id: string;
    type: string;
    data: Record<string, unknown>;
    created_at: string;
  }>;
}

function ActionResult({ result }: { result: { label: string; status: number; body: unknown } | null }) {
  if (!result) return null;
  const ok = result.status >= 200 && result.status < 300;
  return (
    <div className={`mt-3 rounded-lg border p-3 text-xs font-mono ${ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"}`}>
      <div className="font-sans font-bold">
        {result.label} → HTTP {result.status}
      </div>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(result.body, null, 2)}</pre>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-3 w-32" />
        <div className="mt-3 flex items-center justify-between">
          <div>
            <Skeleton className="h-6 w-64" />
            <Skeleton className="mt-2 h-3.5 w-48" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="fb-card p-5 md:col-span-2">
          <Skeleton className="h-4 w-32" />
          <div className="mt-4 space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <div className="fb-card p-5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-4 h-3.5 w-full" />
            <Skeleton className="mt-2 h-3.5 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TransactionDetail() {
  const { id = "" } = useParams();
  const { confirmAndRun } = useConsoleConfirm();
  const [actionResult, setActionResult] = useState<{ label: string; status: number; body: unknown } | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetched once per id, then re-fetched only when the shared SSE
  // connection reports a status change for this specific payment intent.
  const { data, error } = useConsoleResource<{ data: PaymentIntent }>(
    () => consoleApi.get(`/api/v1/console/payment-intents/${id}`),
    ["payment.status_changed"],
    [id],
    (event) => event.payment_intent_id === id,
  );

  const previousStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    previousStatus.current = undefined;
  }, [id]);
  useEffect(() => {
    if (!data) return;
    notifyPaymentStatusChange(data.data.id, data.data.status, previousStatus.current);
    previousStatus.current = data.data.status;
  }, [data]);

  async function runAction(label: string, path: string, body?: unknown) {
    setBusy(true);
    try {
      const res = await consoleApi.post(path, body);
      setActionResult({ label, status: 200, body: res });
    } catch (err) {
      if (err instanceof ApiError) {
        setActionResult({ label, status: err.status, body: { error: { code: err.code, message: err.message } } });
        showToast(`${label} failed: ${err.message}`, "error");
      } else {
        setActionResult({ label, status: 0, body: { error: String(err) } });
        showToast(`${label} failed`, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await consoleApi.post(`/api/v1/console/payment-intents/${id}/cancel`);
    } catch (err) {
      if (err instanceof ApiError) {
        setActionResult({ label: "Cancel", status: err.status, body: { error: { code: err.code, message: err.message } } });
      } else {
        setActionResult({ label: "Cancel", status: 0, body: { error: String(err) } });
      }
    } finally {
      setBusy(false);
    }
  }

  if (!data && error) {
    return (
      <div className="space-y-6">
        <Link
          to="/console/transactions"
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to transactions
        </Link>
        <div className="fb-card">
          <EmptyState icon={Receipt} title="Payment intent not found" body={error} />
        </div>
      </div>
    );
  }

  if (!data) return <DetailSkeleton />;
  const pi = data.data;
  const isProviderB = pi.provider === "sim_provider_b";
  const canSimulateWebhook = isProviderB && pi.status === "processing";
  const canReplayOrTamper = isProviderB && (pi.status === "succeeded" || pi.status === "failed");

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/console/transactions"
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to transactions
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="font-mono text-xl font-bold text-slate-900">{pi.id}</h1>
              <CopyButton value={pi.id} label="payment intent id" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <ProviderBadge provider={pi.provider} />
              <span>{formatAmount(pi.amount, pi.currency)}</span>
              <span>· created {formatDateTime(pi.created_at)}</span>
            </div>
          </div>
          <StatusBadge status={pi.status as "created" | "processing" | "succeeded" | "failed" | "cancelled"} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="fb-card p-5 md:col-span-2">
          <h2 className="text-sm font-bold text-slate-900">Lifecycle Timeline</h2>
          <ol className="mt-4 space-y-4">
            {(pi.events ?? []).map((event, i) => {
              const meta = TIMELINE_META[event.type] ?? { label: event.type, icon: Circle, classes: "bg-slate-100 text-slate-500" };
              return (
                <li key={event.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.classes}`}>
                      <meta.icon className="h-3.5 w-3.5" />
                    </span>
                    {i < (pi.events?.length ?? 0) - 1 && <span className="mt-1 h-full w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className="pb-2">
                    <div className="text-sm font-semibold text-slate-800">{meta.label}</div>
                    <div className="text-xs text-slate-400">{formatDateTime(event.created_at)}</div>
                    {Object.keys(event.data).length > 0 && (
                      <pre className="mt-1 max-w-md overflow-x-auto rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
                        {JSON.stringify(event.data)}
                      </pre>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="space-y-4">
          <div className="fb-card p-5">
            <h2 className="text-sm font-bold text-slate-900">Details</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Reference" value={pi.reference ?? "—"} />
              <Row label="Provider reference" value={pi.provider_reference ?? "—"} mono />
              <Row label="Scenario" value={pi.scenario ?? "—"} />
              <Row label="Failure reason" value={pi.failure_reason ?? "—"} />
              <Row label="Sandbox" value={String(pi.sandbox)} />
            </dl>
          </div>

          <div className="fb-card p-5">
            <h2 className="text-sm font-bold text-slate-900">Sandbox Actions</h2>
            <p className="mt-1 text-xs text-slate-500">Demonstrate the security controls live.</p>
            <div className="mt-3 flex flex-col gap-2">
              {(pi.status === "created" || pi.status === "processing") && (
                <button
                  className="fb-btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    confirmAndRun(
                      { asking: "Cancel this payment?", target: `payment-intents/${id}/cancel`, running: `POST /api/v1/console/payment-intents/${id}/cancel` },
                      cancel,
                    )
                  }
                >
                  Cancel payment
                </button>
              )}
              {canSimulateWebhook && (
                <>
                  <button
                    className="fb-btn-primary"
                    disabled={busy}
                    onClick={() =>
                      confirmAndRun(
                        { asking: "Simulate webhook (succeeded)?", target: `payment-intents/${id}/simulate-webhook`, running: `POST /api/v1/console/payment-intents/${id}/simulate-webhook` },
                        () => runAction("Simulate webhook (succeeded)", `/api/v1/console/payment-intents/${id}/simulate-webhook`, { outcome: "succeeded" }),
                      )
                    }
                  >
                    Simulate webhook → succeeded
                  </button>
                  <button
                    className="fb-btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      confirmAndRun(
                        { asking: "Simulate webhook (failed)?", target: `payment-intents/${id}/simulate-webhook`, running: `POST /api/v1/console/payment-intents/${id}/simulate-webhook` },
                        () => runAction("Simulate webhook (failed)", `/api/v1/console/payment-intents/${id}/simulate-webhook`, { outcome: "failed" }),
                      )
                    }
                  >
                    Simulate webhook → failed
                  </button>
                </>
              )}
              {canReplayOrTamper && (
                <>
                  <button
                    className="fb-btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      confirmAndRun(
                        { asking: "Replay last webhook (expect 409)?", target: `payment-intents/${id}/replay-webhook`, running: `POST /api/v1/console/payment-intents/${id}/replay-webhook` },
                        () => runAction("Replay last webhook (expect 409)", `/api/v1/console/payment-intents/${id}/replay-webhook`),
                      )
                    }
                  >
                    Replay last webhook
                  </button>
                  <button
                    className="fb-btn-danger"
                    disabled={busy}
                    onClick={() =>
                      confirmAndRun(
                        { asking: "Send tampered webhook (expect 401)?", target: `payment-intents/${id}/tamper-webhook`, running: `POST /api/v1/console/payment-intents/${id}/tamper-webhook` },
                        () => runAction("Send tampered webhook (expect 401)", `/api/v1/console/payment-intents/${id}/tamper-webhook`),
                      )
                    }
                  >
                    Send tampered webhook
                  </button>
                </>
              )}
              {!canSimulateWebhook && !canReplayOrTamper && pi.status !== "created" && (
                <p className="text-xs text-slate-400">No sandbox actions available for this payment's current state.</p>
              )}
            </div>
            <ActionResult result={actionResult} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs font-semibold text-slate-400">{label}</dt>
      <dd className={`text-right text-sm text-slate-700 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}