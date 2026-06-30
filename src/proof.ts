import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { readLedger, verifyLedger } from "./ledger.js";
import type { CallState, LedgerEvent, LedgerVerification, TriageDecision } from "./types/domain.js";

export type ProofArtifact = {
  name: string;
  kind: "json" | "text" | "binary";
  sizeBytes: number;
  data?: unknown;
  text?: string;
};

export type ProofBundle = {
  callId: string;
  generatedAt: string;
  artifacts: ProofArtifact[];
  ledger: {
    source?: string;
    events: LedgerEvent[];
    verification: LedgerVerification;
  };
  state?: Record<string, unknown>;
  triage?: Record<string, unknown>;
  transcript?: string;
};

export type RenderProofOptions = {
  rootDir?: string;
  now?: () => Date;
};

export class ProofError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 500 = 500,
  ) {
    super(message);
    this.name = "ProofError";
  }
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".log", ".ndjson", ".json"]);
const MAX_INLINE_ARTIFACT_BYTES = 1024 * 1024;

export function assertSafeCallId(callId: string): void {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(callId)) {
    throw new ProofError("Invalid proof call id.", 400);
  }
}

export function hashLedgerEvent(eventWithoutHash: Record<string, unknown>): string {
  const event = { ...eventWithoutHash };
  delete event.hash;
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}

export function verifyLedgerEvents(events: LedgerEvent[]): LedgerVerification {
  const errors: string[] = [];

  if (events.length === 0) {
    return {
      valid: false,
      eventCount: 0,
      errors: ["No ledger events found."],
    };
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const previousEvent = events[index - 1];

    if (event.index !== index) {
      errors.push(`Event ${index} has index ${event.index}.`);
    }

    if (index > 0 && event.prev_hash !== previousEvent.hash) {
      errors.push(`Event ${index} prev_hash does not match event ${index - 1}.`);
    }

    if (!event.hash) {
      errors.push(`Event ${index} is missing hash.`);
      continue;
    }

    const expectedHash = hashLedgerEvent(event as unknown as Record<string, unknown>);
    if (event.hash !== expectedHash) {
      errors.push(`Event ${index} hash does not match its canonical payload.`);
    }
  }

  return {
    valid: errors.length === 0,
    eventCount: events.length,
    firstHash: events[0]?.hash,
    lastHash: events.at(-1)?.hash,
    errors,
  };
}

export async function loadProofBundle(
  callId: string,
  options: RenderProofOptions = {},
): Promise<ProofBundle> {
  assertSafeCallId(callId);

  const rootDir = resolve(options.rootDir ?? process.cwd());
  const proofRoot = resolve(rootDir, "data", "proof");
  const proofPath = resolve(proofRoot, callId);
  const singleJsonPath = resolve(proofRoot, `${callId}.json`);
  const callState = await readCallStateFromRoot(rootDir, callId);

  let artifactPaths: string[] = [];
  let basePath = proofPath;

  if (await pathExists(proofPath)) {
    const proofStat = await stat(proofPath);
    artifactPaths = proofStat.isDirectory() ? await listFiles(proofPath) : [proofPath];
  } else if (await pathExists(singleJsonPath)) {
    basePath = proofRoot;
    artifactPaths = [singleJsonPath];
  } else if (callState) {
    artifactPaths = [];
  } else {
    throw new ProofError(`No proof artifacts found for ${callId}.`, 404);
  }

  const artifacts = await Promise.all(
    artifactPaths.sort().map((artifactPath) => readArtifact(basePath, artifactPath)),
  );
  const artifactLedger = extractLedgerEvents(artifacts);
  const globalLedger = await extractGlobalLedger(rootDir, callId);
  const events = globalLedger.events.length > 0 ? globalLedger.events : artifactLedger.events;
  const verification =
    globalLedger.events.length > 0
      ? globalLedger.verification
      : verifyLedgerEvents(artifactLedger.events);
  const persistedVerification = extractPersistedVerification(artifacts);
  const state = callState ?? extractNamedObject(artifacts, ["state", "call", "call-state"]);
  const triage = extractNamedObject(artifacts, [
    "triage",
    "decision",
    "triage-decision",
    "triage_decision",
    "hermes_decision",
  ]);

  return {
    callId,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    artifacts,
    ledger: {
      source: globalLedger.source ?? artifactLedger.source,
      events,
      verification: persistedVerification ?? verification,
    },
    state,
    triage,
    transcript: extractTranscript(artifacts, state),
  };
}

