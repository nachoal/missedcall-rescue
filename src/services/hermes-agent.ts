import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { TriageDecision } from "../types/domain.js";
import { parseJsonFromModelContent } from "./nemotron.js";

/**
 * Runs the REAL Nous Hermes Agent CLI (`hermes`) with Nemotron as the model.
 * This is not a simulator: it spawns the installed `hermes` binary, which
 * executes the agent loop and returns the model's structured decision.
 */

export type HermesAgentTriageInput = {
  callId: string;
  transcript?: string;
  problem?: string;
  customerName?: string;
  address?: string;
  callerPhone?: string;
  vulnerablePerson?: boolean;
};

export type HermesAgentResult = {
  decision: Partial<TriageDecision>;
  hermesRunId: string;
  model: string;
  bin: string;
  rawOutput: string;
};

const DEFAULT_NEMOTRON_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const DEFAULT_NEMOCLAW_SANDBOX = "hermes-proof";
const HERMES_TIMEOUT_MS = 180_000;
const NEMOCLAW_HERMES_TIMEOUT_MS = 300_000;

export function resolveHermesBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HERMES_BIN?.trim();
  const candidates = [
    explicit,
    resolve(homedir(), ".local/bin/hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "hermes"; // rely on PATH
}

export function resolveNemoHermesBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.NEMOHERMES_BIN?.trim() || env.NEMOCLAW_BIN?.trim();
  const candidates = [
    explicit,
    resolve(homedir(), ".local/bin/nemohermes"),
    "/opt/homebrew/bin/nemohermes",
    "/usr/local/bin/nemohermes",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "nemohermes"; // rely on PATH
}

export function hermesEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nim = env.NVIDIA_NIM_API_KEY || env.NVIDIA_API_KEY || "";
  return {
    ...env,
    PATH: `${resolve(homedir(), ".local/bin")}:${env.PATH ?? ""}`,
    NVIDIA_API_KEY: env.NVIDIA_API_KEY || nim,
    NVIDIA_NIM_API_KEY: env.NVIDIA_NIM_API_KEY || nim,
  };
}

function buildPrompt(input: HermesAgentTriageInput): string {
  return [
    "You are the triage brain for an after-hours HVAC emergency dispatcher.",
    "Read the call facts and decide. Output ONLY one JSON object, no prose, no code fences, with EXACTLY these keys:",
    '{"urgency":"emergency"|"same_day"|"routine","depositAmountCents":4900,"reasons":["short reason", ...],"recommendedWindow":"e.g. tonight 6-9pm","nextAction":"ask_followup"|"send_deposit"|"escalate_human","customerSummary":{"name":"","address":"","problem":"","vulnerablePerson":true|false}}',
    "Call facts (JSON):",
    JSON.stringify(triageFacts(input)),
  ].join("\n");
}

function triageFacts(input: HermesAgentTriageInput): Record<string, unknown> {
  return {
    transcript: input.transcript,
    problem: input.problem,
    name: input.customerName,
    address: input.address,
    phone: input.callerPhone,
    vulnerablePerson: input.vulnerablePerson,
  };
}

function buildSandboxPrompt(input: HermesAgentTriageInput): string {
  return [
    "HVAC emergency dispatcher triage.",
    "Return ONLY one JSON object with keys urgency, depositAmountCents, reasons, recommendedWindow, nextAction, customerSummary.",
    'urgency is "emergency", "same_day", or "routine"; nextAction is "ask_followup", "send_deposit", or "escalate_human"; depositAmountCents must be 4900.',
    'customerSummary must be an object: {"name":"","address":"","problem":"","vulnerablePerson":true}.',
    `Call facts: ${JSON.stringify(triageFacts(input))}`,
  ].join(" ");
}

function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function resolveNemoClawSandbox(env: NodeJS.ProcessEnv): string {
  return (
    env.NEMOCLAW_SANDBOX_NAME?.trim() ||
    env.NEMOCLAW_SANDBOX?.trim() ||
    env.REAL_NEMOCLAW_SANDBOX?.trim() ||
    DEFAULT_NEMOCLAW_SANDBOX
  );
}

function buildDirectHermesArgs(model: string, prompt: string): string[] {
  return [
    "--cli",
    "--yolo",
    "--ignore-user-config",
    "--provider",
    "nvidia",
    "-m",
    model,
    "-z",
    prompt,
  ];
}

function buildSandboxHermesArgs(model: string, prompt: string): string[] {
  const sandboxPrompt = prompt.replace(/\s*\n+\s*/g, " ");
  return [
    "--yolo",
    "-m",
    model,
    "-z",
    sandboxPrompt,
  ];
}

async function spawnForOutput(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { env: hermesEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("hermes agent timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = stdout.trim() ? stdout : code === 0 && stderr.trim() ? stderr : "";
      if (!output.trim()) {
        rejectPromise(new Error(`hermes produced no output (exit ${code}): ${stderr.slice(0, 400)}`));
        return;
      }
      resolvePromise(output);
    });
  });
}

async function runDirectHermes(
  input: HermesAgentTriageInput,
  model: string,
  env: NodeJS.ProcessEnv,
): Promise<{ bin: string; rawOutput: string }> {
  const bin = resolveHermesBinary(env);
  const rawOutput = await spawnForOutput(
    bin,
    buildDirectHermesArgs(model, buildPrompt(input)),
    env,
    HERMES_TIMEOUT_MS,
  );
  return { bin, rawOutput };
}

async function runNemoClawHermes(
  input: HermesAgentTriageInput,
  model: string,
  env: NodeJS.ProcessEnv,
): Promise<{ bin: string; rawOutput: string }> {
  const nemohermes = resolveNemoHermesBinary(env);
  const sandbox = resolveNemoClawSandbox(env);
  const timeoutMs = Number(env.NEMOCLAW_HERMES_TIMEOUT_MS) || NEMOCLAW_HERMES_TIMEOUT_MS;
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const rawOutput = await spawnForOutput(
    nemohermes,
    [
      sandbox,
      "exec",
      "--no-tty",
      "--timeout",
      String(timeoutSeconds),
      "--",
      "hermes",
      ...buildSandboxHermesArgs(model, buildSandboxPrompt(input)),
    ],
    env,
    timeoutMs,
  );
  return { bin: `${nemohermes}:${sandbox}:hermes`, rawOutput };
}

export async function runHermesAgentTriage(
  input: HermesAgentTriageInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesAgentResult> {
  const model = env.NEMOTRON_MODEL?.trim() || DEFAULT_NEMOTRON_MODEL;
  let run: { bin: string; rawOutput: string };
  if (envFlagEnabled(env.REAL_NEMOCLAW)) {
    try {
      run = await runNemoClawHermes(input, model, env);
    } catch {
      run = await runDirectHermes(input, model, env);
    }
  } else {
    run = await runDirectHermes(input, model, env);
  }

  const decision = parseJsonFromModelContent<Partial<TriageDecision>>(run.rawOutput);
  // run id is derived from the REAL agent output — auditable, never fabricated
  const hermesRunId =
    "hermes-" + createHash("sha256").update(`${input.callId}:${run.rawOutput}`).digest("hex").slice(0, 16);

  return { decision, hermesRunId, model, bin: run.bin, rawOutput: run.rawOutput };
}
