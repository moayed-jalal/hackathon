import { FlaskConical, CheckCircle2, XCircle, Terminal } from "lucide-react";
import { api } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import { formatDateTime } from "../lib/format";
import type { SmokeTestResult } from "../api/types";

export function SmokeTests() {
  const { data } = useConsoleResource<{ data: SmokeTestResult | null }>(
    () => api.get("/api/v1/sandbox/smoke-test-results/latest"),
    ["smoke_test.completed"],
  );
  const result = data?.data ?? null;
  const allPassed = result ? result.passed === result.total : false;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FlaskConical}
        title="Smoke Tests"
        subtitle="Real-HTTP conformance run against the live sandbox API — not internal function calls."
      />

      {!result && (
        <div className="fb-card">
          <EmptyState
            icon={Terminal}
            title="No smoke test run recorded yet"
            body="Run pnpm smoke-test from the repository root against the running sandbox API. Results appear here automatically."
            action={
              <code className="rounded-lg bg-slate-900 px-3 py-1.5 font-mono text-xs text-slate-100">
                pnpm smoke-test
              </code>
            }
          />
        </div>
      )}

      {result && (
        <div className="fb-card p-6">
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-4">
              <div
                className={`flex h-14 w-14 items-center justify-center rounded-full ${
                  allPassed ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
                }`}
              >
                {allPassed ? <CheckCircle2 className="h-7 w-7" /> : <XCircle className="h-7 w-7" />}
              </div>
              <div>
                <div className="text-3xl font-bold text-slate-900">
                  {result.passed} / {result.total}{" "}
                  <span className={allPassed ? "text-emerald-600" : "text-rose-600"}>
                    {allPassed ? "PASSED" : "FAILED"}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-400">Last run {formatDateTime(result.ranAt)}</div>
              </div>
            </div>
            <code className="rounded-lg bg-slate-900 px-3 py-1.5 font-mono text-xs text-slate-100">
              pnpm smoke-test
            </code>
          </div>
          <ul className="mt-6 divide-y divide-slate-100 border-t border-slate-100">
            {result.results.map((r) => (
              <li key={r.name} className="flex items-center gap-2.5 py-2.5 text-sm">
                {r.passed ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0 text-rose-600" />
                )}
                <span className={r.passed ? "text-slate-700" : "font-semibold text-rose-700"}>{r.name}</span>
                {r.detail && <span className="text-xs text-slate-400">— {r.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
