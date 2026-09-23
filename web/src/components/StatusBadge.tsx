import type { PaymentStatus } from "../api/types";

const STYLES: Record<PaymentStatus, string> = {
  created: "bg-slate-100 text-slate-700",
  processing: "bg-amber-100 text-amber-800",
  succeeded: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  cancelled: "bg-slate-200 text-slate-600",
};

const DOTS: Record<PaymentStatus, string> = {
  created: "bg-slate-500",
  processing: "bg-amber-500",
  succeeded: "bg-emerald-500",
  failed: "bg-rose-500",
  cancelled: "bg-slate-500",
};

export function StatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={`fb-badge ${STYLES[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOTS[status]}`} />
      {status}
    </span>
  );
}
