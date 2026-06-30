# MissedCall Rescue — Design system & wiring contract (Claude owns `web/`)

## My goal (design workstream)
Make the proof pack + landing look **premium and demo-ready** — a refined blend of the three sponsor brands so each judge sees their stack honored:
- **Nous / Hermes** → the cosmic **dark base** (near-black, deep-space gradient, starfield). The agent/brain.
- **NVIDIA** → **green `#76B900`** = *allowed / authorized / verified / safe*. The safety rail.
- **Stripe** → **blurple `#635BFF`** = *money / payments / the $49 hero*. The revenue rail.
- **Danger red** `#FF4D6D` = the **403 blocked** spend (the safety money-shot).

This colour semantics is intentional: **blurple = money in/out, green = the policy allowed/verified it, red = the policy killed it, cosmic = Hermes is the operator.** The page literally tells the sponsor story.

Type: **Space Grotesk** (display) · **Inter** (UI/body) · **JetBrains Mono** (all technical artifacts: JSON, hashes, ledger). Loaded via Google Fonts in the templates.

## Files in `web/` (do not edit these, codex)
- `theme.css` — the full design system (CSS variables + components). Serve it statically at `/theme.css`.
- `proof.template.html` — the proof-pack page. **Codex renders the proof route by reading this file and replacing the `{{TOKENS}}` below**, then serving the result. No styling logic in the backend — just token replacement.
- `index.html` — the landing/hero page (use as the public live URL / submission link, and a clean on-camera asset). Mostly static; optional `{{PHONE_NUMBER}}` token.
- `proof.example.html` — a fully-filled reference render (sample data) so we can eyeball the design. Not used at runtime.

## Token contract for `proof.template.html`
Codex's proof renderer (`src/proof.ts` / `GET /proof/:callId`) must replace these exact tokens with **HTML-escaped** values (except the `_HTML`/`_ROWS` tokens, which are pre-rendered HTML):

| Token | Type | Meaning |
|---|---|---|
| `{{CALL_ID}}` | text | the call id |
| `{{GENERATED_AT}}` | text | ISO timestamp |
| `{{HERMES_RUN_ID}}` | text | Hermes run id (proves Hermes was the operator) |
| `{{DEPOSIT_AMOUNT}}` | text | e.g. `$49.00` |
| `{{DEPOSIT_STATUS}}` | text | `CAPTURED` / `PENDING` |
| `{{STRIPE_PI_ID}}` | text | payment_intent id |
| `{{TRANSCRIPT_HTML}}` | HTML | transcript turns as `<div class="turn caller|agent">…</div>` |
| `{{TRIAGE_JSON}}` | text | pretty-printed TriageDecision JSON (goes inside a `<pre>`) |
| `{{TRIAGE_URGENCY}}` | text | `emergency` / `same_day` / `routine` (drives a badge) |
| `{{BOOKING_WHEN}}` | text | human booking time |
| `{{BOOKING_ID}}` | text | Cal.com booking id |
| `{{SPEND_VENDOR}}` | text | allowed vendor name |
| `{{SPEND_AMOUNT}}` | text | e.g. `$0.37` |
| `{{SPEND_STRIPE_ID}}` | text | Issuing auth / PI id |
| `{{BLOCKED_VENDOR}}` | text | e.g. `google_ads` |
| `{{BLOCKED_AMOUNT}}` | text | e.g. `$400.00` |
| `{{BLOCKED_REASON}}` | text | policy reason string |
| `{{LEDGER_ROWS}}` | HTML | `<tr>` rows: `<td>`s for index, ts, type, amount, stripe_id, policy, hash(8), prev(8) |
| `{{LEDGER_VERIFIED}}` | text | `true` / `false` (drives the verified pill) |
| `{{LEDGER_COUNT}}` | text | event count |
| `{{STACK_NOTE}}` | text | one-line stack credit |

Helper classes available (see `theme.css`): `.badge.badge--ok` (green), `.badge.badge--pay` (blurple), `.badge.badge--block` (red), `.badge.badge--warn`, `.pre` (mono code block), `.mono`, `.hashchain td.hash`.

Keep secrets out of the rendered page (no keys, no full card numbers).
