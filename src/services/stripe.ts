import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { CallState } from "../types/domain.js";

const CURRENCY = "usd" as const;
const COMMS_SPEND_LIMIT_CENTS = 1000;

type Env = NodeJS.ProcessEnv;

type CheckoutSessionLike = {
  id?: unknown;
  object?: unknown;
  amount_total?: unknown;
  amount_subtotal?: unknown;
  client_reference_id?: unknown;
  currency?: unknown;
  customer_email?: unknown;
  metadata?: unknown;
  payment_intent?: unknown;
  payment_status?: unknown;
  status?: unknown;
  url?: unknown;
};

type StripeClientLike = {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session>;
      retrieve(
        id: string,
        params?: Stripe.Checkout.SessionRetrieveParams,
      ): Promise<Stripe.Checkout.Session>;
    };
  };
  paymentIntents: {
    create(params: Stripe.PaymentIntentCreateParams): Promise<Stripe.PaymentIntent>;
  };
  webhooks?: {
    constructEvent(
      payload: string | Buffer,
      header: string | string[],
      secret: string,
    ): Stripe.Event;
  };
  testHelpers?: {
    issuing?: {
      authorizations?: {
        create(params: Record<string, unknown>): Promise<Stripe.Issuing.Authorization>;
      };
    };
  };
};

export type StripeServiceOptions = {
  env?: Env;
  stripe?: StripeClientLike;
};

export type DepositCheckoutResult = {
  provider: "mock" | "stripe";
  callId: string;
  sessionId: string;
  checkoutUrl: string;
  url: string;
  paymentIntentId?: string;
  payment_intent_id?: string;
  amountCents: number;
  currency: typeof CURRENCY;
  raw: Record<string, unknown>;
};

export type NormalizedPaymentData = {
  provider: "mock" | "stripe";
  callId: string;
  sessionId: string;
  paymentIntentId?: string;
  payment_intent_id?: string;
  amountCents: number;
  currency: typeof CURRENCY;
  paymentStatus?: string;
  status?: string;
  customerEmail?: string;
  raw: Record<string, unknown>;
};

export type SpendAuthorizationResult =
  | {
      allowed: true;
      provider: "mock" | "stripe";
      method: "mock" | "issuing_test_helper" | "payment_intent";
      callId: string;
      stripeId: string;
      authorizationId?: string;
      paymentIntentId?: string;
      payment_intent_id?: string;
      amountCents: number;
      currency: typeof CURRENCY;
      raw: Record<string, unknown>;
    }
  | {
      allowed: false;
      provider: "policy";
      method: "blocked";
      callId: string;
      amountCents: number;
      currency: typeof CURRENCY;
      policyDecision: "deny";
      status: 403;
      reason: string;
      stripeId?: undefined;
      raw: Record<string, unknown>;
    };

export type CheckoutCompletionInput = {
  callId: string;
  sessionId?: string;
  paymentIntentId?: string;
  rawEvent?: unknown;
};

let stripeClientPromise: Promise<StripeClientLike> | undefined;
const mockCheckoutSessions = new Map<string, CheckoutSessionLike>();
const STRIPE_TEST_SECRET_PREFIX = ["sk", "test"].join("_") + "_";

export function isRealStripeTestKey(key: string | undefined): boolean {
  const trimmed = key?.trim();
  return Boolean(trimmed && trimmed.startsWith(STRIPE_TEST_SECRET_PREFIX) && trimmed !== STRIPE_TEST_SECRET_PREFIX);
}

export function shouldUseStripeSdk(env: Env = process.env): boolean {
  return env.USE_MOCKS === "false" && isRealStripeTestKey(env.STRIPE_SECRET_KEY);
}

