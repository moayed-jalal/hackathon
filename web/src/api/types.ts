export type PaymentStatus = "created" | "processing" | "succeeded" | "failed" | "cancelled";

export interface PaymentIntent {
  id: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  provider: "sim_provider_a" | "sim_provider_b";
  scenario: string | null;
  reference: string | null;
  metadata: Record<string, unknown>;
  failure_reason: string | null;
  provider_reference: string | null;
  sandbox: boolean;
  created_at: string;
  updated_at: string;
}

export interface TimelineEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  type: string;
  requestId: string;
  merchantId: string | null;
  paymentIntentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardSummary {
  sandbox: boolean;
  merchant_name: string;
  transaction_counts: Record<PaymentStatus, number>;
  total_transactions: number;
  security_event_count: number;
  latest_smoke_test: SmokeTestResult | null;
}

export interface SmokeTestResult {
  id: string;
  total: number;
  passed: number;
  results: { name: string; passed: boolean; detail?: string }[];
  ranAt: string;
}

export interface ProviderConfiguration {
  name: string;
  displayName: string;
  mode: "sync" | "async";
  description: string;
  enabled: boolean;
}
