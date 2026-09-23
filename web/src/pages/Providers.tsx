import { Boxes, Zap, Webhook, CheckCircle2 } from "lucide-react";
import { consoleApi } from "../api/client";
import { useConsoleResource } from "../lib/useConsoleResource";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";

const PROVIDER_ICON: Record<string, typeof Zap> = {
  sim_provider_a: Zap,
  sim_provider_b: Webhook,
};

interface ProviderConfiguration {
  name: string;
  displayName: string;
  mode: string;
  description: string;
  enabled: boolean;
}

export function Providers() {
  // Provider configuration is static for this sandbox — fetch once, no polling.
  const { data } = useConsoleResource<{ data: ProviderConfiguration[] }>(
    () => consoleApi.get("/api/v1/console/providers"),
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Boxes}
        title="Providers"
        subtitle="Two simulated providers, one canonical API. Adding a third provider means writing one adapter — the public API and dashboard never change."
      />

      {!data && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="fb-card p-5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="mt-3 h-4 w-full" />
              <Skeleton className="mt-1.5 h-4 w-2/3" />
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data?.data.map((provider) => {
          const Icon = PROVIDER_ICON[provider.name] ?? Boxes;
          return (
            <div key={provider.name} className="fb-card p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <Icon className="h-4 w-4" />
                  </div>
                  <h2 className="text-lg font-bold text-slate-900">{provider.displayName}</h2>
                </div>
                <span className="fb-badge bg-brand-50 text-brand-700">
                  {provider.mode === "sync" ? "Synchronous" : "Asynchronous"}
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-600">{provider.description}</p>
              <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                {provider.name === "sim_provider_a" ? (
                  <>
                    Provider vocabulary: <code className="font-mono">success</code> /{" "}
                    <code className="font-mono">declined</code> → normalized to{" "}
                    <code className="font-mono">succeeded</code> / <code className="font-mono">failed</code>.
                  </>
                ) : (
                  <>
                    Provider vocabulary: <code className="font-mono">accepted</code> →{" "}
                    <code className="font-mono">pending</code> → <code className="font-mono">settled</code> /{" "}
                    <code className="font-mono">rejected</code> (via webhook) → normalized to{" "}
                    <code className="font-mono">processing</code> → <code className="font-mono">succeeded</code> /{" "}
                    <code className="font-mono">failed</code>.
                  </>
                )}
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {provider.enabled ? "Enabled in this sandbox" : "Disabled"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}