import { useEffect, useState } from "react";
import {
  Webhook,
  KeyRound,
  RefreshCw,
  Send,
  Trash2,
  CheckCircle2,
  XCircle,
  Link2,
  Terminal,
} from "lucide-react";
import { consoleApi, ApiError } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { CopyButton } from "../components/CopyButton";
import { formatDateTime, timeAgo } from "../lib/format";
import { showToast } from "../lib/toast";
import { useConsoleConfirm } from "../lib/useConsoleConfirm";

interface WebhookConfig {
  url: string | null;
  enabled: boolean;
  configured: boolean;
  secret_preview: string | null;
  events: string[];
}

interface WebhookDelivery {
  id: string;
  payment_intent_id: string | null;
  event_type: string;
  endpoint_url: string;
  attempt_count: number;
  status: "pending" | "delivered" | "failed";
  http_status: number | null;
  last_error: string | null;
  created_at: string;
}

const DELIVERY_STATUS_STYLES: Record<WebhookDelivery["status"], string> = {
  pending: "bg-amber-100 text-amber-800",
  delivered: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
};

function DeliveryStatusBadge({ status }: { status: WebhookDelivery["status"] }) {
  return <span className={`fb-badge ${DELIVERY_STATUS_STYLES[status]}`}>{status}</span>;
}

