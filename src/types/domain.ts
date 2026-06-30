export type CallStatus =
  | "triaging"
  | "deposit_sent"
  | "paid"
  | "booked"
  | "complete";

export type CallState = {
  callId: string;
  callerPhone: string;
  customerName?: string;
  address?: string;
  problem?: string;
  vulnerablePerson?: boolean;
  preferredWindow?: string;
  email?: string;
  depositCheckoutUrl?: string;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  bookingId?: string;
  hermesRunId?: string;
  status: CallStatus;
  transcript: string;
};

export type TriageDecision = {
  callId: string;
  hermesRunId: string;
  vertical: "hvac";
  offer: "emergency_ac_diagnostic";
  urgency: "emergency" | "same_day" | "routine";
  reasons: string[];
  depositAmountCents: 4900;
  recommendedWindow: string;
  requiredFieldsMissing: string[];
  customerSummary: {
    name?: string;
    phone?: string;
    address?: string;
    problem: string;
    vulnerablePerson: boolean;
  };
  nextAction: "ask_followup" | "send_deposit" | "escalate_human";
  model: string;
};

export type LedgerEvent = {
  index: number;
  ts: string;
  callId: string;
  type: string;
  amount?: number;
  currency?: "usd";
  stripe_id?: string;
  policy_decision?: "allow" | "deny" | "none";
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

export type LedgerVerification = {
  valid: boolean;
  eventCount: number;
  firstHash?: string;
  lastHash?: string;
  errors: string[];
};

export type PolicyDecision = {
  allowed: boolean;
  status: 200 | 403;
  policyDecision: "allow" | "deny";
  ruleId: string;
  reason?: string;
};

export type SpendRequest = {
  callId: string;
  vendor: string;
  amountCents: number;
  currency: "usd";
  purpose: string;
};
