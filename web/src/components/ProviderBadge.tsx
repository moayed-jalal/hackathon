import { Zap, Webhook } from "lucide-react";

const META = {
  sim_provider_a: { label: "SimProviderA", icon: Zap, classes: "bg-brand-50 text-brand-700" },
  sim_provider_b: { label: "SimProviderB", icon: Webhook, classes: "bg-amber-50 text-amber-700" },
} as const;

export function ProviderBadge({ provider }: { provider: string }) {
  const meta = META[provider as keyof typeof META];
  if (!meta) {
    return <span className="fb-badge bg-slate-100 text-slate-600">{provider}</span>;
  }
  return (
    <span className={`fb-badge ${meta.classes}`}>
      <meta.icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}