export function Webhooks() {
  // Config only ever changes through this page's own actions (save/regenerate/
  // remove), which call refetch() directly — no SSE event type for it.
  const { data, refetch } = useConsoleResource<{ data: WebhookConfig }>(
    () => consoleApi.get("/api/v1/console/webhook"),
    [],
  );
  // Deliveries re-fetch only when the shared SSE connection reports a new
  // or updated delivery attempt — no interval polling.
  const { data: deliveriesData, refetch: refetchDeliveries } = useConsoleResource<{ data: WebhookDelivery[] }>(
    () => consoleApi.get("/api/v1/console/webhook/deliveries"),
    ["webhook.delivery_recorded"],
  );

  const config = data?.data;
  const deliveries = deliveriesData?.data ?? [];
  const { confirmAndRun } = useConsoleConfirm();

  const [urlInput, setUrlInput] = useState("");
  const [hasSeededInput, setHasSeededInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; http_status?: number; error?: string } | null>(null);

  useEffect(() => {
    if (config && !hasSeededInput) {
      setUrlInput(config.url ?? "");
      setHasSeededInput(true);
    }
  }, [config, hasSeededInput]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await consoleApi.put<{ data: WebhookConfig & { secret?: string } }>("/api/v1/console/webhook", {
        url: urlInput,
      });
      if (res.data.secret) {
        setRevealedSecret(res.data.secret);
        showToast("Webhook secret created — copy it now, it won't be shown again.", "success");
      } else {
        showToast("Webhook URL saved.", "success");
      }
      refetch();
    } catch (err) {
      showToast(err instanceof ApiError ? `Couldn't save webhook URL: ${err.message}` : "Couldn't save webhook URL", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const res = await consoleApi.post<{ data: WebhookConfig & { secret: string } }>("/api/v1/console/webhook/regenerate-secret");
      setRevealedSecret(res.data.secret);
      showToast("Webhook secret regenerated — copy it now, it won't be shown again.", "success");
      refetch();
    } catch {
      showToast("Couldn't regenerate the webhook secret", "error");
    } finally {
      setRegenerating(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await consoleApi.del("/api/v1/console/webhook");
      setUrlInput("");
      setHasSeededInput(false);
      setRevealedSecret(null);
      setTestResult(null);
      showToast("Webhook configuration removed.", "info");
      refetch();
    } catch {
      showToast("Couldn't remove the webhook configuration", "error");
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await consoleApi.post<{ data: { event_id: string; success: boolean; http_status?: number; error?: string } }>(
        "/api/v1/console/webhook/test",
      );
      setTestResult(res.data);
      showToast(
        res.data.success
          ? "Test webhook delivered successfully."
          : `Test webhook failed${res.data.http_status ? ` (HTTP ${res.data.http_status})` : ""}.`,
        res.data.success ? "success" : "error",
      );
      refetchDeliveries();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Test webhook failed";
      setTestResult({ success: false, error: message });
      showToast(message, "error");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Webhook}
        title="Webhooks"
        subtitle="Configure once, and FinBridge notifies your backend through a single unified event — no matter which provider actually processed the payment."
      />

      <div className="fb-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900">Webhook Configuration</h2>
          {config && (
            <span className={`fb-badge ${config.configured && config.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${config.configured && config.enabled ? "bg-emerald-500" : "bg-slate-400"}`} />
              {config.configured && config.enabled ? "Connected" : "Not configured"}
            </span>
          )}
        </div>

        <label className="mt-4 block text-xs font-semibold text-slate-500">
          Endpoint URL
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://merchant.example.com/api/webhooks/finbridge"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-brand-500 focus:outline-none"
            />
            <button
              className="fb-btn-primary shrink-0"
              disabled={saving || !urlInput}
              onClick={() =>
                confirmAndRun(
                  { asking: "Save this webhook URL?", target: "webhook", running: "PUT /api/v1/console/webhook" },
                  handleSave,
                )
              }
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </label>

        <div className="mt-4">
          <div className="text-xs font-semibold text-slate-500">Webhook Secret</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100">
              {revealedSecret ?? config?.secret_preview ?? "whsec_—"}
            </code>
            {revealedSecret && <CopyButton value={revealedSecret} label="webhook secret" />}
            <button
              className="fb-btn-secondary !px-3 !py-1.5 text-xs"
              disabled={regenerating || !config?.configured}
              onClick={() =>
                confirmAndRun(
                  {
                    asking: "Regenerate the webhook secret? Any endpoint still verifying signatures with the old secret will start rejecting deliveries until it's updated.",
                    target: "webhook/regenerate-secret",
                    running: "POST /api/v1/console/webhook/regenerate-secret",
                  },
                  handleRegenerate,
                )
              }
            >
              <RefreshCw className="h-3.5 w-3.5" /> {regenerating ? "Regenerating…" : "Regenerate"}
            </button>
          </div>
          {revealedSecret ? (
            <p className="mt-1.5 text-xs font-semibold text-amber-700">Copy this now — it won't be shown again.</p>
          ) : (
            <p className="mt-1.5 text-xs text-slate-400">
              Only shown in full at creation or regeneration. FinBridge uses it to sign every delivery to your endpoint.
            </p>
          )}
        </div>

        <div className="mt-4">
          <div className="text-xs font-semibold text-slate-500">Events</div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {(config?.events ?? ["payment.succeeded", "payment.failed", "payment.cancelled"]).map((event) => (
              <span key={event} className="flex items-center gap-1.5 text-sm text-slate-700">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                <code className="font-mono text-xs">{event}</code>
              </span>
            ))}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <button
            className="fb-btn-secondary"
            disabled={testing || !config?.configured}
            onClick={() =>
              confirmAndRun(
                { asking: "Send a test webhook event?", target: "webhook/test", running: "POST /api/v1/console/webhook/test" },
                handleTest,
              )
            }
          >
            <Send className="h-4 w-4" /> {testing ? "Sending…" : "Test Webhook"}
          </button>
          <button
            className="fb-btn-danger"
            disabled={deleting || !config?.configured}
            onClick={() =>
              confirmAndRun(
                {
                  asking: "Remove the webhook configuration? FinBridge will stop sending payment events to this endpoint.",
                  target: "webhook",
                  running: "DELETE /api/v1/console/webhook",
                },
                handleDelete,
              )
            }
          >
            <Trash2 className="h-4 w-4" /> {deleting ? "Removing…" : "Remove"}
          </button>
        </div>

        {testResult && (
          <div
            className={`mt-3 rounded-lg border p-3 text-xs ${
              testResult.success ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"
            }`}
          >
            <div className="flex items-center gap-1.5 font-sans font-bold">
              {testResult.success ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {testResult.success ? "Delivered" : "Failed"}
              {testResult.http_status ? ` — HTTP ${testResult.http_status}` : ""}
            </div>
            {testResult.error && <div className="mt-1 font-mono">{testResult.error}</div>}
          </div>
        )}
      </div>

      <div className="fb-card p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Link2 className="h-4 w-4 text-brand-600" /> Developer Integration
        </h2>
        <p className="mt-1 text-xs text-slate-500">Three credentials, three jobs — this is the whole integration surface.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-slate-50 p-3">
            <div className="text-xs font-bold text-slate-700">API Key</div>
            <p className="mt-1 text-[11px] text-slate-500">Authenticates requests you send to FinBridge.</p>
            <code className="mt-2 block truncate rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-100">
              Authorization: Bearer sk_test_...
            </code>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <div className="text-xs font-bold text-slate-700">Webhook URL</div>
            <p className="mt-1 text-[11px] text-slate-500">Where FinBridge sends payment updates back to you.</p>
            <code className="mt-2 block truncate rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-100">
              {config?.url ?? "https://your-backend/webhooks/finbridge"}
            </code>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <div className="text-xs font-bold text-slate-700 flex items-center gap-1"><KeyRound className="h-3 w-3" /> Webhook Secret</div>
            <p className="mt-1 text-[11px] text-slate-500">Verify a delivery genuinely came from FinBridge.</p>
            <code className="mt-2 block truncate rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-100">
              {config?.secret_preview ?? "whsec_..."}
            </code>
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-slate-50 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-slate-700">
            <Terminal className="h-3.5 w-3.5" /> Verifying a delivery (pseudocode)
          </div>
          <pre className="overflow-x-auto rounded bg-slate-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100">
{`expected = hmac_sha256(secret, timestamp + "." + raw_body)
if not constant_time_equals(expected, header["X-FinBridge-Signature"]):
    reject()`}
          </pre>
        </div>
      </div>

      <div className="fb-card overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-sm font-bold text-slate-900">Recent Deliveries</h2>
        </div>
        {deliveries.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No deliveries yet"
            body="Configure a webhook URL and create a payment (or send a test event) to see delivery attempts here."
          />
        ) : (
          <>
            <div className="mt-3 space-y-3 px-5 pb-5 sm:hidden">
              {deliveries.map((d) => (
                <div key={d.id} className="rounded-lg border border-slate-100 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                      <code className="truncate font-mono text-xs font-semibold text-slate-700">{d.event_type}</code>
                      <CopyButton value={d.id} label="event id" />
                    </div>
                    <DeliveryStatusBadge status={d.status} />
                  </div>
                  {d.last_error && <div className="mt-1 truncate text-[11px] text-rose-500">{d.last_error}</div>}
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>HTTP {d.http_status ?? "—"} · {d.attempt_count} attempt{d.attempt_count === 1 ? "" : "s"}</span>
                    <span title={formatDateTime(d.created_at)}>{timeAgo(d.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Event</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">HTTP</th>
                    <th className="px-4 py-3 font-semibold">Attempts</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {deliveries.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1">
                          <code className="font-mono text-xs font-semibold text-slate-700">{d.event_type}</code>
                          <CopyButton value={d.id} label="event id" />
                        </div>
                        {d.last_error && <div className="mt-0.5 max-w-xs truncate text-[11px] text-rose-500">{d.last_error}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <DeliveryStatusBadge status={d.status} />
                      </td>
                      <td className="px-4 py-3 text-slate-600">{d.http_status ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-600">{d.attempt_count}</td>
                      <td className="px-4 py-3 text-slate-500" title={formatDateTime(d.created_at)}>
                        {timeAgo(d.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
