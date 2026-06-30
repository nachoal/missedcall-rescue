import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { readArtifact, writeArtifact } from "../artifacts.js";
import type { TriageDecision } from "../types/domain.js";
import {
  DEFAULT_NEMOTRON_MODEL,
  isNemotronConfigured,
  requestNemotronJson,
  type NemotronChatMessage,
  type NemotronJsonResult,
} from "./nemotron.js";
import { runHermesAgentTriage } from "./hermes-agent.js";

export type HermesTriageRequest = {
  callId: string;
  callerPhone?: string;
  transcript: string;
  customerName?: string;
  address?: string;
  problem?: string;
  vulnerablePerson?: boolean;
  preferredWindow?: string;
  email?: string;
};

export type BookingFieldExtraction = {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  problem?: string;
  preferredWindow?: string;
  vulnerablePerson: boolean;
  missing: string[];
  confidence: "low" | "medium" | "high";
};

export type HermesTriageOptions = {
  env?: NodeJS.ProcessEnv;
  nemotronJson?: (
    messages: NemotronChatMessage[],
  ) => Promise<NemotronJsonResult<Partial<TriageDecision>>>;
};

export type HermesToolInvocationInput<T> = {
  callId: string;
  hermesRunId?: string;
  skill: (typeof HERMES_TRIAGE_SKILLS)[number];
  tool: string;
  handler: () => Promise<T> | T;
};

export const HERMES_TRIAGE_SKILLS = [
  "hvac_triage",
  "collect_booking_details",
  "price_deposit",
  "create_deposit_checkout",
  "book_calendar",
  "authorize_comms_spend",
  "write_proof_pack",
] as const;

const LOCAL_HERMES_MODEL = "local-hermes-simulator/nemotron-triage-v0";
const DEPOSIT_AMOUNT_CENTS = 4900;

export async function runHermesTriage(
  request: HermesTriageRequest,
  options: HermesTriageOptions = {},
): Promise<TriageDecision> {
  const env = options.env ?? process.env;
  const hermesRunId = createHermesRunId("local", request);

  if (!shouldUseLiveHermes(env)) {
    const decision = await localHermesTriage(request, hermesRunId);
    await persistHermesRun(request, decision, "local");
    return decision;
  }

  // 1) REAL Hermes Agent on Nemotron — spawns the installed `hermes` CLI and
  //    lets the agent reason. Skipped when a nemotronJson stub is injected
  //    (unit tests) or when REAL_HERMES=false.
  if (
    !options.nemotronJson &&
    isNemotronConfigured(env) &&
    String(env.REAL_HERMES ?? "true").toLowerCase() !== "false"
  ) {
    try {
      const agent = await runHermesAgentTriage(request, env);
      const decision = normalizeDecision(agent.decision, request, {
        hermesRunId: agent.hermesRunId,
        model: agent.model,
      });
      await persistHermesRun(request, decision, "hermes-agent", agent.hermesRunId);
      return decision;
    } catch {
      // fall through to the direct-Nemotron path below
    }
  }

  // 2) Direct Nemotron (real model, without the Hermes harness).
  try {
    const messages = buildNemotronMessages(request, hermesRunId, env);
    const response = options.nemotronJson
      ? await options.nemotronJson(messages)
      : await requestNemotronJson<Partial<TriageDecision>>(messages, { env });
    const decision = normalizeDecision(response.data, request, {
      hermesRunId: createHermesRunId("remote", request),
      model: response.model,
    });
    await persistHermesRun(request, decision, "remote", response.providerRunId);
    return decision;
  } catch (error) {
    const fallback = await localHermesTriage(request, hermesRunId);
    const decision = {
      ...fallback,
      reasons: [
        ...fallback.reasons,
        "nemotron-unavailable-fallback",
        error instanceof Error ? error.message : "unknown-nemotron-error",
      ],
    };
    await persistHermesRun(request, decision, "fallback");
    return decision;
  }
}