export async function createDepositCheckout(
  callState: CallState,
  amountCents: number,
  options: StripeServiceOptions = {},
): Promise<DepositCheckoutResult> {
  assertPositiveCents(amountCents, "Deposit amount");

  if (!shouldUseStripe(options)) {
    return createMockDepositCheckout(callState, amountCents, options.env);
  }

  const env = options.env ?? process.env;
  const stripe = await getStripeClient(options);
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? "http://localhost:8788";
  const metadata = {
    callId: callState.callId,
    call_id: callState.callId,
    flow: "missedcall_rescue_deposit",
    amountCents: String(amountCents),
    amount_cents: String(amountCents),
  };

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    client_reference_id: callState.callId,
    customer_email: callState.email,
    line_items: [
      {
        price_data: {
          currency: CURRENCY,
          unit_amount: amountCents,
          product_data: {
            name: "Emergency AC diagnostic deposit",
            description: callState.problem,
            metadata,
          },
        },
        quantity: 1,
      },
    ],
    metadata,
    payment_intent_data: { metadata },
    success_url:
      env.STRIPE_SUCCESS_URL ??
      `${publicBaseUrl}/pay/success?call_id=${encodeURIComponent(callState.callId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:
      env.STRIPE_CANCEL_URL ??
      `${publicBaseUrl}/pay/cancel?call_id=${encodeURIComponent(callState.callId)}`,
  });

  const paymentIntentId = extractStripeId(session.payment_intent);
  return {
    provider: "stripe",
    callId: callState.callId,
    sessionId: session.id,
    checkoutUrl: session.url ?? "",
    url: session.url ?? "",
    paymentIntentId,
    payment_intent_id: paymentIntentId,
    amountCents,
    currency: CURRENCY,
    raw: safeCheckoutSessionPayload(session),
  };
}

export function handleCheckoutCompleted(
  eventOrSession: unknown,
  options: StripeServiceOptions = {},
): NormalizedPaymentData {
  const session = unwrapCheckoutSession(eventOrSession);
  return normalizeCheckoutSession(session, shouldUseStripe(options) ? "stripe" : "mock");
}

export async function normalizeCheckoutCompleted(
  input: CheckoutCompletionInput,
  options: StripeServiceOptions = {},
): Promise<NormalizedPaymentData> {
  if (input.rawEvent) {
    try {
      return handleCheckoutCompleted(input.rawEvent, options);
    } catch {
      // Demo replay payloads often contain ids only. Fall through to those fields.
    }
  }

  if (input.sessionId) {
    try {
      return await replayCheckoutSession(input.sessionId, options);
    } catch {
      // If no local/mock session exists, normalize the explicit replay payload below.
    }
  }

  return normalizeCheckoutSession(
    {
      id: input.sessionId,
      object: "checkout.session",
      client_reference_id: input.callId,
      metadata: { callId: input.callId, call_id: input.callId },
      payment_intent: input.paymentIntentId,
      payment_status: "paid",
      status: "complete",
    },
    shouldUseStripe(options) ? "stripe" : "mock",
  );
}

export async function constructStripeEvent(
  rawBody: unknown,
  signature: string | string[] | undefined,
  webhookSecret?: string,
  options: StripeServiceOptions = {},
): Promise<Stripe.Event | { type: string; data: { object: unknown } }> {
  if (shouldUseStripe(options) && signature && webhookSecret) {
    const stripe = await getStripeClient(options);
    if (!stripe.webhooks?.constructEvent) {
      throw new Error("Stripe webhook construction is unavailable on the configured client.");
    }
    return stripe.webhooks.constructEvent(coerceWebhookPayload(rawBody), signature, webhookSecret);
  }

  const parsed = parseMaybeJson(rawBody);
  const record = asRecord(parsed);
  if (typeof record.type === "string" && asRecord(record.data).object) {
    return record as { type: string; data: { object: unknown } };
  }

  return {
    type: "checkout.session.completed",
    data: { object: record },
  };
}

export async function replayCheckoutSession(
  sessionId: string,
  options: StripeServiceOptions = {},
): Promise<NormalizedPaymentData> {
  if (!shouldUseStripe(options)) {
    const session = mockCheckoutSessions.get(sessionId);
    if (!session) {
      throw new Error(`No mock checkout session found for ${sessionId}`);
    }
    return normalizeCheckoutSession(session, "mock");
  }

  const stripe = await getStripeClient(options);
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent"],
  });
  return normalizeCheckoutSession(session, "stripe");
}

export const handleCheckoutSessionReplay = replayCheckoutSession;

export async function createCommsSpendAuthorization(
  callId: string,
  amountCents: number,
  options: StripeServiceOptions = {},
): Promise<SpendAuthorizationResult> {
  const policy = evaluateCommsSpendPolicy(amountCents);
  if (!policy.allowed) {
    return {
      allowed: false,
      provider: "policy",
      method: "blocked",
      callId,
      amountCents,
      currency: CURRENCY,
      policyDecision: "deny",
      status: 403,
      reason: policy.reason,
      raw: {
        ruleId: "allow-small-comms",
        maxAmountCents: COMMS_SPEND_LIMIT_CENTS,
      },
    };
  }

  if (!shouldUseStripe(options)) {
    const authorizationId = mockStripeId("iauth", callId, amountCents);
    return {
      allowed: true,
      provider: "mock",
      method: "mock",
      callId,
      stripeId: authorizationId,
      authorizationId,
      amountCents,
      currency: CURRENCY,
      raw: {
        id: authorizationId,
        object: "issuing.authorization",
        amount: amountCents,
        approved: true,
        currency: CURRENCY,
        metadata: { callId },
      },
    };
  }

  const env = options.env ?? process.env;
  const stripe = await getStripeClient(options);
  const cardId = env.STRIPE_ISSUING_CARD_ID?.trim();

  if (cardId && stripe.testHelpers?.issuing?.authorizations?.create) {
    const authorization = await stripe.testHelpers.issuing.authorizations.create({
      card: cardId,
      amount: amountCents,
      currency: CURRENCY,
      authorization_method: "online",
      merchant_data: {
        category: "utilities",
        city: "San Francisco",
        country: "US",
        name: "MissedCall Comms Test Vendor",
        postal_code: "94107",
        state: "CA",
        url: "https://example.com/missedcall-rescue",
      },
      metadata: { callId, purpose: "customer_confirmation_sms" },
    });

    return {
      allowed: true,
      provider: "stripe",
      method: "issuing_test_helper",
      callId,
      stripeId: authorization.id,
      authorizationId: authorization.id,
      amountCents,
      currency: CURRENCY,
      raw: safeAuthorizationPayload(authorization),
    };
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: CURRENCY,
    capture_method: "manual",
    payment_method_types: ["card"],
    metadata: {
      callId,
      purpose: "customer_confirmation_sms",
      fallback: "issuing_card_unconfigured",
    },
    description: `MissedCall Rescue comms spend for ${callId}`,
  });

  return {
    allowed: true,
    provider: "stripe",
    method: "payment_intent",
    callId,
    stripeId: paymentIntent.id,
    paymentIntentId: paymentIntent.id,
    payment_intent_id: paymentIntent.id,
    amountCents,
    currency: CURRENCY,
    raw: safePaymentIntentPayload(paymentIntent),
  };
}

function shouldUseStripe(options: StripeServiceOptions): boolean {
  return Boolean(options.stripe) || shouldUseStripeSdk(options.env ?? process.env);
}

async function getStripeClient(options: StripeServiceOptions): Promise<StripeClientLike> {
  if (options.stripe) {
    return options.stripe;
  }

  const env = options.env ?? process.env;
  if (!shouldUseStripeSdk(env)) {
    throw new Error("Stripe SDK is not configured. Set USE_MOCKS=false and provide STRIPE_SECRET_KEY with a Stripe test secret key.");
  }

  if (!stripeClientPromise) {
    stripeClientPromise = import("stripe").then((stripeModule) => {
      return new stripeModule.default(env.STRIPE_SECRET_KEY as string) as unknown as StripeClientLike;
    });
  }

  return await stripeClientPromise;
}

function createMockDepositCheckout(
  callState: CallState,
  amountCents: number,
  env: Env = process.env,
): DepositCheckoutResult {
  const sessionId = mockStripeId("cs", callState.callId, amountCents);
  const paymentIntentId = mockStripeId("pi", callState.callId, amountCents);
  const checkoutUrl = `${env.PUBLIC_BASE_URL ?? "http://localhost:8788"}/mock/stripe/checkout/${sessionId}`;
  const session: CheckoutSessionLike = {
    id: sessionId,
    object: "checkout.session",
    amount_total: amountCents,
    amount_subtotal: amountCents,
    client_reference_id: callState.callId,
    currency: CURRENCY,
    customer_email: callState.email,
	      metadata: {
      callId: callState.callId,
      call_id: callState.callId,
      flow: "missedcall_rescue_deposit",
      amountCents: String(amountCents),
      amount_cents: String(amountCents),
    },
    payment_intent: paymentIntentId,
    payment_status: "paid",
    status: "complete",
    url: checkoutUrl,
  };

  mockCheckoutSessions.set(sessionId, session);

  return {
    provider: "mock",
    callId: callState.callId,
    sessionId,
    checkoutUrl,
    url: checkoutUrl,
    paymentIntentId,
    payment_intent_id: paymentIntentId,
    amountCents,
    currency: CURRENCY,
    raw: safeCheckoutSessionPayload(session),
  };
}

function evaluateCommsSpendPolicy(amountCents: number): { allowed: true } | { allowed: false; reason: string } {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { allowed: false, reason: "Comms spend amount must be a positive integer number of cents." };
  }

  if (amountCents > COMMS_SPEND_LIMIT_CENTS) {
    return {
      allowed: false,
      reason: `Comms spend is capped at ${COMMS_SPEND_LIMIT_CENTS} cents without owner approval.`,
    };
  }

  return { allowed: true };
}

function normalizeCheckoutSession(
  session: CheckoutSessionLike,
  provider: "mock" | "stripe",
): NormalizedPaymentData {
  const metadata = asRecord(session.metadata);
  const callId =
    stringValue(session.client_reference_id) ??
    stringValue(metadata.callId) ??
    stringValue(metadata.call_id);
  if (!callId) {
    throw new Error("Checkout session did not include a callId.");
  }

  const amountCents =
	    numberValue(session.amount_total) ??
	    numberValue(session.amount_subtotal) ??
	    numberValue(metadata.amountCents) ??
	    numberValue(metadata.amount_cents) ??
	    0;
  const paymentIntentId = extractStripeId(session.payment_intent);

  return {
    provider,
    callId,
    sessionId: stringValue(session.id) ?? "",
    paymentIntentId,
    payment_intent_id: paymentIntentId,
    amountCents,
    currency: stringValue(session.currency) === CURRENCY ? CURRENCY : CURRENCY,
    paymentStatus: stringValue(session.payment_status),
    status: stringValue(session.status),
    customerEmail: stringValue(session.customer_email),
    raw: safeCheckoutSessionPayload(session),
  };
}

function unwrapCheckoutSession(input: unknown): CheckoutSessionLike {
  const record = asRecord(input);
  const data = asRecord(record.data);
  const eventObject = data.object;

  if (eventObject && typeof eventObject === "object") {
    return eventObject as CheckoutSessionLike;
  }

  return record as CheckoutSessionLike;
}

function coerceWebhookPayload(rawBody: unknown): string | Buffer {
  if (Buffer.isBuffer(rawBody)) {
    return rawBody;
  }

  if (typeof rawBody === "string") {
    return rawBody;
  }

  return JSON.stringify(rawBody ?? {});
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function safeCheckoutSessionPayload(session: CheckoutSessionLike): Record<string, unknown> {
  return {
    id: stringValue(session.id),
    object: stringValue(session.object),
    amount_total: numberValue(session.amount_total),
    amount_subtotal: numberValue(session.amount_subtotal),
    client_reference_id: stringValue(session.client_reference_id),
    currency: stringValue(session.currency),
    customer_email: stringValue(session.customer_email),
    metadata: safeMetadata(session.metadata),
    payment_intent: extractStripeId(session.payment_intent),
    payment_status: stringValue(session.payment_status),
    status: stringValue(session.status),
    url: stringValue(session.url),
  };
}

function safeAuthorizationPayload(authorization: Stripe.Issuing.Authorization): Record<string, unknown> {
  return {
    id: authorization.id,
    object: authorization.object,
    amount: authorization.amount,
    approved: authorization.approved,
    authorization_method: authorization.authorization_method,
    currency: authorization.currency,
    merchant_data: {
      category: authorization.merchant_data?.category,
      name: authorization.merchant_data?.name,
    },
    metadata: safeMetadata(authorization.metadata),
    status: authorization.status,
  };
}

function safePaymentIntentPayload(paymentIntent: Stripe.PaymentIntent): Record<string, unknown> {
  return {
    id: paymentIntent.id,
    object: paymentIntent.object,
    amount: paymentIntent.amount,
    capture_method: paymentIntent.capture_method,
    currency: paymentIntent.currency,
    metadata: safeMetadata(paymentIntent.metadata),
    status: paymentIntent.status,
  };
}

function safeMetadata(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const safe: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      safe[key] = String(item);
    }
  }
  return safe;
}

function extractStripeId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  return stringValue(record.id);
}

function assertPositiveCents(amountCents: number, label: string): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`${label} must be a positive integer number of cents.`);
  }
}

function mockStripeId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}_test_${safeSlug(String(parts[0] ?? "call"))}_${shortHash(...parts)}`;
}

function shortHash(...parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.slice(0, 24) || "call";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}
