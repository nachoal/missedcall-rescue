<div align="center">

# 📞 MissedCall Rescue

### An always-on after-hours dispatcher for HVAC & home-services.
**It answers the calls you miss, triages the emergency, collects a deposit, books the visit — and physically can't overspend.**

🔗 **Live — call it yourself:** **[rescuemissedcall.com](https://rescuemissedcall.com)**
🏆 Built for the **Hermes Agent Accelerated Business Hackathon** · NVIDIA × Stripe × Nous Research

</div>

---

## The problem

After hours, home-services businesses send emergencies to voicemail — and the customer just calls the next contractor. **74% of after-hours service calls go unanswered.** Five missed jobs a week is thousands in booked work, gone.

## What it does

Forward your line after close. For **every** missed call, the agent runs a controlled, end-to-end operation — not a chatbot, an operator:

| # | Step | Powered by |
|---|------|-----------|
| 1 | **Answers** the call and captures the emergency | Vapi voice |
| 2 | **Triages** urgency + deposit amount in one structured read | **Nous Hermes Agent → NVIDIA Nemotron** |
| 3 | **Collects a real $49 deposit** — money in, before you ring back | **Stripe** Checkout (test rails) |
| 4 | **Books the visit** the moment the deposit clears | Cal.com |
| 5 | **Can't overspend** — an off-policy ad-buy is blocked `403` before any charge | **NVIDIA NemoClaw / OpenShell** + policy gate |

Every step is appended to a **hash-chained, tamper-evident ledger** and a one-click **[/proof](https://rescuemissedcall.com/proof.html)** page. The owner reviews the money it brought in — not a pile of tasks.

## Why it's different — it earns, spends, and *can't go rogue*

Most agent demos either talk or spend, never both, and rarely safely. MissedCall Rescue does all three:

- **Earns new revenue** — a real Stripe deposit collected on the call.
- **Spends under policy** — it can make a tiny, allowed confirmation spend, but reaching for a $400 off-policy ad buy is **blocked with a 403** before any Stripe call is made.
- **Sandboxed for real** — the Hermes loop runs inside **NVIDIA's NemoClaw / OpenShell sandbox** with a **deny-by-default network policy**. Off-policy egress is genuinely refused at the sandbox boundary (a probe to `example.com` returns `policy_denied`), not just gated in app code.
- **Provable** — every action is hash-chained and replayable on the proof page; nothing is staged.

## The stack — all sponsor tech, genuinely wired

| Sponsor | Used for | Real? |
|---|---|---|
| **Nous Hermes Agent** | runs the post-call business loop (the real `hermes` CLI) | ✅ live |
| **NVIDIA Nemotron** (`nemotron-3-ultra-550b`) | triages every call with a structured decision | ✅ live |
| **NVIDIA NemoClaw / OpenShell** | deny-by-default sandbox the agent runs inside | ✅ verified ([writeup](#nemoclaw--openshell-verification)) |
| **Stripe** | $49 deposit in, policy-capped spend out (test mode) | ✅ live |
| Vapi · Cal.com | voice front-door · booking | ✅ live |

## Architecture

```
 Missed call ─► Vapi voice ─► Fastify backend
                                 │
                                 ├─► Hermes Agent ──► NVIDIA Nemotron     (triage: urgency, $ deposit, next action)
                                 │     running inside NemoClaw/OpenShell  (deny-by-default egress)
                                 ├─► Stripe Checkout                      ($49 deposit, test rails)
                                 ├─► Cal.com                              (book the visit)
                                 ├─► policy.yaml gate ──► 403             (blocks off-policy spend)
                                 └─► SHA-256 hash-chained ledger ─► /proof (tamper-evident receipt)
```

## Run it

```sh
pnpm install
cp .env.example .env      # fill provider keys in your private .env (never committed)
pnpm dev                  # USE_MOCKS=true runs fully local, no provider calls
pnpm typecheck && pnpm test
```

Run the triage through the real **NemoClaw / OpenShell** sandbox (requires NemoClaw installed — see writeup):

```sh
REAL_NEMOCLAW=true NEMOCLAW_SANDBOX_NAME=hermes-proof \
NEMOTRON_MODEL=nvidia/nemotron-3-ultra-550b-a55b pnpm start
# Hermes triage then executes via:  nemohermes <sandbox> exec -- hermes ...
# falls back to a direct Hermes spawn if the sandbox is unavailable.
```

## NemoClaw / OpenShell verification

The agent genuinely runs inside NVIDIA's [NemoClaw](https://github.com/NVIDIA/NemoClaw) OpenShell sandbox — installed via the official NVIDIA installer, OpenShell 0.0.44 in Docker, inference routed to NVIDIA Endpoints. Proven: a sandboxed Hermes triage returns the correct emergency decision, and an off-policy egress probe is refused with `policy_denied`. (NemoClaw is alpha / "tested with limitations" per NVIDIA's docs; the integration is flag-gated with a safe fallback so the demo never breaks.)

## Hackathon

Built for the Hermes Agent Accelerated Business Hackathon, judged on **usefulness · viability · presentation**. MissedCall Rescue is a narrow operator a real contractor could switch on tonight: it answers, earns, books, and refuses unsafe spend — with a receipt for every call.

---

<div align="center"><sub>Every scene in the demo is a real browser recording. Live at <b>rescuemissedcall.com</b>.</sub></div>