export async function extractBookingFields(
  source: string | HermesTriageRequest,
): Promise<BookingFieldExtraction> {
  const request =
    typeof source === "string"
      ? { callId: "voice-preview", transcript: source }
      : source;
  const transcript = request.transcript.trim();
  const name = request.customerName ?? extractName(transcript);
  const phone = request.callerPhone;
  const email = request.email ?? transcript.match(emailRegex)?.[0];
  const address = request.address ?? extractAddress(transcript);
  const problem = request.problem ?? extractProblem(transcript);
  const preferredWindow =
    request.preferredWindow ?? extractPreferredWindow(transcript);
  const vulnerablePerson =
    request.vulnerablePerson ?? vulnerablePersonRegex.test(transcript);
  const missing = requiredMissing({ name, phone, address, problem });
  const presentCount = [name, phone, email, address, problem, preferredWindow]
    .filter(Boolean)
    .length;

  return {
    name,
    phone,
    email,
    address,
    problem,
    preferredWindow,
    vulnerablePerson,
    missing,
    confidence:
      presentCount >= 5 ? "high" : presentCount >= 3 ? "medium" : "low",
  };
}

export async function invokeHermesTool<T>(
  input: HermesToolInvocationInput<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  try {
    const result = await input.handler();
    await appendHermesToolInvocation(input, {
      status: "ok",
      startedAt,
      completedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    await appendHermesToolInvocation(input, {
      status: "error",
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "unknown error",
    });
    throw error;
  }
}

async function localHermesTriage(
  request: HermesTriageRequest,
  hermesRunId: string,
): Promise<TriageDecision> {
  const fields = await extractBookingFields(request);
  const redFlag = redFlagRegex.test(request.transcript);
  const urgency = decideUrgency(request.transcript, fields.vulnerablePerson);
  const reasons = decisionReasons(request.transcript, fields, redFlag);
  const requiredFieldsMissing = fields.missing;
  const nextAction =
    redFlag ||
    (urgency === "emergency" &&
      /gas|fire|smoke|electrical/i.test(request.transcript))
      ? "escalate_human"
      : requiredFieldsMissing.length > 0
        ? "ask_followup"
        : "send_deposit";

  return {
    callId: request.callId,
    hermesRunId,
    vertical: "hvac",
    offer: "emergency_ac_diagnostic",
    urgency,
    reasons,
    depositAmountCents: DEPOSIT_AMOUNT_CENTS,
    recommendedWindow:
      fields.preferredWindow ?? recommendedWindowForUrgency(urgency),
    requiredFieldsMissing,
    customerSummary: {
      name: fields.name,
      phone: fields.phone,
      address: fields.address,
      problem: fields.problem ?? "Air conditioning service request",
      vulnerablePerson: fields.vulnerablePerson,
    },
    nextAction,
    model: LOCAL_HERMES_MODEL,
  };
}

function shouldUseLiveHermes(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HERMES_BASE_URL?.trim()) && isNemotronConfigured(env);
}

async function persistHermesRun(
  request: HermesTriageRequest,
  decision: TriageDecision,
  mode: "local" | "remote" | "fallback" | "hermes-agent",
  providerRunId?: string,
): Promise<void> {
  const skillFiles = HERMES_TRIAGE_SKILLS.map((skill) => `${skill}.md`);
  const skills = await Promise.all(
    skillFiles.map(async (fileName) => {
      const path = resolve(process.cwd(), "src", "hermes", "skills", fileName);
      const body = await readFile(path, "utf8");
      if (fileName === "hvac_triage.md") {
        await writeArtifact(request.callId, "hermes_skill_hvac_triage.md", body);
      }
      return {
        fileName,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    }),
  );

  await writeArtifact(request.callId, "hermes_run.json", {
    hermesRunId: decision.hermesRunId,
    profile: process.env.HERMES_PROFILE ?? "missedcall-rescue",
    mode,
    providerRunId,
    model: decision.model,
    emitted: "TriageDecision",
    toolInvocations: [
      {
        tool: "nemotron.triage",
        status: "ok",
      },
    ],
    skills,
  });
}

async function appendHermesToolInvocation(
  input: Omit<HermesToolInvocationInput<unknown>, "handler">,
  event: {
    status: "ok" | "error";
    startedAt: string;
    completedAt: string;
    error?: string;
  },
): Promise<void> {
  const invocation = {
    hermesRunId: input.hermesRunId,
    skill: input.skill,
    tool: input.tool,
    ...event,
  };
  const previousRun = await readArtifact<Record<string, unknown>>(input.callId, "hermes_run.json");
  const previousInvocations = Array.isArray(previousRun?.toolInvocations)
    ? previousRun.toolInvocations
    : [];
  await writeArtifact(input.callId, "hermes_run.json", {
    ...(previousRun ?? {
      hermesRunId: input.hermesRunId,
      profile: process.env.HERMES_PROFILE ?? "missedcall-rescue",
      mode: "tool-only",
    }),
    toolInvocations: [...previousInvocations, invocation],
  });

  const previousLog = await readArtifact<{ invocations?: unknown[] }>(
    input.callId,
    "hermes_tool_invocations.json",
  );
  await writeArtifact(input.callId, "hermes_tool_invocations.json", {
    invocations: [...(previousLog?.invocations ?? []), invocation],
  });
}

function buildNemotronMessages(
  request: HermesTriageRequest,
  hermesRunId: string,
  env: NodeJS.ProcessEnv,
): NemotronChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are Hermes for MissedCall Rescue, an HVAC missed-call recovery demo.",
        "Use the visible skills: hvac_triage, collect_booking_details, price_deposit, create_deposit_checkout, book_calendar, authorize_comms_spend, write_proof_pack.",
        "Return only JSON matching the TriageDecision shape.",
        "Use vertical hvac, offer emergency_ac_diagnostic, depositAmountCents 4900, and include hermesRunId.",
        "nextAction must be ask_followup, send_deposit, or escalate_human.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        hermesRunId,
        profile: env.HERMES_PROFILE ?? "missedcall-rescue",
        call: request,
      }),
    },
  ];
}