export async function renderProofPage(
  callId: string,
  options: RenderProofOptions = {},
): Promise<string> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const bundle = await loadProofBundle(callId, { ...options, rootDir });
  const themeLink = (await pathExists(resolve(rootDir, "web", "theme.css")))
    ? '<link rel="stylesheet" href="/theme.css">'
    : "";

  const templatePath = resolve(rootDir, "web", "proof.template.html");
  if (await pathExists(templatePath)) {
    const template = await readFile(templatePath, "utf8");
    return replaceTemplateTokens(template, buildProofTokens(bundle, themeLink));
  }

  const proofJson = jsonForHtml(bundle);
  const proofContent = renderProofContent(bundle);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proof ${escapeHtml(callId)}</title>
  ${themeLink}
</head>
<body>
  ${proofContent}
  <script id="proof-json" type="application/json">${proofJson}</script>
</body>
</html>`;
}

export async function renderProofHtml(
  callId: string,
  options: RenderProofOptions = {},
): Promise<{ callId: string; html: string; path: string }> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const html = await renderProofPage(callId, { ...options, rootDir });
  const path = resolve(rootDir, "data", "proof", callId, "proof.html");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${html}\n`, "utf8");
  return { callId, html, path };
}

function renderProofContent(bundle: ProofBundle): string {
  const verification = bundle.ledger.verification;
  const stateRows = bundle.state
    ? Object.entries(bundle.state)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(
          ([key, value]) =>
            `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(formatValue(value))}</td></tr>`,
        )
        .join("")
    : "";
  const ledgerRows = bundle.ledger.events
    .map(
      (event) =>
        `<tr><td>${escapeHtml(event.index)}</td><td>${escapeHtml(event.ts)}</td><td>${escapeHtml(
          event.type,
        )}</td><td><code>${escapeHtml(event.hash.slice(0, 12))}</code></td></tr>`,
    )
    .join("");
  const artifactItems = bundle.artifacts
    .map(
      (artifact) =>
        `<li><code>${escapeHtml(artifact.name)}</code> <span>${escapeHtml(
          artifact.kind,
        )}, ${escapeHtml(artifact.sizeBytes)} bytes</span></li>`,
    )
    .join("");
  const verificationClass = verification.valid ? "verified" : "unverified";
  const verificationText = verification.valid ? "Ledger verified" : "Ledger needs attention";
  const errors = verification.errors.length
    ? `<ul>${verification.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`
    : "";

  return `<main class="proof" data-call-id="${escapeAttribute(bundle.callId)}">
  <header>
    <p>MissedCall Rescue</p>
    <h1>Call proof ${escapeHtml(bundle.callId)}</h1>
    <p class="${verificationClass}">${verificationText}</p>
  </header>
  <section>
    <h2>Ledger</h2>
    <p>${escapeHtml(verification.eventCount)} events. Last hash: <code>${escapeHtml(
      verification.lastHash ?? "none",
    )}</code></p>
    ${errors}
    <table>
      <thead><tr><th>Index</th><th>Time</th><th>Type</th><th>Hash</th></tr></thead>
      <tbody>${ledgerRows}</tbody>
    </table>
  </section>
  <section>
    <h2>Call State</h2>
    <table>
      <tbody>${stateRows}</tbody>
    </table>
  </section>
  <section>
    <h2>Artifacts</h2>
    <ul>${artifactItems}</ul>
  </section>
</main>`;
}

