import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  ArrowLeftRight,
  ShieldCheck,
  Boxes,
  Webhook,
  KeyRound,
  FlaskConical,
  ExternalLink,
  ArrowLeft,
  LogOut,
  User,
  ChevronDown,
  Menu,
  X,
} from "lucide-react";
import { useSessionUser } from "../lib/auth";
import { ToastContainer } from "./ToastContainer";
import { ConsoleConfirmProvider, useConsoleConfirm } from "../lib/useConsoleConfirm";
import { usePaymentStatusNotifications } from "../lib/usePaymentStatusNotifications";

const NAV_ITEMS = [
  { to: "/console", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/console/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/console/security", label: "Security", icon: ShieldCheck },
  { to: "/console/providers", label: "Providers", icon: Boxes },
  { to: "/console/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/console/api-keys", label: "API Keys", icon: KeyRound },
  { to: "/console/smoke-tests", label: "Smoke Tests", icon: FlaskConical },
];

async function logout() {
  try {
    await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
  }
  window.location.href = "/";
}

function UserMenu({ user }: { user: ReturnType<typeof useSessionUser> }) {
  const [open, setOpen] = useState(false);
  const { confirmAndRun } = useConsoleConfirm();

  if (!user) return null;

  function confirmLogout() {
    setOpen(false);
    confirmAndRun(
      { asking: "Log out of the console?", target: "session", running: "POST /auth/logout" },
      logout,
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100 transition-colors"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-brand-700">
            <User className="h-4 w-4" />
          </div>
        )}
        <div className="hidden text-left sm:block">
          <div className="text-sm font-medium text-slate-900">{user.name}</div>
          <div className="text-[11px] text-slate-400">{user.workspaceName}</div>
        </div>
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-56 origin-top-right rounded-lg border border-slate-200 bg-white py-1.5 shadow-lg">
            <div className="px-3 py-2 border-b border-slate-100">
              <div className="text-sm font-medium text-slate-900">{user.name}</div>
              <div className="text-xs text-slate-400">{user.email}</div>
            </div>
            <div className="px-3 py-2 border-b border-slate-100">
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">Workspace</div>
              <div className="text-sm text-slate-700">{user.workspaceName}</div>
            </div>
            <button
              onClick={confirmLogout}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function UserSection({ user }: { user: ReturnType<typeof useSessionUser> }) {
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">Workspace</div>
            <div className="text-sm text-slate-700">{user.workspaceName}</div>
          </div>
        </>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left hover:bg-slate-50"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-brand-700">
            <User className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-900">{user.name}</div>
          <div className="truncate text-xs text-slate-400">{user.email}</div>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
    </div>
  );
}

function ConsoleShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const user = useSessionUser();
  const { confirmAndRun } = useConsoleConfirm();
  usePaymentStatusNotifications();

  function confirmLogout() {
    setMobileNavOpen(false);
    confirmAndRun(
      { asking: "Log out of the console?", target: "session", running: "POST /auth/logout" },
      logout,
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex min-h-screen">
        <aside className="fixed bottom-0 left-0 top-0 z-20 hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white px-4 py-6 md:flex">
          <Link to="/" className="mb-8 flex items-center gap-2.5 px-2">
            <div>
              <div className="text-sm font-bold leading-tight text-slate-900">FinBridge</div>
              <div className="text-[10px] font-medium leading-tight text-slate-400">Console</div>
            </div>
          </Link>

          <nav className="flex flex-1 flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="space-y-4 border-t border-slate-200 pt-4">
            <a
              href="http://localhost:4000/docs"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-2 text-xs font-semibold text-slate-500 hover:text-brand-600"
            >
              API Reference <ExternalLink className="h-3 w-3" />
            </a>
            <Link to="/" className="flex items-center gap-1.5 px-2 text-xs font-semibold text-slate-500 hover:text-brand-600">
              <ArrowLeft className="h-3 w-3" /> Back to site
            </Link>
          </div>
        </aside>

        <div className="min-w-0 flex-1 md:ml-64">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:justify-end">
            <div className="flex items-center gap-2 md:hidden">
              <Link to="/" className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-900">FinBridge</span>
              </Link>
            </div>
            <div className="flex items-center gap-4">
              <button
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="hidden md:block">
                <UserMenu user={user} />
              </div>
            </div>
          </header>

          <div
            className={`fixed inset-0 z-30 bg-black/30 transition-opacity md:hidden ${
              mobileNavOpen ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            className={`fixed inset-y-0 right-0 z-40 flex w-72 max-w-[80%] flex-col bg-white shadow-xl transition-transform duration-200 md:hidden ${
              mobileNavOpen ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <span className="text-sm font-bold text-slate-900">Menu</span>
              <button
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMobileNavOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${
                      isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100"
                    }`
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="border-t border-slate-200 px-3 py-3">
              <UserSection user={user} />
            </div>
            <div className="border-t border-slate-200 px-3 py-3">
              <button
                onClick={confirmLogout}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </button>
            </div>
          </div>

          <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-10">
            <Outlet />
          </main>
        </div>
      </div>
      <ToastContainer />
    </div>
  );
}

export function ConsoleLayout() {
  return (
    <ConsoleConfirmProvider>
      <ConsoleShell />
    </ConsoleConfirmProvider>
  );
}