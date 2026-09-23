import { Route, Routes, Navigate } from "react-router-dom";
import { ConsoleLayout } from "./components/ConsoleLayout";
import { Landing } from "./pages/Landing";
import { Overview } from "./pages/Overview";
import { Transactions } from "./pages/Transactions";
import { TransactionDetail } from "./pages/TransactionDetail";
import { Security } from "./pages/Security";
import { Providers } from "./pages/Providers";
import { Webhooks } from "./pages/Webhooks";
import { ApiKeys } from "./pages/ApiKeys";
import { SmokeTests } from "./pages/SmokeTests";
import { NotFound } from "./pages/NotFound";
import { Login } from "./pages/Login";
import { ProtectedRoute } from "./lib/auth";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/console"
        element={
          <ProtectedRoute>
            <ConsoleLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Overview />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="transactions/:id" element={<TransactionDetail />} />
        <Route path="security" element={<Security />} />
        <Route path="providers" element={<Providers />} />
        <Route path="webhooks" element={<Webhooks />} />
        <Route path="api-keys" element={<ApiKeys />} />
        <Route path="smoke-tests" element={<SmokeTests />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}