function normalizeDecision(
  decision: Partial<TriageDecision>,
  request: HermesTriageRequest,
  defaults: { hermesRunId: string; model: string },
): TriageDecision {
  const remoteVulnerable = Boolean(decision.customerSummary?.vulnerablePerson);
  const urgency = isUrgency(decision.urgency)
    ? decision.urgency
    : decideUrgency(request.transcript, remoteVulnerable);
  const nextAction = isNextAction(decision.nextAction)
    ? decision.nextAction
    : decision.requiredFieldsMissing?.length
      ? "ask_followup"
      : "send_deposit";
  const customerSummary = {
    problem:
      nonEmpty(decision.customerSummary?.problem) ??
      extractProblem(request.transcript) ??
      "Air conditioning service request",
    vulnerablePerson:
      decision.customerSummary?.vulnerablePerson ??
      vulnerablePersonRegex.test(request.transcript),
    name:
      nonEmpty(decision.customerSummary?.name) ??
      request.customerName ??
      extractName(request.transcript),
    phone: nonEmpty(decision.customerSummary?.phone) ?? request.callerPhone,
    address:
      nonEmpty(decision.customerSummary?.address) ??
      request.address ??
      extractAddress(request.transcript),
  };

  return {
    callId: nonEmpty(decision.callId) ?? request.callId,
    hermesRunId: nonEmpty(decision.hermesRunId) ?? defaults.hermesRunId,
    vertical: "hvac",
    offer: "emergency_ac_diagnostic",
    urgency,
    reasons: normalizeReasons(decision.reasons),
    depositAmountCents: DEPOSIT_AMOUNT_CENTS,
    recommendedWindow:
      nonEmpty(decision.recommendedWindow) ??
      recommendedWindowForUrgency(urgency),
    requiredFieldsMissing: normalizeMissing(decision.requiredFieldsMissing),
    customerSummary,
    nextAction,
    model: nonEmpty(decision.model) ?? defaults.model,
  };
}

function createHermesRunId(
  source: "local" | "remote",
  request: HermesTriageRequest,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        callId: request.callId,
        callerPhone: request.callerPhone,
        transcript: request.transcript,
        source,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `hermes_${source}_${digest}`;
}

function decideUrgency(
  transcript: string,
  vulnerablePerson: boolean,
): TriageDecision["urgency"] {
  if (
    emergencyRegex.test(transcript) ||
    (vulnerablePerson && noCoolingRegex.test(transcript))
  ) {
    return "emergency";
  }
  if (sameDayRegex.test(transcript) || noCoolingRegex.test(transcript)) {
    return "same_day";
  }
  return "routine";
}

