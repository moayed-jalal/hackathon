import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  workspaceId: string;
  workspaceName: string;
  merchantId: string;
  merchantName: string;
}

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const meResponse = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? ""}/auth/me`,
        { credentials: "include" },
      );
      const meJson = await meResponse.json();
      const meData = meJson.data ?? meJson;
      if (meData.authenticated && meData.user) {
        setUser(meData.user);
      } else {
        navigate("/login", { replace: true, state: { from: location } });
      }
    } catch {
      navigate("/login", { replace: true, state: { from: location } });
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

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

export function useSessionUser(): SessionUser | null {
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    async function fetchUser() {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_API_BASE_URL ?? ""}/auth/me`,
          { credentials: "include" },
        );
        const json = await response.json();
        const data = json.data ?? json;
        if (data.authenticated && data.user) {
          setUser(data.user);
        }
      } catch {
      }
    }
    fetchUser();
  }, []);

  return user;
}