function buildProofTokens(bundle: ProofBundle, themeLink = ""): Record<string, string> {
  const state = bundle.state as (Partial<CallState> & Record<string, unknown>) | undefined;
  const triage = bundle.triage as (Partial<TriageDecision> & Record<string, unknown>) | undefined;
  const deposit = objectArtifact(bundle, ["stripe_deposit"]);
  const payment = objectArtifact(bundle, ["stripe_payment_succeeded", "payment"]);
  const booking = objectArtifact(bundle, ["cal_booking", "booking"]);
  const spend = objectArtifact(bundle, ["spend_authorization", "allowed_spend"]);
  const blocked = objectArtifact(bundle, ["blocked_spend"]);

  const depositAmountCents =
    numberAt(triage, ["depositAmountCents"]) ??
    numberAt(deposit, ["amountCents"]) ??
    numberAt(payment, ["amountCents"]) ??
    4900;
  const spendAmountCents =
    numberAt(spend, ["request", "amountCents"]) ??
    numberAt(spend, ["authorization", "amountCents"]) ??
    numberAt(spend, ["amountCents"]);
  const blockedAmountCents =
    numberAt(blocked, ["request", "amountCents"]) ?? numberAt(blocked, ["amountCents"]);
  const bookingStart =
    stringAt(booking, ["selectedIsoStart"]) ??
    stringAt(booking, ["raw", "data", "start"]) ??
    stringAt(booking, ["raw", "start"]);
  const paymentIntentId =
    stringAt(payment, ["paymentIntentId"]) ??
    stringAt(payment, ["payment_intent_id"]) ??
    stringAt(deposit, ["paymentIntentId"]) ??
    stringAt(deposit, ["payment_intent_id"]) ??
    state?.stripePaymentIntentId ??
    "";
  const spendStripeId =
    stringAt(spend, ["authorization", "stripeId"]) ??
    stringAt(spend, ["authorization", "authorizationId"]) ??
    stringAt(spend, ["authorization", "paymentIntentId"]) ??
    findLedgerStripeId(bundle.ledger.events, "spend.allowed_authorized") ??
    "";
  const blockedReason =
    stringAt(blocked, ["reason"]) ??
    stringAt(blocked, ["policy", "reason"]) ??
    "No blocked spend has been recorded yet.";
  const hermesRunId =
    stringAt(triage, ["hermesRunId"]) ??
    state?.hermesRunId ??
    findLedgerPayloadString(bundle.ledger.events, "hermes.triage_decision.emitted", [
      "hermesRunId",
    ]) ??
    "";
  const depositCaptured = Boolean(payment) || ["paid", "booked", "complete"].includes(String(state?.status ?? ""));

  return {
    CALL_ID: textToken(bundle.callId),
    GENERATED_AT: textToken(bundle.generatedAt),
    PROOF_JSON: jsonForHtml(bundle),
    PROOF_CONTENT: renderProofContent(bundle),
    THEME_LINK: themeLink,
    TOKENS: "tokens",
    HERMES_RUN_ID: textToken(hermesRunId || "not-recorded"),
    TRANSCRIPT: textToken(bundle.transcript ?? ""),
    DEPOSIT_AMOUNT: textToken(formatMoney(depositAmountCents)),
    DEPOSIT_STATUS: textToken(depositCaptured ? "CAPTURED" : "PENDING"),
    STRIPE_PI_ID: textToken(paymentIntentId || "not-captured-yet"),
    TRANSCRIPT_HTML: renderTranscriptHtml(bundle.transcript ?? ""),
    TRIAGE_JSON: textToken(JSON.stringify(triage ?? {}, null, 2)),
    TRIAGE_URGENCY: textToken(String(triage?.urgency ?? "routine")),
    BOOKING_WHEN: textToken(formatBookingWhen(bookingStart)),
    BOOKING_ID: textToken(stringAt(booking, ["bookingId"]) ?? state?.bookingId ?? "not-booked-yet"),
    SPEND_VENDOR: textToken(stringAt(spend, ["request", "vendor"]) ?? "comms_confirmations"),
    SPEND_AMOUNT: textToken(spendAmountCents === undefined ? "$0.00" : formatMoney(spendAmountCents)),
    SPEND_STRIPE_ID: textToken(spendStripeId || "not-authorized-yet"),
    BLOCKED_VENDOR: textToken(stringAt(blocked, ["request", "vendor"]) ?? "google_ads"),
    BLOCKED_AMOUNT: textToken(blockedAmountCents === undefined ? "$0.00" : formatMoney(blockedAmountCents)),
    BLOCKED_REASON: textToken(blockedReason),
    LEDGER_ROWS: renderLedgerRows(bundle.ledger.events),
    LEDGER_STATUS: bundle.ledger.verification.valid ? "verified" : "unverified",
    LEDGER_EVENT_COUNT: textToken(String(bundle.ledger.verification.eventCount)),
    LEDGER_LAST_HASH: textToken(bundle.ledger.verification.lastHash ?? ""),
    LEDGER_COUNT: textToken(String(bundle.ledger.verification.eventCount)),
    STACK_NOTE: textToken(
      "Hermes operator; Nemotron triage; Stripe Checkout and PaymentIntent test rails; Cal.com booking; policy.yaml 403; SHA-256 ledger.",
    ),
  };
}

