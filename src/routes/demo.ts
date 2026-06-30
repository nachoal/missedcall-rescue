import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { readCurrentDemoCallId, readDemoEvents } from "../demo-events.js";

export type DemoRoutesOptions = {
  rootDir?: string;
};

type DemoEventsQuery = {
  callId?: string;
  since?: string;
};

export const demoRoutes: FastifyPluginAsync<DemoRoutesOptions> = async (fastify, options) => {
  const rootDir = options.rootDir ?? process.cwd();

  fastify.get<{ Querystring: { callId?: string } }>("/demo", async (request, reply) => {
    const callId = request.query.callId ?? (await readCurrentDemoCallId({ rootDir }));
    return reply.type("text/html; charset=utf-8").send(renderDemoPage(callId));
  });

  fastify.get<{ Querystring: DemoEventsQuery }>("/demo/events", async (request, reply) => {
    const callId = request.query.callId ?? (await readCurrentDemoCallId({ rootDir }));
    let lastSeq = integerFrom(request.query.since) ?? -1;
    const stream = new PassThrough();
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(keepalive);
      stream.end();
    };

    const flush = async () => {
      if (closed) return;
      try {
        const events = await readDemoEvents({ rootDir, callId, sinceSeq: lastSeq });
        for (const event of events) {
          lastSeq = Math.max(lastSeq, event.seq);
          stream.write(`id: ${event.seq}\n`);
          stream.write("event: demo\n");
          stream.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        stream.write("event: demo-error\n");
        stream.write(`data: ${JSON.stringify({ message: error instanceof Error ? error.message : "unknown error" })}\n\n`);
      }
    };

    stream.write("retry: 1000\n\n");
    await flush();
    const poll = setInterval(() => {
      void flush();
    }, 500);
    const keepalive = setInterval(() => {
      stream.write(": keepalive\n\n");
    }, 15000);
    request.raw.on("close", cleanup);
    stream.on("close", cleanup);

    return reply
      .headers({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      .send(stream);
  });
};

export async function registerDemoRoutes(
  fastify: FastifyInstance,
  options: DemoRoutesOptions = {},
): Promise<void> {
  await fastify.register(demoRoutes, options);
}

export default demoRoutes;

function renderDemoPage(callId: string): string {
  const callIdJson = JSON.stringify(callId).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MissedCall Rescue — Live Demo Console</title>
<link rel="stylesheet" href="/theme.css">
</head>
<body>
<header class="topbar">
  <div class="wrap row">
    <div class="brandmark"><span class="dot"></span> MissedCall&nbsp;Rescue</div>
    <div class="spacer"></div>
    <div class="sponsors">
      <span class="chip nous"><i></i> Hermes</span>
      <span class="chip nv"><i></i> Nemotron</span>
      <span class="chip stripe"><i></i> Stripe test rails</span>
    </div>
  </div>
</header>

<main class="wrap">
  <section class="section">
    <div class="eyebrow">Live agent-business loop</div>
    <h1>One call becomes paid work, safely.</h1>
    <p class="section-sub">Call <span class="mono" id="call-id">${escapeHtml(callId)}</span> streams here in real time: voice, triage, money, booking, safety, and proof.</p>
    <div class="stats">
      <div class="stat"><div class="v" id="voice-status">READY</div><div class="k">Voice transcript</div></div>
      <div class="stat money"><div class="v" id="deposit-status">$49 pending</div><div class="k">Stripe deposit</div></div>
      <div class="stat safe"><div class="v" id="ledger-status">0 events</div><div class="k">Hash-chained ledger</div></div>
    </div>
  </section>

  <section class="section">
    <div class="steps">
      <div class="step" id="step-voice"><img class="art" src="/assets/steps/answer.png" alt=""><div class="step-body"><div class="num">01</div><div class="t">Voice call</div><div class="d" data-step-copy>Waiting for transcript.</div><span class="tag nous">live</span></div></div>
      <div class="step" id="step-triage"><img class="art" src="/assets/steps/triage.png" alt=""><div class="step-body"><div class="num">02</div><div class="t">Triage</div><div class="d" data-step-copy>Nemotron decision pending.</div><span class="tag nv">TriageDecision</span></div></div>
      <div class="step" id="step-payment"><img class="art" src="/assets/steps/paid.png" alt=""><div class="step-body"><div class="num">03</div><div class="t">Deposit</div><div class="d" data-step-copy>Checkout not created yet.</div><span class="tag stripe">Stripe</span></div></div>
      <div class="step" id="step-booking"><img class="art" src="/assets/steps/book.png" alt=""><div class="step-body"><div class="num">04</div><div class="t">Booking</div><div class="d" data-step-copy>Calendar waiting.</div><span class="tag nous">Cal.com</span></div></div>
      <div class="step" id="step-safety"><img class="art" src="/assets/steps/safe.png" alt=""><div class="step-body"><div class="num">05</div><div class="t">Safety</div><div class="d" data-step-copy>Policy gate waiting.</div><span class="tag nv">policy.yaml</span></div></div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="head"><div class="ico">01</div><div><div class="title">Voice transcript</div><div class="sub mono" id="stream-status">Connecting to /demo/events</div></div><span class="spacer"></span><span class="badge badge--warn" id="event-badge">WAITING</span></div>
      <div class="body"><div class="transcript" id="transcript"></div></div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="head"><div class="ico">02</div><div><div class="title">Nemotron TriageDecision</div><div class="sub mono" id="hermes-run">Hermes run pending</div></div><span class="spacer"></span><span class="badge badge--pay" id="triage-badge">PENDING</span></div>
      <div class="body"><pre class="pre" id="triage-json">{}</pre></div>
    </div>
  </section>

  <section class="section">
    <div class="stats">
      <div class="stat money"><div class="v" id="money-in">$0</div><div class="k" id="money-in-copy">Deposit link pending.</div></div>
      <div class="stat safe"><div class="v" id="booking-id">-</div><div class="k" id="booking-copy">Booking pending.</div></div>
      <div class="stat block"><div class="v" id="blocked-code">-</div><div class="k" id="blocked-copy">No off-policy purchase attempted yet.</div></div>
    </div>
  </section>

  <section class="section">
    <div class="block-callout">
      <div class="big" id="block-big">403</div>
      <div><h3 id="block-title">Safety test — pending</h3><div class="note" id="block-note">The agent is allowed to send a tiny customer confirmation, but not buy ads or make arbitrary purchases.</div><div class="nostripe" id="block-rail">No off-policy Stripe call made.</div></div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="head"><div class="ico">#</div><div><div class="title">Hash-chained ledger</div><div class="sub mono" id="ledger-hash">Waiting for first event</div></div><span class="spacer"></span><span class="badge badge--warn" id="verified-badge">VERIFYING</span></div>
      <div class="body" style="padding:0"><table class="ledger"><thead><tr><th>#</th><th>type</th><th>amount</th><th>policy</th><th>stripe</th><th>hash</th><th>prev</th></tr></thead><tbody id="ledger-rows"></tbody></table></div>
      <div class="verify-bar"><span class="badge badge--ok" id="proof-badge">PROOF WAITING</span><a class="cta-ghost" id="proof-link" href="/proof/${encodeURIComponent(callId)}">Open proof</a></div>
    </div>
  </section>
</main>

<script>
const DEMO_CALL_ID = ${callIdJson};
const state = { transcript: "", turns: [], ledger: new Map(), latestSeq: -1 };
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);

function setStep(stage, text, kind = "ok") {
  const el = $("step-" + stage);
  if (!el) return;
  const copy = el.querySelector("[data-step-copy]");
  if (copy) copy.textContent = text;
  el.style.borderColor = kind === "block" ? "var(--block)" : kind === "pay" ? "var(--hermes)" : "var(--ok)";
}

function renderTranscriptFromText(text) {
  state.transcript = text || state.transcript;
  state.turns = state.transcript.split(/\\n+/).map((line) => {
    const parts = line.split(":");
    const role = parts.length > 1 ? parts.shift() : "caller";
    return { role: String(role).trim(), text: parts.join(":").trim() || line };
  }).filter((turn) => turn.text);
  renderTranscript();
}

function renderTranscript() {
  $("transcript").innerHTML = state.turns.map((turn) => {
    const agent = /agent|assistant/i.test(turn.role);
    return '<div class="turn ' + (agent ? "agent" : "caller") + '"><span class="who">' + esc(agent ? "agent" : "caller") + '</span>' + esc(turn.text) + '</div>';
  }).join("");
  $("voice-status").textContent = state.turns.length ? "LIVE" : "READY";
  setStep("voice", state.turns.length ? state.turns.length + " transcript turns captured" : "Waiting for transcript.");
}

function renderLedger() {
  const rows = [...state.ledger.values()].sort((a, b) => a.index - b.index);
  $("ledger-rows").innerHTML = rows.map((event) => {
    const policy = event.policy_decision || "none";
    return "<tr>" +
      "<td>" + event.index + "</td>" +
      "<td>" + esc(event.type) + "</td>" +
      "<td class='amt'>" + (event.amount ? money(event.amount) : "-") + "</td>" +
      "<td><span class='pol-" + esc(policy) + "'>" + esc(policy) + "</span></td>" +
      "<td>" + esc(event.stripe_id || "-") + "</td>" +
      "<td class='hash'>" + esc(String(event.hash || "").slice(0, 8)) + "</td>" +
      "<td>" + esc(String(event.prev_hash || "").slice(0, 8)) + "</td>" +
    "</tr>";
  }).join("");
  $("ledger-status").textContent = rows.length + " events";
  const last = rows.at(-1);
  $("ledger-hash").textContent = last ? "last " + String(last.hash).slice(0, 16) : "Waiting for first event";
}

function handleDemoEvent(event) {
  state.latestSeq = Math.max(state.latestSeq, event.seq);
  $("event-badge").className = "badge " + (event.status === "blocked" ? "badge--block" : event.status === "paid" || event.stage === "payment" ? "badge--pay" : "badge--ok");
  $("event-badge").textContent = event.type.toUpperCase();

  if (event.type === "voice.webhook" || event.type === "transcript.updated") {
    renderTranscriptFromText(event.payload.transcript || "");
  }
  if (event.type === "transcript.turn") {
    state.turns.push(event.payload.turn);
    renderTranscript();
  }
  if (event.type === "triage.started") {
    $("triage-badge").textContent = "RUNNING";
    setStep("triage", "Nemotron is emitting the decision.", "pay");
  }
  if (event.type === "triage.decision") {
    const decision = event.payload.decision || {};
    $("triage-json").textContent = JSON.stringify(decision, null, 2);
    $("triage-badge").className = "badge badge--ok";
    $("triage-badge").textContent = String(decision.urgency || "DECIDED").toUpperCase();
    $("hermes-run").textContent = decision.hermesRunId || "Hermes run captured";
    setStep("triage", (decision.urgency || "triaged") + " · " + (decision.nextAction || "next action"));
  }
  if (event.type === "deposit.pending") {
    const checkout = event.payload.checkout || {};
    $("deposit-status").textContent = "$49 pending";
    $("money-in").textContent = "$49";
    $("money-in-copy").innerHTML = "Checkout pending · <a href='" + esc(checkout.url || "#") + "' target='_blank' rel='noreferrer'>open Stripe test link</a>";
    setStep("payment", "$49 Checkout created.", "pay");
  }
  if (event.type === "deposit.paid") {
    const payment = event.payload.payment || {};
    $("deposit-status").textContent = "$49 PAID";
    $("money-in").textContent = "$49";
    $("money-in-copy").textContent = "Paid · " + (payment.paymentIntentId || payment.sessionId || "Stripe test payment");
    setStep("payment", "$49 paid by customer.", "pay");
  }
  if (event.type === "booking.confirmed") {
    const booking = event.payload.booking || {};
    $("booking-id").textContent = String(booking.bookingId || "BOOKED").slice(0, 14);
    $("booking-copy").textContent = (booking.provider || "calendar") + " · " + (booking.selectedIsoStart || "confirmed");
    setStep("booking", "Appointment confirmed.");
  }
  if (event.type === "spend.allowed") {
    const auth = event.payload.authorization || {};
    setStep("safety", "$0.50 micro-spend allowed.");
    $("block-rail").textContent = "Allowed rail: " + (auth.stripeId || "policy-approved");
  }
  if (event.type === "spend.blocked") {
    const blocked = event.payload.blocked || {};
    $("blocked-code").textContent = "403";
    $("blocked-copy").textContent = blocked.reason || "Off-policy spend denied.";
    $("block-title").textContent = "403 blocked: " + ((blocked.request && blocked.request.vendor) || "off-policy vendor");
    $("block-note").textContent = blocked.reason || "Policy denied the spend.";
    $("block-rail").textContent = blocked.stripeCallMade === false ? "No off-policy Stripe call made." : "Blocked before capture.";
    setStep("safety", "$400 Google Ads attempt blocked.", "block");
  }
  if (event.type === "ledger.appended") {
    const ledgerEvent = event.payload.event;
    if (ledgerEvent) state.ledger.set(ledgerEvent.index, ledgerEvent);
    renderLedger();
  }
  if (event.type === "ledger.verified") {
    const verification = event.payload.verification || {};
    $("verified-badge").className = "badge " + (verification.valid ? "badge--ok" : "badge--block");
    $("verified-badge").textContent = verification.valid ? "CHAIN VERIFIED" : "CHAIN FAILED";
    $("ledger-status").textContent = (verification.eventCount || state.ledger.size) + " verified";
  }
  if (event.type === "proof.ready") {
    const proofUrl = event.payload.proofUrl || ("/proof/" + encodeURIComponent(DEMO_CALL_ID));
    $("proof-link").href = proofUrl;
    $("proof-badge").textContent = "PROOF READY";
    $("proof-badge").className = "badge badge--ok";
  }
}

const source = new EventSource("/demo/events?callId=" + encodeURIComponent(DEMO_CALL_ID));
source.addEventListener("open", () => { $("stream-status").textContent = "SSE connected"; });
source.addEventListener("demo", (message) => handleDemoEvent(JSON.parse(message.data)));
source.addEventListener("demo-error", (message) => { $("stream-status").textContent = "SSE error: " + JSON.parse(message.data).message; });
source.addEventListener("error", () => { $("stream-status").textContent = "SSE reconnecting"; });
</script>
</body>
</html>`;
}

function integerFrom(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
