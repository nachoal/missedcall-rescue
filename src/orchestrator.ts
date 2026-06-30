import { writeArtifact } from "./artifacts.js";
import { publishDemoEvent } from "./demo-events.js";
import { appendLedger } from "./ledger.js";
import { createBooking, findAvailableSlot } from "./services/cal.js";
import { invokeHermesTool, runHermesTriage } from "./services/hermes.js";
import { sendDepositLink } from "./services/sms.js";
import { createDepositCheckout, normalizeCheckoutCompleted } from "./services/stripe.js";
import { saveCallState, requireCallState } from "./store.js";
import type { CallState, TriageDecision } from "./types/domain.js";

export async function startTracerCall(state: CallState): Promise<{
  state: CallState;
  decision: TriageDecision;
  checkout: Awaited<ReturnType<typeof createDepositCheckout>>;
}> {
  await publishDemoEvent({
    callId: state.callId,
    type: "call.started",
    stage: "voice",
    status: "active",
    title: "Voice call captured",
    summary: state.customerName ? `${state.customerName} reached the after-hours agent.` : "After-hours caller reached the agent.",
    payload: {
      callerPhone: state.callerPhone,
      customerName: state.customerName,
      address: state.address,
      problem: state.problem,
    },
  });
  await saveCallState(state);
  await writeArtifact(state.callId, "state.json", state);
  await appendLedger({
    callId: state.callId,
    type: "call.started",
    policy_decision: "none",
    payload: { callerPhone: state.callerPhone, source: "simulator" }
  });
  await appendLedger({
    callId: state.callId,
    type: "call.transcript.updated",
    policy_decision: "none",
    payload: { transcript: state.transcript }
  });
  await publishDemoEvent({
    callId: state.callId,
    type: "transcript.updated",
    stage: "voice",
    status: "captured",
    title: "Transcript captured",
    summary: `${state.transcript.length} transcript characters`,
    payload: { transcript: state.transcript },
  });
  await writeArtifact(state.callId, "transcript.txt", state.transcript);

  await publishDemoEvent({
    callId: state.callId,
    type: "triage.started",
    stage: "triage",
    status: "running",
    title: "Nemotron triage running",
    summary: "Hermes is emitting a TriageDecision.",
  });
  const decision = await runHermesTriage(state);
  state.hermesRunId = decision.hermesRunId;
  await writeArtifact(state.callId, "triage_decision.json", decision);
  await appendLedger({
    callId: state.callId,
    type: "hermes.triage_decision.emitted",
    policy_decision: "none",
    payload: { hermesRunId: decision.hermesRunId, decision }
  });
  await publishDemoEvent({
    callId: state.callId,
    type: "triage.decision",
    stage: "triage",
    status: decision.urgency,
    title: "TriageDecision emitted",
    summary: `${decision.urgency} · ${decision.nextAction} · $${(decision.depositAmountCents / 100).toFixed(2)} deposit`,
    payload: { decision },
  });

  const checkout = await invokeHermesTool({
    callId: state.callId,
    hermesRunId: decision.hermesRunId,
    skill: "create_deposit_checkout",
    tool: "stripe.createCheckout",
    handler: () => createDepositCheckout(state, decision.depositAmountCents),
  });
  state.depositCheckoutUrl = checkout.url;
  state.stripeSessionId = checkout.sessionId;
  state.stripePaymentIntentId = checkout.paymentIntentId;
  state.status = "deposit_sent";
  await saveCallState(state);
  await writeArtifact(state.callId, "state.json", state);
  await writeArtifact(state.callId, "stripe_deposit.json", checkout);
  await appendLedger({
    callId: state.callId,
    type: "deposit.checkout.created",
    amount: decision.depositAmountCents,
    currency: "usd",
    stripe_id: checkout.sessionId,
    policy_decision: "none",
    payload: checkout
  });
  await publishDemoEvent({
    callId: state.callId,
    type: "deposit.pending",
    stage: "payment",
    status: "pending",
    title: "$49 deposit link created",
    summary: checkout.provider === "stripe" ? "Stripe test Checkout session is ready." : "Mock Checkout session is ready.",
    payload: { checkout },
  });

  const sms = await sendDepositLink(state, checkout.url);
  await writeArtifact(state.callId, "deposit_sms.json", sms);
  await appendLedger({
    callId: state.callId,
    type: "sms.deposit_link.sent",
    policy_decision: "none",
    payload: sms
  });
  await publishDemoEvent({
    callId: state.callId,
    type: "deposit.link_sent",
    stage: "payment",
    status: "sent",
    title: "Deposit link sent",
    summary: "Customer receives the diagnostic deposit link.",
    payload: { sms },
  });

  return { state, decision, checkout };
}

export async function completeDepositAndBook(input: {
  callId: string;
  stripeSessionId?: string;
  paymentIntentId?: string;
  rawEvent?: unknown;
}): Promise<{
  state: CallState;
  payment: Awaited<ReturnType<typeof normalizeCheckoutCompleted>>;
  booking: Awaited<ReturnType<typeof createBooking>>;
}> {
  const state = await requireCallState(input.callId);
  const payment = await normalizeCheckoutCompleted({
    callId: input.callId,
    sessionId: input.stripeSessionId ?? state.stripeSessionId,
    paymentIntentId: input.paymentIntentId ?? state.stripePaymentIntentId,
    rawEvent: input.rawEvent
  });
  state.status = "paid";
  state.stripeSessionId = payment.sessionId;
  state.stripePaymentIntentId = payment.paymentIntentId;
  await saveCallState(state);
  await writeArtifact(state.callId, "state.json", state);
  await writeArtifact(state.callId, "stripe_payment_succeeded.json", payment);
  await appendLedger({
    callId: state.callId,
    type: "deposit.payment_succeeded",
    amount: 4900,
    currency: "usd",
    stripe_id: payment.paymentIntentId ?? payment.sessionId,
    policy_decision: "none",
    payload: payment
  });
  await publishDemoEvent({
    callId: state.callId,
    type: "deposit.paid",
    stage: "payment",
    status: "paid",
    title: "$49 deposit paid",
    summary: `${payment.provider === "stripe" ? "Stripe test" : "Mock"} payment marked paid.`,
    payload: { payment },
  });

  const booking = await invokeHermesTool({
    callId: state.callId,
    hermesRunId: state.hermesRunId,
    skill: "book_calendar",
    tool: "cal.createBooking",
    handler: async () => {
      const slot = await findAvailableSlot();
      return createBooking(state, slot.selectedIsoStart);
    },
  });
  state.status = "booked";
  state.bookingId = booking.bookingId;
  await saveCallState(state);
  await writeArtifact(state.callId, "state.json", state);
  await writeArtifact(state.callId, "cal_booking.json", booking);
  await appendLedger({
    callId: state.callId,
    type: "calendar.booking.created",
    policy_decision: "none",
    payload: booking
  });
  await publishDemoEvent({
    callId: state.callId,
    type: "booking.confirmed",
    stage: "booking",
    status: "confirmed",
    title: "Calendar booking confirmed",
    summary: `${booking.provider === "cal" ? "Cal.com" : "Mock calendar"} booking ${booking.bookingId}`,
    payload: { booking },
  });

  return { state, payment, booking };
}
