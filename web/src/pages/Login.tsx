import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  google_denied: "Google sign-in was cancelled or denied.",
  missing_params: "The sign-in link was incomplete. Please try again.",
  invalid_state: "That sign-in link expired or was already used. Please try again.",
  token_exchange_failed: "Couldn't complete sign-in with Google. Please try again.",
  userinfo_fetch_failed: "Couldn't fetch your Google account details. Please try again.",
  email_not_verified: "That Google account's email address isn't verified.",
};

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") ?? "/console";
  const loginError = searchParams.get("error");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    setLoading(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/auth/me`, {
        credentials: "include",
      });
      const json = await response.json();
      const data = json.data ?? json;
      if (data.authenticated) {
        navigate(redirect, { replace: true });
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }

  function handleGoogleLogin() {
    window.location.href = `${import.meta.env.VITE_API_BASE_URL ?? ""}/auth/google`;
  }

  async function handleDevLogin() {
    setLoading(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/auth/dev-login`, {
        method: "POST",
        credentials: "include",
      });
      if (response.ok) {
        navigate(redirect, { replace: true });
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-10 w-10 border-3 border-brand-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-900">FinBridge</h1>
          <p className="mt-2 text-slate-500">Secure FinTech Interoperability Sandbox</p>
        </div>

        {loginError && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {LOGIN_ERROR_MESSAGES[loginError] ?? "Sign-in failed. Please try again."}
          </div>
        )}

        <div className="bg-white rounded-xl border border-slate-200 p-8 shadow-sm">
          <div className="space-y-4">
            <button
              onClick={handleGoogleLogin}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 rounded-lg bg-white px-4 py-3 text-sm font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-colors"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </button>

            <button
              onClick={handleDevLogin}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-3 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors"
            >
              Continue as Sandbox Judge
            </button>

            <p className="text-center text-xs text-slate-400">
              Sandbox environment • No real money • No Google account required for judging
            </p>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          By continuing, you agree to FinBridge's Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}