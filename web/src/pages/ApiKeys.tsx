import { useState } from "react";
import { KeyRound, Plus, Trash2, CheckCircle2 } from "lucide-react";
import { consoleApi, ApiError } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { CopyButton } from "../components/CopyButton";
import { formatDateTime, timeAgo } from "../lib/format";
import { showToast } from "../lib/toast";
import { useConsoleConfirm } from "../lib/useConsoleConfirm";

interface ApiKeySummary {
  id: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function ApiKeys() {
  const { data, refetch } = useConsoleResource<{ data: ApiKeySummary[] }>(
    () => consoleApi.get("/api/v1/console/api-keys"),
    [],
  );
  const keys = data?.data ?? [];
  const { confirmAndRun } = useConsoleConfirm();

  const [creating, setCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function handleCreate() {
    setCreating(true);
    setRevealedKey(null);
    try {
      const res = await consoleApi.post<{ data: { api_key: string } }>("/api/v1/console/api-keys");
      setRevealedKey(res.data.api_key);
      showToast("New API key created — copy it now, it won't be shown again.", "success");
      refetch();
    } catch (err) {
      showToast(err instanceof ApiError ? `Couldn't create key: ${err.message}` : "Couldn't create key", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevokingId(id);
    try {
      await consoleApi.del(`/api/v1/console/api-keys/${id}`);
      showToast("API key revoked.", "info");
      refetch();
    } catch (err) {
      showToast(err instanceof ApiError ? `Couldn't revoke key: ${err.message}` : "Couldn't revoke key", "error");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={KeyRound}
        title="API Keys"
        subtitle="Authenticate an external application's requests to FinBridge. The full secret is shown exactly once, at creation."
      />

      <div className="fb-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900">Your Keys</h2>
          <button
            className="fb-btn-primary"
            disabled={creating}
            onClick={() =>
              confirmAndRun(
                { asking: "Create a new API key?", target: "api-keys", running: "POST /api/v1/console/api-keys" },
                handleCreate,
              )
            }
          >
            <Plus className="h-4 w-4" /> {creating ? "Creating…" : "Create New Key"}
          </button>
        </div>

        {revealedKey && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="flex items-center gap-1.5 text-xs font-bold text-amber-800">
              <CheckCircle2 className="h-3.5 w-3.5" /> Copy this now — it won't be shown again.
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-slate-900 px-2 py-1.5 font-mono text-xs text-slate-100">{revealedKey}</code>
              <CopyButton value={revealedKey} label="API key" />
            </div>
          </div>
        )}

        <div className="mt-4">
          {keys.length === 0 ? (
            <EmptyState icon={KeyRound} title="No API keys yet" body="Create one to authenticate requests from an external application." />
          ) : (
            <>
              <div className="space-y-3 sm:hidden">
                {keys.map((key) => (
                  <div key={key.id} className="rounded-lg border border-slate-100 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <code className="font-mono text-xs text-slate-700">{key.prefix}…</code>
                      <span className={`fb-badge ${key.revoked_at ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-800"}`}>
                        {key.revoked_at ? "Revoked" : "Active"}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <span key={scope} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                          {scope}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                      <span title={formatDateTime(key.created_at)}>Created {timeAgo(key.created_at)}</span>
                      <span>{key.last_used_at ? `Used ${timeAgo(key.last_used_at)}` : "Never used"}</span>
                    </div>
                    {!key.revoked_at && (
                      <button
                        className="fb-btn-secondary mt-3 w-full !py-1.5 text-xs"
                        disabled={revokingId === key.id}
                        onClick={() =>
                          confirmAndRun(
                            {
                              asking: "Revoke this API key? Any external application using it will start failing authentication immediately.",
                              target: `api-keys/${key.id}`,
                              running: `DELETE /api/v1/console/api-keys/${key.id}`,
                            },
                            () => handleRevoke(key.id),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Key</th>
                      <th className="px-4 py-3 font-semibold">Scopes</th>
                      <th className="px-4 py-3 font-semibold">Created</th>
                      <th className="px-4 py-3 font-semibold">Last used</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {keys.map((key) => (
                      <tr key={key.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <code className="font-mono text-xs text-slate-700">{key.prefix}…</code>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex max-w-xs flex-wrap gap-1">
                            {key.scopes.map((scope) => (
                              <span key={scope} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                                {scope}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-500" title={formatDateTime(key.created_at)}>
                          {timeAgo(key.created_at)}
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          {key.last_used_at ? timeAgo(key.last_used_at) : "Never"}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`fb-badge ${key.revoked_at ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-800"}`}>
                            {key.revoked_at ? "Revoked" : "Active"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!key.revoked_at && (
                            <button
                              className="fb-btn-secondary !px-2 !py-1 text-xs"
                              disabled={revokingId === key.id}
                              onClick={() =>
                                confirmAndRun(
                                  {
                                    asking: "Revoke this API key? Any external application using it will start failing authentication immediately.",
                                    target: `api-keys/${key.id}`,
                                    running: `DELETE /api/v1/console/api-keys/${key.id}`,
                                  },
                                  () => handleRevoke(key.id),
                                )
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" /> Revoke
                            </button>
                          )}
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
    </div>
  );
}
