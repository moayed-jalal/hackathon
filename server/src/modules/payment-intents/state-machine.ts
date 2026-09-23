export type PaymentStatus = "created" | "processing" | "succeeded" | "failed" | "cancelled";

/**
 * The single source of truth for valid payment lifecycle transitions.
 * Every status change in the system must go through `assertTransition` —
 * never mutate `payment_intents.status` directly elsewhere.
 */
export const VALID_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  created: ["processing", "succeeded", "failed", "cancelled"],
  // "processing -> cancelled" is a deliberate addition beyond the minimum
  // table: SimProviderA resolves synchronously, so the only realistic window
  // to cancel a SimProviderB payment is while it's awaiting its webhook.
  processing: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`Cannot transition payment from "${from}" to "${to}"`);
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function isTerminal(status: PaymentStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}