function replaceTemplateTokens(template: string, tokens: Record<string, string>): string {
  return Object.entries(tokens).reduce(
    (html, [token, value]) => html.replaceAll(`{{${token}}}`, value),
    template,
  );
}

function textToken(value: unknown): string {
  return escapeHtml(value);
}

function renderTranscriptHtml(transcript: string): string {
  const lines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return `<div class="turn agent"><span class="who">Hermes</span>${escapeHtml(
      "Transcript will appear here after the call intake.",
    )}</div>`;
  }

  return lines
    .map((line) => {
      const match = line.match(/^(agent|assistant|hermes|caller|user|customer)\s*:\s*(.*)$/i);
      const rawRole = match?.[1]?.toLowerCase();
      const text = match?.[2] ?? line;
      const isAgent = rawRole === "agent" || rawRole === "assistant" || rawRole === "hermes";
      const roleClass = isAgent ? "agent" : "caller";
      const who = isAgent ? "Agent - Hermes" : "Caller";
      return `<div class="turn ${roleClass}"><span class="who">${escapeHtml(who)}</span>${escapeHtml(
        text,
      )}</div>`;
    })
    .join("");
}

function renderLedgerRows(events: LedgerEvent[]): string {
  if (events.length === 0) {
    return `<tr><td colspan="7">No ledger events recorded.</td></tr>`;
  }

  return events
    .map((event) => {
      const policy = event.policy_decision ?? "none";
      const policyClass = policy === "allow" ? "pol-allow" : policy === "deny" ? "pol-deny" : "pol-none";
      const policyLabel = policy === "deny" && event.payload?.status === 403 ? "deny / 403" : policy;
      return `<tr title="${escapeAttribute(event.ts)}"><td>${escapeHtml(event.index)}</td><td>${escapeHtml(
        event.type,
      )}</td><td>${escapeHtml(event.amount === undefined ? "-" : formatMoney(event.amount))}</td><td class="mono">${escapeHtml(
        event.stripe_id ?? "-",
      )}</td><td><span class="${policyClass}">${escapeHtml(policyLabel)}</span></td><td class="hash">${escapeHtml(
        event.hash.slice(0, 8),
      )}</td><td class="muted">${escapeHtml(event.prev_hash.slice(0, 8))}</td></tr>`;
    })
    .join("");
}

async function extractGlobalLedger(
  rootDir: string,
  callId: string,
): Promise<{ events: LedgerEvent[]; verification: LedgerVerification; source?: string }> {
  const ledgerPath = resolve(rootDir, "data", "events.jsonl");
  if (!(await pathExists(ledgerPath))) {
    return {
      events: [],
      verification: verifyLedgerEvents([]),
    };
  }

  const events = await readLedger({ ledgerPath, callId });
  const verification = await verifyLedger({ ledgerPath, callId });
  return {
    events,
    verification,
    source: "data/events.jsonl",
  };
}

