import { ShieldAlert } from "lucide-react";

export interface ConsoleConfirmDetails {
  /** What the user is being asked to do. */
  asking: string;
  /** What this action targets (endpoint, resource id, etc). */
  target: string;
  /** What will actually run once confirmed. */
  running: string;
}

interface ConsoleConfirmDialogProps extends ConsoleConfirmDetails {
  isRunning: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Reusable div-based confirmation popout for Console operations. */
export function ConsoleConfirmDialog({
  asking,
  isRunning,
  onConfirm,
  onCancel,
}: ConsoleConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="console-confirm-title"
    >
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <h2 id="console-confirm-title" className="text-sm font-bold text-slate-900">
            Confirm action
          </h2>
        </div>

        <p className="mt-4 text-sm text-slate-700">{asking}</p>

        <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button type="button" className="fb-btn-secondary" disabled={isRunning} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="fb-btn-primary" disabled={isRunning} onClick={onConfirm}>
            {isRunning ? "Running…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
