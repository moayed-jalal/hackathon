import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { ConsoleConfirmDialog, type ConsoleConfirmDetails } from "../components/ConsoleConfirmDialog";

interface PendingOperation extends ConsoleConfirmDetails {
  run: () => Promise<void> | void;
}

interface ConsoleConfirmContextValue {
  /** Central trigger: every Console operation routes its call through this. */
  confirmAndRun: (details: ConsoleConfirmDetails, run: () => Promise<void> | void) => void;
}

const ConsoleConfirmContext = createContext<ConsoleConfirmContextValue | null>(null);

/** Mounted once (in ConsoleLayout) so every page shares the same popout instance. */
export function ConsoleConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  // Guards against duplicate triggers while a dialog is open or an
  // operation is in flight — a second confirmAndRun call is dropped.
  const busyRef = useRef(false);

  const confirmAndRun = useCallback((details: ConsoleConfirmDetails, run: () => Promise<void> | void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending({ ...details, run });
  }, []);

  function close() {
    busyRef.current = false;
    setPending(null);
    setIsRunning(false);
  }

  async function handleConfirm() {
    if (!pending || isRunning) return;
    setIsRunning(true);
    try {
      await pending.run();
    } finally {
      close();
    }
  }

  function handleCancel() {
    if (isRunning) return;
    close();
  }

  return (
    <ConsoleConfirmContext.Provider value={{ confirmAndRun }}>
      {children}
      {pending && (
        <ConsoleConfirmDialog
          asking={pending.asking}
          target={pending.target}
          running={pending.running}
          isRunning={isRunning}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConsoleConfirmContext.Provider>
  );
}

export function useConsoleConfirm(): ConsoleConfirmContextValue {
  const ctx = useContext(ConsoleConfirmContext);
  if (!ctx) throw new Error("useConsoleConfirm must be used within ConsoleConfirmProvider");
  return ctx;
}