async function readCallStateFromRoot(
  rootDir: string,
  callId: string,
): Promise<(CallState & Record<string, unknown>) | undefined> {
  const path = resolve(rootDir, "data", "calls", `${callId}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as CallState & Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function extractTranscript(
  artifacts: ProofArtifact[],
  state?: Record<string, unknown>,
): string | undefined {
  const transcriptArtifact = artifacts.find((artifact) =>
    basename(artifact.name).toLowerCase().startsWith("transcript."),
  );
  if (transcriptArtifact?.kind === "text") {
    return transcriptArtifact.text?.trim();
  }
  const transcript = state?.transcript;
  return typeof transcript === "string" ? transcript : undefined;
}

function objectArtifact(
  bundle: ProofBundle,
  names: string[],
): Record<string, unknown> | undefined {
  return extractNamedObject(bundle.artifacts, names);
}

function stringAt(record: unknown, path: string[]): string | undefined {
  const value = valueAt(record, path);
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function numberAt(record: unknown, path: string[]): number | undefined {
  const value = valueAt(record, path);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function valueAt(record: unknown, path: string[]): unknown {
  let current = record;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function findLedgerStripeId(events: LedgerEvent[], eventType: string): string | undefined {
  return events.find((event) => event.type === eventType)?.stripe_id;
}

function findLedgerPayloadString(
  events: LedgerEvent[],
  eventType: string,
  path: string[],
): string | undefined {
  const event = events.find((candidate) => candidate.type === eventType);
  return stringAt(event?.payload, path);
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatBookingWhen(value: string | undefined): string {
  if (!value) return "not booked yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(date);
}

async function readArtifact(basePath: string, artifactPath: string): Promise<ProofArtifact> {
  const artifactStat = await stat(artifactPath);
  const name = relative(basePath, artifactPath) || basename(artifactPath);
  const extension = extname(artifactPath).toLowerCase();

  if (!TEXT_EXTENSIONS.has(extension) || artifactStat.size > MAX_INLINE_ARTIFACT_BYTES) {
    return { name, kind: "binary", sizeBytes: artifactStat.size };
  }

  const text = await readFile(artifactPath, "utf8");
  if (extension === ".json") {
    try {
      return {
        name,
        kind: "json",
        sizeBytes: artifactStat.size,
        data: JSON.parse(text) as unknown,
      };
    } catch {
      return { name, kind: "text", sizeBytes: artifactStat.size, text };
    }
  }

  return { name, kind: "text", sizeBytes: artifactStat.size, text };
}

async function listFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(dirPath, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }
      return [entryPath];
    }),
  );
  return files.flat();
}

function extractLedgerEvents(artifacts: ProofArtifact[]): { events: LedgerEvent[]; source?: string } {
  for (const artifact of artifacts) {
    const lowerName = artifact.name.toLowerCase();
    if (!lowerName.includes("ledger") && !lowerName.includes("event")) {
      continue;
    }

    if (artifact.kind === "json") {
      const events = coerceLedgerEvents(artifact.data);
      if (events.length > 0) {
        return { events, source: artifact.name };
      }
    }

    if (artifact.kind === "text" && lowerName.endsWith(".ndjson")) {
      const events = artifact.text
        ?.split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
        .flatMap((value) => coerceLedgerEvents(value));
      if (events && events.length > 0) {
        return { events, source: artifact.name };
      }
    }
  }

  return { events: [] };
}

function coerceLedgerEvents(value: unknown): LedgerEvent[] {
  if (Array.isArray(value)) {
    return value.filter(isLedgerEvent);
  }

  if (isRecord(value)) {
    if (Array.isArray(value.events)) {
      return value.events.filter(isLedgerEvent);
    }
    if (Array.isArray(value.ledger)) {
      return value.ledger.filter(isLedgerEvent);
    }
  }

  return [];
}

function extractPersistedVerification(artifacts: ProofArtifact[]): LedgerVerification | undefined {
  for (const artifact of artifacts) {
    const lowerName = artifact.name.toLowerCase();
    if (!lowerName.includes("verification") && !lowerName.includes("verify")) {
      continue;
    }
    if (isLedgerVerification(artifact.data)) {
      return artifact.data;
    }
  }
  return undefined;
}

function extractNamedObject(
  artifacts: ProofArtifact[],
  names: string[],
): Record<string, unknown> | undefined {
  for (const artifact of artifacts) {
    if (artifact.kind !== "json" || !isRecord(artifact.data)) {
      continue;
    }
    const artifactStem = basename(artifact.name, extname(artifact.name)).toLowerCase();
    if (names.includes(artifactStem)) {
      return artifact.data;
    }
  }
  return undefined;
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.ts === "string" &&
    typeof value.callId === "string" &&
    typeof value.type === "string" &&
    typeof value.payload === "object" &&
    value.payload !== null &&
    typeof value.prev_hash === "string" &&
    typeof value.hash === "string"
  );
}

function isLedgerVerification(value: unknown): value is LedgerVerification {
  return (
    isRecord(value) &&
    typeof value.valid === "boolean" &&
    typeof value.eventCount === "number" &&
    Array.isArray(value.errors) &&
    value.errors.every((error) => typeof error === "string")
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function formatValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
