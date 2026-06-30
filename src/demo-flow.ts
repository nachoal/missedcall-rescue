import { writeArtifact } from "./artifacts.js";
import { publishDemoEvent, publishLedgerVerification } from "./demo-events.js";
import { appendLedger, readLedger, verifyLedger } from "./ledger.js";
import { authorizeSpend } from "./policy.js";
import { renderProofHtml } from "./proof.js";
import { invokeHermesTool } from "./services/hermes.js";
import { createCommsSpendAuthorization } from "./services/stripe.js";
import { getCallState, saveCallState } from "./store.js";

export type PostBookingDemoResult = {
  callId: string;
  proofPath: string;
  proofUrl: string;
  ledgerValid: boolean;
  ledgerCount: number;
  allowedSpendStripeId?: string;
  blockedStatus: number;
};

export async function runPostBookingDemoLoop(callId: string): Promise<PostBookingDemoResult> {
  const state = await getCallState(callId);
  const hermesRunId = state?.hermesRunId;

  const spend = {
    callId,
    vendor: "comms_confirmations",
    amountCents: 50,
    currency: "usd" as const,
    purpose: "customer_confirmation_sms",
  };
  await publishDemoEvent({
    callId,
    type: "spend.policy_check",
    stage: "safety",
    status: "checking",
    title: "Checking micro-spend policy",
    summary: "$0.50 customer confirmation SMS against policy.yaml",
    payload: { request: spend },
  });
  const policy = await authorizeSpend(spend);
  if (!policy.allowed) {
    throw new Error(`Expected comms spend to be allowed: ${policy.reason}`);
  }

  const authorization = await invokeHermesTool({
    callId,
    hermesRunId,
    skill: "authorize_comms_spend",
    tool: "spend.authorizeComms",
    handler: () => createCommsSpendAuthorization(callId, spend.amountCents),
  });
  await writeArtifact(callId, "spend_authorization.json", { ...policy, request: spend, authorization });
  await appendLedger({
    callId,
    type: "spend.allowed_authorized",
    amount: spend.amountCents,
    currency: "usd",
    stripe_id: authorization.allowed ? authorization.stripeId : undefined,
    policy_decision: "allow",
    payload: { ...policy, request: spend, authorization },
  });
  await publishDemoEvent({
    callId,
    type: "spend.allowed",
    stage: "safety",
    status: "allowed",
    title: "Allowed micro-spend",
    summary: `${formatMoney(spend.amountCents)} approved for ${spend.vendor}`,
    payload: { policy, request: spend, authorization },
  });

  const blockedRequest = {
    callId,
    vendor: "google_ads",
    amountCents: 40000,
    currency: "usd" as const,
    purpose: "promote_open_slot",
  };
  await publishDemoEvent({
    callId,
    type: "spend.block_check",
    stage: "blocked",
    status: "checking",
    title: "Testing off-policy spend",
    summary: "$400.00 Google Ads attempt should be denied.",
    payload: { request: blockedRequest },
  });
  const blockedDecision = await invokeHermesTool({
    callId,
    hermesRunId,
    skill: "authorize_comms_spend",
    tool: "spend.authorizeComms",
    handler: () => authorizeSpend(blockedRequest),
  });
  if (blockedDecision.allowed) {
    throw new Error("Expected google_ads spend to be blocked");
  }

  const blocked = { ...blockedDecision, request: blockedRequest, stripeCallMade: false };
  await writeArtifact(callId, "blocked_spend.json", blocked);
  await appendLedger({
    callId,
    type: "spend.blocked",
    amount: blockedRequest.amountCents,
    currency: "usd",
    policy_decision: "deny",
    payload: blocked,
  });
  await publishDemoEvent({
    callId,
    type: "spend.blocked",
    stage: "blocked",
    status: "blocked",
    title: "403 spend blocked",
    summary: blockedDecision.reason ?? "Policy denied the off-policy spend.",
    payload: { blocked },
  });

  if (state) {
    state.status = "complete";
    await saveCallState(state);
    await writeArtifact(callId, "state.json", state);
  }

  const verification = await verifyLedger(callId);
  await writeArtifact(callId, "ledger.json", { events: await readLedger(callId) });
  await writeArtifact(callId, "ledger_verification.json", verification);
  await publishLedgerVerification(callId, verification);

  const proof = await renderProofHtml(callId);
  const proofUrl = `${process.env.PUBLIC_BASE_URL ?? "http://localhost:8788"}/proof/${callId}`;
  await publishDemoEvent({
    callId,
    type: "proof.ready",
    stage: "proof",
    status: verification.valid ? "verified" : "failed",
    title: "Proof page ready",
    summary: proofUrl,
    payload: {
      proofPath: proof.path,
      proofUrl,
      verification,
    },
  });

  return {
    callId,
    proofPath: proof.path,
    proofUrl,
    ledgerValid: verification.valid,
    ledgerCount: verification.eventCount,
    allowedSpendStripeId: authorization.allowed ? authorization.stripeId : undefined,
    blockedStatus: blockedDecision.status,
  };
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