function decisionReasons(
  transcript: string,
  fields: BookingFieldExtraction,
  redFlag: boolean,
): string[] {
  const reasons = ["hvac-missed-call-recovery"];
  if (noCoolingRegex.test(transcript)) {
    reasons.push("no-cooling");
  }
  if (fields.vulnerablePerson) {
    reasons.push("vulnerable-person");
  }
  if (sameDayRegex.test(transcript)) {
    reasons.push("same-day-requested");
  }
  if (redFlag) {
    reasons.push("human-escalation-red-flag");
  }
  if (fields.missing.length > 0) {
    reasons.push(`missing-fields:${fields.missing.join(",")}`);
  }
  if (reasons.length === 1) {
    reasons.push("routine-hvac-diagnostic");
  }
  return reasons;
}

function requiredMissing(fields: {
  name?: string;
  phone?: string;
  address?: string;
  problem?: string;
}): string[] {
  const missing: string[] = [];
  if (!fields.name) missing.push("name");
  if (!fields.phone) missing.push("phone");
  if (!fields.address) missing.push("address");
  if (!fields.problem) missing.push("problem");
  return missing;
}

function recommendedWindowForUrgency(
  urgency: TriageDecision["urgency"],
): string {
  if (urgency === "emergency") {
    return "next available emergency dispatch window";
  }
  if (urgency === "same_day") {
    return "today between 2:00 PM and 6:00 PM";
  }
  return "next business day between 9:00 AM and 12:00 PM";
}

function extractName(transcript: string): string | undefined {
  return nonEmpty(
    transcript.match(
      /\b(?:this is|i am|i'm|my name is)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})(?=\s+(?:at|and|with|calling|from)|[,.]|$)/i,
    )?.[1],
  );
}

function extractAddress(transcript: string): string | undefined {
  return nonEmpty(
    transcript.match(
      /\b(?:at|address is|located at)\s+(\d{1,6}\s+[a-z0-9 .'-]{4,80}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way)\b[^\n,.]*)/i,
    )?.[1],
  );
}

function extractProblem(transcript: string): string | undefined {
  if (noCoolingRegex.test(transcript)) {
    return "AC is not cooling";
  }
  if (/leak|drip|water/i.test(transcript)) {
    return "HVAC system is leaking water";
  }
  if (/thermostat/i.test(transcript)) {
    return "Thermostat or controls issue";
  }
  if (/heater|furnace|heat/i.test(transcript)) {
    return "Heating system service request";
  }
  if (/ac|a\/c|air condition|hvac/i.test(transcript)) {
    return "Air conditioning service request";
  }
  return undefined;
}

function extractPreferredWindow(transcript: string): string | undefined {
  return nonEmpty(
    transcript.match(
      /\b(?:today|tonight|tomorrow|after\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|before\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|between\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+and\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    )?.[0],
  );
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed : undefined;
}

function normalizeReasons(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) {
    return ["nemotron-triage"];
  }
  const normalized = reasons
    .map((reason) => nonEmpty(reason))
    .filter((reason): reason is string => Boolean(reason));
  return normalized.length > 0 ? normalized : ["nemotron-triage"];
}

function normalizeMissing(missing: unknown): string[] {
  if (!Array.isArray(missing)) {
    return [];
  }
  return missing
    .map((field) => nonEmpty(field))
    .filter((field): field is string => Boolean(field));
}

function isUrgency(value: unknown): value is TriageDecision["urgency"] {
  return value === "emergency" || value === "same_day" || value === "routine";
}

function isNextAction(value: unknown): value is TriageDecision["nextAction"] {
  return (
    value === "ask_followup" ||
    value === "send_deposit" ||
    value === "escalate_human"
  );
}

const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const noCoolingRegex =
  /\b(no\s+(?:ac|a\/c|air|cooling)|not\s+cooling|stopped\s+cooling|broken\s+(?:ac|a\/c)|ac\s+(?:is\s+)?out|air\s+conditioning\s+(?:is\s+)?out)\b/i;
const emergencyRegex =
  /\b(emergency|urgent|asap|tonight|heat\s*wave|100\s*degrees|one hundred degrees|elderly|senior|infant|baby|oxygen|medical|asthma)\b/i;
const sameDayRegex = /\b(today|same[- ]day|this afternoon|this evening|tonight)\b/i;
const vulnerablePersonRegex =
  /\b(elderly|senior|infant|baby|newborn|child|pregnant|oxygen|medical|asthma|disabled|vulnerable)\b/i;
const redFlagRegex = /\b(gas smell|carbon monoxide|fire|smoke|sparking|electrical)\b/i;

export { DEFAULT_NEMOTRON_MODEL };
