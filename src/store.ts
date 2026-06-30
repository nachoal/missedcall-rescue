import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CallState } from "./types/domain.js";

const callsDir = join(process.cwd(), "data", "calls");

export async function ensureDataDirs(): Promise<void> {
  await mkdir(callsDir, { recursive: true });
  await mkdir(join(process.cwd(), "data", "proof"), { recursive: true });
}

export function callPath(callId: string): string {
  return join(callsDir, `${callId}.json`);
}

export async function saveCallState(state: CallState): Promise<CallState> {
  await mkdir(dirname(callPath(state.callId)), { recursive: true });
  await writeFile(callPath(state.callId), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export async function getCallState(callId: string): Promise<CallState | undefined> {
  try {
    const raw = await readFile(callPath(callId), "utf8");
    return JSON.parse(raw) as CallState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function requireCallState(callId: string): Promise<CallState> {
  const state = await getCallState(callId);
  if (!state) throw new Error(`Call state not found for ${callId}`);
  return state;
}

export function createInitialCallState(input: {
  callId: string;
  callerPhone: string;
  transcript: string;
  customerName?: string;
  address?: string;
  problem?: string;
  vulnerablePerson?: boolean;
  preferredWindow?: string;
  email?: string;
}): CallState {
  return {
    callId: input.callId,
    callerPhone: input.callerPhone,
    customerName: input.customerName,
    address: input.address,
    problem: input.problem,
    vulnerablePerson: input.vulnerablePerson,
    preferredWindow: input.preferredWindow,
    email: input.email,
    status: "triaging",
    transcript: input.transcript
  };
}
