import { useSyncExternalStore } from "react";
import { CheckCircle2, XCircle, Info } from "lucide-react";
import { subscribeToasts, getToastsSnapshot, type ToastVariant } from "../lib/toast";

const ICONS: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: XCircle,
};

const STYLES: Record<ToastVariant, string> = {
  info: "border-slate-200 bg-white text-slate-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  error: "border-rose-200 bg-rose-50 text-rose-900",
};

export function ToastContainer() {
  const toasts = useSyncExternalStore(subscribeToasts, getToastsSnapshot);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <div
            key={t.id}
            className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg ${STYLES[t.variant]}`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}
